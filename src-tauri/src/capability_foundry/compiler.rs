use super::models::*;
use super::origin::{
    is_metadata_ip, is_private_or_local_ip, is_unroutable_ip, validate_compilation_origin,
};
use super::risk;
use super::sanitizer::sanitize_json;
use super::schema::{object_schema, validate_schema};
use chrono::Utc;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::net::IpAddr;

pub const COMPILER_VERSION: &str = "iris-foundry-0.2.0";

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), canonical_json(value)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(canonical_json).collect()),
        _ => value.clone(),
    }
}

pub fn value_hash(value: &Value) -> String {
    sha256(&serde_json::to_vec(&canonical_json(value)).expect("JSON serialization cannot fail"))
}

fn safe_name(input: &str) -> String {
    let mut output = String::new();
    let mut last_separator = false;
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            output.push(ch.to_ascii_lowercase());
            last_separator = false;
        } else if !last_separator && !output.is_empty() {
            output.push('_');
            last_separator = true;
        }
    }
    output.trim_matches('_').to_string()
}

fn package_namespace(origin: &str) -> String {
    reqwest::Url::parse(origin)
        .ok()
        .and_then(|url| url.host_str().map(safe_name))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "capability".to_string())
}

const MAX_FOUNDRY_TOOL_NAME: usize = 64;

fn bounded_tool_name(full: &str, identity: &Value, force_suffix: bool) -> String {
    if !force_suffix && full.len() <= MAX_FOUNDRY_TOOL_NAME {
        return full.to_string();
    }
    let suffix = &value_hash(identity)[..8];
    let prefix_len = MAX_FOUNDRY_TOOL_NAME - suffix.len() - 1;
    let prefix = full
        .chars()
        .take(prefix_len)
        .collect::<String>()
        .trim_end_matches('_')
        .to_string();
    format!("{prefix}_{suffix}")
}

fn normalize_tool_names(origin: &str, capabilities: &mut [Capability]) {
    let namespace = package_namespace(origin);
    let origin_slug = safe_name(&namespace);
    let foundry_prefix = format!("foundry_{origin_slug}_");
    let raw_bases: Vec<String> = capabilities
        .iter()
        .map(|capability| {
            let operation = capability
                .tool_name
                .strip_prefix(&foundry_prefix)
                .or_else(|| capability.tool_name.strip_prefix(&format!("{namespace}_")))
                .unwrap_or(&capability.tool_name);
            format!("foundry_{origin_slug}_{}", safe_name(operation))
        })
        .collect();
    let mut counts = BTreeMap::new();
    for base in &raw_bases {
        *counts.entry(base.clone()).or_insert(0usize) += 1;
    }
    for (capability, base) in capabilities.iter_mut().zip(raw_bases) {
        let identity = serde_json::json!({
            "origin": origin,
            "capabilityId": capability.id,
            "method": capability.method,
            "endpoint": capability.endpoint,
            "inputSchema": capability.input_schema
        });
        capability.tool_name = bounded_tool_name(
            &base,
            &identity,
            counts.get(&base).copied().unwrap_or(0) > 1,
        );
    }
}

fn evidence(
    source_type: &str,
    source_mode: &str,
    source_url: &str,
    payload: &Value,
    confidence: f64,
) -> Evidence {
    let fingerprint = value_hash(payload);
    Evidence {
        id: format!("ev_{}", &fingerprint[..16]),
        source_mode: source_mode.to_string(),
        source_type: source_type.to_string(),
        source_url: super::sanitizer::sanitize_text(source_url)
            .unwrap_or_else(|_| "[REDACTED URL]".to_string()),
        confidence,
        fingerprint,
        metadata: serde_json::json!({"contentStored": false, "untrusted": true}),
    }
}

fn resolve_local_ref(
    value: &Value,
    root: &Value,
    depth: usize,
    seen: &mut BTreeSet<String>,
) -> Result<Value, String> {
    if depth > 12 {
        return Err("OPENAPI_REF_DEPTH_EXCEEDED".to_string());
    }
    if let Some(reference) = value.get("$ref").and_then(Value::as_str) {
        if !reference.starts_with("#/") {
            return Err("EXTERNAL_OPENAPI_REF_REJECTED".to_string());
        }
        if !seen.insert(reference.to_string()) {
            return Err("OPENAPI_REF_CYCLE".to_string());
        }
        let pointer = reference.trim_start_matches('#');
        let target = root
            .pointer(pointer)
            .ok_or_else(|| "OPENAPI_REF_NOT_FOUND".to_string())?;
        let result = resolve_local_ref(target, root, depth + 1, seen);
        seen.remove(reference);
        return result;
    }
    Ok(value.clone())
}

