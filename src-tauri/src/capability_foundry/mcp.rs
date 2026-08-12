use super::models::{CapabilityExecutionRequest, CapabilityPackage};
use super::{execution, storage};
use serde_json::Value;
use std::io::{self, BufRead, Write};
use std::path::Path;

fn response(id: Value, result: Value) -> Value {
    serde_json::json!({"jsonrpc":"2.0","id":id,"result":result})
}
fn error(id: Value, code: i64, message: &str) -> Value {
    serde_json::json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

pub async fn handle(root: &Path, package: &CapabilityPackage, request: &Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return error(id, -32600, "Invalid Request");
    }
    let installed = match storage::load_installed_package(root, &package.package_id) {
        Ok(installed)
            if installed.package_id == package.package_id
                && installed.content_hash == package.content_hash =>
        {
            installed
        }
        _ => return error(id, -32002, "CAPABILITY_PACKAGE_TAMPERED"),
    };
    let package = &installed;
    match request.get("method").and_then(Value::as_str).unwrap_or("") {
        "initialize" => response(
            id,
            serde_json::json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"iris-capability-host","version":env!("CARGO_PKG_VERSION")}}),
        ),
        "notifications/initialized" => Value::Null,
        "tools/list" => response(
            id,
            serde_json::json!({"tools":package.capabilities.iter().filter(|c|c.enabled).map(|c|serde_json::json!({"name":c.tool_name,"description":format!("{}\nSource: {} | Confidence: {:.2} | Risk: {} | Origin: {}",c.description,c.source_mode,c.confidence,c.risk_level,package.target_origin),"inputSchema":c.input_schema})).collect::<Vec<_>>() }),
        ),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let Some(capability) = package.capabilities.iter().find(|c| c.tool_name == name) else {
                return error(id, -32602, "Unknown capability tool");
            };
            if capability.approval_required {
                return error(id, -32001, "APPROVAL_REQUIRED");
            };
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            match execution::execute(
                root,
                CapabilityExecutionRequest {
                    package_id: package.package_id.clone(),
                    capability_id: capability.id.clone(),
                    arguments,
                    approval_id: None,
                },
            )
            .await
            {
                Ok(value) => response(
                    id,
                    serde_json::json!({"content":[{"type":"text","text":serde_json::to_string(&value).unwrap_or_else(|_|"SANITIZATION_FAILED".to_string())}],"structuredContent":value,"isError":false}),
                ),
                Err(message) => error(id, -32000, &message),
            }
        }
        _ => error(id, -32601, "Method not found"),
    }
}

pub fn package_for_host(root: &Path, package_id: &str) -> Result<CapabilityPackage, String> {
    storage::load_installed_package(root, package_id)
}

pub async fn serve_stdio(root: &Path, package: &CapabilityPackage) -> Result<(), String> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value =
            serde_json::from_str(&line).map_err(|_| "Invalid JSON-RPC input".to_string())?;
        let result = handle(root, package, &request).await;
        if !result.is_null() {
            writeln!(
                stdout,
                "{}",
                serde_json::to_string(&result).map_err(|error| error.to_string())?
            )
            .map_err(|error| error.to_string())?;
            stdout.flush().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::compiler::compile_openapi;
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    #[tokio::test]
    async fn supports_initialize_list_and_denies_write_without_approval() {
        let candidate=compile_openapi(&serde_json::json!({"openapi":"3.0.0","paths":{"/write":{"post":{"operationId":"writeThing","responses":{"200":{"description":"ok"}}}}}}),"http://localhost:1/openapi.json",true).unwrap();
        let candidate = super::super::compiler::bind_approved_network_addresses(
            &candidate,
            &["127.0.0.1".to_string()],
        )
        .unwrap();
        let root = std::env::temp_dir().join(format!(
            "iris-foundry-mcp-unit-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let package = storage::prepare_final_install_package(
            &root,
            &candidate,
            &[candidate.capabilities[0].id.clone()],
        )
        .unwrap();
        let binding = storage::install_approval_binding(&package).unwrap();
        storage::persist_approved_package(&root, &package, &binding, true).unwrap();
        let init = handle(
            &root,
            &package,
            &serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
        )
        .await;
        assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
        let list = handle(
            &root,
            &package,
            &serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        )
        .await;
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 1);
        let call=handle(&root,&package,&serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":package.capabilities[0].tool_name,"arguments":{}}})).await;
        assert_eq!(call["error"]["message"], "APPROVAL_REQUIRED");
        let _ = std::fs::remove_dir_all(root);
    }
}
