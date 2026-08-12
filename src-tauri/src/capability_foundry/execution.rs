use super::compiler::value_hash;
use super::models::*;
use super::origin::{
    enforce_same_origin, resolve_and_validate_approved, validate_execution_origin,
};
use super::sanitizer::sanitize_bytes;
use super::schema::validate_instance;
use super::storage;
use lazy_static::lazy_static;
use reqwest::{Method, StatusCode, Url};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const APPROVAL_TTL_SECONDS: u64 = 90;
const MAX_RESPONSE_BYTES: usize = 1_048_576;

#[derive(Debug, Clone)]
struct BoundApproval {
    request_hash: String,
    expires_at: u64,
}

#[derive(Debug, Clone)]
pub struct ApprovalPreview {
    pub package: CapabilityPackage,
    pub capability: Capability,
    pub expires_at: u64,
}

lazy_static! {
    static ref APPROVALS: Mutex<HashMap<String, BoundApproval>> = Mutex::new(HashMap::new());
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn approval_material(
    package: &CapabilityPackage,
    capability: &Capability,
    arguments: &Value,
) -> Value {
    serde_json::json!({"packageId":package.package_id,"capabilityId":capability.id,"packageHash":package.content_hash,"method":capability.method,"endpoint":capability.endpoint,"argumentsHash":value_hash(arguments),"targetOrigin":package.target_origin,"risk":capability.risk_level})
}

pub fn preview_approval(
    root: &Path,
    request: &CapabilityApprovalRequest,
) -> Result<ApprovalPreview, String> {
    if request.request_id.trim().is_empty() {
        return Err("REQUEST_ID_REQUIRED".to_string());
    }
    let package = storage::load_installed_package(root, &request.package_id)?;
    let capability = package
        .capabilities
        .iter()
        .find(|item| item.id == request.capability_id)
        .cloned()
        .ok_or_else(|| "CAPABILITY_NOT_FOUND".to_string())?;
    if !capability.enabled {
        return Err("CAPABILITY_DISABLED".to_string());
    }
    validate_instance(&capability.input_schema, &request.arguments)?;
    if !capability.approval_required {
        return Err("CAPABILITY_DOES_NOT_REQUIRE_APPROVAL".to_string());
    }
    Ok(ApprovalPreview {
        package,
        capability,
        expires_at: now() + APPROVAL_TTL_SECONDS,
    })
}

pub fn issue_approval(
    request: &CapabilityApprovalRequest,
    preview: &ApprovalPreview,
    human_approved: bool,
) -> CapabilityApprovalResponse {
    if !human_approved {
        return CapabilityApprovalResponse {
            approved: false,
            approval_id: None,
            expires_at: None,
        };
    }
    let id = uuid::Uuid::new_v4().to_string();
    let request_hash = value_hash(&approval_material(
        &preview.package,
        &preview.capability,
        &request.arguments,
    ));
    APPROVALS.lock().unwrap().insert(
        id.clone(),
        BoundApproval {
            request_hash,
            expires_at: preview.expires_at,
        },
    );
    CapabilityApprovalResponse {
        approved: true,
        approval_id: Some(id),
        expires_at: Some(preview.expires_at),
    }
}

fn consume_approval(
    package: &CapabilityPackage,
    capability: &Capability,
    arguments: &Value,
    id: Option<&str>,
) -> Result<(), String> {
    if !capability.approval_required {
        return Ok(());
    }
    let id = id.ok_or_else(|| "APPROVAL_REQUIRED".to_string())?;
    let approval = APPROVALS
        .lock()
        .unwrap()
        .remove(id)
        .ok_or_else(|| "APPROVAL_INVALID_OR_ALREADY_CONSUMED".to_string())?;
    if approval.expires_at < now() {
        return Err("APPROVAL_EXPIRED".to_string());
    }
    let expected = value_hash(&approval_material(package, capability, arguments));
    if approval.request_hash != expected {
        return Err("APPROVAL_NOT_BOUND_TO_REQUEST".to_string());
    }
    Ok(())
}

fn argument_text(value: &Value, name: &str) -> Result<String, String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Number(number) => Ok(number.to_string()),
        Value::Bool(flag) => Ok(flag.to_string()),
        _ => Err(format!("PATH_OR_QUERY_ARGUMENT_MUST_BE_SCALAR:{name}")),
    }
}