fn normalize_schema(value: &Value, root: &Value, depth: usize) -> Result<Value, String> {
    if depth > 12 {
        return Err("OPENAPI_SCHEMA_DEPTH_EXCEEDED".to_string());
    }
    let resolved = resolve_local_ref(value, root, 0, &mut BTreeSet::new())?;
    let object = resolved.as_object().cloned().unwrap_or_default();
    if object.keys().any(|key| {
        matches!(
            key.as_str(),
            "oneOf" | "anyOf" | "not" | "if" | "then" | "else"
        )
    }) {
        return Err("UNSUPPORTED_OPENAPI_SCHEMA_COMPOSITION".to_string());
    }
    if let Some(all_of) = object.get("allOf").and_then(Value::as_array) {
        let mut properties = Map::new();
        let mut required = BTreeSet::new();
        for child in all_of {
            let child = normalize_schema(child, root, depth + 1)?;
            if let Some(values) = child.get("properties").and_then(Value::as_object) {
                properties.extend(values.clone());
            }
            if let Some(values) = child.get("required").and_then(Value::as_array) {
                required.extend(values.iter().filter_map(Value::as_str).map(str::to_string));
            }
        }
        return Ok(object_schema(properties, required.into_iter().collect()));
    }
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| object.contains_key("properties").then_some("object"))
        .unwrap_or("string");
    let mut output = Map::new();
    output.insert("type".to_string(), Value::String(kind.to_string()));
    for key in [
        "description",
        "title",
        "format",
        "default",
        "nullable",
        "enum",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "pattern",
    ] {
        if let Some(value) = object.get(key) {
            output.insert(key.to_string(), value.clone());
        }
    }
    if kind == "object" {
        let mut properties = Map::new();
        for (name, schema) in object
            .get("properties")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
        {
            properties.insert(name, normalize_schema(&schema, root, depth + 1)?);
        }
        output.insert("properties".to_string(), Value::Object(properties));
        output.insert(
            "required".to_string(),
            object
                .get("required")
                .cloned()
                .unwrap_or_else(|| Value::Array(vec![])),
        );
        output.insert("additionalProperties".to_string(), Value::Bool(false));
    } else if kind == "array" {
        let items = object
            .get("items")
            .ok_or_else(|| "ARRAY_SCHEMA_REQUIRES_ITEMS".to_string())?;
        output.insert(
            "items".to_string(),
            normalize_schema(items, root, depth + 1)?,
        );
    }
    let normalized = Value::Object(output);
    validate_schema(&normalized)?;
    Ok(normalized)
}

fn response_schema(operation: &Value, root: &Value) -> Value {
    let responses = operation.get("responses").and_then(Value::as_object);
    let response = responses.and_then(|map| {
        map.get("200")
            .or_else(|| map.get("201"))
            .or_else(|| map.get("default"))
            .or_else(|| map.values().next())
    });
    let schema = response.and_then(|response| {
        response
            .pointer("/content/application~1json/schema")
            .or_else(|| response.get("schema"))
    });
    schema
        .and_then(|schema| normalize_schema(schema, root, 0).ok())
        .unwrap_or_else(
            || serde_json::json!({"type":"object","properties":{},"additionalProperties":false}),
        )
}

pub fn compile_openapi(
    document: &Value,
    source_url: &str,
    allow_local_network: bool,
) -> Result<CapabilityPackage, String> {
    let source =
        reqwest::Url::parse(source_url).map_err(|_| "INVALID_OPENAPI_SOURCE_URL".to_string())?;
    let target = validate_compilation_origin(source_url, allow_local_network)?;
    if document.get("openapi").is_none() && document.get("swagger").is_none() {
        return Err("OPENAPI_OR_SWAGGER_VERSION_REQUIRED".to_string());
    }
    let paths = document
        .get("paths")
        .and_then(Value::as_object)
        .ok_or_else(|| "OPENAPI_PATHS_REQUIRED".to_string())?;
    let namespace = package_namespace(&target.origin);
    let source_evidence = evidence("openapi", "native", source.as_str(), document, 1.0);
    let mut capabilities = Vec::new();
    let mut routes = Vec::new();
    for (path, item) in paths {
        if !path.starts_with('/') || path.starts_with("//") {
            continue;
        }
        for method in ["get", "head", "options", "post", "put", "patch", "delete"] {
            let Some(operation) = item.get(method) else {
                continue;
            };
            let raw_operation_id = operation
                .get("operationId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let operation_id = (!raw_operation_id.is_empty())
                .then(|| safe_name(raw_operation_id))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| safe_name(&format!("{method}_{path}")));
            let capability_id = format!(
                "cap_{}",
                &value_hash(
                    &serde_json::json!({"origin":target.origin,"method":method,"path":path,"operation":operation_id})
                )[..16]
            );
            let mut properties = Map::new();
            let mut required = BTreeSet::new();
            let mut path_parameters = Vec::new();
            let mut query_parameters = Vec::new();
            let mut body_fields = Vec::new();
            let combined_parameters = item
                .get("parameters")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .chain(
                    operation
                        .get("parameters")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten(),
                );
            for raw in combined_parameters {
                let parameter = resolve_local_ref(raw, document, 0, &mut BTreeSet::new())?;
                let name = parameter.get("name").and_then(Value::as_str).unwrap_or("");
                let location = parameter.get("in").and_then(Value::as_str).unwrap_or("");
                if name.is_empty() || !matches!(location, "path" | "query" | "body") {
                    continue;
                }
                if location == "body" {
                    let body = normalize_schema(
                        parameter.get("schema").unwrap_or(&Value::Null),
                        document,
                        0,
                    )?;
                    if let Some(fields) = body.get("properties").and_then(Value::as_object) {
                        for (field, schema) in fields {
                            properties.insert(field.clone(), schema.clone());
                            body_fields.push(field.clone());
                        }
                        required.extend(
                            body.get("required")
                                .and_then(Value::as_array)
                                .into_iter()
                                .flatten()
                                .filter_map(Value::as_str)
                                .map(str::to_string),
                        );
                    } else {
                        properties.insert("body".to_string(), body);
                        body_fields.push("body".to_string());
                    }
                } else {
                    let schema = parameter.get("schema").cloned().unwrap_or_else(|| serde_json::json!({"type":parameter.get("type").and_then(Value::as_str).unwrap_or("string")}));
                    properties.insert(name.to_string(), normalize_schema(&schema, document, 0)?);
                    if parameter.get("required").and_then(Value::as_bool) == Some(true)
                        || location == "path"
                    {
                        required.insert(name.to_string());
                    }
                    if location == "path" {
                        path_parameters.push(name.to_string());
                    } else {
                        query_parameters.push(name.to_string());
                    }
                }
            }
            if let Some(body) = operation.pointer("/requestBody/content/application~1json/schema") {
                let body = normalize_schema(body, document, 0)?;
                if let Some(fields) = body.get("properties").and_then(Value::as_object) {
                    for (field, schema) in fields {
                        properties.insert(field.clone(), schema.clone());
                        body_fields.push(field.clone());
                    }
                    required.extend(
                        body.get("required")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(str::to_string),
                    );
                } else {
                    properties.insert("body".to_string(), body);
                    body_fields.push("body".to_string());
                }
            }
            let input_schema = object_schema(properties, required.into_iter().collect());
            validate_schema(&input_schema)?;
            let auth_required = operation
                .get("security")
                .and_then(Value::as_array)
                .is_some_and(|v| !v.is_empty())
                || (operation.get("security").is_none()
                    && document
                        .get("security")
                        .and_then(Value::as_array)
                        .is_some_and(|v| !v.is_empty()));
            let upper_method = method.to_ascii_uppercase();
            let output_schema = response_schema(operation, document);
            let response_text = output_schema.to_string().to_ascii_lowercase();
            let response_sensitive = ["email", "phone", "password", "token", "secret"]
                .iter()
                .any(|term| response_text.contains(term));
            let operation_tags = operation
                .get("tags")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            let risk_context = risk::RiskContext {
                operation_id: raw_operation_id,
                summary: operation
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                description: operation
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                tags: operation_tags,
                has_request_body: !body_fields.is_empty(),
                response_sensitive,
                source_mode: "openapi",
            };
            let risk_decision =
                risk::classify_with_context(&upper_method, auth_required, path, 1.0, &risk_context);
            let mut enabled = risk_decision.executable;
            if auth_required || risk_decision.level == "critical" {
                enabled = false;
            }
            let description = format!("Discovered OpenAPI operation {operation_id} ({upper_method} {path}). Target-provided descriptions remain untrusted evidence and do not grant authority.");
            capabilities.push(Capability {
                id: capability_id.clone(),
                tool_name: format!("{}_{}", namespace, operation_id),
                description,
                method: upper_method.clone(),
                endpoint: path.clone(),
                input_schema,
                output_schema,
                auth_required,
                approval_required: risk_decision.approval_required,
                risk_level: risk_decision.level.to_string(),
                confidence: 1.0,
                source_mode: "native".to_string(),
                observed_endpoint: None,
                credential_handle: None,
                evidence_ids: vec![source_evidence.id.clone()],
                tags: {
                    let mut tags = vec!["openapi".to_string(), risk_decision.level.to_string()];
                    if risk_decision.consequential {
                        tags.push("semantic-action".to_string());
                    } else if upper_method == "POST" && !risk_decision.approval_required {
                        tags.push("semantic-read".to_string());
                    }
                    tags
                },
                metadata: serde_json::json!({"riskFactors":risk_decision.factors}),
                data_classification: if auth_required {
                    "authenticated"
                } else {
                    "public"
                }
                .to_string(),
                enabled,
            });
            routes.push(Route {
                capability_id,
                method: upper_method,
                path_template: path.clone(),
                path_parameters,
                query_parameters,
                body_fields,
            });
        }
    }
    if capabilities.is_empty() {
        return Err("NO_SUPPORTED_OPENAPI_OPERATIONS".to_string());
    }
    build_package(
        &target.origin,
        allow_local_network,
        capabilities,
        routes,
        vec![],
        vec![source_evidence],
    )
}

