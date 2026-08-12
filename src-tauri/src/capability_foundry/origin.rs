use reqwest::Url;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[derive(Debug, Clone)]
pub struct ValidatedOrigin {
    pub origin: String,
    pub url: Url,
    pub allow_local_network: bool,
}

pub fn parse_origin(input: &str) -> Result<ValidatedOrigin, String> {
    let url = Url::parse(input).map_err(|_| "INVALID_TARGET_URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("UNSUPPORTED_URL_SCHEME".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URL_CREDENTIALS_REJECTED".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "TARGET_HOST_REQUIRED".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "TARGET_PORT_REQUIRED".to_string())?;
    let origin = format!(
        "{}://{}{}",
        url.scheme(),
        host.to_ascii_lowercase(),
        match (url.scheme(), port) {
            ("https", 443) | ("http", 80) => String::new(),
            _ => format!(":{port}"),
        }
    );
    let origin_url =
        Url::parse(&format!("{origin}/")).map_err(|_| "INVALID_TARGET_ORIGIN".to_string())?;
    Ok(ValidatedOrigin {
        origin,
        url: origin_url,
        allow_local_network: false,
    })
}

pub fn validate_origin(input: &str, allow_local_network: bool) -> Result<ValidatedOrigin, String> {
    let mut origin = parse_origin(input)?;
    let host = origin
        .url
        .host_str()
        .ok_or_else(|| "TARGET_HOST_REQUIRED".to_string())?;
    let is_local_name = matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "localhost.localdomain"
    );
    let is_granted_local_ip = host.parse::<IpAddr>().is_ok_and(is_private_or_local_ip);
    if origin.url.scheme() != "https"
        && !(allow_local_network && (is_local_name || is_granted_local_ip))
    {
        return Err("HTTPS_REQUIRED".to_string());
    }
    if host.parse::<IpAddr>().is_ok_and(is_metadata_ip) {
        return Err("CLOUD_METADATA_TARGET_REJECTED".to_string());
    }
    origin.allow_local_network = allow_local_network;
    Ok(origin)
}

/// Compilation may describe an HTTP hostname, but that description carries no
/// execution authority. Installation and execution require a native-approved,
/// hash-bound address set for every local/private HTTP origin.
pub fn validate_compilation_origin(
    input: &str,
    allow_local_network: bool,
) -> Result<ValidatedOrigin, String> {
    let mut origin = parse_origin(input)?;
    if origin.url.scheme() != "https" && !allow_local_network {
        return Err("HTTPS_REQUIRED".to_string());
    }
    let host = origin
        .url
        .host_str()
        .ok_or_else(|| "TARGET_HOST_REQUIRED".to_string())?;
    if host.parse::<IpAddr>().is_ok_and(is_metadata_ip) {
        return Err("CLOUD_METADATA_TARGET_REJECTED".to_string());
    }
    origin.allow_local_network = allow_local_network;
    Ok(origin)
}

pub fn validate_execution_origin(
    input: &str,
    allow_local_network: bool,
    approved_addresses: &[String],
) -> Result<ValidatedOrigin, String> {
    let mut origin = parse_origin(input)?;
    let host = origin
        .url
        .host_str()
        .ok_or_else(|| "TARGET_HOST_REQUIRED".to_string())?;
    if host.parse::<IpAddr>().is_ok_and(is_metadata_ip) {
        return Err("CLOUD_METADATA_TARGET_REJECTED".to_string());
    }
    if origin.url.scheme() != "https" && (!allow_local_network || approved_addresses.is_empty()) {
        return Err("HTTPS_REQUIRED".to_string());
    }
    if !allow_local_network && !approved_addresses.is_empty() {
        return Err("INVALID_NETWORK_SCOPE".to_string());
    }
    origin.allow_local_network = allow_local_network;
    Ok(origin)
}

