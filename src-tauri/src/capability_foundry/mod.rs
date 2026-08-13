pub mod compiler;
pub mod discovery;
pub mod drift;
pub mod execution;
pub mod mcp;
pub mod models;
pub mod origin;
pub mod risk;
pub mod sanitizer;
pub mod schema;
pub mod storage;

use models::*;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

static DISCOVERY_CANCELLED: AtomicBool = AtomicBool::new(false);

fn root() -> Result<std::path::PathBuf, String> {
    storage::default_root()
}

#[cfg(windows)]
fn local_confirmation_style() -> windows::Win32::UI::WindowsAndMessaging::MESSAGEBOX_STYLE {
    use windows::Win32::UI::WindowsAndMessaging::{
        MB_DEFBUTTON2, MB_ICONWARNING, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO,
    };
    MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND | MB_TOPMOST
}

#[cfg(windows)]
fn local_confirmation(title: &str, message: &str) -> bool {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES};
    unsafe {
        MessageBoxW(
            None,
            &HSTRING::from(message),
            &HSTRING::from(title),
            local_confirmation_style(),
        ) == IDYES
    }
}
#[cfg(not(windows))]
fn local_confirmation(_title: &str, _message: &str) -> bool {
    false
}

fn save(package: &CapabilityPackage) -> Result<CapabilityPackage, String> {
    storage::save_candidate(&root()?, package)?;
    Ok(package.clone())
}

#[tauri::command]
pub async fn foundry_discover(
    app: AppHandle,
    target_url: String,
    allow_local_network: bool,
) -> Result<DiscoveryResult, String> {
    DISCOVERY_CANCELLED.store(false, Ordering::SeqCst);
    let mut grant = discovery::inspect_target(&target_url).await?;
    if grant.local_private {
        if !allow_local_network {
            return Err("LOCAL_DISCOVERY_REQUIRES_NATIVE_GRANT".to_string());
        }
        let details = format!(
            "IRIS wants to inspect a local/private service\n\nTarget:\n{}\n\nResolved addresses:\n{}\n\nBounded surfaces may include OpenAPI, Swagger, robots.txt, sitemap.xml, llms.txt, and target HTML.\n\nMaximum requests: {}\nMaximum duration: 45 seconds\nNo credentials will be sent automatically.\n\nAuthorize this exact origin?",
            grant.normalized_origin,
            grant.resolved_addresses.join(", "),
            grant.request_limit
        );
        let approved = local_confirmation("IRIS Local Discovery Authorization", &details);
        discovery::authorize_local_grant(&mut grant, approved)?;
    }
    storage::append_history(
        &root()?,
        "discovery_started",
        None,
        None,
        serde_json::json!({"target":grant.normalized_origin,"localPrivate":grant.local_private,"grantId":grant.grant_id}),
    )?;
    for phase in [
        "Validating target",
        "Discovering machine-readable interfaces",
        "Scanning bounded site surface",
        "Extracting forms",
        "Normalizing schemas",
        "Classifying risk",
        "Generating evidence",
        "Running validation",
        "Preparing candidate package",
    ] {
        app.emit("capability-foundry-progress", phase)
            .map_err(|e| e.to_string())?;
    }
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(45),
        discovery::discover(&target_url, &mut grant, &DISCOVERY_CANCELLED),
    )
    .await
    .map_err(|_| "DISCOVERY_DURATION_EXCEEDED".to_string())??;
    if let Some(package) = &result.package {
        storage::save_candidate(&root()?, package)?;
    }
    Ok(result)
}