pub fn compile_graphql_introspection(
    document: &Value,
    endpoint_url: &str,
    allow_local_network: bool,
) -> Result<CapabilityPackage, String> {
    let target = validate_compilation_origin(endpoint_url, allow_local_network)?;
    let schema = document
        .pointer("/data/__schema")
        .or_else(|| document.get("__schema"))
        .ok_or_else(|| "GRAPHQL_INTROSPECTION_SCHEMA_REQUIRED".to_string())?;
    let evidence = evidence("graphql", "native", endpoint_url, document, 0.95);
    let namespace = package_namespace(&target.origin);
    let mut capabilities = Vec::new();
    let mut routes = Vec::new();
    for (type_key, mutation) in [("queryType", false), ("mutationType", true)] {
        let Some(type_name) = schema
            .get(type_key)
            .and_then(|v| v.get("name"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let Some(type_def) = schema
            .get("types")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|item| item.get("name").and_then(Value::as_str) == Some(type_name))
        else {
            continue;
        };
        for field in type_def
            .get("fields")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(field_name) = field.get("name").and_then(Value::as_str) else {
                continue;
            };
            let mut properties = Map::new();
            let mut required = Vec::new();
            let mut declarations = Vec::new();
            let mut bindings = Vec::new();
            for arg in field
                .get("args")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(name) = arg.get("name").and_then(Value::as_str) else {
                    continue;
                };
                properties.insert(name.to_string(), serde_json::json!({"type":"string","description":"GraphQL argument; exact scalar type must be reviewed"}));
                let graphql_type = graphql_type_name(arg.get("type").unwrap_or(&Value::Null), 0)?;
                declarations.push(format!("${name}: {graphql_type}"));
                bindings.push(format!("{name}: ${name}"));
                if graphql_type.ends_with('!') {
                    required.push(name.to_string());
                }
            }
            let operation_kind = if mutation { "mutation" } else { "query" };
            let selection = if graphql_named_kind(field.get("type").unwrap_or(&Value::Null), 0)
                .is_some_and(|kind| matches!(kind, "OBJECT" | "INTERFACE" | "UNION"))
            {
                " { __typename }"
            } else {
                ""
            };
            let variable_block = if declarations.is_empty() {
                String::new()
            } else {
                format!("({})", declarations.join(", "))
            };
            let argument_block = if bindings.is_empty() {
                String::new()
            } else {
                format!("({})", bindings.join(", "))
            };
            let graphql_document = format!("{operation_kind} IrisFoundry{variable_block} {{ {field_name}{argument_block}{selection} }}");
            let capability_id = format!(
                "cap_{}",
                &value_hash(
                    &serde_json::json!({"origin":target.origin,"graphql":operation_kind,"field":field_name})
                )[..16]
            );
            let endpoint = reqwest::Url::parse(endpoint_url)
                .ok()
                .map(|url| url.path().to_string())
                .unwrap_or_else(|| "/graphql".to_string());
            let semantic = risk::classify_with_context(
                "POST",
                false,
                &endpoint,
                0.9,
                &risk::RiskContext {
                    operation_id: field_name,
                    description: field
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    tags: vec![operation_kind],
                    source_mode: "graphql",
                    ..risk::RiskContext::default()
                },
            );
            let (risk_level, approval_required, enabled, consequential) =
                if mutation || semantic.consequential {
                    (semantic.level, true, semantic.level != "critical", true)
                } else {
                    ("medium", false, true, false)
                };
            let mut tags = vec!["graphql".to_string(), operation_kind.to_string()];
            if consequential {
                tags.push("semantic-action".to_string());
            } else {
                tags.push("semantic-read".to_string());
            }
            capabilities.push(Capability { id: capability_id.clone(), tool_name: format!("{}_{}", namespace, safe_name(field_name)),
                description: format!("Discovered GraphQL {operation_kind} {field_name}. Target-provided descriptions remain untrusted evidence."),
                method: "POST".to_string(), endpoint: endpoint.clone(),
                input_schema: object_schema(properties, required), output_schema: serde_json::json!({"type":"object","properties":{},"additionalProperties":false}),
                auth_required: false, approval_required, risk_level: risk_level.to_string(), confidence: 0.9,
                source_mode:"native".to_string(), observed_endpoint:None, credential_handle:None, evidence_ids:vec![evidence.id.clone()], tags, metadata:serde_json::json!({"graphql":{"operationKind":operation_kind,"fieldName":field_name,"document":graphql_document},"riskFactors":semantic.factors}), data_classification:"unknown".to_string(), enabled });
            routes.push(Route {
                capability_id,
                method: "POST".to_string(),
                path_template: endpoint,
                path_parameters: vec![],
                query_parameters: vec![],
                body_fields: vec![],
            });
        }
    }
    if capabilities.is_empty() {
        return Err("NO_GRAPHQL_FIELDS_DISCOVERED".to_string());
    }
    build_package(
        &target.origin,
        allow_local_network,
        capabilities,
        routes,
        vec![],
        vec![evidence],
    )
}

