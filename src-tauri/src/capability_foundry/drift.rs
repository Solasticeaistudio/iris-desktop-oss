use super::models::*;
use super::risk::{is_write, risk_rank};
use super::storage;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

fn change(id: &str, field: &str, old: Value, new: Value, severity: &str) -> DriftChange {
    DriftChange {
        capability_id: id.to_string(),
        field: field.to_string(),
        old_value: old,
        new_value: new,
        severity: severity.to_string(),
    }
}

fn schema_widened(old: &Value, new: &Value) -> bool {
    let old_required: BTreeSet<&str> = old
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let new_required: BTreeSet<&str> = new
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let old_props: BTreeSet<&str> = old
        .get("properties")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|m| m.keys().map(String::as_str))
        .collect();
    let new_props: BTreeSet<&str> = new
        .get("properties")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|m| m.keys().map(String::as_str))
        .collect();
    !new_required.is_superset(&old_required) || !new_props.is_subset(&old_props)
}

pub fn compare(
    package_id: &str,
    baseline: &CapabilityPackage,
    current: &CapabilityPackage,
) -> DriftReport {
    let mut changes = Vec::new();
    let mut suspended = BTreeSet::new();
    let mut max = 0u8;
    if baseline.target_origin != current.target_origin {
        changes.push(change(
            "package",
            "origin",
            Value::String(baseline.target_origin.clone()),
            Value::String(current.target_origin.clone()),
            "critical",
        ));
        max = 4;
        suspended.extend(
            baseline
                .capabilities
                .iter()
                .filter(|c| is_write(c))
                .map(|c| c.id.clone()),
        );
    }
    let current_by_name: BTreeMap<&str, &Capability> = current
        .capabilities
        .iter()
        .map(|c| (c.tool_name.as_str(), c))
        .collect();
    for old in &baseline.capabilities {
        let Some(new) = current
            .capabilities
            .iter()
            .find(|c| c.id == old.id)
            .or_else(|| current_by_name.get(old.tool_name.as_str()).copied())
        else {
            changes.push(change(
                &old.id,
                "removed",
                serde_json::to_value(old).unwrap_or(Value::Null),
                Value::Null,
                if is_write(old) { "critical" } else { "high" },
            ));
            max = max.max(if is_write(old) { 4 } else { 3 });
            if is_write(old) {
                suspended.insert(old.id.clone());
            }
            continue;
        };
        for (field, old_value, new_value, severity) in [
            (
                "method",
                Value::String(old.method.clone()),
                Value::String(new.method.clone()),
                "critical",
            ),
            (
                "endpoint",
                Value::String(old.endpoint.clone()),
                Value::String(new.endpoint.clone()),
                if is_write(old) { "critical" } else { "high" },
            ),
            (
                "authRequired",
                Value::Bool(old.auth_required),
                Value::Bool(new.auth_required),
                "high",
            ),
        ] {
            if old_value != new_value {
                changes.push(change(&old.id, field, old_value, new_value, severity));
                let rank = if severity == "critical" { 4 } else { 3 };
                max = max.max(rank);
                if is_write(old) {
                    suspended.insert(old.id.clone());
                }
            }
        }
        if old.risk_level != new.risk_level {
            let severity = if risk_rank(&new.risk_level) > risk_rank(&old.risk_level) {
                "critical"
            } else {
                "medium"
            };
            changes.push(change(
                &old.id,
                "risk",
                Value::String(old.risk_level.clone()),
                Value::String(new.risk_level.clone()),
                severity,
            ));
            max = max.max(if severity == "critical" { 4 } else { 2 });
            if severity == "critical" && is_write(old) {
                suspended.insert(old.id.clone());
            }
        }
        if old.input_schema != new.input_schema {
            let severity = if schema_widened(&old.input_schema, &new.input_schema) {
                "high"
            } else {
                "low"
            };
            changes.push(change(
                &old.id,
                "inputSchema",
                old.input_schema.clone(),
                new.input_schema.clone(),
                severity,
            ));
            max = max.max(if severity == "high" { 3 } else { 1 });
            if severity == "high" && is_write(old) {
                suspended.insert(old.id.clone());
            }
        }
        if old.output_schema != new.output_schema {
            changes.push(change(
                &old.id,
                "outputSchema",
                old.output_schema.clone(),
                new.output_schema.clone(),
                "low",
            ));
            max = max.max(1);
        }
    }
    let severity = match max {
        0 => "none",
        1 => "low",
        2 => "medium",
        3 => "high",
        _ => "critical",
    }
    .to_string();
    let status = if changes.is_empty() {
        "stable"
    } else if max >= 3 || !suspended.is_empty() {
        "needs_attention"
    } else {
        "drift_detected"
    }
    .to_string();
    DriftReport {
        package_id: package_id.to_string(),
        status,
        severity,
        write_capabilities_suspended: suspended.into_iter().collect(),
        changes,
    }
}