fn build_request(
    package: &CapabilityPackage,
    capability: &Capability,
    route: &Route,
    arguments: &Value,
) -> Result<(Url, Option<Value>), String> {
    let origin = validate_execution_origin(
        &package.target_origin,
        package.network_scope.allow_local_network,
        &package.network_scope.approved_addresses,
    )?;
    let args = arguments
        .as_object()
        .ok_or_else(|| "CAPABILITY_ARGUMENTS_MUST_BE_OBJECT".to_string())?;
    let endpoint = if capability.endpoint.starts_with("http://")
        || capability.endpoint.starts_with("https://")
    {
        let parsed = Url::parse(&capability.endpoint)
            .map_err(|_| "CAPABILITY_ENDPOINT_INVALID".to_string())?;
        enforce_same_origin(&origin, &parsed)?;
        parsed
    } else {
        origin
            .url
            .join(capability.endpoint.trim_start_matches('/'))
            .map_err(|_| "CAPABILITY_ENDPOINT_INVALID".to_string())?
    };
    enforce_same_origin(&origin, &endpoint)?;
    let mut url = origin.url.clone();
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "CAPABILITY_ENDPOINT_INVALID".to_string())?;
        segments.clear();
        for segment in endpoint
            .path()
            .trim_start_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
        {
            if segment.starts_with('{') && segment.ends_with('}') && segment.len() > 2 {
                let name = &segment[1..segment.len() - 1];
                if !route.path_parameters.iter().any(|item| item == name) {
                    return Err("UNDECLARED_PATH_PARAMETER".to_string());
                }
                segments.push(&argument_text(
                    args.get(name)
                        .ok_or_else(|| format!("MISSING_PATH_PARAMETER:{name}"))?,
                    name,
                )?);
            } else if segment.contains('{') || segment.contains('}') || segment.starts_with("//") {
                return Err("UNSAFE_ENDPOINT_TEMPLATE".to_string());
            } else {
                segments.push(segment);
            }
        }
    }
    {
        let mut query = url.query_pairs_mut();
        for name in &route.query_parameters {
            if let Some(value) = args.get(name) {
                query.append_pair(name, &argument_text(value, name)?);
            }
        }
    }
    let mut body = Map::new();
    if let Some(document) = capability
        .metadata
        .pointer("/graphql/document")
        .and_then(Value::as_str)
    {
        body.insert("query".to_string(), Value::String(document.to_string()));
        body.insert("variables".to_string(), Value::Object(args.clone()));
    } else {
        for name in &route.body_fields {
            if let Some(value) = args.get(name) {
                body.insert(name.clone(), value.clone());
            }
        }
    }
    Ok((url, (!body.is_empty()).then_some(Value::Object(body))))
}

fn status_is_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