fn graphql_type_name(value: &Value, depth: usize) -> Result<String, String> {
    if depth > 8 {
        return Err("GRAPHQL_TYPE_DEPTH_EXCEEDED".to_string());
    }
    match value.get("kind").and_then(Value::as_str).unwrap_or("") {
        "NON_NULL" => Ok(format!(
            "{}!",
            graphql_type_name(value.get("ofType").unwrap_or(&Value::Null), depth + 1)?
        )),
        "LIST" => Ok(format!(
            "[{}]",
            graphql_type_name(value.get("ofType").unwrap_or(&Value::Null), depth + 1)?
        )),
        "SCALAR" | "ENUM" | "INPUT_OBJECT" => value
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| {
                name.chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
            })
            .map(str::to_string)
            .ok_or_else(|| "GRAPHQL_TYPE_NAME_INVALID".to_string()),
        _ => Err("GRAPHQL_ARGUMENT_TYPE_UNSUPPORTED".to_string()),
    }
}

fn graphql_named_kind(value: &Value, depth: usize) -> Option<&str> {
    if depth > 8 {
        return None;
    }
    match value.get("kind").and_then(Value::as_str)? {
        "NON_NULL" | "LIST" => graphql_named_kind(value.get("ofType")?, depth + 1),
        kind => Some(kind),
    }
}