#[tauri::command]
pub fn foundry_cancel_discovery() {
    DISCOVERY_CANCELLED.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn foundry_import_openapi(
    document: Value,
    source_url: String,
    allow_local_network: bool,
) -> Result<CapabilityPackage, String> {
    save(&compiler::compile_openapi(
        &document,
        &source_url,
        allow_local_network,
    )?)
}
#[tauri::command]
pub fn foundry_import_graphql(
    document: Value,
    endpoint_url: String,
    allow_local_network: bool,
) -> Result<CapabilityPackage, String> {
    save(&compiler::compile_graphql_introspection(
        &document,
        &endpoint_url,
        allow_local_network,
    )?)
}
#[tauri::command]
pub fn foundry_import_har(
    document: Value,
    target_url: String,
    allow_local_network: bool,
) -> Result<CapabilityPackage, String> {
    save(&compiler::compile_har(
        &document,
        &target_url,
        allow_local_network,
    )?)
}
#[tauri::command]
pub fn foundry_import_html(
    html: String,
    page_url: String,
    allow_local_network: bool,
) -> Result<CapabilityPackage, String> {
    save(&compiler::compile_html_forms(
        &html,
        &page_url,
        allow_local_network,
    )?)
}

#[tauri::command]
pub fn foundry_get_candidate(package_id: String) -> Result<CapabilityPackage, String> {
    storage::load_candidate(&root()?, &package_id)
}
#[tauri::command]
pub fn foundry_reject_candidate(package_id: String) -> Result<(), String> {
    storage::reject_candidate(&root()?, &package_id)
}
#[tauri::command]
pub fn foundry_install_candidate(
    package_id: String,
    selected_capability_ids: Vec<String>,
) -> Result<InstalledCapability, String> {
    let root = root()?;
    let candidate = storage::load_candidate(&root, &package_id)?;
    let package =
        storage::prepare_final_install_package(&root, &candidate, &selected_capability_ids)?;
    let binding = storage::install_approval_binding(&package)?;
    let details = installation_review_text(&package, &binding)?;
    let approved = local_confirmation("IRIS Capability Installation Review", &details);
    storage::persist_approved_package(&root, &package, &binding, approved)
}

fn installation_review_text(
    package: &CapabilityPackage,
    binding: &InstallApprovalBinding,
) -> Result<String, String> {
    if package.capabilities.len() > storage::MAX_CAPABILITIES_PER_INSTALL
        || binding.capability_count > storage::MAX_CAPABILITIES_PER_INSTALL
    {
        return Err("TOO_MANY_CAPABILITIES_FOR_TRUSTED_REVIEW: A single installation may contain at most 20 capabilities. Install larger capability sets in multiple reviewed batches.".to_string());
    }
    let mut capabilities = package.capabilities.iter().collect::<Vec<_>>();
    capabilities.sort_by(|left, right| left.tool_name.cmp(&right.tool_name));
    let lines = capabilities
        .iter()
        .map(|capability| {
            format!(
                "{}\n{} {}\n{}{}",
                capability.tool_name,
                capability.method,
                capability.endpoint,
                capability.risk_level.to_ascii_uppercase(),
                if capability.approval_required {
                    " — execution approval required"
                } else {
                    ""
                }
            )
        })
        .collect::<Vec<_>>();
    Ok(format!(
        "IRIS Capability Foundry\n\nTarget:\n{}\n\nInstall these exact capabilities:\n\n{}\n\nCapability count:\n{}\n\nNetwork scope:\n{}\n\nApproved addresses:\n{}\n\nCredentials:\n{}\n\nFinal package ID:\n{}\n\nFinal package hash:\n{}\n\nInstall this exact package?",
        binding.target_origin,
        lines.join("\n\n"),
        binding.capability_count,
        binding.network_scope,
        if binding.approved_addresses.is_empty() {
            "not applicable".to_string()
        } else {
            binding.approved_addresses.join(", ")
        },
        if binding.credential_requirements.is_empty() {
            "none".to_string()
        } else {
            binding.credential_requirements.join(", ")
        },
        binding.package_id,
        binding.content_hash
    ))
}
#[tauri::command]
pub fn foundry_list_packages() -> Result<Vec<InstalledCapability>, String> {
    storage::list_installed(&root()?)
}
#[tauri::command]
pub fn foundry_list_tools() -> Result<Vec<DynamicToolDefinition>, String> {
    storage::dynamic_tools(&root()?)
}
#[tauri::command]
pub fn foundry_set_package_enabled(package_id: String, enabled: bool) -> Result<(), String> {
    let action = if enabled { "Enable" } else { "Disable" };
    let approved = local_confirmation(
        "IRIS Capability Authority",
        &format!("{action} capability package {package_id}?"),
    );
    if !approved {
        return Err("LOCAL_HUMAN_CONFIRMATION_REQUIRED".to_string());
    }
    storage::set_package_state(&root()?, &package_id, enabled)
}
#[tauri::command]
pub fn foundry_uninstall_package(package_id: String) -> Result<(), String> {
    let approved = local_confirmation(
        "IRIS Capability Uninstall",
        &format!("Uninstall capability package {package_id}?"),
    );
    storage::uninstall(&root()?, &package_id, approved)
}

#[tauri::command]
pub fn foundry_request_approval(
    request: CapabilityApprovalRequest,
) -> Result<CapabilityApprovalResponse, String> {
    let root = root()?;
    let preview = execution::preview_approval(&root, &request)?;
    let message=format!("Approve this exact one-time capability action?\n\nPackage: {}\nCapability: {}\nOrigin: {}\nMethod: {}\nEndpoint: {}\nRisk: {}\nArguments hash: {}",preview.package.package_id,preview.capability.tool_name,preview.package.target_origin,preview.capability.method,preview.capability.endpoint,preview.capability.risk_level,compiler::value_hash(&request.arguments));
    let approved = local_confirmation("IRIS Capability Approval", &message);
    Ok(execution::issue_approval(&request, &preview, approved))
}
#[tauri::command]
pub async fn foundry_execute(request: CapabilityExecutionRequest) -> Result<Value, String> {
    execution::execute(&root()?, request).await
}

#[tauri::command]
pub fn foundry_check_drift(
    package_id: String,
    current_candidate_id: String,
) -> Result<DriftReport, String> {
    let root = root()?;
    let current = storage::load_candidate(&root, &current_candidate_id)?;
    drift::compare_and_enforce(&root, &package_id, &current)
}
#[tauri::command]
pub fn foundry_history() -> Result<Vec<Value>, String> {
    storage::read_history(&root()?)
}
#[tauri::command]
pub fn foundry_mcp_info(package_id: String) -> Result<Value, String> {
    let package = storage::load_installed_package(&root()?, &package_id)?;
    Ok(
        serde_json::json!({"package":package.package_id,"tools":package.capabilities.iter().filter(|c|c.enabled).count(),"command":"iris-desktop --capability-host --package <package-id>","developmentCommand":"iris-capability-host --package <package-id>","transport":"stdio","note":"Uses the app-managed capability registry; no development path is required."}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn trusted_confirmation_is_forced_above_the_always_on_top_iris_window() {
        use windows::Win32::UI::WindowsAndMessaging::{
            MB_DEFBUTTON2, MB_SETFOREGROUND, MB_TOPMOST,
        };
        let style = local_confirmation_style();
        assert_ne!(style.0 & MB_TOPMOST.0, 0);
        assert_ne!(style.0 & MB_SETFOREGROUND.0, 0);
        assert_ne!(style.0 & MB_DEFBUTTON2.0, 0);
    }

    #[test]
    fn trusted_install_review_names_exact_final_capabilities_and_hash() {
        let package = compiler::compile_openapi(
            &serde_json::json!({"openapi":"3.0.0","paths":{"/shipments":{"get":{"operationId":"getShipments","responses":{"200":{"description":"ok"}}}}}}),
            "https://shipping.example/openapi.json",
            false,
        )
        .unwrap();
        let binding = storage::install_approval_binding(&package).unwrap();
        let text = installation_review_text(&package, &binding).unwrap();
        assert!(text.contains(&package.capabilities[0].tool_name));
        assert!(text.contains("GET /shipments"));
        assert!(text.contains(&package.content_hash));
        assert!(text.contains(&package.package_id));
        assert!(text.contains("https://shipping.example"));
    }

    #[test]
    fn trusted_install_review_displays_all_twenty_capabilities() {
        let template = compiler::compile_openapi(
            &serde_json::json!({"openapi":"3.0.0","paths":{"/item":{"get":{"operationId":"item","responses":{"200":{"description":"ok"}}}}}}),
            "https://shipping.example/openapi.json",
            false,
        )
        .unwrap();
        let capability = &template.capabilities[0];
        let route = &template.routes[0];
        let package = compiler::build_package(
            &template.target_origin,
            false,
            (0..storage::MAX_CAPABILITIES_PER_INSTALL)
                .map(|index| {
                    let mut item = capability.clone();
                    item.id = format!("cap_review_{index}");
                    item.tool_name = format!("review_{index}");
                    item.endpoint = format!("/review/{index}");
                    item
                })
                .collect(),
            (0..storage::MAX_CAPABILITIES_PER_INSTALL)
                .map(|index| {
                    let mut item = route.clone();
                    item.capability_id = format!("cap_review_{index}");
                    item.path_template = format!("/review/{index}");
                    item
                })
                .collect(),
            vec![],
            template.evidence,
        )
        .unwrap();
        let binding = storage::install_approval_binding(&package).unwrap();
        let text = installation_review_text(&package, &binding).unwrap();
        for capability in &package.capabilities {
            assert!(text.contains(&capability.tool_name));
        }
        assert!(!text.contains("additional selected capabilities"));
    }
}
