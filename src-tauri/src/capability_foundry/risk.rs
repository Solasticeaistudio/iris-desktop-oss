use super::models::Capability;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RiskDecision {
    pub level: &'static str,
    pub approval_required: bool,
    pub executable: bool,
    pub consequential: bool,
    pub factors: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct RiskContext<'a> {
    pub operation_id: &'a str,
    pub summary: &'a str,
    pub description: &'a str,
    pub tags: Vec<&'a str>,
    pub has_request_body: bool,
    pub response_sensitive: bool,
    pub source_mode: &'a str,
}

const CONSEQUENTIAL_TERMS: &[&str] = &[
    "delete",
    "remove",
    "destroy",
    "erase",
    "reset",
    "reboot",
    "shutdown",
    "restart",
    "trigger",
    "execute",
    "run",
    "submit",
    "confirm",
    "approve",
    "publish",
    "deploy",
    "send",
    "unsubscribe",
    "cancel",
    "terminate",
    "activate",
    "deactivate",
    "disable",
    "enable",
    "create",
    "update",
    "modify",
    "write",
    "order",
    "invite",
    "revoke",
];
const CRITICAL_TERMS: &[&str] = &[
    "purchase",
    "checkout",
    "payment",
    "pay",
    "charge",
    "refund",
    "transfer",
    "withdraw",
    "deposit",
    "regulated",
    "medical",
    "healthrecord",
    "banktransfer",
];
const READ_SEMANTIC_TERMS: &[&str] = &["search", "query", "lookup", "find", "list", "read", "get"];

fn semantic_words(values: &[&str]) -> Vec<String> {
    let mut joined = String::new();
    for value in values {
        let mut previous_lower_or_digit = false;
        for ch in value.chars() {
            if ch.is_ascii_uppercase() && previous_lower_or_digit {
                joined.push(' ');
            }
            if ch.is_ascii_alphanumeric() {
                joined.push(ch.to_ascii_lowercase());
                previous_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
            } else {
                joined.push(' ');
                previous_lower_or_digit = false;
            }
        }
        joined.push(' ');
    }
    joined.split_whitespace().map(str::to_string).collect()
}

pub fn classify_with_context(
    method: &str,
    auth_required: bool,
    endpoint: &str,
    confidence: f64,
    context: &RiskContext<'_>,
) -> RiskDecision {
    let method = method.to_ascii_uppercase();
    let mut semantic_inputs = vec![
        endpoint,
        context.operation_id,
        context.summary,
        context.description,
    ];
    semantic_inputs.extend(context.tags.iter().copied());
    let words = semantic_words(&semantic_inputs);
    let critical = CRITICAL_TERMS
        .iter()
        .find(|term| words.iter().any(|word| word == **term));
    let consequential = CONSEQUENTIAL_TERMS
        .iter()
        .find(|term| words.iter().any(|word| word == **term));
    let read_semantic = READ_SEMANTIC_TERMS
        .iter()
        .any(|term| words.iter().any(|word| word == term));
    let mut factors = vec![format!("method:{method}")];
    factors.push(format!("source:{}", context.source_mode));
    factors.push(format!("confidence:{confidence:.2}"));
    if auth_required {
        factors.push("authenticated:true".to_string());
    }
    if context.has_request_body {
        factors.push("request_body:true".to_string());
    }
    if context.response_sensitive {
        factors.push("response_sensitive:true".to_string());
    }
    if let Some(term) = critical {
        factors.push(format!("critical_action:{term}"));
        return RiskDecision {
            level: "critical",
            approval_required: true,
            executable: false,
            consequential: true,
            factors,
        };
    }
    if confidence < 0.5
        || !["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].contains(&method.as_str())
    {
        factors.push("unknown_or_low_confidence:true".to_string());
        return RiskDecision {
            level: "critical",
            approval_required: true,
            executable: false,
            consequential: true,
            factors,
        };
    }
    if let Some(term) = consequential {
        factors.push(format!("semantic_action:{term}"));
        return RiskDecision {
            level: "high",
            approval_required: true,
            executable: true,
            consequential: true,
            factors,
        };
    }
    if matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS") {
        if auth_required || context.response_sensitive {
            RiskDecision {
                level: "high",
                approval_required: true,
                executable: true,
                consequential: false,
                factors,
            }
        } else if confidence >= 0.9 {
            RiskDecision {
                level: "low",
                approval_required: false,
                executable: true,
                consequential: false,
                factors,
            }
        } else {
            RiskDecision {
                level: "medium",
                approval_required: false,
                executable: true,
                consequential: false,
                factors,
            }
        }
    } else if method == "POST" && read_semantic && !context.has_request_body {
        factors.push("semantic_read:true".to_string());
        RiskDecision {
            level: "medium",
            approval_required: false,
            executable: true,
            consequential: false,
            factors,
        }
    } else {
        RiskDecision {
            level: "high",
            approval_required: true,
            executable: true,
            consequential: true,
            factors,
        }
    }
}