pub fn compile_html_forms(
    html: &str,
    page_url: &str,
    allow_local_network: bool,
) -> Result<CapabilityPackage, String> {
    if html.len() > 2_000_000 {
        return Err("HTML_INPUT_TOO_LARGE".to_string());
    }
    let target = validate_compilation_origin(page_url, allow_local_network)?;
    let source_value = Value::String(html.chars().take(32_000).collect());
    let evidence = evidence("form", "extraction", page_url, &source_value, 0.65);
    let namespace = package_namespace(&target.origin);
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    let mut capabilities = Vec::new();
    let mut routes = Vec::new();
    let mut index = 0;
    while let Some(start_rel) = lower[cursor..].find("<form") {
        let start = cursor + start_rel;
        let Some(tag_end_rel) = lower[start..].find('>') else {
            break;
        };
        let tag_end = start + tag_end_rel;
        let Some(close_rel) = lower[tag_end..].find("</form>") else {
            break;
        };
        let close = tag_end + close_rel;
        let tag = &html[start..=tag_end];
        let body = &html[tag_end + 1..close];
        index += 1;
        let action = attribute(tag, "action").unwrap_or_else(|| {
            reqwest::Url::parse(page_url)
                .ok()
                .map(|u| u.path().to_string())
                .unwrap_or_else(|| "/".to_string())
        });
        if action.starts_with("http://") || action.starts_with("https://") {
            let action_url =
                reqwest::Url::parse(&action).map_err(|_| "FORM_ACTION_INVALID".to_string())?;
            super::origin::enforce_same_origin(&target, &action_url)?;
        }
        let method = attribute(tag, "method")
            .unwrap_or_else(|| "GET".to_string())
            .to_ascii_uppercase();
        let mut properties = Map::new();
        let mut required = Vec::new();
        let mut scan = 0;
        while let Some(input_rel) = body[scan..].to_ascii_lowercase().find("<input") {
            let input_start = scan + input_rel;
            let Some(end_rel) = body[input_start..].find('>') else {
                break;
            };
            let input_end = input_start + end_rel;
            let input = &body[input_start..=input_end];
            scan = input_end + 1;
            let Some(name) = attribute(input, "name") else {
                continue;
            };
            let kind = attribute(input, "type")
                .unwrap_or_else(|| "text".to_string())
                .to_ascii_lowercase();
            if matches!(kind.as_str(), "password" | "file" | "hidden") {
                continue;
            }
            properties.insert(name.clone(), serde_json::json!({"type":if kind=="number" {"number"} else if kind=="checkbox" {"boolean"} else {"string"}}));
            if input.to_ascii_lowercase().contains(" required") {
                required.push(name);
            }
        }
        let capability_id = format!(
            "cap_{}",
            &value_hash(
                &serde_json::json!({"origin":target.origin,"form":index,"action":action,"method":method})
            )[..16]
        );
        let risk_decision = risk::classify_with_context(
            &method,
            false,
            &action,
            0.65,
            &risk::RiskContext {
                has_request_body: method != "GET",
                source_mode: "form",
                ..risk::RiskContext::default()
            },
        );
        let mut tags = vec!["form".to_string(), "review-required".to_string()];
        if risk_decision.consequential {
            tags.push("semantic-action".to_string());
        }
        capabilities.push(Capability { id:capability_id.clone(), tool_name:format!("{}_form_{}",namespace,index), description:"Form-derived candidate; semantics require human review".to_string(), method:method.clone(), endpoint:action.clone(), input_schema:object_schema(properties.clone(),required), output_schema:serde_json::json!({"type":"object","properties":{},"additionalProperties":false}), auth_required:false, approval_required:risk_decision.approval_required, risk_level:risk_decision.level.to_string(), confidence:0.65, source_mode:"extraction".to_string(), observed_endpoint:None, credential_handle:None, evidence_ids:vec![evidence.id.clone()], tags, metadata:serde_json::json!({"riskFactors":risk_decision.factors}), data_classification:"unknown".to_string(), enabled:risk_decision.executable && method=="GET" });
        routes.push(Route {
            capability_id,
            method: method.clone(),
            path_template: action,
            path_parameters: vec![],
            query_parameters: if method == "GET" {
                properties.keys().cloned().collect()
            } else {
                vec![]
            },
            body_fields: if method == "GET" {
                vec![]
            } else {
                properties.keys().cloned().collect()
            },
        });
        cursor = close + 7;
    }
    if capabilities.is_empty() {
        return Err("NO_FORMS_DISCOVERED".to_string());
    }
    build_package(
        &target.origin,
        allow_local_network,
        capabilities,
        routes,
        vec![],
        vec![evidence],
    )
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let start = lower.find(&format!("{name}="))? + name.len() + 1;
    let rest = &tag[start..];
    let quote = rest.chars().next()?;
    if quote == '\"' || quote == '\'' {
        let end = rest[1..].find(quote)? + 1;
        Some(rest[1..end].to_string())
    } else {
        Some(
            rest.split_whitespace()
                .next()?
                .trim_end_matches('>')
                .to_string(),
        )
    }
}

pub fn compile_har(
    document: &Value,
    target_url: &str,
    allow_local_network: bool,
) -> Result<CapabilityPackage, String> {
    let target = validate_compilation_origin(target_url, allow_local_network)?;
    let entries = document
        .pointer("/log/entries")
        .or_else(|| document.get("entries"))
        .and_then(Value::as_array)
        .ok_or_else(|| "HAR_ENTRIES_REQUIRED".to_string())?;
    let sanitized = sanitize_json(document)?;
    let evidence = evidence("network", "observed", target_url, &sanitized, 0.8);
    let namespace = package_namespace(&target.origin);
    let mut seen = BTreeSet::new();
    let mut capabilities = Vec::new();
    let mut routes = Vec::new();
    for entry in entries.iter().take(500) {
        let request = entry.get("request").unwrap_or(entry);
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN")
            .to_ascii_uppercase();
        let Some(raw_url) = request.get("url").and_then(Value::as_str) else {
            continue;
        };
        let url = reqwest::Url::parse(raw_url).map_err(|_| "HAR_URL_INVALID".to_string())?;
        super::origin::enforce_same_origin(&target, &url)?;
        let path = url.path().to_string();
        let dedupe = format!("{method} {path}");
        if !seen.insert(dedupe) {
            continue;
        }
        let mut properties = Map::new();
        let mut query = Vec::new();
        for (name, value) in url.query_pairs() {
            properties.insert(
                name.to_string(),
                infer_schema(&Value::String(value.to_string()), 0),
            );
            query.push(name.to_string());
        }
        let mut body_fields = Vec::new();
        if let Some(text) = request.pointer("/postData/text").and_then(Value::as_str) {
            if let Ok(body) = serde_json::from_str::<Value>(text) {
                if let Some(map) = body.as_object() {
                    for (name, value) in map {
                        properties.insert(name.clone(), infer_schema(value, 0));
                        body_fields.push(name.clone());
                    }
                }
            }
        }
        let auth_required = request
            .get("headers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|h| {
                matches!(
                    h.get("name")
                        .and_then(Value::as_str)
                        .map(str::to_ascii_lowercase)
                        .as_deref(),
                    Some("authorization" | "cookie")
                )
            });
        let confidence = 0.8;
        let observed_graphql = request
            .pointer("/postData/text")
            .and_then(Value::as_str)
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .and_then(|body| {
                body.get("query").and_then(Value::as_str).map(|query| {
                    let normalized = query.trim_start().to_ascii_lowercase();
                    if normalized.starts_with("query") || normalized.starts_with('{') {
                        "query"
                    } else if normalized.starts_with("mutation") {
                        "mutation"
                    } else {
                        "unknown"
                    }
                })
            });
        let risk_decision = if let Some(kind) = observed_graphql {
            let (level, approval_required) = match kind {
                "query" => ("medium", false),
                "mutation" => ("high", true),
                _ => ("critical", true),
            };
            risk::RiskDecision {
                level,
                approval_required,
                executable: false,
                consequential: kind != "query",
                factors: vec![
                    "method:POST".to_string(),
                    "source:observed".to_string(),
                    format!("graphql:{kind}"),
                ],
            }
        } else {
            risk::classify_with_context(
                &method,
                auth_required,
                &path,
                confidence,
                &risk::RiskContext {
                    has_request_body: !body_fields.is_empty(),
                    source_mode: "observed",
                    ..risk::RiskContext::default()
                },
            )
        };
        let operation = safe_name(&format!("{}_{}", method, path));
        let id = format!(
            "cap_{}",
            &value_hash(&serde_json::json!({"origin":target.origin,"observed":method,"path":path}))
                [..16]
        );
        capabilities.push(Capability {
            id: id.clone(),
            tool_name: format!("{}_{}", namespace, operation),
            description:
                "Observed request candidate; captured values were redacted and are not credentials"
                    .to_string(),
            method: method.clone(),
            endpoint: path.clone(),
            input_schema: object_schema(properties, vec![]),
            output_schema: entry
                .pointer("/response/content/text")
                .and_then(Value::as_str)
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .map(|value| infer_schema(&value, 0))
                .unwrap_or_else(|| {
                    infer_schema(
                        entry.pointer("/response/content/text").unwrap_or(&Value::Null),
                        0,
                    )
                }),
            auth_required,
            approval_required: risk_decision.approval_required,
            risk_level: risk_decision.level.to_string(),
            confidence,
            source_mode: "observed".to_string(),
            observed_endpoint: Some(path.clone()),
            credential_handle: None,
            evidence_ids: vec![evidence.id.clone()],
            tags: {
                let mut tags = observed_graphql.map(|kind| vec!["observed".to_string(),"graphql".to_string(),kind.to_string()]).unwrap_or_else(||vec!["observed".to_string()]);
                if risk_decision.consequential {
                    tags.push("semantic-action".to_string());
                } else if method == "POST" && risk_decision.executable {
                    tags.push("semantic-read".to_string());
                }
                tags
            },
            metadata: observed_graphql.map(|kind|serde_json::json!({"graphql":{"classification":kind,"executable":false,"reason":"Observed GraphQL requires recompilation from an authorized schema"},"riskFactors":risk_decision.factors})).unwrap_or_else(||serde_json::json!({"riskFactors":risk_decision.factors})),
            data_classification: if auth_required {
                "authenticated"
            } else {
                "unknown"
            }
            .to_string(),
            enabled: risk_decision.executable && !auth_required,
        });
        routes.push(Route {
            capability_id: id,
            method,
            path_template: path,
            path_parameters: vec![],
            query_parameters: query,
            body_fields,
        });
    }
    if capabilities.is_empty() {
        return Err("NO_OBSERVED_CAPABILITIES".to_string());
    }
    build_package(
        &target.origin,
        allow_local_network,
        capabilities,
        routes,
        vec![],
        vec![evidence],
    )
}