pub fn compare_and_enforce(
    root: &Path,
    package_id: &str,
    current: &CapabilityPackage,
) -> Result<DriftReport, String> {
    let baseline = storage::load_installed_package(root, package_id)?;
    let report = compare(package_id, &baseline, current);
    let disable = report.severity == "critical" || !report.write_capabilities_suspended.is_empty();
    storage::update_drift_state(root, package_id, &report.status, disable)?;
    if !report.changes.is_empty() {
        storage::append_history(
            root,
            "drift_detected",
            Some(package_id),
            None,
            serde_json::json!({"status":report.status,"severity":report.severity,"writeCapabilitiesSuspended":report.write_capabilities_suspended}),
        )?;
        if disable {
            storage::append_history(
                root,
                "package_suspended",
                Some(package_id),
                None,
                serde_json::json!({"reason":"material_drift","severity":report.severity}),
            )?;
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::super::compiler::compile_openapi;
    use super::*;
    fn p(path: &str, method: &str, output_extra: bool) -> CapabilityPackage {
        let mut schema = serde_json::json!({"type":"object","properties":{"id":{"type":"string"}}});
        if output_extra {
            schema["properties"]["extra"] = serde_json::json!({"type":"string"});
        }
        compile_openapi(&serde_json::json!({"openapi":"3.0.0","paths":{path:{method:{"operationId":"changeDelivery","requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{"date":{"type":"string"}}}}}},"responses":{"200":{"content":{"application/json":{"schema":schema}}}}}}}}),"https://shipping.example/openapi.json",false).unwrap()
    }
    #[test]
    fn stable_and_additive_response_drift() {
        let a = p("/delivery", "get", false);
        assert_eq!(compare(&a.package_id, &a, &a).status, "stable");
        let b = p("/delivery", "get", true);
        let report = compare(&a.package_id, &a, &b);
        assert_eq!(report.status, "drift_detected");
        assert_eq!(report.severity, "low");
    }
    #[test]
    fn write_endpoint_and_origin_changes_need_attention() {
        let a = p("/delivery/{id}", "patch", false);
        let b = p("/delivery/change", "post", false);
        let report = compare(&a.package_id, &a, &b);
        assert_eq!(report.status, "needs_attention");
        assert!(!report.write_capabilities_suspended.is_empty());
        let mut c = a.clone();
        c.target_origin = "https://attacker.example".to_string();
        let report = compare(&a.package_id, &a, &c);
        assert_eq!(report.severity, "critical");
    }

    #[test]
    fn risk_increase_requires_attention() {
        let a = p("/delivery", "get", false);
        let mut b = a.clone();
        b.capabilities[0].risk_level = "high".to_string();
        b.capabilities[0].approval_required = true;
        let report = compare(&a.package_id, &a, &b);
        assert_eq!(report.status, "needs_attention");
        assert_eq!(report.severity, "critical");
    }

    #[test]
    fn non_installed_candidate_capabilities_do_not_enter_baseline() {
        let full = compile_openapi(
            &serde_json::json!({"openapi":"3.0.0","paths":{
                "/users":{"get":{"operationId":"getUsers","responses":{"200":{"description":"ok"}}}},
                "/admin":{"delete":{"operationId":"deleteAdmin","responses":{"200":{"description":"ok"}}}}
            }}),
            "https://shipping.example/openapi.json",
            false,
        )
        .unwrap();
        let selected = &full.capabilities[0];
        let baseline = super::super::compiler::build_package(
            &full.target_origin,
            false,
            vec![selected.clone()],
            full.routes
                .iter()
                .filter(|route| route.capability_id == selected.id)
                .cloned()
                .collect(),
            full.entities.clone(),
            full.evidence.clone(),
        )
        .unwrap();
        assert_eq!(
            compare(&baseline.package_id, &baseline, &full).status,
            "stable"
        );
        assert_eq!(baseline.capabilities.len(), 1);
    }
}