pub fn classify(
    method: &str,
    auth_required: bool,
    endpoint: &str,
    confidence: f64,
) -> (&'static str, bool, bool) {
    let context = RiskContext {
        source_mode: "unknown",
        ..RiskContext::default()
    };
    let decision = classify_with_context(method, auth_required, endpoint, confidence, &context);
    (
        decision.level,
        decision.approval_required,
        decision.executable,
    )
}

pub fn is_write(capability: &Capability) -> bool {
    if capability.tags.iter().any(|tag| tag == "graphql")
        && capability.tags.iter().any(|tag| tag == "query")
    {
        return false;
    }
    if capability.tags.iter().any(|tag| tag == "semantic-read") {
        return false;
    }
    capability.tags.iter().any(|tag| tag == "semantic-action")
        || !matches!(capability.method.as_str(), "GET" | "HEAD" | "OPTIONS")
}

pub fn risk_rank(risk: &str) -> u8 {
    match risk {
        "low" => 1,
        "medium" => 2,
        "high" => 3,
        "critical" => 4,
        _ => 5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify_case(method: &str, path: &str, operation: &str) -> RiskDecision {
        classify_with_context(
            method,
            false,
            path,
            1.0,
            &RiskContext {
                operation_id: operation,
                source_mode: "openapi",
                ..RiskContext::default()
            },
        )
    }

    #[test]
    fn semantic_classifier_does_not_assume_get_is_safe() {
        for path in ["/users", "/users/{id}"] {
            assert_eq!(classify_case("GET", path, "getUser").level, "low");
        }
        for path in [
            "/delete-account",
            "/unsubscribe",
            "/trigger-deployment",
            "/reboot",
            "/confirm-order",
        ] {
            let decision = classify_case("GET", path, "operation");
            assert_eq!(decision.level, "high", "{path}");
            assert!(decision.approval_required, "{path}");
        }
        assert_eq!(classify_case("POST", "/search", "search").level, "medium");
        assert_eq!(
            classify_case("PATCH", "/delivery/{id}", "updateDelivery").level,
            "high"
        );
        assert_eq!(
            classify_case("DELETE", "/users/{id}", "deleteUser").level,
            "high"
        );
        assert_eq!(
            classify_case("POST", "/checkout", "checkout").level,
            "critical"
        );
        assert_eq!(
            classify_case("POST", "/payment", "makePayment").level,
            "critical"
        );
    }

    #[test]
    fn summary_and_operation_id_are_semantic_signals() {
        let decision = classify_with_context(
            "GET",
            false,
            "/action",
            1.0,
            &RiskContext {
                operation_id: "triggerDeployment",
                summary: "Run deployment",
                source_mode: "openapi",
                ..RiskContext::default()
            },
        );
        assert_eq!(decision.level, "high");
        assert!(decision
            .factors
            .iter()
            .any(|factor| factor == "semantic_action:trigger"));
    }

    #[test]
    fn graphql_query_and_mutation_policy_is_explicit() {
        assert_eq!(
            classify_case("POST", "/graphql", "queryShipments").level,
            "medium"
        );
        assert_eq!(
            classify_case("POST", "/graphql", "updateShipment").level,
            "high"
        );
        assert_eq!(classify("MYSTERY", false, "/x", 1.0).0, "critical");
    }
}
