use lazy_static::lazy_static;
use regex::Regex;
use serde_json::Value;

const MAX_SANITIZED_BYTES: usize = 1_048_576;

lazy_static! {
    static ref BEARER: Regex = Regex::new(r#"(?i)bearer\s+[^\s,;"']+"#).unwrap();
    static ref KEY_VALUE: Regex = Regex::new(r#"(?i)(api[_-]?key|client[_-]?secret|password|refresh[_-]?token|access[_-]?token|authorization|cookie|session)\s*[:=]\s*[\"']?[^\s,;\"']+"#).unwrap();
    static ref SIMPLE_SECRET: Regex = Regex::new(r"(?i)\b(token|api[_-]?key|apikey|password|secret|session|cookie|authorization)=[^&\s,;]+" ).unwrap();
    static ref CREDENTIAL_URL: Regex = Regex::new(r"(?i)https?://[^\s/@:]+:[^\s/@]+@").unwrap();
    static ref PRIVATE_KEY: Regex = Regex::new(r"(?s)-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----").unwrap();
    static ref EMAIL: Regex = Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b").unwrap();
    static ref PHONE: Regex = Regex::new(r"(?x)\b(?:\+?1[-.\s]?)?\(?[2-9][0-9]{2}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b").unwrap();
}

fn sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace('-', "_");
    [
        "authorization",
        "cookie",
        "set_cookie",
        "password",
        "passwd",
        "secret",
        "token",
        "access_token",
        "refresh_token",
        "api_key",
        "apikey",
        "csrf",
        "session",
        "private_key",
        "email",
        "phone",
    ]
    .iter()
    .any(|needle| normalized == *needle || normalized.ends_with(&format!("_{needle}")))
}

pub fn sanitize_text(input: &str) -> Result<String, String> {
    if input.len() > MAX_SANITIZED_BYTES {
        return Err("SANITIZATION_FAILED: response exceeds safe size".to_string());
    }
    let mut output = PRIVATE_KEY
        .replace_all(input, "[REDACTED PRIVATE KEY]")
        .into_owned();
    output = BEARER
        .replace_all(&output, "Bearer [REDACTED]")
        .into_owned();
    output = KEY_VALUE.replace_all(&output, "$1=[REDACTED]").into_owned();
    output = SIMPLE_SECRET
        .replace_all(&output, "$1=[REDACTED]")
        .into_owned();
    output = CREDENTIAL_URL
        .replace_all(&output, "https://[REDACTED]@")
        .into_owned();
    output = EMAIL.replace_all(&output, "[REDACTED EMAIL]").into_owned();
    output = PHONE.replace_all(&output, "[REDACTED PHONE]").into_owned();
    Ok(output)
}

pub fn sanitize_json(value: &Value) -> Result<Value, String> {
    sanitize_json_at(value, 0)
}

fn sanitize_json_at(value: &Value, depth: usize) -> Result<Value, String> {
    if depth > 24 {
        return Err("SANITIZATION_FAILED: nesting limit exceeded".to_string());
    }
    match value {
        Value::Object(map) => {
            let mut output = serde_json::Map::new();
            for (key, child) in map {
                if sensitive_key(key) {
                    output.insert(key.clone(), Value::String("[REDACTED]".to_string()));
                    if key.eq_ignore_ascii_case("authorization") {
                        output.insert("authorization_present".to_string(), Value::Bool(true));
                    }
                } else {
                    output.insert(key.clone(), sanitize_json_at(child, depth + 1)?);
                }
            }
            Ok(Value::Object(output))
        }
        Value::Array(items) => Ok(Value::Array(
            items
                .iter()
                .map(|item| sanitize_json_at(item, depth + 1))
                .collect::<Result<Vec<_>, _>>()?,
        )),
        Value::String(text) => Ok(Value::String(sanitize_text(text)?)),
        _ => Ok(value.clone()),
    }
}

pub fn sanitize_bytes(bytes: &[u8], content_type: Option<&str>) -> Result<Value, String> {
    if bytes.len() > MAX_SANITIZED_BYTES {
        return Err("SANITIZATION_FAILED: response exceeds safe size".to_string());
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "SANITIZATION_FAILED: response is not UTF-8".to_string())?;
    if content_type.is_some_and(|kind| kind.to_ascii_lowercase().contains("json")) {
        let value: Value = serde_json::from_str(text)
            .map_err(|_| "SANITIZATION_FAILED: invalid JSON response".to_string())?;
        sanitize_json(&value)
    } else {
        Ok(Value::String(sanitize_text(text)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_observed_credentials_and_private_keys() {
        let value = serde_json::json!({
            "Authorization":"Bearer test-secret-value",
            "Cookie":"session=test-secret",
            "nested":{"api_key":"test-secret","password":"test-secret"},
            "text":"token=test-secret Bearer test-secret-value https://user:pass@example.test/a"
        });
        let output = sanitize_json(&value).unwrap().to_string();
        assert!(!output.contains("test-secret"), "{output}");
        assert!(!output.contains("user:pass"));
        assert!(output.contains("REDACTED"));
    }

    #[test]
    fn sanitizer_fails_closed_on_oversize_or_invalid_utf8() {
        assert!(sanitize_bytes(&vec![b'x'; MAX_SANITIZED_BYTES + 1], None).is_err());
        assert!(sanitize_bytes(&[0xff, 0xfe], None).is_err());
    }
}
