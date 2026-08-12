use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub id: String,
    pub source_mode: String,
    pub source_type: String,
    pub source_url: String,
    pub confidence: f64,
    pub fingerprint: String,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub id: String,
    pub tool_name: String,
    pub description: String,
    pub method: String,
    pub endpoint: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub auth_required: bool,
    pub approval_required: bool,
    pub risk_level: String,
    pub confidence: f64,
    pub source_mode: String,
    #[serde(default)]
    pub observed_endpoint: Option<String>,
    #[serde(default)]
    pub credential_handle: Option<String>,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub data_classification: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub capability_id: String,
    pub method: String,
    pub path_template: String,
    #[serde(default)]
    pub path_parameters: Vec<String>,
    #[serde(default)]
    pub query_parameters: Vec<String>,
    #[serde(default)]
    pub body_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    pub id: String,
    pub name: String,
    pub schema: Value,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiskProfile {
    pub default_risk: String,
    #[serde(default)]
    pub disabled_classes: Vec<String>,
    pub unknown_behavior: String,
    pub write_ownership_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedManifest {
    pub target_origin: String,
    #[serde(default)]
    pub capabilities: Vec<Capability>,
    #[serde(default)]
    pub routes: Vec<Route>,
    #[serde(default)]
    pub entities: Vec<Entity>,
    pub risk_profile: RiskProfile,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkScope {
    pub origin: String,
    pub same_origin_redirects_only: bool,
    pub allow_local_network: bool,
    #[serde(default)]
    pub approved_addresses: Vec<String>,
    pub max_redirects: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifest {
    pub format_version: String,
    pub content_hash: String,
    pub compiler_version: String,
    pub declarative_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityPackage {
    pub package_id: String,
    pub name: String,
    pub version: String,
    pub target_origin: String,
    pub created_at: String,
    pub compiler_version: String,
    pub capabilities: Vec<Capability>,
    pub routes: Vec<Route>,
    #[serde(default)]
    pub entities: Vec<Entity>,
    pub risk_profile: RiskProfile,
    pub evidence: Vec<Evidence>,
    #[serde(default)]
    pub permissions: Vec<String>,
    pub network_scope: NetworkScope,
    #[serde(default)]
    pub credential_requirements: Vec<String>,
    #[serde(default)]
    pub data_flow_metadata: Value,
    pub drift_fingerprint: String,
    pub content_hash: String,
    pub manifest: PackageManifest,
    #[serde(default)]
    pub tests: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledCapability {
    pub package_id: String,
    pub name: String,
    pub origin: String,
    pub version: String,
    pub content_hash: String,
    pub installed_at: String,
    pub enabled: bool,
    pub drift_status: String,
    pub tool_count: usize,
    #[serde(default)]
    pub credential_handles: Vec<String>,
    #[serde(default)]
    pub tampered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DynamicToolDefinition {
    pub package_id: String,
    pub capability_id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub input_schema: Value,
    pub risk_level: String,
    pub requires_approval: bool,
    pub enabled: bool,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DriftChange {
    pub capability_id: String,
    pub field: String,
    pub old_value: Value,
    pub new_value: Value,
    pub severity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DriftReport {
    pub package_id: String,
    pub status: String,
    pub severity: String,
    pub write_capabilities_suspended: Vec<String>,
    pub changes: Vec<DriftChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityExecutionRequest {
    pub package_id: String,
    pub capability_id: String,
    pub arguments: Value,
    #[serde(default)]
    pub approval_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityApprovalRequest {
    pub request_id: String,
    pub package_id: String,
    pub capability_id: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityApprovalResponse {
    pub approved: bool,
    pub approval_id: Option<String>,
    pub expires_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryResult {
    pub authorized_origin: String,
    pub package: Option<CapabilityPackage>,
    pub detected_surfaces: Vec<String>,
    pub rejected_surfaces: Vec<String>,
    pub requests_made: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryGrant {
    pub grant_id: String,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub normalized_origin: String,
    pub resolved_addresses: Vec<String>,
    pub created_at: u64,
    pub expires_at: u64,
    pub request_limit: usize,
    pub requests_used: usize,
    pub local_private: bool,
    pub local_authorized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallApprovalBinding {
    pub package_id: String,
    pub content_hash: String,
    pub target_origin: String,
    pub selected_capability_ids: Vec<String>,
    pub capability_count: usize,
    pub risk_summary: Vec<String>,
    pub network_scope: String,
    pub approved_addresses: Vec<String>,
    pub credential_requirements: Vec<String>,
}
