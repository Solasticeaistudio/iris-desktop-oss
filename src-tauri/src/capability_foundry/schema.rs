use serde_json::{Map, Value};
use std::collections::BTreeSet;

const ALLOWED_KEYWORDS: &[&str] = &[
    "$schema",
    "type",
    "description",
    "properties",
    "required",
    "items",
    "enum",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "pattern",
    "additionalProperties",
    "default",
    "title",
    "format",
    "nullable",
];

pub fn validate_schema(schema: &Value) -> Result<(), String> {
    validate_schema_at(schema, 0)
}

fn validate_schema_at(schema: &Value, depth: usize) -> Result<(), String> {
    if depth > 12 {
        return Err("SCHEMA_DEPTH_EXCEEDED".to_string());
    }
    let obj = schema
        .as_object()
        .ok_or_else(|| "Schema must be an object".to_string())?;
    for key in obj.keys() {
        if !ALLOWED_KEYWORDS.contains(&key.as_str()) {
            return Err(format!("UNSUPPORTED_SCHEMA_KEYWORD:{key}"));
        }
    }
    let kind = obj.get("type").and_then(Value::as_str).unwrap_or("object");
    if ![
        "object", "array", "string", "number", "integer", "boolean", "null",
    ]
    .contains(&kind)
    {
        return Err(format!("UNSUPPORTED_SCHEMA_TYPE:{kind}"));
    }
    if let Some(properties) = obj.get("properties") {
        let properties = properties
            .as_object()
            .ok_or_else(|| "properties must be an object".to_string())?;
        for child in properties.values() {
            validate_schema_at(child, depth + 1)?;
        }
    }
    if let Some(items) = obj.get("items") {
        validate_schema_at(items, depth + 1)?;
    }
    if let Some(required) = obj.get("required") {
        let values = required
            .as_array()
            .ok_or_else(|| "required must be an array".to_string())?;
        if values.iter().any(|item| !item.is_string()) {
            return Err("required entries must be strings".to_string());
        }
    }
    if let Some(additional) = obj.get("additionalProperties") {
        if !additional.is_boolean() {
            return Err("additionalProperties must be boolean".to_string());
        }
    }
    if let Some(pattern) = obj.get("pattern") {
        regex::Regex::new(
            pattern
                .as_str()
                .ok_or_else(|| "pattern must be a string".to_string())?,
        )
        .map_err(|_| "Invalid schema pattern".to_string())?;
    }
    Ok(())
}

pub fn validate_instance(schema: &Value, value: &Value) -> Result<(), String> {
    validate_instance_at(schema, value, "$", 0)
}

fn validate_instance_at(
    schema: &Value,
    value: &Value,
    path: &str,
    depth: usize,
) -> Result<(), String> {
    if depth > 20 {
        return Err("INSTANCE_DEPTH_EXCEEDED".to_string());
    }
    let obj = schema
        .as_object()
        .ok_or_else(|| "Schema must be an object".to_string())?;
    if value.is_null() && obj.get("nullable").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    let kind = obj.get("type").and_then(Value::as_str).unwrap_or("object");
    let type_ok = match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.as_f64().is_some(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => false,
    };
    if !type_ok {
        return Err(format!("{path}: expected {kind}"));
    }
    if let Some(allowed) = obj.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            return Err(format!("{path}: value is not in enum"));
        }
    }
    if let Some(number) = value.as_f64() {
        if let Some(minimum) = obj.get("minimum").and_then(Value::as_f64) {
            if number < minimum {
                return Err(format!("{path}: below minimum"));
            }
        }
        if let Some(maximum) = obj.get("maximum").and_then(Value::as_f64) {
            if number > maximum {
                return Err(format!("{path}: above maximum"));
            }
        }
    }
    if let Some(text) = value.as_str() {
        let len = text.chars().count() as u64;
        if obj
            .get("minLength")
            .and_then(Value::as_u64)
            .is_some_and(|min| len < min)
        {
            return Err(format!("{path}: shorter than minLength"));
        }
        if obj
            .get("maxLength")
            .and_then(Value::as_u64)
            .is_some_and(|max| len > max)
        {
            return Err(format!("{path}: longer than maxLength"));
        }
        if let Some(pattern) = obj.get("pattern").and_then(Value::as_str) {
            if !regex::Regex::new(pattern)
                .map_err(|_| "Invalid schema pattern".to_string())?
                .is_match(text)
            {
                return Err(format!("{path}: pattern mismatch"));
            }
        }
    }
    if let Some(values) = value.as_array() {
        if let Some(items) = obj.get("items") {
            for (index, item) in values.iter().enumerate() {
                validate_instance_at(items, item, &format!("{path}[{index}]"), depth + 1)?;
            }
        }
    }
    if let Some(values) = value.as_object() {
        let properties = obj
            .get("properties")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let required: BTreeSet<&str> = obj
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        for name in required {
            if !values.contains_key(name) {
                return Err(format!("{path}: missing required property {name}"));
            }
        }
        if obj.get("additionalProperties").and_then(Value::as_bool) == Some(false) {
            for name in values.keys() {
                if !properties.contains_key(name) {
                    return Err(format!("{path}: unknown property {name}"));
                }
            }
        }
        for (name, child_schema) in properties {
            if let Some(child) = values.get(&name) {
                validate_instance_at(&child_schema, child, &format!("{path}.{name}"), depth + 1)?;
            }
        }
    }
    Ok(())
}

pub fn object_schema(properties: Map<String, Value>, required: Vec<String>) -> Value {
    serde_json::json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_supported_schema_subset() {
        let schema = serde_json::json!({
            "type":"object","properties":{"state":{"type":"string","enum":["new","done"]}},
            "required":["state"],"additionalProperties":false
        });
        validate_schema(&schema).unwrap();
        validate_instance(&schema, &serde_json::json!({"state":"new"})).unwrap();
        assert!(validate_instance(&schema, &serde_json::json!({"state":"bad"})).is_err());
        assert!(validate_instance(&schema, &serde_json::json!({"state":"new","x":1})).is_err());
        assert!(validate_schema(&serde_json::json!({"oneOf":[]})).is_err());
    }
}
