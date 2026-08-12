use super::compiler::{
    bind_approved_network_addresses, compile_html_forms, compile_openapi, value_hash,
};
use super::models::{DiscoveryGrant, DiscoveryResult};
use super::origin::{
    is_metadata_ip, is_private_or_local_ip, is_unroutable_ip, parse_origin, resolve,
    ValidatedOrigin,
};
use reqwest::{StatusCode, Url};
use serde_json::Value;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_DISCOVERY_BYTES: usize = 2_000_000;
pub const MAX_DISCOVERY_REQUESTS: usize = 10;
pub const DISCOVERY_GRANT_SECONDS: u64 = 60;
const OPENAPI_PATHS: &[&str] = &[
    "/openapi.json",
    "/swagger.json",
    "/api/openapi.json",
    "/docs/openapi.json",
    "/v3/api-docs",
    "/v2/api-docs",
];
const STATIC_PATHS: &[(&str, &str)] = &[
    ("/sitemap.xml", "sitemap"),
    ("/robots.txt", "robots"),
    ("/llms.txt", "llms.txt"),
];

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub async fn inspect_target(target_url: &str) -> Result<DiscoveryGrant, String> {
    let origin = parse_origin(target_url)?;
    let host = origin
        .url
        .host_str()
        .ok_or_else(|| "TARGET_HOST_REQUIRED".to_string())?
        .to_ascii_lowercase();
    let addresses = resolve(&origin).await?;
    if addresses.iter().copied().any(is_metadata_ip) {
        return Err("CLOUD_METADATA_TARGET_REJECTED".to_string());
    }
    if addresses.iter().copied().any(is_unroutable_ip) {
        return Err("SSRF_TARGET_REJECTED".to_string());
    }
    let local_private = matches!(host.as_str(), "localhost" | "localhost.localdomain")
        || addresses.iter().copied().any(is_private_or_local_ip);
    if !local_private && origin.url.scheme() != "https" {
        return Err("HTTPS_REQUIRED".to_string());
    }
    let created_at = now();
    let resolved_addresses: Vec<String> = addresses.iter().map(ToString::to_string).collect();
    let grant_id = format!(
        "grant_{}",
        &value_hash(&serde_json::json!({
            "origin": origin.origin,
            "addresses": resolved_addresses,
            "createdAt": created_at
        }))[..20]
    );
    Ok(DiscoveryGrant {
        grant_id,
        scheme: origin.url.scheme().to_string(),
        host,
        port: origin
            .url
            .port_or_known_default()
            .ok_or_else(|| "TARGET_PORT_REQUIRED".to_string())?,
        normalized_origin: origin.origin,
        resolved_addresses,
        created_at,
        expires_at: created_at + DISCOVERY_GRANT_SECONDS,
        request_limit: MAX_DISCOVERY_REQUESTS,
        requests_used: 0,
        local_private,
        local_authorized: !local_private,
    })
}

pub fn authorize_local_grant(
    grant: &mut DiscoveryGrant,
    human_approved: bool,
) -> Result<(), String> {
    if !grant.local_private {
        return Ok(());
    }
    if !human_approved {
        return Err("LOCAL_DISCOVERY_REQUIRES_NATIVE_GRANT".to_string());
    }
    grant.local_authorized = true;
    Ok(())
}