pub async fn execute(root: &Path, request: CapabilityExecutionRequest) -> Result<Value, String> {
    let records = storage::list_installed(root)?;
    let record = records
        .iter()
        .find(|item| item.package_id == request.package_id)
        .ok_or_else(|| "CAPABILITY_PACKAGE_NOT_INSTALLED".to_string())?;
    if record.tampered {
        return Err("CAPABILITY_PACKAGE_TAMPERED".to_string());
    }
    if !record.enabled {
        return Err("CAPABILITY_PACKAGE_DISABLED".to_string());
    }
    let package = storage::load_installed_package(root, &request.package_id)?;
    let capability = package
        .capabilities
        .iter()
        .find(|item| item.id == request.capability_id)
        .ok_or_else(|| "CAPABILITY_NOT_FOUND".to_string())?;
    if !capability.enabled {
        return Err("CAPABILITY_DISABLED".to_string());
    }
    if capability.risk_level == "critical" {
        return Err("CAPABILITY_CLASS_DISABLED".to_string());
    }
    if capability.auth_required || capability.credential_handle.is_some() {
        return Err("SECURE_CREDENTIAL_STORAGE_NOT_CONFIGURED".to_string());
    }
    validate_instance(&capability.input_schema, &request.arguments)?;
    let route = package
        .routes
        .iter()
        .find(|item| item.capability_id == capability.id)
        .ok_or_else(|| "CAPABILITY_ROUTE_NOT_FOUND".to_string())?;
    if route.method != capability.method {
        return Err("CAPABILITY_METHOD_MISMATCH".to_string());
    }
    consume_approval(
        &package,
        capability,
        &request.arguments,
        request.approval_id.as_deref(),
    )?;
    let (mut url, body) = build_request(&package, capability, route, &request.arguments)?;
    let origin = validate_execution_origin(
        &package.target_origin,
        package.network_scope.allow_local_network,
        &package.network_scope.approved_addresses,
    )?;
    let method = Method::from_bytes(capability.method.as_bytes())
        .map_err(|_| "CAPABILITY_METHOD_INVALID".to_string())?;
    let mut redirect_count = 0u8;
    let response = loop {
        enforce_same_origin(&origin, &url)?;
        let addresses =
            resolve_and_validate_approved(&origin, &package.network_scope.approved_addresses)
                .await?;
        let host = origin
            .url
            .host_str()
            .ok_or_else(|| "TARGET_HOST_REQUIRED".to_string())?;
        let port = origin
            .url
            .port_or_known_default()
            .ok_or_else(|| "TARGET_PORT_REQUIRED".to_string())?;
        let pinned = SocketAddr::new(addresses[0], port);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .user_agent("IRIS-Capability-Foundry/0.2")
            .resolve(host, pinned)
            .build()
            .map_err(|_| "CAPABILITY_HTTP_CLIENT_FAILED".to_string())?;
        let mut builder = client
            .request(method.clone(), url.clone())
            .header("accept", "application/json, text/plain;q=0.9");
        if let Some(value) = &body {
            builder = builder.json(value)
        }
        let candidate = builder
            .send()
            .await
            .map_err(|_| "CAPABILITY_NETWORK_REQUEST_FAILED".to_string())?;
        if !status_is_redirect(candidate.status()) {
            break candidate;
        }
        if redirect_count >= package.network_scope.max_redirects {
            return Err("REDIRECT_LIMIT_EXCEEDED".to_string());
        }
        if !matches!(method, Method::GET | Method::HEAD)
            && matches!(candidate.status().as_u16(), 301..=303)
        {
            return Err("WRITE_REDIRECT_METHOD_CHANGE_REJECTED".to_string());
        }
        let location = candidate
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| "REDIRECT_LOCATION_INVALID".to_string())?;
        let next = url
            .join(location)
            .map_err(|_| "REDIRECT_LOCATION_INVALID".to_string())?;
        enforce_same_origin(&origin, &next)?;
        url = next;
        redirect_count += 1;
    };
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|size| size as usize > MAX_RESPONSE_BYTES)
    {
        return Err("RESPONSE_SIZE_LIMIT_EXCEEDED".to_string());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if let Some(kind) = &content_type {
        let lower = kind.to_ascii_lowercase();
        if !(lower.contains("json") || lower.starts_with("text/")) {
            return Err("UNSUPPORTED_RESPONSE_CONTENT_TYPE".to_string());
        }
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "CAPABILITY_RESPONSE_READ_FAILED".to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("RESPONSE_SIZE_LIMIT_EXCEEDED".to_string());
    }
    let sanitized = sanitize_bytes(&bytes, content_type.as_deref())?;
    storage::append_history(
        root,
        "capability_executed",
        Some(&package.package_id),
        Some(&capability.id),
        serde_json::json!({"packageHash":package.content_hash,"origin":package.target_origin,"method":capability.method,"endpointTemplate":capability.endpoint,"risk":capability.risk_level,"approvalRequired":capability.approval_required,"executionResult":status.as_u16()}),
    )?;
    Ok(
        serde_json::json!({"status":status.as_u16(),"ok":status.is_success(),"data":sanitized,"classification":capability.data_classification,"untrustedContent":true,"sanitized":true}),
    )
}

