use super::compiler::{build_package_with_approved_addresses, verify_package_hash};
use super::models::*;
use super::origin::{is_metadata_ip, is_private_or_local_ip, is_unroutable_ip};
use super::schema::validate_schema;
use chrono::Utc;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

const RESERVED_TOOLS: &[&str] = &[
    "delete_file",
    "delete_folder",
    "clear_folder",
    "read_file",
    "type_text",
    "launch_app",
    "open_app",
    "close_app",
    "open_url",
    "web_search",
    "read_clipboard",
    "drag",
    "initialize",
    "tools_list",
    "tools_call",
    "install_capability_package",
    "foundry_initialize",
    "foundry_tools_list",
    "foundry_tools_call",
    "foundry_install",
    "foundry_uninstall",
    "foundry_enable",
    "foundry_disable",
];

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    #[serde(default)]
    packages: Vec<InstalledCapability>,
}

pub fn default_root() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|path| path.join("IRIS").join("capabilities"))
        .ok_or_else(|| "CAPABILITY_APP_DATA_UNAVAILABLE".to_string())
}

fn ensure_root(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root.join("candidates")).map_err(|error| error.to_string())?;
    fs::create_dir_all(root.join("packages")).map_err(|error| error.to_string())?;
    Ok(())
}

fn write_json(path: &Path, value: &impl serde::Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let temp = path.with_extension("tmp");
    {
        let mut file = fs::File::create(&temp).map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    fs::rename(temp, path).map_err(|error| error.to_string())
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() > 4_194_304 {
        return Err("CAPABILITY_PACKAGE_TOO_LARGE".to_string());
    }
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn package_dir(root: &Path, package_id: &str) -> PathBuf {
    root.join("packages").join(package_id)
}

fn validate_id(value: &str, prefix: &str) -> Result<(), String> {
    if !value.starts_with(prefix)
        || value.len() > 80
        || value
            .chars()
            .any(|ch| !ch.is_ascii_alphanumeric() && ch != '_')
    {
        return Err("INVALID_CAPABILITY_IDENTIFIER".to_string());
    }
    Ok(())
}

pub fn save_candidate(root: &Path, package: &CapabilityPackage) -> Result<(), String> {
    ensure_root(root)?;
    verify_package_hash(package)?;
    validate_id(&package.package_id, "pkg_")?;
    write_json(
        &root
            .join("candidates")
            .join(format!("{}.json", package.package_id)),
        package,
    )?;
    append_history(
        root,
        "candidate_created",
        Some(&package.package_id),
        None,
        serde_json::json!({"origin":package.target_origin,"toolCount":package.capabilities.len()}),
    )
}

pub fn load_candidate(root: &Path, package_id: &str) -> Result<CapabilityPackage, String> {
    validate_id(package_id, "pkg_")?;
    let package: CapabilityPackage =
        read_json(&root.join("candidates").join(format!("{package_id}.json")))?;
    verify_package_hash(&package)?;
    Ok(package)
}

pub fn reject_candidate(root: &Path, package_id: &str) -> Result<(), String> {
    validate_id(package_id, "pkg_")?;
    let path = root.join("candidates").join(format!("{package_id}.json"));
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    append_history(
        root,
        "candidate_rejected",
        Some(package_id),
        None,
        Value::Null,
    )
}

fn read_registry(root: &Path) -> Result<RegistryFile, String> {
    ensure_root(root)?;
    let path = root.join("registry.json");
    if !path.exists() {
        return Ok(RegistryFile::default());
    }
    read_json(&path)
}

fn write_registry(root: &Path, registry: &RegistryFile) -> Result<(), String> {
    write_json(&root.join("registry.json"), registry)
}

const MAX_TOOL_NAME_LEN: usize = 64;
pub const MAX_CAPABILITIES_PER_INSTALL: usize = 20;

fn trusted_review_limit_error() -> String {
    "TOO_MANY_CAPABILITIES_FOR_TRUSTED_REVIEW: A single installation may contain at most 20 capabilities. Install larger capability sets in multiple reviewed batches."
        .to_string()
}

fn validate_trusted_review_count(count: usize) -> Result<(), String> {
    if count > MAX_CAPABILITIES_PER_INSTALL {
        return Err(trusted_review_limit_error());
    }
    Ok(())
}

fn validate_tool_name(name: &str) -> Result<(), String> {
    if !name.starts_with("foundry_")
        || name.len() > MAX_TOOL_NAME_LEN
        || name
            .chars()
            .any(|ch| !ch.is_ascii_lowercase() && !ch.is_ascii_digit() && ch != '_')
    {
        return Err(format!("INVALID_FOUNDRY_TOOL_NAME:{name}"));
    }
    Ok(())
}

fn validate_install(root: &Path, package: &CapabilityPackage) -> Result<(), String> {
    verify_package_hash(package)?;
    validate_trusted_review_count(package.capabilities.len())?;
    if !package.manifest.declarative_only {
        return Err("ARBITRARY_CODE_PACKAGE_REJECTED".to_string());
    }
    if package.network_scope.origin != package.target_origin
        || !package.network_scope.same_origin_redirects_only
    {
        return Err("INVALID_NETWORK_SCOPE".to_string());
    }
    if package.network_scope.allow_local_network {
        if package.network_scope.approved_addresses.is_empty() {
            return Err("LOCAL_NETWORK_APPROVAL_REQUIRED".to_string());
        }
        for address in &package.network_scope.approved_addresses {
            let address = address
                .parse::<IpAddr>()
                .map_err(|_| "INVALID_APPROVED_ADDRESS".to_string())?;
            if is_metadata_ip(address) {
                return Err("CLOUD_METADATA_TARGET_REJECTED".to_string());
            }
            if is_unroutable_ip(address) || !is_private_or_local_ip(address) {
                return Err("SSRF_TARGET_REJECTED".to_string());
            }
        }
    } else if !package.network_scope.approved_addresses.is_empty() {
        return Err("INVALID_NETWORK_SCOPE".to_string());
    }
    let registry = read_registry(root)?;
    let mut existing_names = BTreeSet::new();
    for record in &registry.packages {
        let installed = load_installed_package(root, &record.package_id)
            .map_err(|_| "CAPABILITY_REGISTRY_INTEGRITY_REQUIRED".to_string())?;
        existing_names.extend(
            installed
                .capabilities
                .into_iter()
                .map(|capability| capability.tool_name),
        );
    }
    let mut package_names = BTreeSet::new();
    for capability in &package.capabilities {
        validate_id(&capability.id, "cap_")?;
        validate_tool_name(&capability.tool_name)?;
        validate_schema(&capability.input_schema)?;
        validate_schema(&capability.output_schema)?;
        if RESERVED_TOOLS.contains(&capability.tool_name.as_str())
            || !package_names.insert(capability.tool_name.clone())
            || existing_names.contains(&capability.tool_name)
        {
            return Err(format!("TOOL_NAME_COLLISION:{}", capability.tool_name));
        }
        if super::risk::is_write(capability) && !capability.approval_required {
            return Err("UNVERIFIED_WRITE_MUST_REQUIRE_APPROVAL".to_string());
        }
        if capability.risk_level == "critical" && capability.enabled {
            return Err("CRITICAL_CAPABILITY_MUST_BE_DISABLED".to_string());
        }
    }
    Ok(())
}

pub fn prepare_final_install_package(
    root: &Path,
    candidate: &CapabilityPackage,
    selected: &[String],
) -> Result<CapabilityPackage, String> {
    verify_package_hash(candidate)?;
    let selected: BTreeSet<&str> = selected.iter().map(String::as_str).collect();
    if selected.is_empty() {
        return Err("NO_CAPABILITIES_SELECTED".to_string());
    }
    validate_trusted_review_count(selected.len())?;
    let capabilities: Vec<_> = candidate
        .capabilities
        .iter()
        .filter(|item| selected.contains(item.id.as_str()))
        .cloned()
        .collect();
    if capabilities.len() != selected.len() {
        return Err("UNKNOWN_SELECTED_CAPABILITY".to_string());
    }
    let ids: BTreeSet<&str> = capabilities.iter().map(|item| item.id.as_str()).collect();
    let routes = candidate
        .routes
        .iter()
        .filter(|route| ids.contains(route.capability_id.as_str()))
        .cloned()
        .collect();
    let package = build_package_with_approved_addresses(
        &candidate.target_origin,
        candidate.network_scope.allow_local_network,
        candidate.network_scope.approved_addresses.clone(),
        capabilities,
        routes,
        candidate.entities.clone(),
        candidate.evidence.clone(),
    )?;
    validate_install(root, &package)?;
    Ok(package)
}

pub fn install_approval_binding(
    package: &CapabilityPackage,
) -> Result<InstallApprovalBinding, String> {
    verify_package_hash(package)?;
    validate_trusted_review_count(package.capabilities.len())?;
    let mut selected_capability_ids: Vec<String> = package
        .capabilities
        .iter()
        .map(|item| item.id.clone())
        .collect();
    selected_capability_ids.sort();
    let mut risk_summary: Vec<String> = package
        .capabilities
        .iter()
        .map(|item| {
            format!(
                "{}:{}",
                item.tool_name,
                item.risk_level.to_ascii_uppercase()
            )
        })
        .collect();
    risk_summary.sort();
    let mut credential_requirements = package.credential_requirements.clone();
    credential_requirements.sort();
    let mut approved_addresses = package.network_scope.approved_addresses.clone();
    approved_addresses.sort();
    Ok(InstallApprovalBinding {
        package_id: package.package_id.clone(),
        content_hash: package.content_hash.clone(),
        target_origin: package.target_origin.clone(),
        selected_capability_ids,
        capability_count: package.capabilities.len(),
        risk_summary,
        network_scope: package.network_scope.origin.clone(),
        approved_addresses,
        credential_requirements,
    })
}

fn validate_approval_binding(
    package: &CapabilityPackage,
    approved: &InstallApprovalBinding,
) -> Result<(), String> {
    let current = install_approval_binding(package)
        .map_err(|_| "INSTALL_PACKAGE_CHANGED_AFTER_APPROVAL".to_string())?;
    if &current != approved {
        return Err("INSTALL_PACKAGE_CHANGED_AFTER_APPROVAL".to_string());
    }
    Ok(())
}

pub fn persist_approved_package(
    root: &Path,
    package: &CapabilityPackage,
    approved: &InstallApprovalBinding,
    human_approved: bool,
) -> Result<InstalledCapability, String> {
    if !human_approved {
        return Err("INSTALLATION_REQUIRES_LOCAL_HUMAN_REVIEW".to_string());
    }
    // Recompute and compare immediately before persistence. Nothing is rebuilt here.
    validate_approval_binding(package, approved)?;
    validate_install(root, package)?;
    let mut registry = read_registry(root)?;
    let destination = package_dir(root, &package.package_id);
    if destination.exists() {
        return Err("CAPABILITY_PACKAGE_ALREADY_INSTALLED".to_string());
    }
    fs::create_dir(&destination).map_err(|error| error.to_string())?;
    write_json(&destination.join("capability.json"), &package)?;
    write_json(
        &destination.join("normalized-capabilities.json"),
        &serde_json::json!({"capabilities":package.capabilities,"entities":package.entities}),
    )?;
    write_json(&destination.join("evidence-map.json"), &package.evidence)?;
    write_json(&destination.join("risk-policy.json"), &package.risk_profile)?;
    write_json(&destination.join("routes.json"), &package.routes)?;
    write_json(&destination.join("tests.json"), &package.tests)?;
    write_json(
        &destination.join("drift-baseline.json"),
        &serde_json::json!({"fingerprint":package.drift_fingerprint}),
    )?;
    write_json(&destination.join("manifest.json"), &package.manifest)?;
    let record = InstalledCapability {
        package_id: package.package_id.clone(),
        name: package.name.clone(),
        origin: package.target_origin.clone(),
        version: package.version.clone(),
        content_hash: package.content_hash.clone(),
        installed_at: Utc::now().to_rfc3339(),
        enabled: true,
        drift_status: "stable".to_string(),
        tool_count: package.capabilities.len(),
        credential_handles: vec![],
        tampered: false,
    };
    registry
        .packages
        .retain(|item| item.package_id != record.package_id);
    registry.packages.push(record.clone());
    write_registry(root, &registry)?;
    append_history(
        root,
        "package_installed",
        Some(&record.package_id),
        None,
        serde_json::json!({"origin":record.origin,"toolCount":record.tool_count}),
    )?;
    Ok(record)
}

pub fn load_installed_package(root: &Path, package_id: &str) -> Result<CapabilityPackage, String> {
    validate_id(package_id, "pkg_")?;
    let package: CapabilityPackage =
        read_json(&package_dir(root, package_id).join("capability.json"))?;
    verify_package_hash(&package)?;
    Ok(package)
}

pub fn list_installed(root: &Path) -> Result<Vec<InstalledCapability>, String> {
    let mut registry = read_registry(root)?;
    let mut changed = false;
    for record in &mut registry.packages {
        match load_installed_package(root, &record.package_id) {
            Ok(package) if package.content_hash == record.content_hash => {}
            _ => {
                record.enabled = false;
                record.tampered = true;
                record.drift_status = "tampered".to_string();
                changed = true;
            }
        }
    }
    if changed {
        write_registry(root, &registry)?;
    }
    Ok(registry.packages)
}

pub fn dynamic_tools(root: &Path) -> Result<Vec<DynamicToolDefinition>, String> {
    let records = list_installed(root)?;
    let mut output = Vec::new();
    for record in records
        .into_iter()
        .filter(|item| item.enabled && !item.tampered)
    {
        let package = load_installed_package(root, &record.package_id)?;
        for capability in package.capabilities.into_iter().filter(|item| item.enabled) {
            output.push(DynamicToolDefinition {
                package_id: record.package_id.clone(),
                capability_id: capability.id.clone(),
                name: capability.tool_name.clone(),
                description: format!(
                    "{}\n\nSource: {}\nConfidence: {:.2}\nRisk: {}\nApproval: {}\nOrigin: {}",
                    capability.description,
                    capability.source_mode,
                    capability.confidence,
                    capability.risk_level,
                    if capability.approval_required {
                        "required"
                    } else {
                        "not required"
                    },
                    record.origin
                ),
                category: "capability-foundry".to_string(),
                input_schema: capability.input_schema,
                risk_level: capability.risk_level,
                requires_approval: capability.approval_required,
                enabled: true,
                tags: capability.tags,
            });
        }
    }
    Ok(output)
}

pub fn set_package_state(root: &Path, package_id: &str, enabled: bool) -> Result<(), String> {
    let mut registry = read_registry(root)?;
    let record = registry
        .packages
        .iter_mut()
        .find(|item| item.package_id == package_id)
        .ok_or_else(|| "CAPABILITY_PACKAGE_NOT_INSTALLED".to_string())?;
    if record.tampered && enabled {
        return Err("CAPABILITY_PACKAGE_TAMPERED".to_string());
    }
    record.enabled = enabled;
    write_registry(root, &registry)?;
    append_history(
        root,
        if enabled {
            "package_enabled"
        } else {
            "package_disabled"
        },
        Some(package_id),
        None,
        Value::Null,
    )
}

pub fn uninstall(root: &Path, package_id: &str, human_approved: bool) -> Result<(), String> {
    if !human_approved {
        return Err("UNINSTALL_REQUIRES_LOCAL_HUMAN_REVIEW".to_string());
    }
    validate_id(package_id, "pkg_")?;
    let destination = package_dir(root, package_id);
    if destination.exists() {
        fs::remove_dir_all(&destination).map_err(|error| error.to_string())?;
    }
    let mut registry = read_registry(root)?;
    registry
        .packages
        .retain(|item| item.package_id != package_id);
    write_registry(root, &registry)?;
    append_history(
        root,
        "package_uninstalled",
        Some(package_id),
        None,
        Value::Null,
    )
}

pub fn update_drift_state(
    root: &Path,
    package_id: &str,
    status: &str,
    disable: bool,
) -> Result<(), String> {
    let mut registry = read_registry(root)?;
    let record = registry
        .packages
        .iter_mut()
        .find(|item| item.package_id == package_id)
        .ok_or_else(|| "CAPABILITY_PACKAGE_NOT_INSTALLED".to_string())?;
    record.drift_status = status.to_string();
    if disable {
        record.enabled = false;
    }
    write_registry(root, &registry)
}

pub fn append_history(
    root: &Path,
    event: &str,
    package_id: Option<&str>,
    capability_id: Option<&str>,
    metadata: Value,
) -> Result<(), String> {
    ensure_root(root)?;
    let entry = serde_json::json!({"timestamp":Utc::now().to_rfc3339(),"event":event,"packageId":package_id,"capabilityId":capability_id,"metadata":metadata});
    let sanitized = super::sanitizer::sanitize_json(&entry)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("history.jsonl"))
        .map_err(|e| e.to_string())?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(&sanitized).map_err(|e| e.to_string())?
    )
    .map_err(|e| e.to_string())
}