async fn authorize_request(
    grant: &mut DiscoveryGrant,
    candidate: &Url,
) -> Result<(ValidatedOrigin, Vec<IpAddr>), String> {
    if now() > grant.expires_at {
        return Err("DISCOVERY_GRANT_EXPIRED".to_string());
    }
    if grant.local_private && !grant.local_authorized {
        return Err("LOCAL_DISCOVERY_REQUIRES_NATIVE_GRANT".to_string());
    }
    if grant.requests_used >= grant.request_limit {
        return Err("DISCOVERY_REQUEST_LIMIT_EXCEEDED".to_string());
    }
    let mut origin = parse_origin(candidate.as_str())?;
    if origin.origin != grant.normalized_origin
        || origin.url.scheme() != grant.scheme
        || origin.url.host_str() != Some(grant.host.as_str())
        || origin.url.port_or_known_default() != Some(grant.port)
    {
        return Err("DISCOVERY_GRANT_TARGET_MISMATCH".to_string());
    }
    origin.allow_local_network = grant.local_private && grant.local_authorized;
    let current = resolve(&origin).await?;
    if current.iter().copied().any(is_metadata_ip) {
        return Err("CLOUD_METADATA_TARGET_REJECTED".to_string());
    }
    if current.iter().copied().any(is_unroutable_ip) {
        return Err("SSRF_TARGET_REJECTED".to_string());
    }
    if !origin.allow_local_network && current.iter().copied().any(is_private_or_local_ip) {
        return Err("SSRF_TARGET_REJECTED".to_string());
    }
    let current_strings: Vec<String> = current.iter().map(ToString::to_string).collect();
    if current_strings != grant.resolved_addresses {
        return Err("DISCOVERY_TARGET_CHANGED".to_string());
    }
    grant.requests_used += 1;
    Ok((origin, current))
}

async fn get(
    grant: &mut DiscoveryGrant,
    url: Url,
    cancel: &AtomicBool,
) -> Result<Option<(StatusCode, String, String)>, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("DISCOVERY_CANCELLED".to_string());
    }
    let (origin, addresses) = authorize_request(grant, &url).await?;
    let host = origin
        .url
        .host_str()
        .ok_or_else(|| "TARGET_HOST_REQUIRED".to_string())?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .user_agent("IRIS-Capability-Foundry/0.2 (authorized inspection)")
        .resolve(host, SocketAddr::new(addresses[0], grant.port))
        .build()
        .map_err(|_| "DISCOVERY_CLIENT_FAILED".to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "DISCOVERY_REQUEST_FAILED".to_string())?;
    if response.status().is_redirection() {
        return Err("DISCOVERY_REDIRECT_REQUIRES_SEPARATE_AUTHORIZATION".to_string());
    }
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if response
        .content_length()
        .is_some_and(|size| size as usize > MAX_DISCOVERY_BYTES)
    {
        return Err("DISCOVERY_RESPONSE_TOO_LARGE".to_string());
    }
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "DISCOVERY_RESPONSE_READ_FAILED".to_string())?;
    if bytes.len() > MAX_DISCOVERY_BYTES {
        return Err("DISCOVERY_RESPONSE_TOO_LARGE".to_string());
    }
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| "DISCOVERY_NON_TEXT_RESPONSE_REJECTED".to_string())?;
    Ok(Some((status, content_type, text)))
}

