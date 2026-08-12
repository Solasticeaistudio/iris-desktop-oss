use iris_desktop_lib::capability_foundry::{
    compiler::{bind_approved_network_addresses, compile_openapi},
    storage,
};
use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn mcp_stdio_uses_installed_identity_executes_read_and_denies_write() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let candidate = compile_openapi(
        &serde_json::json!({"openapi":"3.0.0","paths":{
            "/shipments":{"get":{"operationId":"getShipments","responses":{"200":{"description":"ok"}}}},
            "/delivery":{"post":{"operationId":"rescheduleDelivery","responses":{"200":{"description":"ok"}}}}
        }}),
        &format!("http://127.0.0.1:{port}/openapi.json"),
        true,
    )
    .unwrap();
    let candidate =
        bind_approved_network_addresses(&candidate, &["127.0.0.1".to_string()]).unwrap();
    let test_root = std::env::temp_dir().join(format!(
        "iris-mcp-installed-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = test_root.join("capabilities");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(".iris-foundry-test-registry"), b"test only").unwrap();
    let selected: Vec<String> = candidate
        .capabilities
        .iter()
        .map(|item| item.id.clone())
        .collect();
    let package = storage::prepare_final_install_package(&root, &candidate, &selected).unwrap();
    let binding = storage::install_approval_binding(&package).unwrap();
    storage::persist_approved_package(&root, &package, &binding, true).unwrap();
    let read_tool = package
        .capabilities
        .iter()
        .find(|item| item.method == "GET")
        .unwrap()
        .tool_name
        .clone();
    let write_tool = package
        .capabilities
        .iter()
        .find(|item| item.method == "POST")
        .unwrap()
        .tool_name
        .clone();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0u8; 4096];
        let _ = stream.read(&mut buffer).unwrap();
        let body = r#"{"shipments":[],"token":"test-secret-value"}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_iris-capability-host"))
        .args(["--package", package.package_id.as_str()])
        .env("IRIS_CAPABILITY_TEST_ROOT", &root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let input = format!(
        "{}\n{}\n{}\n{}\n",
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":read_tool,"arguments":{}}}),
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":write_tool,"arguments":{}}}),
    );
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    server.join().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses[0]["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(responses[1]["result"]["tools"].as_array().unwrap().len(), 2);
    assert_eq!(
        responses[2]["result"]["structuredContent"]["data"]["token"], "[REDACTED]",
        "{responses:#?}"
    );
    assert_eq!(responses[3]["error"]["message"], "APPROVAL_REQUIRED");
    let _ = std::fs::remove_dir_all(test_root);
}