pub fn read_history(root: &Path) -> Result<Vec<Value>, String> {
    ensure_root(root)?;
    let path = root.join("history.jsonl");
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    text.lines()
        .rev()
        .take(200)
        .map(|line| serde_json::from_str(line).map_err(|e| e.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    fn root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "iris-foundry-storage-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    fn fixture() -> CapabilityPackage {
        let candidate = super::super::compiler::compile_openapi(&serde_json::json!({"openapi":"3.0.0","paths":{"/items":{"get":{"operationId":"items","responses":{"200":{"description":"ok"}}}},"/users":{"get":{"operationId":"users","responses":{"200":{"description":"ok"}}}}}}),"http://localhost:7878/openapi.json",true).unwrap();
        super::super::compiler::bind_approved_network_addresses(
            &candidate,
            &["127.0.0.1".to_string()],
        )
        .unwrap()
    }
    fn candidate_with_count(count: usize) -> CapabilityPackage {
        let fixture = fixture();
        let template = fixture.capabilities[0].clone();
        let route = fixture.routes[0].clone();
        let capabilities = (0..count)
            .map(|index| {
                let mut item = template.clone();
                item.id = format!("cap_bulk_{index}");
                item.tool_name = format!("bulk_{index}");
                item.endpoint = format!("/bulk/{index}");
                item
            })
            .collect::<Vec<_>>();
        let routes = (0..count)
            .map(|index| {
                let mut item = route.clone();
                item.capability_id = format!("cap_bulk_{index}");
                item.path_template = format!("/bulk/{index}");
                item
            })
            .collect::<Vec<_>>();
        build_package_with_approved_addresses(
            &fixture.target_origin,
            true,
            vec!["127.0.0.1".to_string()],
            capabilities,
            routes,
            vec![],
            fixture.evidence,
        )
        .unwrap()
    }
    fn final_package(
        root: &Path,
        candidate: &CapabilityPackage,
        selected: &[String],
    ) -> CapabilityPackage {
        prepare_final_install_package(root, candidate, selected).unwrap()
    }
    fn rebuild(package: &CapabilityPackage) -> CapabilityPackage {
        build_package_with_approved_addresses(
            &package.target_origin,
            package.network_scope.allow_local_network,
            package.network_scope.approved_addresses.clone(),
            package.capabilities.clone(),
            package.routes.clone(),
            package.entities.clone(),
            package.evidence.clone(),
        )
        .unwrap()
    }
    #[test]
    fn exact_approved_package_is_persisted_and_tampering_is_detected() {
        let root = root();
        let candidate = fixture();
        save_candidate(&root, &candidate).unwrap();
        let package = final_package(&root, &candidate, &[candidate.capabilities[0].id.clone()]);
        let binding = install_approval_binding(&package).unwrap();
        let record = persist_approved_package(&root, &package, &binding, true).unwrap();
        assert_eq!(
            load_installed_package(&root, &record.package_id).unwrap(),
            package
        );
        assert_eq!(record.content_hash, binding.content_hash);
        assert_eq!(dynamic_tools(&root).unwrap().len(), 1);
        let path = package_dir(&root, &record.package_id).join("capability.json");
        let mut package: CapabilityPackage = read_json(&path).unwrap();
        package.capabilities[0].endpoint = "https://attacker.example".to_string();
        write_json(&path, &package).unwrap();
        let records = list_installed(&root).unwrap();
        assert!(records[0].tampered);
        assert!(!records[0].enabled);
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn installation_requires_human_decision() {
        let root = root();
        let candidate = fixture();
        let package = final_package(&root, &candidate, &[candidate.capabilities[0].id.clone()]);
        let binding = install_approval_binding(&package).unwrap();
        assert_eq!(
            persist_approved_package(&root, &package, &binding, false).unwrap_err(),
            "INSTALLATION_REQUIRES_LOCAL_HUMAN_REVIEW"
        );
    }

    #[test]
    fn post_approval_endpoint_schema_and_risk_mutation_is_rejected() {
        let root = root();
        let candidate = fixture();
        let package = final_package(&root, &candidate, &[candidate.capabilities[0].id.clone()]);
        let binding = install_approval_binding(&package).unwrap();
        for mutation in ["endpoint", "schema", "risk"] {
            let mut changed = package.clone();
            match mutation {
                "endpoint" => changed.capabilities[0].endpoint = "/attacker".to_string(),
                "schema" => {
                    changed.capabilities[0].input_schema = serde_json::json!({"type":"object","properties":{"extra":{"type":"string"}},"required":[],"additionalProperties":false})
                }
                "risk" => changed.capabilities[0].risk_level = "high".to_string(),
                _ => unreachable!(),
            }
            let changed = rebuild(&changed);
            assert_eq!(
                persist_approved_package(&root, &changed, &binding, true).unwrap_err(),
                "INSTALL_PACKAGE_CHANGED_AFTER_APPROVAL",
                "{mutation}"
            );
        }
    }

    #[test]
    fn selected_tool_and_origin_mutation_is_rejected() {
        let root = root();
        let candidate = fixture();
        let approved_package =
            final_package(&root, &candidate, &[candidate.capabilities[0].id.clone()]);
        let binding = install_approval_binding(&approved_package).unwrap();
        let different_selection =
            final_package(&root, &candidate, &[candidate.capabilities[1].id.clone()]);
        assert_eq!(
            persist_approved_package(&root, &different_selection, &binding, true).unwrap_err(),
            "INSTALL_PACKAGE_CHANGED_AFTER_APPROVAL"
        );
        let mut changed_origin = approved_package.clone();
        changed_origin.target_origin = "https://attacker.example".to_string();
        changed_origin.network_scope.origin = changed_origin.target_origin.clone();
        let changed_origin = rebuild(&changed_origin);
        assert_eq!(
            persist_approved_package(&root, &changed_origin, &binding, true).unwrap_err(),
            "INSTALL_PACKAGE_CHANGED_AFTER_APPROVAL"
        );
    }

    #[test]
    fn duplicate_installed_tool_identity_is_rejected_before_registry_refresh() {
        let root = root();
        let candidate = fixture();
        let selected = &[candidate.capabilities[0].id.clone()];
        let package = final_package(&root, &candidate, selected);
        let binding = install_approval_binding(&package).unwrap();
        persist_approved_package(&root, &package, &binding, true).unwrap();
        assert_eq!(dynamic_tools(&root).unwrap().len(), 1);
        let error = prepare_final_install_package(&root, &candidate, selected).unwrap_err();
        assert!(error.starts_with("TOOL_NAME_COLLISION:foundry_"));
    }

    #[test]
    fn exactly_twenty_capabilities_are_allowed_for_complete_trusted_review() {
        let root = root();
        let candidate = candidate_with_count(MAX_CAPABILITIES_PER_INSTALL);
        let selected = candidate
            .capabilities
            .iter()
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        let package = prepare_final_install_package(&root, &candidate, &selected).unwrap();
        assert_eq!(package.capabilities.len(), MAX_CAPABILITIES_PER_INSTALL);
        let binding = install_approval_binding(&package).unwrap();
        assert_eq!(binding.capability_count, MAX_CAPABILITIES_PER_INSTALL);
    }

    #[test]
    fn twenty_one_capabilities_are_rejected_and_never_persisted() {
        let root = root();
        let candidate = candidate_with_count(MAX_CAPABILITIES_PER_INSTALL + 1);
        let selected = candidate
            .capabilities
            .iter()
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        let error = prepare_final_install_package(&root, &candidate, &selected).unwrap_err();
        assert!(error.starts_with("TOO_MANY_CAPABILITIES_FOR_TRUSTED_REVIEW"));
        assert!(list_installed(&root).unwrap().is_empty());
        assert_eq!(fs::read_dir(root.join("packages")).unwrap().count(), 0);
    }

    #[test]
    fn renderer_claim_cannot_bypass_native_capability_count() {
        let root = root();
        let candidate = candidate_with_count(MAX_CAPABILITIES_PER_INSTALL + 1);
        let renderer_claimed_count = MAX_CAPABILITIES_PER_INSTALL;
        assert_eq!(renderer_claimed_count, 20);
        let selected = candidate
            .capabilities
            .iter()
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        let error = prepare_final_install_package(&root, &candidate, &selected).unwrap_err();
        assert!(error.starts_with("TOO_MANY_CAPABILITIES_FOR_TRUSTED_REVIEW"));
        assert!(list_installed(&root).unwrap().is_empty());
    }
}