pub async fn discover(
    target_url: &str,
    grant: &mut DiscoveryGrant,
    cancel: &AtomicBool,
) -> Result<DiscoveryResult, String> {
    let requested = parse_origin(target_url)?;
    if requested.origin != grant.normalized_origin {
        return Err("DISCOVERY_GRANT_TARGET_MISMATCH".to_string());
    }
    let mut detected = Vec::new();
    let mut rejected = Vec::new();
    for path in OPENAPI_PATHS {
        let url = requested
            .url
            .join(path.trim_start_matches('/'))
            .map_err(|_| "DISCOVERY_URL_INVALID".to_string())?;
        match get(grant, url.clone(), cancel).await {
            Ok(Some((status, _, text))) if status.is_success() => {
                if let Ok(document) = serde_json::from_str::<Value>(&text) {
                    match compile_openapi(&document, url.as_str(), grant.local_private) {
                        Ok(package) => {
                            let package = if grant.local_private {
                                bind_approved_network_addresses(
                                    &package,
                                    &grant.resolved_addresses,
                                )?
                            } else {
                                package
                            };
                            detected.push("openapi".to_string());
                            return Ok(DiscoveryResult {
                                authorized_origin: grant.normalized_origin.clone(),
                                package: Some(package),
                                detected_surfaces: detected,
                                rejected_surfaces: rejected,
                                requests_made: grant.requests_used,
                            });
                        }
                        Err(error) => rejected.push(format!("{path}:{error}")),
                    }
                }
            }
            Ok(_) => {}
            Err(error) => rejected.push(format!("{path}:{error}")),
        }
    }
    for (path, label) in STATIC_PATHS {
        let url = requested
            .url
            .join(path.trim_start_matches('/'))
            .map_err(|_| "DISCOVERY_URL_INVALID".to_string())?;
        if let Ok(Some((status, _, _))) = get(grant, url, cancel).await {
            if status.is_success() {
                detected.push((*label).to_string());
            }
        }
    }
    let page_url = Url::parse(target_url).map_err(|_| "INVALID_TARGET_URL".to_string())?;
    let response = get(grant, page_url.clone(), cancel).await?;
    let mut package = None;
    if let Some((status, content_type, text)) = response {
        if status.is_success() {
            let lower = text.to_ascii_lowercase();
            if lower.contains("application/ld+json") {
                detected.push("json-ld".to_string())
            }
            if lower.contains("graphql") {
                detected.push("graphql-candidate".to_string())
            }
            if content_type.contains("html") || lower.contains("<html") || lower.contains("<form") {
                detected.push("html".to_string());
                if lower.contains("<form") {
                    detected.push("forms".to_string());
                    match compile_html_forms(&text, page_url.as_str(), grant.local_private) {
                        Ok(candidate) => {
                            package = Some(if grant.local_private {
                                bind_approved_network_addresses(
                                    &candidate,
                                    &grant.resolved_addresses,
                                )?
                            } else {
                                candidate
                            })
                        }
                        Err(error) => rejected.push(format!("forms:{error}")),
                    }
                }
            }
        }
    }
    Ok(DiscoveryResult {
        authorized_origin: grant.normalized_origin.clone(),
        package,
        detected_surfaces: detected,
        rejected_surfaces: rejected,
        requests_made: grant.requests_used,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn renderer_request_does_not_authorize_local_discovery() {
        let mut grant = inspect_target("http://127.0.0.1:4319").await.unwrap();
        let error = authorize_request(
            &mut grant,
            &Url::parse("http://127.0.0.1:4319/openapi.json").unwrap(),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "LOCAL_DISCOVERY_REQUIRES_NATIVE_GRANT");
    }

    #[tokio::test]
    async fn exact_local_grant_rejects_port_host_expiry_and_metadata() {
        let mut grant = inspect_target("http://127.0.0.1:4319").await.unwrap();
        authorize_local_grant(&mut grant, true).unwrap();
        assert!(authorize_request(
            &mut grant,
            &Url::parse("http://127.0.0.1:4319/openapi.json").unwrap()
        )
        .await
        .is_ok());
        assert_eq!(
            authorize_request(
                &mut grant,
                &Url::parse("http://127.0.0.1:9000/openapi.json").unwrap()
            )
            .await
            .unwrap_err(),
            "DISCOVERY_GRANT_TARGET_MISMATCH"
        );
        assert_eq!(
            authorize_request(
                &mut grant,
                &Url::parse("http://localhost:4319/openapi.json").unwrap()
            )
            .await
            .unwrap_err(),
            "DISCOVERY_GRANT_TARGET_MISMATCH"
        );
        let approved_addresses = grant.resolved_addresses.clone();
        grant.resolved_addresses = vec!["10.0.0.2".to_string()];
        assert_eq!(
            authorize_request(
                &mut grant,
                &Url::parse("http://127.0.0.1:4319/openapi.json").unwrap()
            )
            .await
            .unwrap_err(),
            "DISCOVERY_TARGET_CHANGED"
        );
        grant.resolved_addresses = approved_addresses;
        grant.requests_used = grant.request_limit;
        assert_eq!(
            authorize_request(
                &mut grant,
                &Url::parse("http://127.0.0.1:4319/openapi.json").unwrap()
            )
            .await
            .unwrap_err(),
            "DISCOVERY_REQUEST_LIMIT_EXCEEDED"
        );
        grant.requests_used = 1;
        grant.expires_at = 0;
        assert_eq!(
            authorize_request(
                &mut grant,
                &Url::parse("http://127.0.0.1:4319/openapi.json").unwrap()
            )
            .await
            .unwrap_err(),
            "DISCOVERY_GRANT_EXPIRED"
        );
        assert_eq!(
            inspect_target("http://169.254.169.254/latest")
                .await
                .unwrap_err(),
            "CLOUD_METADATA_TARGET_REJECTED"
        );
    }
}