fn infer_schema(value: &Value, depth: usize) -> Value {
    if depth > 4 {
        return serde_json::json!({"type":"string"});
    }
    match value {
        Value::Null => serde_json::json!({"type":"string","nullable":true}),
        Value::Bool(_) => serde_json::json!({"type":"boolean"}),
        Value::Number(n) => {
            serde_json::json!({"type":if n.is_i64()||n.is_u64(){"integer"}else{"number"}})
        }
        Value::String(_) => serde_json::json!({"type":"string"}),
        Value::Array(a) => {
            serde_json::json!({"type":"array","items":a.first().map(|v|infer_schema(v,depth+1)).unwrap_or_else(||serde_json::json!({"type":"string"}))})
        }
        Value::Object(m) => object_schema(
            m.iter()
                .map(|(k, v)| (k.clone(), infer_schema(v, depth + 1)))
                .collect(),
            vec![],
        ),
    }
}

pub fn build_package(
    origin: &str,
    allow_local_network: bool,
    capabilities: Vec<Capability>,
    routes: Vec<Route>,
    entities: Vec<Entity>,
    evidence: Vec<Evidence>,
) -> Result<CapabilityPackage, String> {
    build_package_with_approved_addresses(
        origin,
        allow_local_network,
        vec![],
        capabilities,
        routes,
        entities,
        evidence,
    )
}

pub fn build_package_with_approved_addresses(
    origin: &str,
    allow_local_network: bool,
    mut approved_addresses: Vec<String>,
    mut capabilities: Vec<Capability>,
    routes: Vec<Route>,
    entities: Vec<Entity>,
    evidence: Vec<Evidence>,
) -> Result<CapabilityPackage, String> {
    approved_addresses.sort();
    approved_addresses.dedup();
    normalize_tool_names(origin, &mut capabilities);
    for capability in &capabilities {
        validate_schema(&capability.input_schema)?;
        validate_schema(&capability.output_schema)?;
    }
    let risk_profile = RiskProfile {
        default_risk: "disabled".to_string(),
        disabled_classes: vec![
            "purchase".to_string(),
            "regulated".to_string(),
            "unknown".to_string(),
        ],
        unknown_behavior: "disabled_until_reviewed".to_string(),
        write_ownership_required: true,
    };
    let material = serde_json::json!({"targetOrigin":origin,"compilerVersion":COMPILER_VERSION,"capabilities":capabilities,"routes":routes,"entities":entities,"riskProfile":risk_profile,"evidence":evidence,"permissions":["network:origin-bound"],"networkScope":{"origin":origin,"sameOriginRedirectsOnly":true,"allowLocalNetwork":allow_local_network,"approvedAddresses":approved_addresses,"maxRedirects":3},"credentialRequirements":[],"dataFlowMetadata":{"untrustedContentIsData":true,"sanitization":"fail-closed"}});
    let content_hash = value_hash(&material);
    let drift_fingerprint = value_hash(
        &serde_json::json!({"origin":origin,"capabilities":material["capabilities"],"routes":material["routes"],"evidence":material["evidence"]}),
    );
    let package_id = format!("pkg_{}", &content_hash[..20]);
    let tests = vec![
        serde_json::json!({"name":"unknown-field","expected":"reject"}),
        serde_json::json!({"name":"origin-escape","expected":"reject"}),
        serde_json::json!({"name":"redirect-attempt","expected":"reject"}),
        serde_json::json!({"name":"credential-redirect","expected":"reject"}),
    ];
    Ok(CapabilityPackage {
        package_id,
        name: package_namespace(origin),
        version: "0.2.0".to_string(),
        target_origin: origin.to_string(),
        created_at: Utc::now().to_rfc3339(),
        compiler_version: COMPILER_VERSION.to_string(),
        capabilities,
        routes,
        entities,
        risk_profile,
        evidence,
        permissions: vec!["network:origin-bound".to_string()],
        network_scope: NetworkScope {
            origin: origin.to_string(),
            same_origin_redirects_only: true,
            allow_local_network,
            approved_addresses,
            max_redirects: 3,
        },
        credential_requirements: vec![],
        data_flow_metadata: serde_json::json!({"untrustedContentIsData":true,"sanitization":"fail-closed","rawSecrets":false}),
        drift_fingerprint,
        content_hash: content_hash.clone(),
        manifest: PackageManifest {
            format_version: "1".to_string(),
            content_hash,
            compiler_version: COMPILER_VERSION.to_string(),
            declarative_only: true,
        },
        tests,
    })
}