pub fn is_metadata_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip == Ipv4Addr::new(169, 254, 169, 254)
                || ip == Ipv4Addr::new(169, 254, 170, 2)
                || ip == Ipv4Addr::new(100, 100, 100, 200)
        }
        IpAddr::V6(ip) => {
            ip == "fd00:ec2::254".parse::<Ipv6Addr>().expect("static IPv6")
                || ip
                    .to_ipv4()
                    .is_some_and(|mapped| is_metadata_ip(IpAddr::V4(mapped)))
        }
    }
}

pub fn is_unroutable_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_multicast() || ip.is_unspecified() || ip.octets()[0] == 0 || ip.octets()[0] >= 224
        }
        IpAddr::V6(ip) => ip.is_multicast() || ip.is_unspecified(),
    }
}

pub fn is_private_or_local_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
                || ip == Ipv6Addr::LOCALHOST
                || ip
                    .to_ipv4()
                    .is_some_and(|mapped| is_private_or_local_ip(IpAddr::V4(mapped)))
        }
    }
}

pub fn is_forbidden_ip(ip: IpAddr) -> bool {
    is_metadata_ip(ip) || is_unroutable_ip(ip) || is_private_or_local_ip(ip)
}

pub async fn resolve(origin: &ValidatedOrigin) -> Result<Vec<IpAddr>, String> {
    let host = origin
        .url
        .host_str()
        .ok_or_else(|| "TARGET_HOST_REQUIRED".to_string())?;
    let port = origin
        .url
        .port_or_known_default()
        .ok_or_else(|| "TARGET_PORT_REQUIRED".to_string())?;
    let mut resolved: Vec<IpAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "DNS_RESOLUTION_FAILED".to_string())?
        .map(|socket| socket.ip())
        .collect();
    resolved.sort();
    resolved.dedup();
    if resolved.is_empty() {
        return Err("DNS_RESOLUTION_EMPTY".to_string());
    }
    Ok(resolved)
}

pub async fn resolve_and_validate(origin: &ValidatedOrigin) -> Result<Vec<IpAddr>, String> {
    let resolved = resolve(origin).await?;
    if resolved.iter().copied().any(is_metadata_ip) {
        return Err("CLOUD_METADATA_TARGET_REJECTED".to_string());
    }
    if resolved.iter().copied().any(is_unroutable_ip) {
        return Err("SSRF_TARGET_REJECTED".to_string());
    }
    if !origin.allow_local_network && resolved.iter().copied().any(is_private_or_local_ip) {
        return Err("SSRF_TARGET_REJECTED".to_string());
    }
    Ok(resolved)
}