#[cfg(test)]
mod tests {
    use super::super::compiler::{bind_approved_network_addresses, compile_openapi};
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    fn root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "iris-foundry-exec-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    fn write_package() -> (PathBuf, CapabilityPackage) {
        let root = root();
        let p=compile_openapi(&serde_json::json!({"openapi":"3.0.0","paths":{"/delivery/{id}":{"patch":{"operationId":"rescheduleDelivery","parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}}],"requestBody":{"content":{"application/json":{"schema":{"type":"object","required":["date"],"properties":{"date":{"type":"string"}}}}}},"responses":{"200":{"description":"ok"}}}}}}),"http://localhost:4567/openapi.json",true).unwrap();
        let p = bind_approved_network_addresses(&p, &["127.0.0.1".to_string()]).unwrap();
        storage::save_candidate(&root, &p).unwrap();
        let final_package =
            storage::prepare_final_install_package(&root, &p, &[p.capabilities[0].id.clone()])
                .unwrap();
        let binding = storage::install_approval_binding(&final_package).unwrap();
        let installed =
            storage::persist_approved_package(&root, &final_package, &binding, true).unwrap();
        let package = storage::load_installed_package(&root, &installed.package_id).unwrap();
        (root, package)
    }
    #[tokio::test]
    async fn exact_approval_is_single_use_and_argument_bound() {
        let (root, p) = write_package();
        let c = &p.capabilities[0];
        let request = CapabilityApprovalRequest {
            request_id: "one".to_string(),
            package_id: p.package_id.clone(),
            capability_id: c.id.clone(),
            arguments: serde_json::json!({"id":"1","date":"2030-01-01"}),
        };
        let preview = preview_approval(&root, &request).unwrap();
        let approval = issue_approval(&request, &preview, true);
        let id = approval.approval_id.unwrap();
        assert!(consume_approval(&p, c, &request.arguments, Some(&id)).is_ok());
        assert!(consume_approval(&p, c, &request.arguments, Some(&id)).is_err());
        let preview = preview_approval(&root, &request).unwrap();
        let id = issue_approval(&request, &preview, true)
            .approval_id
            .unwrap();
        assert!(consume_approval(
            &p,
            c,
            &serde_json::json!({"id":"2","date":"2030-01-01"}),
            Some(&id)
        )
        .is_err());
        let preview = preview_approval(&root, &request).unwrap();
        let id = issue_approval(&request, &preview, true)
            .approval_id
            .unwrap();
        let mut other = c.clone();
        other.id = "cap_other_tool".to_string();
        assert_eq!(
            consume_approval(&p, &other, &request.arguments, Some(&id)).unwrap_err(),
            "APPROVAL_NOT_BOUND_TO_REQUEST"
        );
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn endpoint_arguments_cannot_escape_origin() {
        let (_, p) = write_package();
        let c = &p.capabilities[0];
        let route = &p.routes[0];
        let (url, _) = build_request(
            &p,
            c,
            route,
            &serde_json::json!({"id":"//attacker.example/%2f","date":"x"}),
        )
        .unwrap();
        assert_eq!(url.host_str(), Some("localhost"));
        assert!(!url.as_str().contains("attacker.example/%2f"));
    }
}