pub fn bind_approved_network_addresses(
    package: &CapabilityPackage,
    addresses: &[String],
) -> Result<CapabilityPackage, String> {
    if !package.network_scope.allow_local_network || addresses.is_empty() {
        return Err("LOCAL_NETWORK_APPROVAL_REQUIRED".to_string());
    }
    let mut approved = addresses
        .iter()
        .map(|address| {
            address
                .parse::<IpAddr>()
                .map_err(|_| "INVALID_APPROVED_ADDRESS".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if approved.iter().copied().any(is_metadata_ip) {
        return Err("CLOUD_METADATA_TARGET_REJECTED".to_string());
    }
    if approved.iter().copied().any(is_unroutable_ip)
        || approved
            .iter()
            .copied()
            .any(|address| !is_private_or_local_ip(address))
    {
        return Err("SSRF_TARGET_REJECTED".to_string());
    }
    approved.sort();
    approved.dedup();
    build_package_with_approved_addresses(
        &package.target_origin,
        true,
        approved
            .into_iter()
            .map(|address| address.to_string())
            .collect(),
        package.capabilities.clone(),
        package.routes.clone(),
        package.entities.clone(),
        package.evidence.clone(),
    )
}

pub fn verify_package_hash(package: &CapabilityPackage) -> Result<(), String> {
    let rebuilt = build_package_with_approved_addresses(
        &package.target_origin,
        package.network_scope.allow_local_network,
        package.network_scope.approved_addresses.clone(),
        package.capabilities.clone(),
        package.routes.clone(),
        package.entities.clone(),
        package.evidence.clone(),
    )?;
    if rebuilt.content_hash != package.content_hash
        || package.manifest.content_hash != package.content_hash
        || rebuilt.package_id != package.package_id
        || rebuilt.name != package.name
        || rebuilt.version != package.version
        || rebuilt.compiler_version != package.compiler_version
        || rebuilt.manifest != package.manifest
        || rebuilt.permissions != package.permissions
        || rebuilt.network_scope != package.network_scope
        || rebuilt.credential_requirements != package.credential_requirements
        || rebuilt.data_flow_metadata != package.data_flow_metadata
        || rebuilt.drift_fingerprint != package.drift_fingerprint
        || rebuilt.tests != package.tests
    {
        Err("CAPABILITY_PACKAGE_TAMPERED".to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::json!({"openapi":"3.0.3","paths":{"/shipments":{"get":{"operationId":"getShipments","summary":"Get shipments","responses":{"200":{"content":{"application/json":{"schema":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"}}}}}}}}}},"/delivery/{id}":{"patch":{"operationId":"rescheduleDelivery","parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}}],"requestBody":{"content":{"application/json":{"schema":{"type":"object","required":["date"],"properties":{"date":{"type":"string","minLength":10}}}}}},"responses":{"200":{"content":{"application/json":{"schema":{"type":"object","properties":{"ok":{"type":"boolean"}}}}}}}}}}})
    }
    #[test]
    fn compiles_openapi_reads_and_governed_writes() {
        let package =
            compile_openapi(&fixture(), "http://localhost:4321/openapi.json", true).unwrap();
        assert_eq!(package.capabilities.len(), 2);
        assert!(package
            .capabilities
            .iter()
            .any(|c| c.method == "GET" && c.enabled && !c.approval_required));
        assert!(package
            .capabilities
            .iter()
            .any(|c| c.method == "PATCH" && c.approval_required));
        verify_package_hash(&package).unwrap();
    }
    #[test]
    fn rejects_external_refs() {
        let mut doc = fixture();
        doc["paths"]["/shipments"]["get"]["parameters"] =
            serde_json::json!([{"$ref":"https://attacker.example/p.json"}]);
        assert!(compile_openapi(&doc, "https://shipping.example/openapi.json", false).is_err());
    }
    #[test]
    fn extracts_forms_as_reviewed_candidates() {
        let p=compile_html_forms("<form action='/submit' method='post'><input name='email' required><input type='password' name='password'></form>","https://shipping.example",false).unwrap();
        assert_eq!(p.capabilities.len(), 1);
        assert!(!p.capabilities[0].enabled);
        assert!(!p.capabilities[0]
            .input_schema
            .to_string()
            .contains("password"));
    }
    #[test]
    fn har_evidence_is_redacted() {
        let har = serde_json::json!({"log":{"entries":[{"request":{"method":"GET","url":"https://shipping.example/shipments?x=1","headers":[{"name":"Authorization","value":"Bearer test-secret-value"}]},"response":{"content":{"text":"{\"token\":\"test-secret-value\"}"}}}]}});
        let p = compile_har(&har, "https://shipping.example", false).unwrap();
        assert!(!serde_json::to_string(&p.evidence)
            .unwrap()
            .contains("test-secret-value"));
        assert!(p.capabilities[0].auth_required);
        assert!(!p.capabilities[0].enabled);
    }

    #[test]
    fn compiles_graphql_queries_and_gates_mutations() {
        let document = serde_json::json!({"data":{"__schema":{"queryType":{"name":"Query"},"mutationType":{"name":"Mutation"},"types":[
          {"name":"Query","fields":[{"name":"shipments","args":[{"name":"state","type":{"kind":"SCALAR","name":"String"}}],"type":{"kind":"LIST","ofType":{"kind":"OBJECT","name":"Shipment"}}}]},
          {"name":"Mutation","fields":[{"name":"reschedule","args":[{"name":"id","type":{"kind":"NON_NULL","ofType":{"kind":"SCALAR","name":"ID"}}}],"type":{"kind":"SCALAR","name":"Boolean"}}]}
        ]}}});
        let package =
            compile_graphql_introspection(&document, "https://shipping.example/graphql", false)
                .unwrap();
        let query = package
            .capabilities
            .iter()
            .find(|item| item.tags.contains(&"query".to_string()))
            .unwrap();
        let mutation = package
            .capabilities
            .iter()
            .find(|item| item.tags.contains(&"mutation".to_string()))
            .unwrap();
        assert!(query.enabled);
        assert!(!query.approval_required);
        assert!(query.metadata.to_string().contains("IrisFoundry"));
        assert!(mutation.approval_required);
        assert!(mutation.enabled);
    }

    #[test]
    fn observed_graphql_is_classified_but_not_executable() {
        let har = serde_json::json!({"log":{"entries":[{"request":{"method":"POST","url":"https://shipping.example/graphql","headers":[],"postData":{"text":"{\"query\":\"mutation Change { change }\"}"}},"response":{"content":{"text":"{}"}}}]}});
        let package = compile_har(&har, "https://shipping.example", false).unwrap();
        let capability = &package.capabilities[0];
        assert!(capability.tags.contains(&"graphql".to_string()));
        assert!(capability.tags.contains(&"mutation".to_string()));
        assert_eq!(capability.risk_level, "high");
        assert!(!capability.enabled);
    }

    #[test]
    fn generated_names_use_reserved_namespace_and_deterministic_collision_suffixes() {
        let document = serde_json::json!({"openapi":"3.0.0","paths":{
            "/one":{"get":{"operationId":"get-users","responses":{"200":{"description":"ok"}}}},
            "/two":{"get":{"operationId":"get_users","responses":{"200":{"description":"ok"}}}},
            "/long":{"get":{"operationId":"ThisOperationNameIsIntentionallyFarLongerThanAnyProviderSafeToolNameLimitAndMustBeHashed","responses":{"200":{"description":"ok"}}}}
        }});
        let first =
            compile_openapi(&document, "https://shipping.example/openapi.json", false).unwrap();
        let second =
            compile_openapi(&document, "https://shipping.example/openapi.json", false).unwrap();
        let first_names: Vec<&str> = first
            .capabilities
            .iter()
            .map(|item| item.tool_name.as_str())
            .collect();
        let second_names: Vec<&str> = second
            .capabilities
            .iter()
            .map(|item| item.tool_name.as_str())
            .collect();
        assert_eq!(first_names, second_names);
        assert_eq!(first_names.iter().collect::<BTreeSet<_>>().len(), 3);
        assert!(first_names
            .iter()
            .all(|name| name.starts_with("foundry_shipping_example_")));
        assert!(first_names
            .iter()
            .all(|name| name.len() <= MAX_FOUNDRY_TOOL_NAME));
        assert!(
            first_names
                .iter()
                .filter(|name| name.contains("get_users_"))
                .count()
                == 2
        );
        assert!(first_names
            .iter()
            .all(|name| !matches!(*name, "read_file" | "delete_file")));
    }

    #[test]
    fn openapi_semantics_raise_consequential_get_risk_with_evidence() {
        let document = serde_json::json!({"openapi":"3.0.0","paths":{
            "/action":{"get":{"operationId":"doThing","summary":"Trigger deployment","responses":{"200":{"description":"ok"}}}}
        }});
        let package =
            compile_openapi(&document, "https://shipping.example/openapi.json", false).unwrap();
        let capability = &package.capabilities[0];
        assert_eq!(capability.risk_level, "high");
        assert!(capability.approval_required);
        assert!(capability.tags.contains(&"semantic-action".to_string()));
        assert!(capability
            .metadata
            .to_string()
            .contains("semantic_action:trigger"));
    }

    #[test]
    fn documented_fixture_names_match_compiler_output() {
        let document = serde_json::json!({"openapi":"3.0.3","paths":{
            "/shipments":{"get":{"operationId":"getShipments","responses":{"200":{"description":"ok"}}}},
            "/delivery-options":{"get":{"operationId":"getDeliveryOptions","responses":{"200":{"description":"ok"}}}},
            "/delivery/{id}":{"patch":{"operationId":"rescheduleDelivery","parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}}],"responses":{"200":{"description":"ok"}}}}
        }});
        let package =
            compile_openapi(&document, "http://localhost:4319/openapi.json", true).unwrap();
        let names = package
            .capabilities
            .iter()
            .map(|capability| capability.tool_name.as_str())
            .collect::<BTreeSet<_>>();
        let expected = BTreeSet::from([
            "foundry_localhost_getshipments",
            "foundry_localhost_getdeliveryoptions",
            "foundry_localhost_rescheduledelivery",
        ]);
        assert_eq!(names, expected);
        let documentation = include_str!("../../../docs/CAPABILITY_FOUNDRY.md");
        for name in expected {
            assert!(documentation.contains(name), "documentation missing {name}");
        }
    }
}