pub fn validate_resolved_addresses(
    origin: &ValidatedOrigin,
    resolved: Vec<IpAddr>,
    approved_addresses: &[String],
) -> Result<Vec<IpAddr>, String> {
    if resolved.iter().copied().any(is_metadata_ip) {
        return Err("CLOUD_METADATA_TARGET_REJECTED".to_string());
    }
    if resolved.iter().copied().any(is_unroutable_ip) {
        return Err("SSRF_TARGET_REJECTED".to_string());
    }
    if origin.allow_local_network {
        if approved_addresses.is_empty()
            || resolved
                .iter()
                .copied()
                .any(|address| !is_private_or_local_ip(address))
        {
            return Err("SSRF_TARGET_REJECTED".to_string());
        }
        let mut approved = approved_addresses
            .iter()
            .map(|address| {
                address
                    .parse::<IpAddr>()
                    .map_err(|_| "INVALID_APPROVED_ADDRESS".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        approved.sort();
        approved.dedup();
        let mut current = resolved.clone();
        current.sort();
        current.dedup();
        if current != approved {
            return Err("CAPABILITY_TARGET_CHANGED".to_string());
        }
    } else if resolved.iter().copied().any(is_private_or_local_ip) {
        return Err("SSRF_TARGET_REJECTED".to_string());
    }
    Ok(resolved)
}

pub async fn resolve_and_validate_approved(
    origin: &ValidatedOrigin,
    approved_addresses: &[String],
) -> Result<Vec<IpAddr>, String> {
    validate_resolved_addresses(origin, resolve(origin).await?, approved_addresses)
}

pub fn enforce_same_origin(expected: &ValidatedOrigin, candidate: &Url) -> Result<(), String> {
    let candidate_origin = parse_origin(candidate.as_str())?;
    if candidate_origin.origin != expected.origin {
        return Err("CROSS_ORIGIN_REQUEST_REJECTED".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ssrf_schemes_credentials_and_private_addresses() {
        assert!(validate_origin("file:///etc/passwd", false).is_err());
        assert!(validate_origin("gopher://example.com", false).is_err());
        assert!(validate_origin("https://user:pass@example.com", false).is_err());
        assert!(validate_origin("http://localhost:3000", false).is_err());
        assert!(validate_origin("http://localhost:3000", true).is_ok());
        for ip in [
            "127.0.0.1",
            "169.254.169.254",
            "10.0.0.1",
            "192.168.1.1",
            "::1",
            "fe80::1",
        ] {
            assert!(is_forbidden_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(validate_origin("http://169.254.169.254/latest", true).is_err());
    }

    #[test]
    fn same_origin_binds_scheme_host_and_port() {
        let expected = validate_origin("https://shipping.example", false).unwrap();
        assert!(enforce_same_origin(
            &expected,
            &Url::parse("https://shipping.example/api").unwrap()
        )
        .is_ok());
        assert!(enforce_same_origin(
            &expected,
            &Url::parse("https://attacker.example/api").unwrap()
        )
        .is_err());
        assert!(enforce_same_origin(
            &expected,
            &Url::parse("https://shipping.example:444/api").unwrap()
        )
        .is_err());
    }

    #[test]
    fn execution_policy_supports_only_hash_bound_private_http_origins() {
        let approved = vec!["192.168.1.50".to_string()];
        assert!(validate_execution_origin("https://example.com", false, &[]).is_ok());
        assert_eq!(
            validate_execution_origin("http://example.com", false, &[]).unwrap_err(),
            "HTTPS_REQUIRED"
        );
        for target in [
            "http://localhost:8080",
            "http://192.168.1.50:8080",
            "http://printer.local:8080",
        ] {
            assert!(
                validate_execution_origin(target, true, &approved).is_ok(),
                "{target}"
            );
            assert!(
                validate_execution_origin(target, true, &[]).is_err(),
                "{target}"
            );
        }
        assert!(validate_execution_origin(
            "http://169.254.169.254/latest",
            true,
            &["169.254.169.254".to_string()]
        )
        .is_err());
    }

    #[test]
    fn private_hostname_resolution_is_pinned_and_fails_closed_on_change() {
        let origin = validate_execution_origin(
            "http://printer.local:8080",
            true,
            &["192.168.1.50".to_string()],
        )
        .unwrap();
        assert!(validate_resolved_addresses(
            &origin,
            vec!["192.168.1.50".parse().unwrap()],
            &["192.168.1.50".to_string()]
        )
        .is_ok());
        assert_eq!(
            validate_resolved_addresses(
                &origin,
                vec!["192.168.1.51".parse().unwrap()],
                &["192.168.1.50".to_string()]
            )
            .unwrap_err(),
            "CAPABILITY_TARGET_CHANGED"
        );
        assert_eq!(
            validate_resolved_addresses(
                &origin,
                vec!["203.0.113.10".parse().unwrap()],
                &["192.168.1.50".to_string()]
            )
            .unwrap_err(),
            "SSRF_TARGET_REJECTED"
        );
        assert_eq!(
            validate_resolved_addresses(
                &origin,
                vec!["169.254.169.254".parse().unwrap()],
                &["192.168.1.50".to_string()]
            )
            .unwrap_err(),
            "CLOUD_METADATA_TARGET_REJECTED"
        );
    }
}
