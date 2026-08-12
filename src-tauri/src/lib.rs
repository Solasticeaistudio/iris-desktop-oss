use base64::{engine::general_purpose::STANDARD, Engine};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use screenshots::Screen;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub mod capability_foundry;

lazy_static::lazy_static! {
    static ref AUDIO_STOP_TX: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);
    static ref LAST_LEVEL_EMIT: Mutex<Instant> = Mutex::new(Instant::now());
    static ref SYSTEM_MONITOR_STOP_TX: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);
    // Echo cancellation: reference signal from TTS output
    static ref AEC_REFERENCE_SIGNAL: Mutex<Vec<f32>> = Mutex::new(Vec::new());
    static ref AEC_REFERENCE_INDEX: Mutex<usize> = Mutex::new(0);
    static ref AEC_ACTIVE: AtomicBool = AtomicBool::new(false);
    static ref AEC_START_TIME: Mutex<Option<Instant>> = Mutex::new(None);
    static ref TOOL_APPROVALS: Mutex<HashMap<String, ToolApproval>> = Mutex::new(HashMap::new());
    static ref CONTROL_SESSIONS: Mutex<HashMap<String, ControlSession>> = Mutex::new(HashMap::new());
}
static IS_CAPTURING: AtomicBool = AtomicBool::new(false);
static IS_MONITORING: AtomicBool = AtomicBool::new(false);
const SPEECH_THRESHOLD: f32 = 0.035; // Raised from 0.015 to reduce ambient noise pickup
const SILENCE_DURATION_MS: u64 = 800;
const MIN_RECORDING_MS: u64 = 500; // Raised from 300 to filter out short noise bursts
const MAX_RECORDING_MS: u64 = 30000;
const LEVEL_EMIT_INTERVAL_MS: u64 = 50; // Throttle audio level events to ~20fps
                                        // Echo cancellation settings
const AEC_CORRELATION_THRESHOLD: f32 = 0.6; // Similarity threshold for echo detection
const AEC_SUPPRESSION_FACTOR: f32 = 0.1; // How much to attenuate detected echo (0 = full suppress)
const APPROVAL_TTL_SECONDS: u64 = 90;
const CONTROL_SESSION_TTL_SECONDS: u64 = 120;

#[derive(Debug, Clone)]
struct ControlSession {
    expires_at: u64,
    purpose: String,
    target: WindowIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowIdentity {
    process_id: u32,
    window_handle: isize,
    executable: String,
    window_title: String,
    bounds: WindowBounds,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowBounds {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl WindowBounds {
    fn contains(self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlSessionResponse {
    control_session_id: String,
    expires_at: u64,
    process_id: u32,
    window_handle: isize,
    executable: String,
    window_title: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum NativeRisk {
    High,
    Critical,
}

#[derive(Debug, Clone)]
struct ToolApproval {
    tool: String,
    request_hash: String,
    risk: NativeRisk,
    expires_at: u64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeToolRequest {
    request_id: String,
    tool: String,
    arguments: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalResponse {
    approved: bool,
    approval_id: Option<String>,
    risk: NativeRisk,
    expires_at: Option<u64>,
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn canonical_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let sorted: BTreeMap<_, _> = map
                .iter()
                .map(|(key, value)| (key.clone(), canonical_json(value)))
                .collect();
            serde_json::to_value(sorted).expect("canonical JSON serialization cannot fail")
        }
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(canonical_json).collect())
        }
        _ => value.clone(),
    }
}

fn request_hash(request: &NativeToolRequest, risk: NativeRisk) -> String {
    let value = serde_json::json!({
        "requestId": request.request_id,
        "tool": request.tool,
        "arguments": canonical_json(&request.arguments),
        "risk": risk,
    });
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value).expect("request serialization cannot fail"))
    )
}

fn native_tool_risk(tool: &str) -> Option<NativeRisk> {
    match tool {
        "close_app" | "open_url" | "web_search" | "toggle_wifi" | "drag" | "delete_file"
        | "turn_off_monitors" | "read_file" | "read_clipboard" | "load_workspace" => {
            Some(NativeRisk::High)
        }
        "delete_folder" | "clear_folder" | "delete_workspace" | "lock_computer"
        | "sleep_computer" => Some(NativeRisk::Critical),
        _ => None,
    }
}

fn validate_native_tool_request(request: &NativeToolRequest) -> Result<NativeRisk, String> {
    if request.request_id.trim().is_empty() {
        return Err("requestId is required".to_string());
    }
    let risk = native_tool_risk(&request.tool)
        .ok_or_else(|| "Tool is not registered in the guarded native dispatcher".to_string())?;
    let args = request
        .arguments
        .as_object()
        .ok_or_else(|| "Tool arguments must be an object".to_string())?;
    let expected: &[(&str, &str)] = match request.tool.as_str() {
        "close_app" => &[("appName", "string")],
        "open_url" => &[("url", "string")],
        "web_search" => &[("query", "string")],
        "toggle_wifi" => &[("enable", "boolean")],
        "drag" => &[
            ("x1", "number"),
            ("y1", "number"),
            ("x2", "number"),
            ("y2", "number"),
            ("controlSessionId", "string"),
        ],
        "delete_file" | "delete_folder" | "clear_folder" => &[("path", "string")],
        "read_file" => &[("path", "string")],
        "read_clipboard" => &[],
        "load_workspace" => &[("name", "string")],
        "delete_workspace" => &[("name", "string")],
        "turn_off_monitors" | "lock_computer" | "sleep_computer" => &[],
        _ => unreachable!(),
    };
    if args.len() != expected.len() {
        return Err("Tool arguments contain missing or unknown fields".to_string());
    }
    for (name, kind) in expected {
        let value = args
            .get(*name)
            .ok_or_else(|| format!("Missing required argument: {name}"))?;
        let valid = match *kind {
            "string" => value.is_string(),
            "boolean" => value.is_boolean(),
            "number" => value.is_number(),
            _ => false,
        };
        if !valid {
            return Err(format!("Invalid type for {name}; expected {kind}"));
        }
    }
    if let Some(path) = args.get("path").and_then(|value| value.as_str()) {
        if request.tool == "read_file" {
            validate_local_path(path, true)?;
        } else {
            validate_destructive_path(path)?;
        }
    }
    if let Some(url) = args.get("url").and_then(|value| value.as_str()) {
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err("Only absolute HTTP(S) URLs are allowed".to_string());
        }
    }
    Ok(risk)
}

fn create_approval(request: &NativeToolRequest, risk: NativeRisk, now: u64) -> String {
    let approval_id = uuid::Uuid::new_v4().to_string();
    TOOL_APPROVALS.lock().unwrap().insert(
        approval_id.clone(),
        ToolApproval {
            tool: request.tool.clone(),
            request_hash: request_hash(request, risk),
            risk,
            expires_at: now + APPROVAL_TTL_SECONDS,
        },
    );
    approval_id
}

fn consume_approval(
    approval_id: &str,
    request: &NativeToolRequest,
    risk: NativeRisk,
    now: u64,
) -> Result<(), String> {
    let approval = TOOL_APPROVALS
        .lock()
        .unwrap()
        .remove(approval_id)
        .ok_or_else(|| "Approval is missing, denied, or already consumed".to_string())?;
    if approval.expires_at < now {
        return Err("Approval has expired".to_string());
    }
    if approval.tool != request.tool
        || approval.risk != risk
        || approval.request_hash != request_hash(request, risk)
    {
        return Err("Approval is not bound to this exact tool request".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn native_approval_dialog(request: &NativeToolRequest, risk: NativeRisk) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO,
    };
    let body = format!("IRIS wants to perform a {:?} action.\n\nTool: {}\nRequest: {}\nArguments:\n{}\n\nApproval is single-use and expires in {} seconds.", risk, request.tool, request.request_id, serde_json::to_string_pretty(&request.arguments).unwrap_or_default(), APPROVAL_TTL_SECONDS);
    let title: Vec<u16> = "IRIS security approval\0".encode_utf16().collect();
    let body: Vec<u16> = format!("{}\0", body).encode_utf16().collect();
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(body.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
        ) == IDYES
    }
}

#[cfg(not(target_os = "windows"))]
fn native_approval_dialog(_request: &NativeToolRequest, _risk: NativeRisk) -> bool {
    false
}

#[tauri::command]
async fn request_tool_approval(request: NativeToolRequest) -> Result<ApprovalResponse, String> {
    let risk = validate_native_tool_request(&request)?;
    let approved = native_approval_dialog(&request, risk);
    if !approved {
        log::warn!(
            "[NativePolicy] request={} tool={} risk={:?} approval=denied",
            request.request_id,
            request.tool,
            risk
        );
        return Ok(ApprovalResponse {
            approved: false,
            approval_id: None,
            risk,
            expires_at: None,
        });
    }
    let now = epoch_seconds();
    let approval_id = create_approval(&request, risk, now);
    log::info!(
        "[NativePolicy] request={} tool={} risk={:?} approval=granted expires_at={}",
        request.request_id,
        request.tool,
        risk,
        now + APPROVAL_TTL_SECONDS
    );
    Ok(ApprovalResponse {
        approved: true,
        approval_id: Some(approval_id),
        risk,
        expires_at: Some(now + APPROVAL_TTL_SECONDS),
    })
}

fn arg_str<'a>(
    args: &'a serde_json::Map<String, serde_json::Value>,
    name: &str,
) -> Result<&'a str, String> {
    args.get(name)
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("Missing string argument: {name}"))
}

fn arg_i32(args: &serde_json::Map<String, serde_json::Value>, name: &str) -> Result<i32, String> {
    let value = args
        .get(name)
        .and_then(|value| value.as_i64())
        .ok_or_else(|| format!("Missing integer argument: {name}"))?;
    i32::try_from(value).map_err(|_| format!("Argument {name} is outside the i32 range"))
}

#[tauri::command]
async fn execute_sensitive_tool(
    request: NativeToolRequest,
    approval_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let started = Instant::now();
    let risk = validate_native_tool_request(&request)?;
    consume_approval(
        approval_id.as_deref().unwrap_or(""),
        &request,
        risk,
        epoch_seconds(),
    )?;
    let args = request.arguments.as_object().expect("validated object");
    let result = match request.tool.as_str() {
        "close_app" => close_application(arg_str(args, "appName")?.to_string()).await,
        "open_url" => open_url(arg_str(args, "url")?.to_string()).await,
        "web_search" => web_search(arg_str(args, "query")?.to_string()).await,
        "toggle_wifi" => {
            toggle_wifi(
                args.get("enable")
                    .and_then(|v| v.as_bool())
                    .ok_or("Missing boolean argument: enable")?,
            )
            .await
        }
        "drag" => {
            let control_session_id = arg_str(args, "controlSessionId")?;
            let session = validate_control_session(control_session_id, true)?;
            validate_control_point(&session, arg_i32(args, "x1")?, arg_i32(args, "y1")?)?;
            validate_control_point(&session, arg_i32(args, "x2")?, arg_i32(args, "y2")?)?;
            drag_mouse(
                arg_i32(args, "x1")?,
                arg_i32(args, "y1")?,
                arg_i32(args, "x2")?,
                arg_i32(args, "y2")?,
            )
            .await
        }
        "delete_file" => delete_file(arg_str(args, "path")?.to_string()).await,
        "delete_folder" => delete_folder(arg_str(args, "path")?.to_string()).await,
        "clear_folder" => clear_folder(arg_str(args, "path")?.to_string()).await,
        "delete_workspace" => delete_workspace(arg_str(args, "name")?.to_string()).await,
        "read_file" => read_file(arg_str(args, "path")?.to_string()).await,
        "read_clipboard" => get_clipboard_text().await,
        "load_workspace" => load_workspace(arg_str(args, "name")?.to_string()).await,
        "turn_off_monitors" => turn_off_monitors()
            .await
            .map(|_| "Monitors turned off".to_string()),
        "lock_computer" => lock_computer().await,
        "sleep_computer" => sleep_computer().await,
        _ => Err("Unknown guarded tool".to_string()),
    };
    match result {
        Ok(value) => {
            log::info!(
                "[NativePolicy] request={} tool={} risk={:?} status=executed duration_ms={}",
                request.request_id,
                request.tool,
                risk,
                started.elapsed().as_millis()
            );
            Ok(serde_json::json!({"success": true, "result": value}))
        }
        Err(error) => {
            log::warn!(
                "[NativePolicy] request={} tool={} risk={:?} status=failed duration_ms={} error={}",
                request.request_id,
                request.tool,
                risk,
                started.elapsed().as_millis(),
                error
            );
            Err(error)
        }
    }
}

fn terminal_identity(executable: &str, title: &str) -> bool {
    let executable = std::path::Path::new(executable)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(executable)
        .to_ascii_lowercase();
    let blocked_executables = [
        "cmd.exe",
        "powershell.exe",
        "pwsh.exe",
        "windowsterminal.exe",
        "wt.exe",
        "bash.exe",
        "wsl.exe",
        "git-bash.exe",
        "mintty.exe",
    ];
    if blocked_executables.contains(&executable.as_str()) {
        return true;
    }
    let title = title.to_ascii_lowercase();
    [
        "command prompt",
        "powershell",
        "windows powershell",
        "windows terminal",
        "git bash",
        "wsl",
    ]
    .iter()
    .any(|blocked| title == *blocked || title.starts_with(&format!("{blocked} -")))
}

#[cfg(target_os = "windows")]
fn inspect_window(window_handle: isize) -> Result<WindowIdentity, String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND, RECT};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsWindow,
    };

    let hwnd = HWND(window_handle as *mut _);
    unsafe {
        if !IsWindow(hwnd).as_bool() {
            return Err("CONTROL_SESSION_TARGET_MISMATCH: target window no longer exists".into());
        }
        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == 0 {
            return Err("CONTROL_SESSION_TARGET_MISMATCH: target process is unavailable".into());
        }
        let mut title_buffer = vec![0u16; 1024];
        let title_length = GetWindowTextW(hwnd, &mut title_buffer).max(0) as usize;
        let window_title = String::from_utf16_lossy(&title_buffer[..title_length]);
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).map_err(|_| {
            "CONTROL_SESSION_TARGET_MISMATCH: target bounds are unavailable".to_string()
        })?;

        let process =
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).map_err(|_| {
                "CONTROL_SESSION_TARGET_MISMATCH: target executable is unavailable".to_string()
            })?;
        let mut executable_buffer = vec![0u16; 32768];
        let mut executable_length = executable_buffer.len() as u32;
        let query_result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(executable_buffer.as_mut_ptr()),
            &mut executable_length,
        );
        let _ = CloseHandle(process);
        query_result.map_err(|_| {
            "CONTROL_SESSION_TARGET_MISMATCH: target executable identity is unavailable".to_string()
        })?;
        let executable = String::from_utf16_lossy(&executable_buffer[..executable_length as usize]);
        Ok(WindowIdentity {
            process_id,
            window_handle,
            executable,
            window_title,
            bounds: WindowBounds {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
            },
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn inspect_window(_window_handle: isize) -> Result<WindowIdentity, String> {
    Err("Target-bound computer control is currently supported only on Windows".into())
}

#[cfg(target_os = "windows")]
fn foreground_window() -> Result<WindowIdentity, String> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Err("No foreground target window is available".into());
    }
    inspect_window(hwnd.0 as isize)
}

#[cfg(not(target_os = "windows"))]
fn foreground_window() -> Result<WindowIdentity, String> {
    Err("Target-bound computer control is currently supported only on Windows".into())
}

fn resolve_window_target(title: Option<&str>) -> Result<WindowIdentity, String> {
    let Some(title) = title.map(str::trim).filter(|title| !title.is_empty()) else {
        return foreground_window();
    };
    let script = r#"
        $needle = $env:IRIS_WINDOW_TITLE
        $handles = @(Get-Process | Where-Object {
            $_.MainWindowHandle -ne 0 -and
            $_.MainWindowTitle.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
        } | ForEach-Object { $_.MainWindowHandle.ToInt64() })
        @{ handles = $handles } | ConvertTo-Json -Compress
    "#;
    let output = powershell_with_data(script, &[("IRIS_WINDOW_TITLE", title)])
        .output()
        .map_err(|error| format!("Unable to resolve target window: {error}"))?;
    if !output.status.success() {
        return Err("Unable to resolve target window safely".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Unable to parse target-window identity".to_string())?;
    let handles = value
        .get("handles")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Unable to resolve target-window identity".to_string())?;
    if handles.len() != 1 {
        return Err(if handles.is_empty() {
            "Target window was not found".into()
        } else {
            "Target window is ambiguous; use a more specific title".into()
        });
    }
    let handle = handles[0]
        .as_i64()
        .ok_or_else(|| "Target window handle is malformed".to_string())?;
    inspect_window(handle as isize)
}

fn identities_match(approved: &WindowIdentity, observed: &WindowIdentity) -> bool {
    approved.window_handle == observed.window_handle
        && approved.process_id == observed.process_id
        && approved
            .executable
            .eq_ignore_ascii_case(&observed.executable)
}

fn validate_observed_target(
    approved: &WindowIdentity,
    observed: &WindowIdentity,
) -> Result<(), String> {
    if !identities_match(approved, observed) {
        return Err("CONTROL_SESSION_TARGET_MISMATCH: PID, HWND, or executable changed".into());
    }
    if terminal_identity(&observed.executable, &observed.window_title) {
        return Err(
            "CONTROL_SESSION_TARGET_MISMATCH: terminal and shell targets are forbidden".into(),
        );
    }
    Ok(())
}

fn validate_session_binding(
    session: &ControlSession,
    observed: &WindowIdentity,
    foreground: Option<&WindowIdentity>,
    now: u64,
) -> Result<(), String> {
    if session.expires_at <= now {
        return Err("Computer-control session is missing, denied, cancelled, or expired".into());
    }
    validate_observed_target(&session.target, observed)?;
    if let Some(foreground) = foreground {
        validate_observed_target(&session.target, foreground)?;
    }
    Ok(())
}

fn validate_session_snapshot(
    session: &ControlSession,
    observed: Option<&WindowIdentity>,
    foreground: Option<&WindowIdentity>,
    now: u64,
) -> Result<(), String> {
    let observed = observed.ok_or_else(|| {
        "CONTROL_SESSION_TARGET_MISMATCH: approved process or window exited".to_string()
    })?;
    validate_session_binding(session, observed, foreground, now)
}

#[cfg(target_os = "windows")]
fn native_control_dialog(purpose: &str, target: &WindowIdentity) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO,
    };
    let application = std::path::Path::new(&target.executable)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&target.executable);
    let body = format!("IRIS wants temporary computer control.\n\nPurpose: {}\n\nApplication: {}\nWindow: {}\nPID: {}\nWindow handle: {}\n\nIRIS control is limited to this application window.\nAllowed: mouse, keyboard, scrolling, and normal interaction with this window only.\nDuration: {} seconds\n\nDirect IRIS capabilities remain separately protected:\n- shell/terminal execution\n- sensitive reads\n- destructive filesystem tools\n- privileged native actions\n\nImportant: this application's own interface may expose consequential, external, destructive, or security-sensitive actions. Development tools may also contain integrated terminals, consoles, or extensions.\n\nAuthorize this target-bound session?\0", purpose, application, target.window_title, target.process_id, target.window_handle, CONTROL_SESSION_TTL_SECONDS);
    let title: Vec<u16> = "IRIS computer-control authorization\0"
        .encode_utf16()
        .collect();
    let body: Vec<u16> = body.encode_utf16().collect();
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(body.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
        ) == IDYES
    }
}

#[cfg(not(target_os = "windows"))]
fn native_control_dialog(_purpose: &str, _target: &WindowIdentity) -> bool {
    false
}

#[tauri::command]
async fn request_control_session(
    purpose: String,
    target_window_title: Option<String>,
) -> Result<ControlSessionResponse, String> {
    let purpose = purpose.trim();
    if purpose.is_empty() || purpose.chars().count() > 500 {
        return Err("A concise control-session purpose is required".to_string());
    }
    let target = resolve_window_target(target_window_title.as_deref())?;
    if terminal_identity(&target.executable, &target.window_title) {
        return Err("Computer-control authorization is forbidden for terminals and shells".into());
    }
    if !native_control_dialog(purpose, &target) {
        return Err("Computer-control authorization was denied".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let expires_at = epoch_seconds() + CONTROL_SESSION_TTL_SECONDS;
    CONTROL_SESSIONS.lock().unwrap().insert(
        id.clone(),
        ControlSession {
            expires_at,
            purpose: purpose.to_string(),
            target: target.clone(),
        },
    );
    log::info!(
        "[ControlSession] session={} status=created target_executable={} pid={} hwnd={} title_chars={} expires_at={}",
        id,
        target.executable,
        target.process_id,
        target.window_handle,
        target.window_title.chars().count(),
        expires_at
    );
    Ok(ControlSessionResponse {
        control_session_id: id,
        expires_at,
        process_id: target.process_id,
        window_handle: target.window_handle,
        executable: target.executable,
        window_title: target.window_title,
    })
}

#[tauri::command]
async fn cancel_control_session(control_session_id: String) -> Result<(), String> {
    if CONTROL_SESSIONS
        .lock()
        .unwrap()
        .remove(&control_session_id)
        .is_some()
    {
        log::info!(
            "[ControlSession] session={} status=terminated reason=cancelled",
            control_session_id
        );
    }
    Ok(())
}

fn validate_control_session(id: &str, require_foreground: bool) -> Result<ControlSession, String> {
    let mut sessions = CONTROL_SESSIONS.lock().unwrap();
    sessions.retain(|_, session| session.expires_at > epoch_seconds());
    let session = sessions.get(id).cloned().ok_or_else(|| {
        "Computer-control session is missing, denied, cancelled, or expired".to_string()
    })?;
    let observed = match inspect_window(session.target.window_handle) {
        Ok(observed) => observed,
        Err(error) => {
            sessions.remove(id);
            log::warn!(
                "[ControlSession] session={} status=invalidated reason={}",
                id,
                error
            );
            let missing_target =
                validate_session_snapshot(&session, None, None, epoch_seconds()).unwrap_err();
            return Err(missing_target);
        }
    };
    if let Err(error) = validate_session_snapshot(&session, Some(&observed), None, epoch_seconds())
    {
        sessions.remove(id);
        return Err(error);
    }
    if require_foreground {
        let foreground = foreground_window()?;
        if let Err(error) = validate_session_snapshot(
            &session,
            Some(&observed),
            Some(&foreground),
            epoch_seconds(),
        ) {
            sessions.remove(id);
            log::warn!(
                "[ControlSession] session={} status=invalidated reason=foreground_target_mismatch",
                id
            );
            return Err(error);
        }
    }
    log::info!(
        "[ControlSession] authorized purpose_chars={} expires_at={}",
        session.purpose.chars().count(),
        session.expires_at
    );
    Ok(ControlSession {
        target: observed,
        ..session
    })
}

fn validate_control_point(session: &ControlSession, x: i32, y: i32) -> Result<(), String> {
    if !session.target.bounds.contains(x, y) {
        return Err(
            "CONTROL_SESSION_TARGET_MISMATCH: mouse coordinates are outside the approved window"
                .into(),
        );
    }
    Ok(())
}

#[tauri::command]
async fn launch_allowlisted_app(app_name: String) -> Result<serde_json::Value, String> {
    let result = launch_app(app_name).await?;
    CONTROL_SESSIONS.lock().unwrap().clear();
    Ok(serde_json::json!({"success": true, "result": result}))
}

#[tauri::command]
async fn execute_control_tool(
    control_session_id: String,
    tool: String,
    arguments: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let args = arguments
        .as_object()
        .ok_or_else(|| "Control tool arguments must be an object".to_string())?;
    let require_foreground = tool != "focus_window";
    let session = validate_control_session(&control_session_id, require_foreground)?;
    let result = match tool.as_str() {
        "type_text" if args.len() == 1 => type_text(arg_str(args, "text")?.to_string())
            .await
            .map(serde_json::Value::String),
        "press_key" if args.len() == 1 => press_key(arg_str(args, "key")?.to_string())
            .await
            .map(serde_json::Value::String),
        "press_key_combo" if args.len() == 1 => {
            let keys = args
                .get("keys")
                .and_then(|v| v.as_array())
                .ok_or("keys must be an array")?
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .ok_or("every key must be a string")
                })
                .collect::<Result<Vec<_>, _>>()?;
            press_key_combo(keys).await.map(serde_json::Value::String)
        }
        "move_mouse" | "click" | "double_click" | "right_click" if args.len() == 2 => {
            let x = arg_i32(args, "x")?;
            let y = arg_i32(args, "y")?;
            validate_control_point(&session, x, y)?;
            match tool.as_str() {
                "move_mouse" => move_mouse_to(x, y).await,
                "click" => click_mouse(x, y).await,
                "double_click" => double_click(x, y).await,
                _ => right_click(x, y).await,
            }
            .map(serde_json::Value::String)
        }
        "focus_window" if args.len() == 1 => {
            let requested = resolve_window_target(Some(arg_str(args, "title")?))?;
            if !identities_match(&session.target, &requested) {
                return Err("NEW_CONTROL_AUTHORIZATION_REQUIRED: requested window differs from the approved target".into());
            }
            focus_window_handle(&session.target)
        }
        "scroll" if args.len() == 2 => {
            let amount = arg_i32(args, "amount")?;
            scroll(arg_str(args, "direction")?.to_string(), Some(amount))
                .await
                .map(serde_json::Value::String)
        }
        _ => Err("Unknown, malformed, or disallowed computer-control tool".to_string()),
    }?;
    let detail = if tool == "type_text" {
        format!(
            "typed_text_length={}",
            arg_str(args, "text")?.chars().count()
        )
    } else {
        "arguments_redacted=true".to_string()
    };
    log::info!("[ControlSession] session={} action={} target_executable={} pid={} hwnd={} status=executed {}", control_session_id, tool, session.target.executable, session.target.process_id, session.target.window_handle, detail);
    Ok(serde_json::json!({"success": true, "result": result}))
}

fn powershell_with_data(script: &str, values: &[(&str, &str)]) -> std::process::Command {
    let mut command = std::process::Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    for (name, value) in values {
        command.env(name, value);
    }
    command
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ScreenshotResult {
    pub base64: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DisplayScreenshot {
    pub base64: String,
    pub width: u32,
    pub height: u32,
    pub display_index: usize,
    pub display_name: String,
    pub x: i32, // Position in virtual desktop
    pub y: i32,
    pub is_primary: bool,
    pub scale_factor: f32, // DPI scaling (1.0 = 100%, 1.25 = 125%, etc.)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeAudioDevice {
    pub name: String,
    pub is_default: bool,
}

#[tauri::command]
async fn list_audio_devices() -> Result<Vec<NativeAudioDevice>, String> {
    let host = cpal::default_host();
    let mut devices = Vec::new();
    let default_device = host.default_input_device();
    let default_name = default_device.as_ref().and_then(|d| d.name().ok());
    let input_devices = host.input_devices().map_err(|e| e.to_string())?;
    for device in input_devices {
        if let Ok(name) = device.name() {
            let is_default = default_name.as_ref().map(|d| d == &name).unwrap_or(false);
            devices.push(NativeAudioDevice { name, is_default });
        }
    }
    log::info!("[Audio] Found {} input devices", devices.len());
    Ok(devices)
}

#[tauri::command]
async fn start_audio_capture<R: Runtime + 'static>(
    app: AppHandle<R>,
    device_name: Option<String>,
) -> Result<(), String> {
    if IS_CAPTURING.load(Ordering::SeqCst) {
        return Err("Audio capture already running".to_string());
    }

    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let (result_tx, result_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    {
        let mut tx_guard = AUDIO_STOP_TX.lock().unwrap();
        *tx_guard = Some(stop_tx);
    }

    // Spawn thread that will own the stream (stream is !Send, must be created in owning thread)
    std::thread::spawn(move || {
        let result: Result<(), String> = (|| {
            let host = cpal::default_host();
            let device = if let Some(ref name) = device_name {
                host.input_devices()
                    .map_err(|e| e.to_string())?
                    .find(|d| d.name().ok().as_ref() == Some(name))
                    .ok_or_else(|| format!("Device not found: {}", name))?
            } else {
                host.default_input_device()
                    .ok_or_else(|| "No default input device found".to_string())?
            };
            let device_name_str = device.name().unwrap_or_else(|_| "Unknown".to_string());
            log::info!("[Audio] Starting capture on: {}", device_name_str);
            let config = device
                .default_input_config()
                .map_err(|e| format!("Failed to get device config: {}", e))?;
            let sample_rate = config.sample_rate().0;
            let channels = config.channels() as usize;
            let sample_format = config.sample_format();
            log::info!(
                "[Audio] Config: {} Hz, {} channels, {:?}",
                sample_rate,
                channels,
                sample_format
            );

            let is_speaking = Arc::new(AtomicBool::new(false));
            let recording_samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
            let last_speech_time: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
            let recording_start: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
            let sample_counter = Arc::new(Mutex::new(0u64));
            let max_samples = (MAX_RECORDING_MS as f32 / 1000.0 * sample_rate as f32) as usize;

            let stream = match sample_format {
                cpal::SampleFormat::F32 => {
                    let is_speaking_clone = is_speaking.clone();
                    let recording_samples_clone = recording_samples.clone();
                    let last_speech_time_clone = last_speech_time.clone();
                    let recording_start_clone = recording_start.clone();
                    let sample_counter_clone = sample_counter.clone();
                    let app_clone = app.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[f32], _: &cpal::InputCallbackInfo| {
                            process_audio_data(
                                data,
                                channels,
                                sample_rate,
                                &is_speaking_clone,
                                &recording_samples_clone,
                                &last_speech_time_clone,
                                &recording_start_clone,
                                &sample_counter_clone,
                                &app_clone,
                                max_samples,
                            );
                        },
                        |err| log::error!("[Audio] Stream error: {}", err),
                        None,
                    )
                }
                cpal::SampleFormat::I16 => {
                    let is_speaking_clone = is_speaking.clone();
                    let recording_samples_clone = recording_samples.clone();
                    let last_speech_time_clone = last_speech_time.clone();
                    let recording_start_clone = recording_start.clone();
                    let sample_counter_clone = sample_counter.clone();
                    let app_clone = app.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[i16], _: &cpal::InputCallbackInfo| {
                            let float_data: Vec<f32> =
                                data.iter().map(|&s| s as f32 / 32768.0).collect();
                            process_audio_data(
                                &float_data,
                                channels,
                                sample_rate,
                                &is_speaking_clone,
                                &recording_samples_clone,
                                &last_speech_time_clone,
                                &recording_start_clone,
                                &sample_counter_clone,
                                &app_clone,
                                max_samples,
                            );
                        },
                        |err| log::error!("[Audio] Stream error: {}", err),
                        None,
                    )
                }
                _ => return Err("Unsupported sample format".to_string()),
            }
            .map_err(|e| format!("Failed to build stream: {}", e))?;

            stream
                .play()
                .map_err(|e| format!("Failed to start stream: {}", e))?;
            IS_CAPTURING.store(true, Ordering::SeqCst);
            log::info!("[Audio] Capture started successfully");

            // Signal success
            let _ = result_tx.send(Ok(()));

            // Keep stream alive until stop signal
            let _ = stop_rx.recv();
            log::info!("[Audio] Capture thread received stop signal");
            drop(stream);
            IS_CAPTURING.store(false, Ordering::SeqCst);
            Ok(())
        })();

        // If we failed before sending success, send the error
        if let Err(ref e) = result {
            let _ = result_tx.send(Err(e.clone()));
        }
    });

    // Wait for the thread to report success or failure
    result_rx
        .recv()
        .map_err(|_| "Audio thread failed to start".to_string())?
}

fn process_audio_data<R: Runtime>(
    data: &[f32],
    channels: usize,
    sample_rate: u32,
    is_speaking: &Arc<AtomicBool>,
    recording_samples: &Arc<Mutex<Vec<f32>>>,
    last_speech_time: &Arc<Mutex<Option<Instant>>>,
    recording_start: &Arc<Mutex<Option<Instant>>>,
    sample_counter: &Arc<Mutex<u64>>,
    app: &AppHandle<R>,
    max_samples: usize,
) {
    // Convert to mono
    let mono_raw: Vec<f32> = if channels > 1 {
        data.chunks(channels)
            .map(|chunk| chunk.iter().sum::<f32>() / channels as f32)
            .collect()
    } else {
        data.to_vec()
    };

    // Apply echo cancellation if active
    let (mono_samples, echo_detected) = apply_echo_cancellation(&mono_raw);

    // If echo was detected, skip speech detection (it's IRIS talking)
    if echo_detected {
        // Still emit audio level for UI feedback, but mark as echo
        let rms = (mono_raw.iter().map(|s| s * s).sum::<f32>() / mono_raw.len() as f32).sqrt();
        let now = Instant::now();
        {
            let mut last_emit = LAST_LEVEL_EMIT.lock().unwrap();
            if now.duration_since(*last_emit) >= Duration::from_millis(LEVEL_EMIT_INTERVAL_MS) {
                let _ = app.emit(
                    "audio-level",
                    serde_json::json!({"level": rms, "is_speech": false, "is_echo": true}),
                );
                *last_emit = now;
            }
        }
        return; // Don't process echo as speech
    }

    let sum_squares: f32 = mono_samples.iter().map(|s| s * s).sum();
    let rms = (sum_squares / mono_samples.len() as f32).sqrt();
    let is_speech = rms > SPEECH_THRESHOLD;
    let was_speaking = is_speaking.load(Ordering::SeqCst);
    {
        let mut counter = sample_counter.lock().unwrap();
        *counter += 1;
        if *counter % 100 == 0 {
            log::debug!("[Audio] RMS: {:.4}, Speech: {}", rms, is_speech);
        }
    }
    let now = Instant::now();
    // Throttle audio level events to reduce frontend overhead
    {
        let mut last_emit = LAST_LEVEL_EMIT.lock().unwrap();
        if now.duration_since(*last_emit) >= Duration::from_millis(LEVEL_EMIT_INTERVAL_MS) {
            let _ = app.emit(
                "audio-level",
                serde_json::json!({"level": rms, "is_speech": is_speech}),
            );
            *last_emit = now;
        }
    }
    if is_speech {
        is_speaking.store(true, Ordering::SeqCst);
        {
            let mut last_time = last_speech_time.lock().unwrap();
            *last_time = Some(now);
        }
        {
            let mut start = recording_start.lock().unwrap();
            if start.is_none() {
                *start = Some(now);
                log::info!("[Audio] Started recording");
            }
        }
        {
            let mut samples = recording_samples.lock().unwrap();
            samples.extend_from_slice(&mono_samples);
            if samples.len() >= max_samples {
                log::info!("[Audio] Max recording length reached");
                let recording_data = std::mem::take(&mut *samples);
                drop(samples);
                is_speaking.store(false, Ordering::SeqCst);
                *last_speech_time.lock().unwrap() = None;
                *recording_start.lock().unwrap() = None;
                finalize_recording(recording_data, sample_rate, app);
            }
        }
    } else if was_speaking {
        {
            let mut samples = recording_samples.lock().unwrap();
            samples.extend_from_slice(&mono_samples);
        }
        let last_time = last_speech_time.lock().unwrap();
        if let Some(last) = *last_time {
            let silence_duration = now.duration_since(last);
            if silence_duration > Duration::from_millis(SILENCE_DURATION_MS) {
                drop(last_time);
                let recording_start_time = recording_start.lock().unwrap();
                let duration_ms = recording_start_time
                    .map(|s| now.duration_since(s).as_millis() as u64)
                    .unwrap_or(0);
                drop(recording_start_time);
                if duration_ms >= MIN_RECORDING_MS {
                    log::info!(
                        "[Audio] Silence detected, finalizing recording ({} ms)",
                        duration_ms
                    );
                    let recording_data = {
                        let mut samples = recording_samples.lock().unwrap();
                        std::mem::take(&mut *samples)
                    };
                    is_speaking.store(false, Ordering::SeqCst);
                    *last_speech_time.lock().unwrap() = None;
                    *recording_start.lock().unwrap() = None;
                    finalize_recording(recording_data, sample_rate, app);
                } else {
                    log::debug!("[Audio] Recording too short, discarding");
                    recording_samples.lock().unwrap().clear();
                    is_speaking.store(false, Ordering::SeqCst);
                    *last_speech_time.lock().unwrap() = None;
                    *recording_start.lock().unwrap() = None;
                }
            }
        }
    }
}

fn finalize_recording<R: Runtime>(samples: Vec<f32>, sample_rate: u32, app: &AppHandle<R>) {
    if samples.is_empty() {
        return;
    }
    let duration_ms = (samples.len() as f32 / sample_rate as f32 * 1000.0) as u64;
    log::info!(
        "[Audio] Finalizing recording: {} samples, {} ms",
        samples.len(),
        duration_ms
    );
    let wav_bytes = encode_wav(&samples, sample_rate);
    let base64_audio = STANDARD.encode(&wav_bytes);
    log::info!(
        "[Audio] Encoded WAV: {} bytes, base64: {} chars",
        wav_bytes.len(),
        base64_audio.len()
    );
    let _ = app.emit("audio-recording", serde_json::json!({"audio_base64": base64_audio, "duration_ms": duration_ms, "sample_rate": sample_rate}));
}

fn encode_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let num_samples = samples.len();
    let bytes_per_sample = 2u16;
    let num_channels = 1u16;
    let byte_rate = sample_rate * num_channels as u32 * bytes_per_sample as u32;
    let block_align = num_channels * bytes_per_sample;
    let data_size = (num_samples * bytes_per_sample as usize) as u32;
    let file_size = 36 + data_size;
    let mut wav = Vec::with_capacity(44 + data_size as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&file_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&num_channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    for &sample in samples {
        let clamped = sample.max(-1.0).min(1.0);
        let pcm = (clamped * 32767.0) as i16;
        wav.extend_from_slice(&pcm.to_le_bytes());
    }
    wav
}

#[tauri::command]
async fn stop_audio_capture() -> Result<(), String> {
    let stop_tx = { AUDIO_STOP_TX.lock().unwrap().take() };
    if let Some(tx) = stop_tx {
        let _ = tx.send(());
        log::info!("[Audio] Sent stop signal");
    }
    IS_CAPTURING.store(false, Ordering::SeqCst);
    Ok(())
}

// ============================================================================
// ECHO CANCELLATION (AEC) - Prevents IRIS from hearing herself
// ============================================================================

/// Set the TTS reference signal for echo cancellation
/// Call this when IRIS starts speaking - pass the TTS audio samples
#[tauri::command]
async fn aec_set_reference(audio_base64: String, sample_rate: u32) -> Result<(), String> {
    log::info!(
        "[AEC] Setting reference signal ({} chars base64, {} Hz)",
        audio_base64.len(),
        sample_rate
    );

    // Decode base64 audio
    let audio_bytes = STANDARD
        .decode(&audio_base64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    // Parse as WAV or raw PCM - for simplicity, assume raw f32 or decode WAV
    let samples = decode_audio_to_f32(&audio_bytes, sample_rate)?;

    // Store reference signal
    {
        let mut ref_signal = AEC_REFERENCE_SIGNAL.lock().unwrap();
        *ref_signal = samples;
    }
    {
        let mut ref_index = AEC_REFERENCE_INDEX.lock().unwrap();
        *ref_index = 0;
    }
    {
        let mut start_time = AEC_START_TIME.lock().unwrap();
        *start_time = Some(Instant::now());
    }

    AEC_ACTIVE.store(true, Ordering::SeqCst);
    log::info!("[AEC] Reference signal set, echo cancellation active");

    Ok(())
}

/// Clear the reference signal (call when TTS finishes)
#[tauri::command]
async fn aec_clear_reference() -> Result<(), String> {
    AEC_ACTIVE.store(false, Ordering::SeqCst);
    {
        let mut ref_signal = AEC_REFERENCE_SIGNAL.lock().unwrap();
        ref_signal.clear();
    }
    {
        let mut ref_index = AEC_REFERENCE_INDEX.lock().unwrap();
        *ref_index = 0;
    }
    {
        let mut start_time = AEC_START_TIME.lock().unwrap();
        *start_time = None;
    }
    log::info!("[AEC] Reference signal cleared, echo cancellation disabled");
    Ok(())
}

/// Check if echo cancellation is currently active
#[tauri::command]
async fn aec_is_active() -> Result<bool, String> {
    Ok(AEC_ACTIVE.load(Ordering::SeqCst))
}

/// Decode audio bytes to f32 samples
fn decode_audio_to_f32(audio_bytes: &[u8], _target_sample_rate: u32) -> Result<Vec<f32>, String> {
    // Check for WAV header
    if audio_bytes.len() > 44 && &audio_bytes[0..4] == b"RIFF" && &audio_bytes[8..12] == b"WAVE" {
        // Parse WAV file
        let num_channels = u16::from_le_bytes([audio_bytes[22], audio_bytes[23]]) as usize;
        let sample_rate = u32::from_le_bytes([
            audio_bytes[24],
            audio_bytes[25],
            audio_bytes[26],
            audio_bytes[27],
        ]);
        let bits_per_sample = u16::from_le_bytes([audio_bytes[34], audio_bytes[35]]);

        log::info!(
            "[AEC] WAV: {} channels, {} Hz, {} bit",
            num_channels,
            sample_rate,
            bits_per_sample
        );

        // Find data chunk
        let mut data_start = 44;
        if &audio_bytes[36..40] != b"data" {
            // Search for data chunk
            for i in 36..audio_bytes.len() - 8 {
                if &audio_bytes[i..i + 4] == b"data" {
                    data_start = i + 8;
                    break;
                }
            }
        }

        let data = &audio_bytes[data_start..];
        let mut samples = Vec::new();

        match bits_per_sample {
            16 => {
                for chunk in data.chunks(2 * num_channels) {
                    if chunk.len() >= 2 {
                        let sample = i16::from_le_bytes([chunk[0], chunk[1]]);
                        samples.push(sample as f32 / 32768.0);
                    }
                }
            }
            32 => {
                for chunk in data.chunks(4 * num_channels) {
                    if chunk.len() >= 4 {
                        let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                        samples.push(sample);
                    }
                }
            }
            _ => return Err(format!("Unsupported bit depth: {}", bits_per_sample)),
        }

        Ok(samples)
    } else {
        // Assume raw f32 samples
        let mut samples = Vec::new();
        for chunk in audio_bytes.chunks(4) {
            if chunk.len() == 4 {
                let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                samples.push(sample);
            }
        }
        Ok(samples)
    }
}

/// Apply echo cancellation to incoming audio
/// Returns the suppressed audio and whether echo was detected
fn apply_echo_cancellation(input_samples: &[f32]) -> (Vec<f32>, bool) {
    if !AEC_ACTIVE.load(Ordering::SeqCst) {
        return (input_samples.to_vec(), false);
    }

    let ref_signal = AEC_REFERENCE_SIGNAL.lock().unwrap();
    let mut ref_index = AEC_REFERENCE_INDEX.lock().unwrap();

    if ref_signal.is_empty() {
        return (input_samples.to_vec(), false);
    }

    // Get the corresponding reference segment
    let ref_len = ref_signal.len();
    let input_len = input_samples.len();

    if *ref_index >= ref_len {
        // Past the reference signal - no more echo expected
        return (input_samples.to_vec(), false);
    }

    // Get reference segment (with some tolerance for timing drift)
    let ref_start = (*ref_index).saturating_sub(input_len / 2);
    let ref_end = (*ref_index + input_len * 2).min(ref_len);
    let ref_segment = &ref_signal[ref_start..ref_end];

    // Compute cross-correlation to detect echo
    let correlation = compute_correlation(input_samples, ref_segment);

    // Update reference index
    *ref_index += input_len;

    if correlation > AEC_CORRELATION_THRESHOLD {
        // Echo detected - suppress the input
        log::debug!(
            "[AEC] Echo detected (correlation: {:.2}), suppressing",
            correlation
        );

        let suppressed: Vec<f32> = input_samples
            .iter()
            .map(|&s| s * AEC_SUPPRESSION_FACTOR)
            .collect();

        return (suppressed, true);
    }

    (input_samples.to_vec(), false)
}

/// Compute normalized cross-correlation between two signals
fn compute_correlation(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }

    let len = a.len().min(b.len());

    // Compute means
    let mean_a: f32 = a[..len].iter().sum::<f32>() / len as f32;
    let mean_b: f32 = b[..len].iter().sum::<f32>() / len as f32;

    // Compute correlation
    let mut num = 0.0f32;
    let mut den_a = 0.0f32;
    let mut den_b = 0.0f32;

    for i in 0..len {
        let da = a[i] - mean_a;
        let db = b[i] - mean_b;
        num += da * db;
        den_a += da * da;
        den_b += db * db;
    }

    let den = (den_a * den_b).sqrt();
    if den < 1e-10 {
        return 0.0;
    }

    (num / den).abs()
}

// ============================================================================
// END ECHO CANCELLATION
// ============================================================================

#[tauri::command]
async fn capture_screen() -> Result<ScreenshotResult, String> {
    let screens = Screen::all().map_err(|e| e.to_string())?;
    if screens.is_empty() {
        return Err("No screens found".to_string());
    }

    log::info!("[capture_screen] Found {} monitors", screens.len());
    for (i, s) in screens.iter().enumerate() {
        let info = s.display_info;
        log::info!(
            "[capture_screen] Monitor {}: {}x{} at ({}, {})",
            i,
            info.width,
            info.height,
            info.x,
            info.y
        );
    }

    // Capture all screens and stitch them horizontally
    let mut captured_images: Vec<image::RgbaImage> = Vec::new();
    let mut total_width: u32 = 0;
    let mut max_height: u32 = 0;

    for screen in screens.iter() {
        let img = screen.capture().map_err(|e| e.to_string())?;
        total_width += img.width();
        max_height = max_height.max(img.height());
        captured_images.push(img);
    }

    // Create combined image canvas
    let mut combined = image::RgbaImage::new(total_width, max_height);

    // Fill with black background (in case monitors have different heights)
    for pixel in combined.pixels_mut() {
        *pixel = image::Rgba([0, 0, 0, 255]);
    }

    // Overlay each screen at correct x offset
    let mut x_offset: u32 = 0;
    for img in captured_images {
        for (x, y, pixel) in img.enumerate_pixels() {
            if x + x_offset < total_width && y < max_height {
                combined.put_pixel(x + x_offset, y, *pixel);
            }
        }
        x_offset += img.width();
    }

    let mut bytes: Vec<u8> = Vec::new();
    let mut cursor = Cursor::new(&mut bytes);
    image::DynamicImage::ImageRgba8(combined)
        .write_to(&mut cursor, image::ImageOutputFormat::Jpeg(80))
        .map_err(|e| e.to_string())?;
    log::info!(
        "[capture_screen] Combined screenshot: {}x{} ({} bytes)",
        total_width,
        max_height,
        bytes.len()
    );
    Ok(ScreenshotResult {
        base64: STANDARD.encode(&bytes),
        width: total_width,
        height: max_height,
    })
}

#[tauri::command]
async fn capture_screen_by_index(index: usize) -> Result<ScreenshotResult, String> {
    let screens = Screen::all().map_err(|e| e.to_string())?;
    if index >= screens.len() {
        return Err(format!("Screen index {} out of range", index));
    }
    let screen = &screens[index];
    let image = screen.capture().map_err(|e| e.to_string())?;
    let width = image.width();
    let height = image.height();
    let mut bytes: Vec<u8> = Vec::new();
    let mut cursor = Cursor::new(&mut bytes);
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut cursor, image::ImageOutputFormat::Jpeg(80))
        .map_err(|e| e.to_string())?;
    Ok(ScreenshotResult {
        base64: STANDARD.encode(&bytes),
        width,
        height,
    })
}

#[tauri::command]
async fn get_screen_count() -> Result<usize, String> {
    let screens = Screen::all().map_err(|e| e.to_string())?;
    Ok(screens.len())
}

/// Capture all displays as separate screenshots with metadata
/// Returns array of screenshots, one per display, with position/size info
#[tauri::command]
async fn capture_all_displays() -> Result<Vec<DisplayScreenshot>, String> {
    let screens = Screen::all().map_err(|e| e.to_string())?;
    if screens.is_empty() {
        return Err("No screens found".to_string());
    }

    log::info!(
        "[capture_all_displays] Capturing {} displays separately",
        screens.len()
    );

    let mut results = Vec::new();

    for (i, screen) in screens.iter().enumerate() {
        let info = screen.display_info;
        let is_primary = info.is_primary;

        // Capture this display
        let image = screen
            .capture()
            .map_err(|e| format!("Failed to capture display {}: {}", i, e))?;
        let width = image.width();
        let height = image.height();

        let mut bytes: Vec<u8> = Vec::new();
        let mut cursor = Cursor::new(&mut bytes);
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut cursor, image::ImageOutputFormat::Jpeg(80))
            .map_err(|e| e.to_string())?;

        let display_name = if is_primary {
            format!("Display {} (Primary)", i + 1)
        } else {
            format!("Display {}", i + 1)
        };

        let scale = info.scale_factor;
        log::info!(
            "[capture_all_displays] {} - {}x{} at ({}, {}) scale={:.2}",
            display_name,
            width,
            height,
            info.x,
            info.y,
            scale
        );

        results.push(DisplayScreenshot {
            base64: STANDARD.encode(&bytes),
            width,
            height,
            display_index: i,
            display_name,
            x: info.x,
            y: info.y,
            is_primary,
            scale_factor: scale,
        });
    }

    Ok(results)
}

#[tauri::command]
async fn toggle_window<R: Runtime>(window: tauri::Window<R>) -> Result<(), String> {
    if window.is_visible().unwrap_or(false) {
        window.hide().map_err(|e| e.to_string())?;
    } else {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn show_window<R: Runtime>(window: tauri::Window<R>) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn hide_window<R: Runtime>(window: tauri::Window<R>) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn minimize_window<R: Runtime>(window: tauri::Window<R>) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn show_canvas_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("canvas") {
        if window.is_minimized().unwrap_or(false) {
            window.unminimize().map_err(|e| e.to_string())?;
        }
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn set_always_on_top<R: Runtime>(
    window: tauri::Window<R>,
    always: bool,
) -> Result<(), String> {
    window
        .set_always_on_top(always)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn set_click_through<R: Runtime>(
    window: tauri::Window<R>,
    ignore: bool,
) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())?;
    log::info!("[Window] Click-through set to: {}", ignore);
    Ok(())
}

#[tauri::command]
async fn quit_app<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn move_window<R: Runtime>(window: tauri::Window<R>, position: String) -> Result<(), String> {
    use tauri::PhysicalPosition;

    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("No monitor found")?;

    let monitor_size = monitor.size();
    let window_size = window.outer_size().map_err(|e| e.to_string())?;
    let current_pos = window.outer_position().map_err(|e| e.to_string())?;

    let padding = 50i32;
    let taskbar_offset = 80i32;
    let move_step = 200i32; // How far to move for relative movements

    // Helper calculations
    let screen_w = monitor_size.width as i32;
    let screen_h = monitor_size.height as i32;
    let win_w = window_size.width as i32;
    let win_h = window_size.height as i32;
    let center_x = (screen_w - win_w) / 2;
    let center_y = (screen_h - win_h) / 2;
    let max_x = screen_w - win_w - padding;
    let max_y = screen_h - win_h - taskbar_offset;

    let (x, y) = match position.to_lowercase().as_str() {
        // Corners
        "top-left" => (padding, padding),
        "top-right" => (max_x, padding),
        "bottom-left" => (padding, max_y),
        "bottom-right" => (max_x, max_y),

        // Center
        "center" => (center_x, center_y),

        // Edges (centered on that edge)
        "left" | "left-side" => (padding, center_y),
        "right" | "right-side" => (max_x, center_y),
        "top" | "top-side" => (center_x, padding),
        "bottom" | "bottom-side" => (center_x, max_y),

        // Middle positions (between center and corners)
        "top-center" => (center_x, padding),
        "bottom-center" => (center_x, max_y),
        "left-center" | "center-left" => (padding, center_y),
        "right-center" | "center-right" => (max_x, center_y),

        // Relative movements (from current position)
        "up" | "move-up" => (current_pos.x, (current_pos.y - move_step).max(padding)),
        "down" | "move-down" => (current_pos.x, (current_pos.y + move_step).min(max_y)),
        "left-rel" | "move-left" => ((current_pos.x - move_step).max(padding), current_pos.y),
        "right-rel" | "move-right" => ((current_pos.x + move_step).min(max_x), current_pos.y),

        // Diagonal relative movements
        "up-left" => (
            (current_pos.x - move_step).max(padding),
            (current_pos.y - move_step).max(padding),
        ),
        "up-right" => (
            (current_pos.x + move_step).min(max_x),
            (current_pos.y - move_step).max(padding),
        ),
        "down-left" => (
            (current_pos.x - move_step).max(padding),
            (current_pos.y + move_step).min(max_y),
        ),
        "down-right" => (
            (current_pos.x + move_step).min(max_x),
            (current_pos.y + move_step).min(max_y),
        ),

        // Fun aliases
        "away" | "out-of-way" => (max_x, padding), // Default to top-right when told to get away
        "back" | "home" => (center_x, center_y),   // Return to center

        // Snap to half screen (also resizes window)
        "snap-left" | "left-half" => {
            let half_w = (screen_w / 2) as u32;
            let snap_h = (screen_h - taskbar_offset) as u32;
            window
                .set_size(tauri::PhysicalSize::new(half_w, snap_h))
                .map_err(|e| e.to_string())?;
            (0, 0)
        }
        "snap-right" | "right-half" => {
            let half_w = (screen_w / 2) as u32;
            let snap_h = (screen_h - taskbar_offset) as u32;
            window
                .set_size(tauri::PhysicalSize::new(half_w, snap_h))
                .map_err(|e| e.to_string())?;
            (screen_w / 2, 0)
        }

        _ => return Err(format!("Unknown position: {}", position)),
    };

    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

// =============================================================================
// MONITOR CONTROL
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub is_primary: bool,
    pub scale_factor: f64,
}

/// Get list of all connected monitors
#[tauri::command]
async fn get_monitors<R: Runtime>(window: tauri::Window<R>) -> Result<Vec<MonitorInfo>, String> {
    let monitors: Vec<tauri::Monitor> = window.available_monitors().map_err(|e| e.to_string())?;
    let current = window.current_monitor().map_err(|e| e.to_string())?;
    let current_name = current.as_ref().and_then(|m| m.name());

    let mut result = Vec::new();
    for (index, monitor) in monitors.into_iter().enumerate() {
        let size = monitor.size();
        let position = monitor.position();
        let name = monitor
            .name()
            .map(|s| s.clone())
            .unwrap_or_else(|| format!("Monitor {}", index + 1));
        let is_primary = current_name
            .as_ref()
            .map(|cn| **cn == name)
            .unwrap_or(index == 0);

        result.push(MonitorInfo {
            index,
            name: name.clone(),
            width: size.width,
            height: size.height,
            x: position.x,
            y: position.y,
            is_primary,
            scale_factor: monitor.scale_factor(),
        });
    }

    log::info!("[Monitor] Found {} monitors", result.len());
    Ok(result)
}

/// Move window to a specific monitor by index (0-based) or "other"/"next" for cycling
#[tauri::command]
async fn move_to_monitor<R: Runtime>(
    window: tauri::Window<R>,
    target: String,
) -> Result<String, String> {
    use tauri::PhysicalPosition;

    let monitors: Vec<tauri::Monitor> = window.available_monitors().map_err(|e| e.to_string())?;

    if monitors.is_empty() {
        return Err("No monitors found".to_string());
    }

    if monitors.len() == 1 {
        return Ok("Only one monitor connected".to_string());
    }

    // Find current monitor index
    let current_pos = window.outer_position().map_err(|e| e.to_string())?;
    let mut current_index = 0;
    for (i, monitor) in monitors.iter().enumerate() {
        let pos = monitor.position();
        let size = monitor.size();
        if current_pos.x >= pos.x
            && current_pos.x < pos.x + size.width as i32
            && current_pos.y >= pos.y
            && current_pos.y < pos.y + size.height as i32
        {
            current_index = i;
            break;
        }
    }

    // Determine target monitor (user inputs are 1-based, internal is 0-based)
    let target_lower = target.to_lowercase();
    let target_index = match target_lower.as_str() {
        "other" | "next" | "switch" => (current_index + 1) % monitors.len(),
        "previous" | "prev" => {
            if current_index == 0 {
                monitors.len() - 1
            } else {
                current_index - 1
            }
        }
        "primary" | "main" | "first" => 0,
        "secondary" | "second" => 1.min(monitors.len() - 1),
        "third" => 2.min(monitors.len() - 1),
        // Numbers are 1-based from user ("display 3" = index 2)
        _ => {
            let num = target.parse::<usize>().unwrap_or(1);
            (num.saturating_sub(1)).min(monitors.len() - 1)
        }
    };

    if target_index == current_index {
        return Ok(format!("Already on monitor {}", target_index + 1));
    }

    let target_monitor = &monitors[target_index];
    let target_pos = target_monitor.position();
    let target_size = target_monitor.size();

    // Center window on target monitor
    let window_size = window.outer_size().map_err(|e| e.to_string())?;
    let new_x = target_pos.x + (target_size.width as i32 - window_size.width as i32) / 2;
    let new_y = target_pos.y + (target_size.height as i32 - window_size.height as i32) / 2;

    window
        .set_position(PhysicalPosition::new(new_x, new_y))
        .map_err(|e| e.to_string())?;

    let monitor_name = target_monitor
        .name()
        .map(|s| s.clone())
        .unwrap_or_else(|| format!("Monitor {}", target_index + 1));
    log::info!(
        "[Monitor] Moved to monitor {}: {}",
        target_index + 1,
        monitor_name
    );
    Ok(format!("Moved to {}", monitor_name))
}

/// Turn off all monitors (Windows only)
/// Uses PostMessage to the current thread's desktop window instead of HWND_BROADCAST
/// to avoid affecting docking stations, keyboards, and other USB devices.
async fn turn_off_monitors() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;

        // Use PowerShell to turn off monitors - much safer than HWND_BROADCAST
        // This uses the same API but targets only the console session's monitors
        let script = r#"
            Add-Type -TypeDefinition @"
            using System;
            using System.Runtime.InteropServices;
            public class MonitorControl {
                [DllImport("user32.dll")]
                private static extern IntPtr GetDesktopWindow();

                [DllImport("user32.dll")]
                private static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

                private const uint WM_SYSCOMMAND = 0x0112;
                private const int SC_MONITORPOWER = 0xF170;

                public static void TurnOff() {
                    // Send to desktop window only, not broadcast
                    IntPtr desktop = GetDesktopWindow();
                    SendMessage(desktop, WM_SYSCOMMAND, (IntPtr)SC_MONITORPOWER, (IntPtr)2);
                }
            }
"@
            [MonitorControl]::TurnOff()
        "#;

        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", script])
            .output()
            .map_err(|e| format!("Failed to run PowerShell: {}", e))?;

        if output.status.success() {
            log::info!("[Monitor] Sent targeted monitor power off signal");
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&output.stderr);
            log::error!("[Monitor] PowerShell error: {}", err);
            Err(format!("Failed to turn off monitors: {}", err))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Monitor power control only supported on Windows".to_string())
    }
}

#[derive(serde::Serialize)]
struct LaunchResult {
    success: bool,
    app_name: String,
    message: String,
}

async fn launch_app(app_name: String) -> Result<LaunchResult, String> {
    use std::process::Command;

    let app_lower = app_name.to_lowercase();

    // Map common app names to Windows commands/executables
    // NOTE: For `start` command, the first quoted arg is window title - use "" for title
    let (cmd, args): (&str, Vec<&str>) = match app_lower.as_str() {
        // Browsers - use "" as window title for start command
        "chrome" | "google chrome" | "browser" => ("cmd", vec!["/C", "start", "", "chrome"]),
        "firefox" | "mozilla" => ("cmd", vec!["/C", "start", "", "firefox"]),
        "edge" | "microsoft edge" => ("cmd", vec!["/C", "start", "", "msedge"]),
        "brave" => ("cmd", vec!["/C", "start", "", "brave"]),

        // Development. Terminals and command shells are deliberately absent: keyboard
        // composition must not reconstruct arbitrary shell execution.
        "vscode" | "vs code" | "visual studio code" | "code" => ("cmd", vec!["/C", "code"]),

        // Communication
        "discord" => ("cmd", vec!["/C", "start", "", "discord:"]),
        "slack" => ("cmd", vec!["/C", "start", "", "slack:"]),
        "teams" | "microsoft teams" => ("cmd", vec!["/C", "start", "", "msteams:"]),
        "zoom" => ("cmd", vec!["/C", "start", "", "zoommtg:"]),

        // Media
        "spotify" => ("cmd", vec!["/C", "start", "", "spotify:"]),
        "vlc" => ("cmd", vec!["/C", "start", "", "vlc"]),

        // Productivity
        "notepad" | "notes" => ("notepad", vec![]),
        "calculator" | "calc" => ("calc", vec![]),
        "word" | "microsoft word" => ("cmd", vec!["/C", "start", "", "winword"]),
        "excel" | "microsoft excel" => ("cmd", vec!["/C", "start", "", "excel"]),
        "powerpoint" | "microsoft powerpoint" => ("cmd", vec!["/C", "start", "", "powerpnt"]),
        "outlook" | "email" | "mail" => ("cmd", vec!["/C", "start", "", "outlook"]),

        // System
        "explorer" | "file explorer" | "files" | "folder" | "folders" => ("explorer", vec![]),
        "settings" | "windows settings" => ("cmd", vec!["/C", "start", "", "ms-settings:"]),
        "control panel" => ("control", vec![]),
        "task manager" => ("taskmgr", vec![]),
        "device manager" => ("devmgmt.msc", vec![]),

        // Games/Entertainment
        "steam" => ("cmd", vec!["/C", "start", "", "steam:"]),
        "epic" | "epic games" => ("cmd", vec!["/C", "start", "", "com.epicgames.launcher:"]),

        // Do not turn model-provided text into an arbitrary executable or shell command.
        _ => {
            return Err(format!(
                "Application '{}' is not in the IRIS launch allowlist",
                app_name
            ))
        }
    };

    let result = Command::new(cmd).args(&args).spawn();

    match result {
        Ok(_) => Ok(LaunchResult {
            success: true,
            app_name: app_name.clone(),
            message: format!("Launched {}", app_name),
        }),
        Err(e) => Ok(LaunchResult {
            success: false,
            app_name: app_name.clone(),
            message: format!("Failed to launch {}: {}", app_name, e),
        }),
    }
}

/// Open a specific folder path in the system file explorer
#[tauri::command]
async fn open_folder(path: String) -> Result<String, String> {
    use std::process::Command;
    validate_local_path(&path, true)?;
    if !std::path::Path::new(&path).is_dir() {
        return Err("Path is not a directory".to_string());
    }
    log::info!("Opening folder: {}", path);

    #[cfg(target_os = "windows")]
    {
        // Use "explorer path" to open folder
        let _status = Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to run explorer: {}", e))?;

        Ok(format!("Opened folder: {}", path))
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to run open: {}", e))?;
        Ok(format!("Opened folder: {}", path))
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to run xdg-open: {}", e))?;
        Ok(format!("Opened folder: {}", path))
    }
}

// ==================== SYSTEM UTILITIES ====================

#[derive(serde::Serialize)]
struct SystemStats {
    cpu_usage: f32,
    memory_used_gb: f32,
    memory_total_gb: f32,
    memory_percent: f32,
    battery_percent: Option<u8>,
    battery_charging: Option<bool>,
}

#[tauri::command]
async fn get_system_stats() -> Result<SystemStats, String> {
    use std::process::Command;

    // Get CPU usage via PowerShell
    let cpu_output = Command::new("powershell")
        .args(&[
            "-Command",
            "(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    let cpu_usage: f32 = String::from_utf8_lossy(&cpu_output.stdout)
        .trim()
        .parse()
        .unwrap_or(0.0);

    // Get memory info via PowerShell
    let mem_output = Command::new("powershell")
        .args(&["-Command", "$m=Get-CimInstance Win32_OperatingSystem; \"$($m.TotalVisibleMemorySize),$($m.FreePhysicalMemory)\""])
        .output()
        .map_err(|e| e.to_string())?;
    let mem_str = String::from_utf8_lossy(&mem_output.stdout);
    let mem_parts: Vec<&str> = mem_str.trim().split(',').collect();
    let total_kb: f32 = mem_parts.get(0).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let free_kb: f32 = mem_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let used_kb = total_kb - free_kb;
    let memory_total_gb = total_kb / 1024.0 / 1024.0;
    let memory_used_gb = used_kb / 1024.0 / 1024.0;
    let memory_percent = if total_kb > 0.0 {
        (used_kb / total_kb) * 100.0
    } else {
        0.0
    };

    // Get battery info via PowerShell
    let bat_output = Command::new("powershell")
        .args(&["-Command", "$b=Get-CimInstance Win32_Battery; if($b){\"$($b.EstimatedChargeRemaining),$($b.BatteryStatus)\"}else{'none'}"])
        .output()
        .map_err(|e| e.to_string())?;
    let bat_str = String::from_utf8_lossy(&bat_output.stdout)
        .trim()
        .to_string();
    let (battery_percent, battery_charging) = if bat_str == "none" || bat_str.is_empty() {
        (None, None)
    } else {
        let bat_parts: Vec<&str> = bat_str.split(',').collect();
        let percent: Option<u8> = bat_parts.get(0).and_then(|s| s.parse().ok());
        let status: Option<u8> = bat_parts.get(1).and_then(|s| s.parse().ok());
        let charging = status.map(|s| s == 2); // 2 = charging
        (percent, charging)
    };

    Ok(SystemStats {
        cpu_usage,
        memory_used_gb,
        memory_total_gb,
        memory_percent,
        battery_percent,
        battery_charging,
    })
}

// ==================== BACKGROUND SYSTEM MONITOR (Phase 3: The Interrupter) ====================
// Continuously monitors system state and emits events when thresholds are crossed
// This allows IRIS to proactively alert the user about battery, memory, CPU issues

#[derive(Clone, Serialize)]
struct SystemAlert {
    alert_type: String,
    message: String,
    severity: String, // "info", "warning", "critical"
    value: f32,
    threshold: f32,
}

#[derive(Clone, Serialize, Deserialize)]
struct MonitorThresholds {
    battery_low: u8,            // Default: 20%
    battery_critical: u8,       // Default: 10%
    memory_high: f32,           // Default: 85%
    memory_critical: f32,       // Default: 95%
    cpu_high: f32,              // Default: 90%
    cpu_sustained_seconds: u64, // Default: 30s - CPU must be high for this long to alert
}

impl Default for MonitorThresholds {
    fn default() -> Self {
        Self {
            battery_low: 20,
            battery_critical: 10,
            memory_high: 85.0,
            memory_critical: 95.0,
            cpu_high: 90.0,
            cpu_sustained_seconds: 30,
        }
    }
}

#[tauri::command]
async fn start_system_monitor<R: Runtime + 'static>(
    app: AppHandle<R>,
    thresholds: Option<MonitorThresholds>,
) -> Result<String, String> {
    if IS_MONITORING.load(Ordering::SeqCst) {
        return Err("System monitor already running".to_string());
    }

    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    {
        let mut tx_guard = SYSTEM_MONITOR_STOP_TX.lock().unwrap();
        *tx_guard = Some(stop_tx);
    }

    let config = thresholds.unwrap_or_default();
    IS_MONITORING.store(true, Ordering::SeqCst);

    std::thread::spawn(move || {
        log::info!(
            "[SystemMonitor] Started with thresholds: battery_low={}, memory_high={}, cpu_high={}",
            config.battery_low,
            config.memory_high,
            config.cpu_high
        );

        let mut last_battery_alert: Option<Instant> = None;
        let mut last_memory_alert: Option<Instant> = None;
        let mut last_cpu_alert: Option<Instant> = None;
        let mut cpu_high_start: Option<Instant> = None;
        let mut last_battery_level: Option<u8> = None;

        let alert_cooldown = Duration::from_secs(300); // 5 min between repeated alerts
        let poll_interval = Duration::from_secs(10); // Check every 10 seconds

        loop {
            // Check for stop signal
            if stop_rx.try_recv().is_ok() {
                log::info!("[SystemMonitor] Received stop signal");
                break;
            }

            // Get system stats using PowerShell (same as get_system_stats but synchronous)
            if let Ok(stats) = get_system_stats_sync() {
                let now = Instant::now();

                // === BATTERY MONITORING ===
                if let Some(battery) = stats.battery_percent {
                    let charging = stats.battery_charging.unwrap_or(false);

                    // Only alert if NOT charging
                    if !charging {
                        // Critical battery (10%)
                        if battery <= config.battery_critical {
                            if should_alert(&last_battery_alert, alert_cooldown, now) {
                                let alert = SystemAlert {
                                    alert_type: "battery_critical".to_string(),
                                    message: format!(
                                        "Battery critically low at {}%! Plug in immediately.",
                                        battery
                                    ),
                                    severity: "critical".to_string(),
                                    value: battery as f32,
                                    threshold: config.battery_critical as f32,
                                };
                                let _ = app.emit("system-alert", &alert);
                                let _ = app.emit("iris-speak", serde_json::json!({
                                    "text": format!("Warning! Your battery is critically low at {}%. Please plug in your charger immediately.", battery),
                                    "priority": "high"
                                }));
                                last_battery_alert = Some(now);
                                log::warn!("[SystemMonitor] CRITICAL: Battery at {}%", battery);
                            }
                        }
                        // Low battery (20%)
                        else if battery <= config.battery_low {
                            if should_alert(&last_battery_alert, alert_cooldown, now) {
                                let alert = SystemAlert {
                                    alert_type: "battery_low".to_string(),
                                    message: format!("Battery is getting low at {}%.", battery),
                                    severity: "warning".to_string(),
                                    value: battery as f32,
                                    threshold: config.battery_low as f32,
                                };
                                let _ = app.emit("system-alert", &alert);
                                let _ = app.emit("iris-speak", serde_json::json!({
                                    "text": format!("Heads up - your battery is at {}%. You might want to plug in soon.", battery),
                                    "priority": "normal"
                                }));
                                last_battery_alert = Some(now);
                                log::info!("[SystemMonitor] LOW: Battery at {}%", battery);
                            }
                        }
                    }

                    // Notify when plugged in after being low
                    if charging {
                        if let Some(last_level) = last_battery_level {
                            if last_level <= config.battery_low && battery > last_level {
                                let _ = app.emit(
                                    "iris-speak",
                                    serde_json::json!({
                                        "text": "I see you've plugged in. Good call.",
                                        "priority": "low"
                                    }),
                                );
                            }
                        }
                    }

                    last_battery_level = Some(battery);
                }

                // === MEMORY MONITORING ===
                let memory_percent = stats.memory_percent;

                if memory_percent >= config.memory_critical {
                    if should_alert(&last_memory_alert, alert_cooldown, now) {
                        let alert = SystemAlert {
                            alert_type: "memory_critical".to_string(),
                            message: format!(
                                "Memory usage critical at {:.0}%! System may become unstable.",
                                memory_percent
                            ),
                            severity: "critical".to_string(),
                            value: memory_percent,
                            threshold: config.memory_critical,
                        };
                        let _ = app.emit("system-alert", &alert);
                        let _ = app.emit("iris-speak", serde_json::json!({
                            "text": format!("Warning - memory usage is at {:.0}%. Your system might slow down or crash. Consider closing some applications.", memory_percent),
                            "priority": "high"
                        }));
                        last_memory_alert = Some(now);
                        log::warn!("[SystemMonitor] CRITICAL: Memory at {:.0}%", memory_percent);
                    }
                } else if memory_percent >= config.memory_high {
                    if should_alert(&last_memory_alert, alert_cooldown, now) {
                        let alert = SystemAlert {
                            alert_type: "memory_high".to_string(),
                            message: format!("Memory usage is high at {:.0}%.", memory_percent),
                            severity: "warning".to_string(),
                            value: memory_percent,
                            threshold: config.memory_high,
                        };
                        let _ = app.emit("system-alert", &alert);
                        last_memory_alert = Some(now);
                        log::info!("[SystemMonitor] HIGH: Memory at {:.0}%", memory_percent);
                    }
                }

                // === CPU MONITORING (sustained high usage) ===
                let cpu = stats.cpu_usage;

                if cpu >= config.cpu_high {
                    if cpu_high_start.is_none() {
                        cpu_high_start = Some(now);
                    } else if let Some(start) = cpu_high_start {
                        let duration = now.duration_since(start);
                        if duration >= Duration::from_secs(config.cpu_sustained_seconds) {
                            if should_alert(&last_cpu_alert, alert_cooldown, now) {
                                let alert = SystemAlert {
                                    alert_type: "cpu_sustained_high".to_string(),
                                    message: format!(
                                        "CPU has been running at {:.0}% for over {} seconds.",
                                        cpu, config.cpu_sustained_seconds
                                    ),
                                    severity: "warning".to_string(),
                                    value: cpu,
                                    threshold: config.cpu_high,
                                };
                                let _ = app.emit("system-alert", &alert);
                                let _ = app.emit("iris-speak", serde_json::json!({
                                    "text": format!("Your CPU has been running hot at {:.0}% for a while. Something might be using a lot of resources.", cpu),
                                    "priority": "normal"
                                }));
                                last_cpu_alert = Some(now);
                                log::info!("[SystemMonitor] SUSTAINED HIGH: CPU at {:.0}%", cpu);
                            }
                        }
                    }
                } else {
                    cpu_high_start = None; // Reset if CPU drops below threshold
                }

                // Emit periodic stats for UI (every poll)
                let _ = app.emit("system-stats", &stats);
            }

            std::thread::sleep(poll_interval);
        }

        IS_MONITORING.store(false, Ordering::SeqCst);
        log::info!("[SystemMonitor] Stopped");
    });

    Ok("System monitor started".to_string())
}

fn should_alert(last_alert: &Option<Instant>, cooldown: Duration, now: Instant) -> bool {
    match last_alert {
        None => true,
        Some(last) => now.duration_since(*last) >= cooldown,
    }
}

// Synchronous version for the monitor thread
fn get_system_stats_sync() -> Result<SystemStats, String> {
    use std::process::Command;

    // Get CPU usage
    let cpu_output = Command::new("powershell")
        .args(&[
            "-Command",
            "(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    let cpu_usage: f32 = String::from_utf8_lossy(&cpu_output.stdout)
        .trim()
        .parse()
        .unwrap_or(0.0);

    // Get memory info
    let mem_output = Command::new("powershell")
        .args(&["-Command", "$m=Get-CimInstance Win32_OperatingSystem; \"$($m.TotalVisibleMemorySize),$($m.FreePhysicalMemory)\""])
        .output()
        .map_err(|e| e.to_string())?;
    let mem_str = String::from_utf8_lossy(&mem_output.stdout);
    let mem_parts: Vec<&str> = mem_str.trim().split(',').collect();
    let total_kb: f32 = mem_parts.get(0).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let free_kb: f32 = mem_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let used_kb = total_kb - free_kb;
    let memory_total_gb = total_kb / 1024.0 / 1024.0;
    let memory_used_gb = used_kb / 1024.0 / 1024.0;
    let memory_percent = if total_kb > 0.0 {
        (used_kb / total_kb) * 100.0
    } else {
        0.0
    };

    // Get battery info
    let bat_output = Command::new("powershell")
        .args(&["-Command", "$b=Get-CimInstance Win32_Battery; if($b){\"$($b.EstimatedChargeRemaining),$($b.BatteryStatus)\"}else{'none'}"])
        .output()
        .map_err(|e| e.to_string())?;
    let bat_str = String::from_utf8_lossy(&bat_output.stdout)
        .trim()
        .to_string();
    let (battery_percent, battery_charging) = if bat_str == "none" || bat_str.is_empty() {
        (None, None)
    } else {
        let bat_parts: Vec<&str> = bat_str.split(',').collect();
        let percent: Option<u8> = bat_parts.get(0).and_then(|s| s.parse().ok());
        let status: Option<u8> = bat_parts.get(1).and_then(|s| s.parse().ok());
        let charging = status.map(|s| s == 2);
        (percent, charging)
    };

    Ok(SystemStats {
        cpu_usage,
        memory_used_gb,
        memory_total_gb,
        memory_percent,
        battery_percent,
        battery_charging,
    })
}

#[tauri::command]
async fn stop_system_monitor() -> Result<String, String> {
    let stop_tx = { SYSTEM_MONITOR_STOP_TX.lock().unwrap().take() };
    if let Some(tx) = stop_tx {
        let _ = tx.send(());
        log::info!("[SystemMonitor] Sent stop signal");
    }
    IS_MONITORING.store(false, Ordering::SeqCst);
    Ok("System monitor stopped".to_string())
}

#[tauri::command]
async fn is_system_monitor_running() -> bool {
    IS_MONITORING.load(Ordering::SeqCst)
}

#[tauri::command]
async fn set_volume(level: u8) -> Result<String, String> {
    let level = level.min(100);

    // Use PowerShell to set volume via key presses (volume down 50x, then up level/2x)
    let script =
        "$steps = [int]$env:IRIS_VOLUME_STEPS; \
         $sig = '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);'; \
         Add-Type -MemberDefinition $sig -Name U32 -Namespace W; \
         1..50 | ForEach-Object { [W.U32]::keybd_event(0xAE, 0, 0, 0); [W.U32]::keybd_event(0xAE, 0, 2, 0) }; \
         if ($steps -gt 0) { 1..$steps | ForEach-Object { [W.U32]::keybd_event(0xAF, 0, 0, 0); [W.U32]::keybd_event(0xAF, 0, 2, 0) } }";

    powershell_with_data(script, &[("IRIS_VOLUME_STEPS", &(level / 2).to_string())])
        .output()
        .map_err(|e| e.to_string())?;

    Ok(format!("Volume set to {}%", level))
}

#[tauri::command]
async fn adjust_volume(direction: String) -> Result<String, String> {
    let key = match direction.to_lowercase().as_str() {
        "up" | "increase" | "raise" | "louder" => "0xAF", // VK_VOLUME_UP
        "down" | "decrease" | "lower" | "quieter" => "0xAE", // VK_VOLUME_DOWN
        "mute" | "toggle_mute" => "0xAD",                 // VK_VOLUME_MUTE
        _ => return Err(format!("Unknown direction: {}", direction)),
    };

    // Press volume key multiple times for noticeable change
    let times = if key == "0xAD" { 1 } else { 5 };
    let script =
        "$key = [Convert]::ToByte($env:IRIS_MEDIA_KEY.Replace('0x',''), 16); $times = [int]$env:IRIS_KEY_TIMES; \
         $sig = '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);'; \
         Add-Type -MemberDefinition $sig -Name U32 -Namespace W; \
         1..$times | ForEach-Object { [W.U32]::keybd_event($key, 0, 0, 0); [W.U32]::keybd_event($key, 0, 2, 0); Start-Sleep -Milliseconds 50 }";

    powershell_with_data(
        script,
        &[
            ("IRIS_MEDIA_KEY", key),
            ("IRIS_KEY_TIMES", &times.to_string()),
        ],
    )
    .output()
    .map_err(|e| e.to_string())?;

    let action = match direction.to_lowercase().as_str() {
        "up" | "increase" | "raise" | "louder" => "increased",
        "down" | "decrease" | "lower" | "quieter" => "decreased",
        "mute" | "toggle_mute" => "mute toggled",
        _ => "adjusted",
    };

    Ok(format!("Volume {}", action))
}

#[tauri::command]
async fn media_control(action: String) -> Result<String, String> {
    let key = match action.to_lowercase().as_str() {
        "play" | "pause" | "play_pause" | "toggle" => "0xB3", // VK_MEDIA_PLAY_PAUSE
        "next" | "skip" | "forward" => "0xB0",                // VK_MEDIA_NEXT_TRACK
        "previous" | "prev" | "back" => "0xB1",               // VK_MEDIA_PREV_TRACK
        "stop" => "0xB2",                                     // VK_MEDIA_STOP
        _ => return Err(format!("Unknown media action: {}", action)),
    };

    let script =
        "$key = [Convert]::ToByte($env:IRIS_MEDIA_KEY.Replace('0x',''), 16); \
         $sig = '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);'; \
         Add-Type -MemberDefinition $sig -Name U32 -Namespace W; \
         [W.U32]::keybd_event($key, 0, 0, 0); [W.U32]::keybd_event($key, 0, 2, 0)";

    powershell_with_data(script, &[("IRIS_MEDIA_KEY", key)])
        .output()
        .map_err(|e| e.to_string())?;

    let action_name = match action.to_lowercase().as_str() {
        "play" | "pause" | "play_pause" | "toggle" => "play/pause toggled",
        "next" | "skip" | "forward" => "skipped to next track",
        "previous" | "prev" | "back" => "went to previous track",
        "stop" => "stopped",
        _ => "controlled",
    };

    Ok(format!("Media {}", action_name))
}

async fn lock_computer() -> Result<String, String> {
    use std::process::Command;

    Command::new("rundll32.exe")
        .args(&["user32.dll,LockWorkStation"])
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok("Computer locked".to_string())
}

async fn sleep_computer() -> Result<String, String> {
    use std::process::Command;

    Command::new("rundll32.exe")
        .args(&["powrprof.dll,SetSuspendState", "0,1,0"])
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok("Computer going to sleep".to_string())
}

async fn open_url(url: String) -> Result<String, String> {
    let candidate = if url.starts_with("http://") || url.starts_with("https://") {
        url.clone()
    } else {
        format!("https://{url}")
    };

    let parsed = reqwest::Url::parse(&candidate).map_err(|_| "URL must be valid".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || parsed.username() != ""
        || parsed.password().is_some()
        || candidate
            .chars()
            .any(|c| c == '\r' || c == '\n' || c == '"')
    {
        return Err("Only credential-free http(s) URLs are allowed".to_string());
    }

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer.exe")
        .arg(&candidate)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&candidate)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&candidate)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(format!("Opening {}", candidate))
}

async fn web_search(query: String) -> Result<String, String> {
    let mut parsed =
        reqwest::Url::parse("https://www.google.com/search").map_err(|error| error.to_string())?;
    parsed.query_pairs_mut().append_pair("q", &query);
    let url = parsed.to_string();

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer.exe")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(format!("Searching for: {}", query))
}

async fn close_application(app_name: String) -> Result<String, String> {
    use std::process::Command;

    let process_name = match app_name.to_lowercase().as_str() {
        "chrome" | "google chrome" => "chrome.exe",
        "firefox" => "firefox.exe",
        "edge" | "microsoft edge" => "msedge.exe",
        "spotify" => "Spotify.exe",
        "discord" => "Discord.exe",
        "slack" => "slack.exe",
        "vscode" | "vs code" | "code" => "Code.exe",
        "notepad" => "notepad.exe",
        "word" => "WINWORD.EXE",
        "excel" => "EXCEL.EXE",
        "teams" => "Teams.exe",
        _ => &app_name,
    };

    let output = Command::new("taskkill")
        .args(&["/IM", process_name, "/F"])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(format!("Closed {}", app_name))
    } else {
        Err(format!(
            "Could not close {} - it may not be running",
            app_name
        ))
    }
}

#[tauri::command]
async fn minimize_all_windows() -> Result<String, String> {
    use std::process::Command;

    // Simulate Win+D to show desktop / minimize all
    let script = "$shell = New-Object -ComObject Shell.Application; $shell.MinimizeAll()";

    Command::new("powershell")
        .args(&["-Command", script])
        .output()
        .map_err(|e| e.to_string())?;

    Ok("Minimized all windows".to_string())
}

#[tauri::command]
async fn show_desktop() -> Result<String, String> {
    minimize_all_windows().await
}

#[tauri::command]
async fn save_screenshot(path: Option<String>) -> Result<String, String> {
    use chrono::Local;

    let timestamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let save_path = path.unwrap_or_else(|| {
        format!(
            "C:\\Users\\{}\\Pictures\\Screenshots\\iris_screenshot_{}.png",
            std::env::var("USERNAME").unwrap_or("user".to_string()),
            timestamp
        )
    });

    // Ensure directory exists
    if let Some(parent) = std::path::Path::new(&save_path).parent() {
        std::fs::create_dir_all(parent).ok();
    }

    // Capture screen
    let screens = Screen::all().map_err(|e| e.to_string())?;
    if screens.is_empty() {
        return Err("No screens found".to_string());
    }
    let screen = &screens[0];
    let image = screen.capture().map_err(|e| e.to_string())?;

    // Save as PNG
    image.save(&save_path).map_err(|e| e.to_string())?;

    Ok(format!("Screenshot saved to {}", save_path))
}

#[tauri::command]
async fn get_time() -> Result<String, String> {
    use chrono::Local;
    let now = Local::now();
    Ok(now.format("%I:%M %p").to_string())
}

#[tauri::command]
async fn get_date() -> Result<String, String> {
    use chrono::Local;
    let now = Local::now();
    Ok(now.format("%A, %B %d, %Y").to_string())
}

// ==================== NEW UTILITIES (Timer, Brightness, WiFi, Notes, Dictation) ====================

#[tauri::command]
async fn set_brightness(level: u8) -> Result<String, String> {
    let level = level.min(100);

    // Use PowerShell to set brightness via WMI
    let script = "$level = [byte]$env:IRIS_BRIGHTNESS; (Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, $level)";

    let output = powershell_with_data(script, &[("IRIS_BRIGHTNESS", &level.to_string())])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(format!("Brightness set to {}%", level))
    } else {
        Err("Failed to set brightness - this may not work on desktop monitors".to_string())
    }
}

#[tauri::command]
async fn adjust_brightness(direction: String) -> Result<String, String> {
    use std::process::Command;

    // Get current brightness
    let get_script =
        "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness";
    let output = Command::new("powershell")
        .args(&["-Command", get_script])
        .output()
        .map_err(|e| e.to_string())?;

    let current: i32 = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .unwrap_or(50);

    let new_level = match direction.to_lowercase().as_str() {
        "up" | "increase" | "brighter" => (current + 20).min(100),
        "down" | "decrease" | "dimmer" | "dim" => (current - 20).max(0),
        _ => return Err(format!("Unknown direction: {}", direction)),
    };

    set_brightness(new_level as u8).await
}

async fn toggle_wifi(enable: bool) -> Result<String, String> {
    use std::process::Command;

    let action = if enable { "enable" } else { "disable" };

    // Use netsh to enable/disable WiFi interface
    let output = Command::new("netsh")
        .args(&["interface", "set", "interface", "Wi-Fi", action])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(format!(
            "WiFi {}",
            if enable { "enabled" } else { "disabled" }
        ))
    } else {
        // Try alternate interface name
        let output2 = Command::new("netsh")
            .args(&["interface", "set", "interface", "WiFi", action])
            .output()
            .map_err(|e| e.to_string())?;

        if output2.status.success() {
            Ok(format!(
                "WiFi {}",
                if enable { "enabled" } else { "disabled" }
            ))
        } else {
            Err("Failed to toggle WiFi - check interface name".to_string())
        }
    }
}

#[tauri::command]
async fn get_wifi_status() -> Result<bool, String> {
    use std::process::Command;

    let output = Command::new("netsh")
        .args(&["interface", "show", "interface", "Wi-Fi"])
        .output()
        .map_err(|e| e.to_string())?;

    let output_str = String::from_utf8_lossy(&output.stdout).to_lowercase();
    Ok(output_str.contains("connected") || output_str.contains("enabled"))
}

#[tauri::command]
async fn save_note(content: String, filename: Option<String>) -> Result<String, String> {
    use chrono::Local;
    use std::fs::{create_dir_all, OpenOptions};
    use std::io::Write;
    use std::path::PathBuf;

    // Get Documents folder
    let docs_path =
        dirs::document_dir().unwrap_or_else(|| PathBuf::from("C:\\Users\\Public\\Documents"));

    let notes_dir = docs_path.join("IrisNotes");
    create_dir_all(&notes_dir).map_err(|e| e.to_string())?;

    let timestamp = Local::now();
    let file_path = if let Some(name) = filename {
        contained_storage_path(&notes_dir, &name, "txt")?
    } else {
        notes_dir.join(format!("note_{}.txt", timestamp.format("%Y%m%d_%H%M%S")))
    };

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
        .map_err(|e| e.to_string())?;

    writeln!(
        file,
        "[{}] {}",
        timestamp.format("%Y-%m-%d %H:%M:%S"),
        content
    )
    .map_err(|e| e.to_string())?;

    Ok(format!("Note saved to {}", file_path.display()))
}

async fn read_file(path: String) -> Result<String, String> {
    use std::fs;
    let file_path = validate_local_path(&path, true)?;
    if !file_path.is_file() {
        return Err("Path is not a regular file.".to_string());
    }

    // Read file content (limit to 100KB to prevent memory issues)
    let content =
        fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {}", e))?;

    if content.len() > 100_000 {
        let end = utf8_boundary_at_or_before(&content, 100_000);
        Ok(format!(
            "{}\n\n[... truncated, file is {} bytes total]",
            &content[..end],
            content.len()
        ))
    } else {
        Ok(content)
    }
}

fn utf8_boundary_at_or_before(content: &str, maximum: usize) -> usize {
    let mut end = maximum.min(content.len());
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }
    end
}

#[derive(Debug, Deserialize)]
struct ModelChatRequest {
    provider: Option<String>,
    messages: serde_json::Value,
    tools: Option<serde_json::Value>,
}

fn validate_provider_url(base_url: &str, has_credential: bool) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(base_url)
        .map_err(|_| "IRIS_BASE_URL is not a valid URL.".to_string())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "IRIS_BASE_URL must include a host.".to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("IRIS_BASE_URL must not contain embedded credentials.".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("IRIS_BASE_URL must not contain a query or fragment.".to_string());
    }
    let is_loopback =
        host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "[::1]";
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" if is_loopback => Ok(parsed),
        "http" if has_credential => Err(
            "Remote model endpoints must use HTTPS when IRIS_API_KEY is configured.".to_string(),
        ),
        "http" => {
            Err("Plain HTTP is allowed only for explicit localhost model endpoints.".to_string())
        }
        _ => Err("IRIS_BASE_URL must use HTTPS, or HTTP only for localhost.".to_string()),
    }
}

/// Call the configured model provider from the native side so API keys never
/// need to be embedded in the renderer bundle or written to audit logs.
#[tauri::command]
async fn model_chat(request: ModelChatRequest) -> Result<serde_json::Value, String> {
    let provider = request
        .provider
        .or_else(|| std::env::var("IRIS_MODEL_PROVIDER").ok())
        .unwrap_or_else(|| "mock".to_string());

    if provider == "mock" {
        let last_text = request
            .messages
            .as_array()
            .and_then(|messages| {
                messages.iter().rev().find(|message| {
                    message.get("role").and_then(|role| role.as_str()) == Some("user")
                })
            })
            .and_then(|message| message.get("content"))
            .and_then(|content| content.as_str())
            .unwrap_or("your request");
        return Ok(serde_json::json!({
            "provider": "mock",
            "message": { "role": "assistant", "content": format!("Mock provider response: I received '{}'. Configure IRIS_MODEL_PROVIDER=openai-compatible for model reasoning.", last_text.chars().take(240).collect::<String>()) }
        }));
    }

    if provider != "openai-compatible" {
        return Err(format!(
            "Unsupported model provider '{}'. Use 'mock' or 'openai-compatible'.",
            provider
        ));
    }

    // Endpoint, model, and credential are loaded together at the native trust boundary.
    // Renderer input cannot substitute the destination that receives IRIS_API_KEY.
    let base_url = std::env::var("IRIS_BASE_URL")
        .map_err(|_| "IRIS_BASE_URL is required for the OpenAI-compatible provider.".to_string())?;
    let model = std::env::var("IRIS_MODEL")
        .map_err(|_| "IRIS_MODEL is required for the OpenAI-compatible provider.".to_string())?;
    let api_key = std::env::var("IRIS_API_KEY").unwrap_or_default();
    let parsed = validate_provider_url(&base_url, !api_key.is_empty())?;

    let endpoint = format!("{}/chat/completions", parsed.as_str().trim_end_matches('/'));
    let mut request_builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        // Authenticated redirects are disabled so credentials never cross origins.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Could not create provider client: {}", error))?
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    if !api_key.is_empty() {
        request_builder = request_builder.bearer_auth(api_key);
    }
    let body = serde_json::json!({
        "model": model,
        "messages": request.messages,
        "tools": request.tools.unwrap_or_else(|| serde_json::json!([])),
        "tool_choice": "auto"
    });
    let response = request_builder
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Provider request failed: {}", error))?;
    let status = response.status();
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "Provider returned malformed JSON.".to_string())?;
    if !status.is_success() {
        return Err(format!("Provider returned HTTP {}. Response details were withheld to avoid leaking credentials or sensitive prompt content.", status.as_u16()));
    }
    Ok(payload)
}

async fn type_text(text: String) -> Result<String, String> {
    use enigo::{Enigo, Keyboard, Settings};
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.text(&text).map_err(|e| e.to_string())?;

    Ok(format!("Typed: {}", text))
}

// ==================== MOUSE CONTROL (Enigo) ====================
// These commands give IRIS the ability to click, move mouse, and interact with UI elements

async fn click_mouse(x: i32, y: i32) -> Result<String, String> {
    use enigo::{Coordinate, Enigo, Mouse, Settings};

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    // Move to position and click
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(50)); // Small delay for stability
    enigo
        .button(enigo::Button::Left, enigo::Direction::Click)
        .map_err(|e| e.to_string())?;

    log::info!("[click_mouse] Clicked at ({}, {})", x, y);
    Ok(format!("Clicked at ({}, {})", x, y))
}

async fn double_click(x: i32, y: i32) -> Result<String, String> {
    use enigo::{Coordinate, Enigo, Mouse, Settings};

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(50));
    enigo
        .button(enigo::Button::Left, enigo::Direction::Click)
        .map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(50));
    enigo
        .button(enigo::Button::Left, enigo::Direction::Click)
        .map_err(|e| e.to_string())?;

    log::info!("[double_click] Double-clicked at ({}, {})", x, y);
    Ok(format!("Double-clicked at ({}, {})", x, y))
}

async fn right_click(x: i32, y: i32) -> Result<String, String> {
    use enigo::{Coordinate, Enigo, Mouse, Settings};

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(50));
    enigo
        .button(enigo::Button::Right, enigo::Direction::Click)
        .map_err(|e| e.to_string())?;

    log::info!("[right_click] Right-clicked at ({}, {})", x, y);
    Ok(format!("Right-clicked at ({}, {})", x, y))
}

async fn move_mouse_to(x: i32, y: i32) -> Result<String, String> {
    use enigo::{Coordinate, Enigo, Mouse, Settings};

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| e.to_string())?;

    log::info!("[move_mouse] Moved to ({}, {})", x, y);
    Ok(format!("Moved mouse to ({}, {})", x, y))
}

#[tauri::command]
async fn get_mouse_position() -> Result<(i32, i32), String> {
    use enigo::{Enigo, Mouse, Settings};

    let enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let (x, y) = enigo.location().map_err(|e| e.to_string())?;

    Ok((x, y))
}

// ==================== KEYBOARD CONTROL ====================
// press_key allows IRIS to send special keys like Enter, Escape, Tab, etc.

async fn press_key(key: String) -> Result<String, String> {
    use enigo::{Enigo, Key, Keyboard, Settings};

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    // Map string key names to enigo Key enum
    let enigo_key = match key.to_lowercase().as_str() {
        "enter" | "return" => Key::Return,
        "escape" | "esc" => Key::Escape,
        "tab" => Key::Tab,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "space" => Key::Space,
        "up" | "uparrow" => Key::UpArrow,
        "down" | "downarrow" => Key::DownArrow,
        "left" | "leftarrow" => Key::LeftArrow,
        "right" | "rightarrow" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        "ctrl" | "control" => Key::Control,
        "alt" => Key::Alt,
        "shift" => Key::Shift,
        "win" | "windows" | "meta" | "super" => Key::Meta,
        _ => return Err(format!("Unknown key: {}. Supported: enter, escape, tab, backspace, delete, space, up, down, left, right, home, end, pageup, pagedown, f1-f12, ctrl, alt, shift, win", key)),
    };

    enigo
        .key(enigo_key, enigo::Direction::Click)
        .map_err(|e| e.to_string())?;

    log::info!("[press_key] Pressed: {}", key);
    Ok(format!("Pressed key: {}", key))
}

// Combo keys like Ctrl+C, Ctrl+V, Alt+Tab
async fn press_key_combo(keys: Vec<String>) -> Result<String, String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    // Helper to map string to Key
    let map_key = |k: &str| -> Result<Key, String> {
        match k.to_lowercase().as_str() {
            "ctrl" | "control" => Ok(Key::Control),
            "alt" => Ok(Key::Alt),
            "shift" => Ok(Key::Shift),
            "win" | "windows" | "meta" | "super" => Ok(Key::Meta),
            "enter" | "return" => Ok(Key::Return),
            "escape" | "esc" => Ok(Key::Escape),
            "tab" => Ok(Key::Tab),
            "backspace" => Ok(Key::Backspace),
            "delete" | "del" => Ok(Key::Delete),
            "space" => Ok(Key::Space),
            "up" => Ok(Key::UpArrow),
            "down" => Ok(Key::DownArrow),
            "left" => Ok(Key::LeftArrow),
            "right" => Ok(Key::RightArrow),
            // Single characters
            s if s.len() == 1 => Ok(Key::Unicode(s.chars().next().unwrap())),
            _ => Err(format!("Unknown key: {}", k)),
        }
    };

    // Press all modifier keys down
    let mut pressed: Vec<Key> = Vec::new();
    for key_str in &keys {
        let key = map_key(key_str)?;
        enigo
            .key(key, Direction::Press)
            .map_err(|e| e.to_string())?;
        pressed.push(key);
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    // Small delay
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Release all keys in reverse order
    for key in pressed.iter().rev() {
        enigo
            .key(*key, Direction::Release)
            .map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    let combo_str = keys.join("+");
    log::info!("[press_key_combo] Pressed: {}", combo_str);
    Ok(format!("Pressed combo: {}", combo_str))
}

// ==================== ACTIVE WINDOW TRACKING ====================
// Know what app/window the user is currently focused on

#[tauri::command]
async fn get_active_window() -> Result<serde_json::Value, String> {
    use std::process::Command;

    // Use PowerShell to get the foreground window info
    let script = r#"
        Add-Type @'
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        public class Win32 {
            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")]
            public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
            [DllImport("user32.dll")]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        }
'@
        $hwnd = [Win32]::GetForegroundWindow()
        $title = New-Object System.Text.StringBuilder 256
        [Win32]::GetWindowText($hwnd, $title, 256) | Out-Null

        $processId = 0
        [Win32]::GetWindowThreadProcessId($hwnd, [ref]$processId) | Out-Null

        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        $appName = if ($process) { $process.ProcessName } else { "Unknown" }

        @{
            title = $title.ToString()
            app = $appName
            pid = $processId
        } | ConvertTo-Json
    "#;

    let output = Command::new("powershell")
        .args(&["-Command", script])
        .output()
        .map_err(|e| e.to_string())?;

    let result = String::from_utf8_lossy(&output.stdout).trim().to_string();

    let json: serde_json::Value =
        serde_json::from_str(&result).map_err(|e| format!("Failed to parse window info: {}", e))?;

    log::info!(
        "[get_active_window] Current: {} ({})",
        json["title"].as_str().unwrap_or(""),
        json["app"].as_str().unwrap_or("")
    );

    Ok(json)
}

// ==================== SCROLL CONTROL ====================

async fn scroll(direction: String, amount: Option<i32>) -> Result<String, String> {
    use enigo::{Axis, Enigo, Mouse, Settings};

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let scroll_amount = amount.unwrap_or(3); // Default 3 lines

    let actual_amount = match direction.to_lowercase().as_str() {
        "up" => scroll_amount,
        "down" => -scroll_amount,
        _ => {
            return Err(format!(
                "Invalid direction: {}. Use 'up' or 'down'",
                direction
            ))
        }
    };

    enigo
        .scroll(actual_amount, Axis::Vertical)
        .map_err(|e| e.to_string())?;

    log::info!("[scroll] Scrolled {} by {}", direction, scroll_amount);
    Ok(format!("Scrolled {} by {} lines", direction, scroll_amount))
}

#[tauri::command]
async fn scroll_horizontal(direction: String, amount: Option<i32>) -> Result<String, String> {
    use enigo::{Axis, Enigo, Mouse, Settings};

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let scroll_amount = amount.unwrap_or(3);

    let actual_amount = match direction.to_lowercase().as_str() {
        "left" => scroll_amount,
        "right" => -scroll_amount,
        _ => {
            return Err(format!(
                "Invalid direction: {}. Use 'left' or 'right'",
                direction
            ))
        }
    };

    enigo
        .scroll(actual_amount, Axis::Horizontal)
        .map_err(|e| e.to_string())?;

    log::info!(
        "[scroll_horizontal] Scrolled {} by {}",
        direction,
        scroll_amount
    );
    Ok(format!("Scrolled {} by {} units", direction, scroll_amount))
}

// ==================== WINDOW LIST & MANIPULATION ====================

#[tauri::command]
async fn get_open_windows() -> Result<Vec<serde_json::Value>, String> {
    use std::process::Command;

    let script = r#"
        Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
            @{
                title = $_.MainWindowTitle
                app = $_.ProcessName
                pid = $_.Id
            }
        } | ConvertTo-Json -AsArray
    "#;

    let output = Command::new("powershell")
        .args(&["-Command", script])
        .output()
        .map_err(|e| e.to_string())?;

    let result = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if result.is_empty() || result == "null" {
        return Ok(vec![]);
    }

    let windows: Vec<serde_json::Value> =
        serde_json::from_str(&result).map_err(|e| format!("Failed to parse windows: {}", e))?;

    log::info!("[get_open_windows] Found {} windows", windows.len());
    Ok(windows)
}

#[tauri::command]
async fn minimize_window_by_title(title: String) -> Result<String, String> {
    let script = format!(
        r#"
        # IRIS fixed data boundary: {}
        Add-Type @'
        using System;
        using System.Runtime.InteropServices;
        public class Win32Min {{
            [DllImport("user32.dll")]
            public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        }}
'@
        $proc = Get-Process | Where-Object {{ $_.MainWindowTitle.Contains($env:IRIS_WINDOW_TITLE) }} | Select-Object -First 1
        if ($proc) {{
            [Win32Min]::ShowWindow($proc.MainWindowHandle, 6)  # SW_MINIMIZE
            Write-Output "Minimized: $($proc.MainWindowTitle)"
        }} else {{
            Write-Output "Window not found"
        }}
        "#,
        "" // fixed placeholder; runtime title is supplied only through the environment
    );

    let output = powershell_with_data(&script, &[("IRIS_WINDOW_TITLE", &title)])
        .output()
        .map_err(|e| e.to_string())?;

    let result = String::from_utf8_lossy(&output.stdout).trim().to_string();
    log::info!("[minimize_window] {}", result);

    if result.contains("not found") {
        Err(format!("Window '{}' not found", title))
    } else {
        Ok(result)
    }
}

#[tauri::command]
async fn maximize_window_by_title(title: String) -> Result<String, String> {
    let script = format!(
        r#"
        # IRIS fixed data boundary: {}
        Add-Type @'
        using System;
        using System.Runtime.InteropServices;
        public class Win32Max {{
            [DllImport("user32.dll")]
            public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        }}
'@
        $proc = Get-Process | Where-Object {{ $_.MainWindowTitle.Contains($env:IRIS_WINDOW_TITLE) }} | Select-Object -First 1
        if ($proc) {{
            [Win32Max]::ShowWindow($proc.MainWindowHandle, 3)  # SW_MAXIMIZE
            Write-Output "Maximized: $($proc.MainWindowTitle)"
        }} else {{
            Write-Output "Window not found"
        }}
        "#,
        "" // fixed placeholder; runtime title is supplied only through the environment
    );

    let output = powershell_with_data(&script, &[("IRIS_WINDOW_TITLE", &title)])
        .output()
        .map_err(|e| e.to_string())?;

    let result = String::from_utf8_lossy(&output.stdout).trim().to_string();
    log::info!("[maximize_window] {}", result);

    if result.contains("not found") {
        Err(format!("Window '{}' not found", title))
    } else {
        Ok(result)
    }
}

#[tauri::command]
async fn restore_window_by_title(title: String) -> Result<String, String> {
    let script = format!(
        r#"
        # IRIS fixed data boundary: {}
        Add-Type @'
        using System;
        using System.Runtime.InteropServices;
        public class Win32Restore {{
            [DllImport("user32.dll")]
            public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        }}
'@
        $proc = Get-Process | Where-Object {{ $_.MainWindowTitle.Contains($env:IRIS_WINDOW_TITLE) }} | Select-Object -First 1
        if ($proc) {{
            [Win32Restore]::ShowWindow($proc.MainWindowHandle, 9)  # SW_RESTORE
            Write-Output "Restored: $($proc.MainWindowTitle)"
        }} else {{
            Write-Output "Window not found"
        }}
        "#,
        "" // fixed placeholder; runtime title is supplied only through the environment
    );

    let output = powershell_with_data(&script, &[("IRIS_WINDOW_TITLE", &title)])
        .output()
        .map_err(|e| e.to_string())?;

    let result = String::from_utf8_lossy(&output.stdout).trim().to_string();
    log::info!("[restore_window] {}", result);

    if result.contains("not found") {
        Err(format!("Window '{}' not found", title))
    } else {
        Ok(result)
    }
}

#[tauri::command]
async fn set_window_position(
    title: String,
    x: i32,
    y: i32,
    width: Option<i32>,
    height: Option<i32>,
) -> Result<String, String> {
    let w = width.unwrap_or(0);
    let h = height.unwrap_or(0);
    let flags = if w == 0 && h == 0 { "0x0001" } else { "0x0000" }; // SWP_NOSIZE if no size specified

    let script = format!(
        r#"
        Add-Type @'
        using System;
        using System.Runtime.InteropServices;
        public class Win32Pos {{
            [DllImport("user32.dll")]
            public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
        }}
'@
        $proc = Get-Process | Where-Object {{ $_.MainWindowTitle.Contains($env:IRIS_WINDOW_TITLE) }} | Select-Object -First 1
        if ($proc) {{
            [Win32Pos]::SetWindowPos($proc.MainWindowHandle, [IntPtr]::Zero, {}, {}, {}, {}, {})
            Write-Output "Moved: $($proc.MainWindowTitle) to ({}, {})"
        }} else {{
            Write-Output "Window not found"
        }}
        "#,
        x, y, w, h, flags, x, y
    );

    let output = powershell_with_data(&script, &[("IRIS_WINDOW_TITLE", &title)])
        .output()
        .map_err(|e| e.to_string())?;

    let result = String::from_utf8_lossy(&output.stdout).trim().to_string();
    log::info!("[set_window_position] {}", result);

    if result.contains("not found") {
        Err(format!("Window '{}' not found", title))
    } else {
        Ok(result)
    }
}

// ==================== DRAG AND DROP ====================

async fn drag_mouse(from_x: i32, from_y: i32, to_x: i32, to_y: i32) -> Result<String, String> {
    use enigo::{Button, Coordinate, Direction, Enigo, Mouse, Settings};

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    // Move to start position
    enigo
        .move_mouse(from_x, from_y, Coordinate::Abs)
        .map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Press mouse button
    enigo
        .button(Button::Left, Direction::Press)
        .map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Move to end position (smooth drag)
    let steps = 20;
    for i in 1..=steps {
        let x = from_x + ((to_x - from_x) * i / steps);
        let y = from_y + ((to_y - from_y) * i / steps);
        enigo
            .move_mouse(x, y, Coordinate::Abs)
            .map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    // Release mouse button
    std::thread::sleep(std::time::Duration::from_millis(50));
    enigo
        .button(Button::Left, Direction::Release)
        .map_err(|e| e.to_string())?;

    log::info!(
        "[drag_mouse] Dragged from ({}, {}) to ({}, {})",
        from_x,
        from_y,
        to_x,
        to_y
    );
    Ok(format!(
        "Dragged from ({}, {}) to ({}, {})",
        from_x, from_y, to_x, to_y
    ))
}

// ==================== CLIPBOARD ====================

async fn get_clipboard_text() -> Result<String, String> {
    use std::process::Command;

    let output = Command::new("powershell")
        .args(&["-Command", "Get-Clipboard"])
        .output()
        .map_err(|e| e.to_string())?;

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    log::info!("[get_clipboard] Read {} chars", text.len());
    Ok(text)
}

#[tauri::command]
async fn set_clipboard_text(text: String) -> Result<String, String> {
    powershell_with_data(
        "Set-Clipboard -Value $env:IRIS_CLIPBOARD_TEXT",
        &[("IRIS_CLIPBOARD_TEXT", &text)],
    )
    .output()
    .map_err(|e| e.to_string())?;

    log::info!("[set_clipboard] Set {} chars", text.len());
    Ok(format!("Clipboard set ({} chars)", text.len()))
}

// ==================== SCREEN INFO ====================

#[tauri::command]
async fn get_screen_info() -> Result<serde_json::Value, String> {
    use std::process::Command;

    let script = r#"
        Add-Type -AssemblyName System.Windows.Forms
        $screens = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
            @{
                name = $_.DeviceName
                primary = $_.Primary
                width = $_.Bounds.Width
                height = $_.Bounds.Height
                x = $_.Bounds.X
                y = $_.Bounds.Y
                workingArea = @{
                    width = $_.WorkingArea.Width
                    height = $_.WorkingArea.Height
                    x = $_.WorkingArea.X
                    y = $_.WorkingArea.Y
                }
            }
        }
        @{
            screens = $screens
            mousePosition = [System.Windows.Forms.Cursor]::Position | ForEach-Object { @{ x = $_.X; y = $_.Y } }
        } | ConvertTo-Json -Depth 3
    "#;

    let output = Command::new("powershell")
        .args(&["-Command", script])
        .output()
        .map_err(|e| e.to_string())?;

    let result = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let json: serde_json::Value =
        serde_json::from_str(&result).map_err(|e| format!("Failed to parse screen info: {}", e))?;

    log::info!("[get_screen_info] Retrieved screen information");
    Ok(json)
}

// ==================== CAPTURE SPECIFIC WINDOW ====================

#[tauri::command]
async fn capture_window_by_title(title: String) -> Result<ScreenshotResult, String> {
    use image::ImageEncoder;
    use screenshots::Screen;

    // First, get the window bounds
    let script = format!(
        r#"
        Add-Type @'
        using System;
        using System.Runtime.InteropServices;
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT {{
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }}
        public class Win32Rect {{
            [DllImport("user32.dll")]
            public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        }}
'@
        # IRIS fixed data boundary: {}
        $proc = Get-Process | Where-Object {{ $_.MainWindowTitle.Contains($env:IRIS_WINDOW_TITLE) }} | Select-Object -First 1
        if ($proc) {{
            $rect = New-Object RECT
            [Win32Rect]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
            @{{
                left = $rect.Left
                top = $rect.Top
                right = $rect.Right
                bottom = $rect.Bottom
                width = $rect.Right - $rect.Left
                height = $rect.Bottom - $rect.Top
            }} | ConvertTo-Json
        }} else {{
            Write-Output "null"
        }}
        "#,
        ""
    );

    let output = powershell_with_data(&script, &[("IRIS_WINDOW_TITLE", &title)])
        .output()
        .map_err(|e| e.to_string())?;

    let result = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if result == "null" || result.is_empty() {
        return Err(format!("Window '{}' not found", title));
    }

    let bounds: serde_json::Value =
        serde_json::from_str(&result).map_err(|e| format!("Failed to parse bounds: {}", e))?;

    let x = bounds["left"].as_i64().unwrap_or(0) as i32;
    let y = bounds["top"].as_i64().unwrap_or(0) as i32;
    let w = bounds["width"].as_i64().unwrap_or(800) as u32;
    let h = bounds["height"].as_i64().unwrap_or(600) as u32;

    // Capture the screen region
    let screens = Screen::all().map_err(|e| e.to_string())?;
    let screen = screens.first().ok_or("No screens found")?;

    let capture = screen.capture_area(x, y, w, h).map_err(|e| e.to_string())?;

    // Encode to JPEG
    let mut jpeg_data = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_data, 85);
    encoder
        .write_image(
            capture.as_raw(),
            capture.width(),
            capture.height(),
            image::ColorType::Rgba8,
        )
        .map_err(|e| e.to_string())?;

    let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &jpeg_data);

    log::info!("[capture_window] Captured '{}' ({}x{})", title, w, h);

    Ok(ScreenshotResult {
        base64,
        width: w,
        height: h,
    })
}

#[cfg(target_os = "windows")]
fn focus_window_handle(target: &WindowIdentity) -> Result<serde_json::Value, String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_RESTORE};
    let observed = inspect_window(target.window_handle)?;
    validate_observed_target(target, &observed)?;
    let hwnd = HWND(target.window_handle as *mut _);
    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        if !SetForegroundWindow(hwnd).as_bool() {
            return Err("Windows refused to focus the approved target window".into());
        }
    }
    Ok(serde_json::Value::String(format!(
        "Focused approved target: {}",
        observed.window_title
    )))
}

#[cfg(not(target_os = "windows"))]
fn focus_window_handle(_target: &WindowIdentity) -> Result<serde_json::Value, String> {
    Err("Target-bound computer control is currently supported only on Windows".into())
}

#[tauri::command]
async fn show_notification(title: String, body: String) -> Result<String, String> {
    // Runtime strings enter the fixed script only as environment data. InnerText
    // performs XML escaping, so neither PowerShell nor toast XML can interpret them.
    let script = r#"
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
        $template = @"
        <toast>
            <visual>
                <binding template="ToastText02">
                    <text id="1"></text>
                    <text id="2"></text>
                </binding>
            </visual>
            <audio src="ms-winsoundevent:Notification.Default"/>
        </toast>
"@
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml($template)
        $nodes = $xml.GetElementsByTagName("text")
        $nodes.Item(0).InnerText = $env:IRIS_NOTIFICATION_TITLE
        $nodes.Item(1).InnerText = $env:IRIS_NOTIFICATION_BODY
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("IRIS").Show($toast)
        "#;

    powershell_with_data(
        script,
        &[
            ("IRIS_NOTIFICATION_TITLE", &title),
            ("IRIS_NOTIFICATION_BODY", &body),
        ],
    )
    .output()
    .map_err(|e| e.to_string())?;

    Ok("Notification shown".to_string())
}

/// Get the user's home directory
#[tauri::command]
async fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

// ==================== FILE OPERATIONS (with guardrails) ====================

fn validate_local_path(raw: &str, must_exist: bool) -> Result<std::path::PathBuf, String> {
    use std::path::{Component, Path};
    if raw.trim().is_empty() {
        return Err("Path must not be empty.".to_string());
    }
    if raw.contains('*') || raw.contains('?') {
        return Err("Wildcards are not permitted.".to_string());
    }
    let input = Path::new(raw);
    if !input.is_absolute() {
        return Err("Only absolute paths are accepted for native file operations.".to_string());
    }
    if input
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Parent-directory traversal is not permitted.".to_string());
    }
    if must_exist && !input.exists() {
        return Err(format!("Path not found: {}", raw));
    }
    let canonical = input
        .canonicalize()
        .map_err(|error| format!("Could not resolve path: {}", error))?;
    if canonical.parent().is_none() {
        return Err("Root directories are not valid mutation targets.".to_string());
    }
    if std::fs::symlink_metadata(input)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("Symlink targets are not permitted for native file operations.".to_string());
    }
    Ok(canonical)
}

fn validate_destructive_path(raw: &str) -> Result<std::path::PathBuf, String> {
    let canonical = validate_local_path(raw, true)?;
    let mut protected = Vec::new();
    for variable in [
        "SystemRoot",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
    ] {
        if let Some(path) = std::env::var_os(variable) {
            if let Ok(path) = std::path::PathBuf::from(path).canonicalize() {
                protected.push(path);
            }
        }
    }
    let home = dirs::home_dir().and_then(|path| path.canonicalize().ok());
    if protected
        .iter()
        .any(|root| canonical == *root || canonical.starts_with(root))
        || home.as_ref().is_some_and(|root| canonical == *root)
    {
        return Err(
            "Destructive operations are blocked for protected system and home roots.".to_string(),
        );
    }
    Ok(canonical)
}

/// Delete a file after a bound, native local approval.
async fn delete_file(path: String) -> Result<String, String> {
    use std::fs;
    let file_path = validate_destructive_path(&path)?;

    if file_path.is_dir() {
        return Err("Path is a directory. Use delete_folder instead.".to_string());
    }

    fs::remove_file(file_path).map_err(|e| format!("Failed to delete file: {}", e))?;

    log::info!("[FileOps] Deleted file: {}", path);
    Ok(format!("Deleted: {}", path))
}

/// Delete a folder and all its contents after a bound, native local approval.
async fn delete_folder(path: String) -> Result<String, String> {
    use std::fs;
    let folder_path = validate_destructive_path(&path)?;

    if !folder_path.is_dir() {
        return Err("Path is not a directory. Use delete_file instead.".to_string());
    }

    // Count files before deletion for reporting
    let file_count = fs::read_dir(&folder_path)
        .map(|entries| entries.count())
        .unwrap_or(0);

    fs::remove_dir_all(folder_path).map_err(|e| format!("Failed to delete folder: {}", e))?;

    log::info!(
        "[FileOps] Deleted folder with {} items: {}",
        file_count,
        path
    );
    Ok(format!(
        "Deleted folder with {} items: {}",
        file_count, path
    ))
}

/// Clear all files in a folder (keeps the folder, deletes contents)
async fn clear_folder(path: String) -> Result<String, String> {
    use std::fs;
    let folder_path = validate_destructive_path(&path)?;

    if !folder_path.is_dir() {
        return Err("Path is not a directory.".to_string());
    }

    let mut deleted_count = 0;
    let mut error_count = 0;

    for entry in fs::read_dir(folder_path).map_err(|e| format!("Failed to read folder: {}", e))? {
        if let Ok(entry) = entry {
            let entry_path = entry.path();
            if fs::symlink_metadata(&entry_path)
                .map(|metadata| metadata.file_type().is_symlink())
                .unwrap_or(true)
            {
                error_count += 1;
                continue;
            }
            let result = if entry_path.is_dir() {
                fs::remove_dir_all(&entry_path)
            } else {
                fs::remove_file(&entry_path)
            };

            if result.is_ok() {
                deleted_count += 1;
            } else {
                error_count += 1;
            }
        }
    }

    log::info!(
        "[FileOps] Cleared folder {} - deleted {} items, {} errors",
        path,
        deleted_count,
        error_count
    );

    if error_count > 0 {
        Ok(format!(
            "Cleared {} items from folder. {} items could not be deleted.",
            deleted_count, error_count
        ))
    } else {
        Ok(format!("Cleared {} items from folder.", deleted_count))
    }
}

/// Count files in a folder (for guardrails to report affected items)
#[tauri::command]
async fn count_folder_items(path: String) -> Result<usize, String> {
    use std::fs;
    use std::path::Path;

    let folder_path = Path::new(&path);

    if !folder_path.exists() {
        return Err(format!("Folder not found: {}", path));
    }

    if !folder_path.is_dir() {
        return Ok(1); // Single file
    }

    let count = fs::read_dir(folder_path)
        .map_err(|e| format!("Failed to read folder: {}", e))?
        .count();

    Ok(count)
}

/// Save audit log entry for file operations (guardrails)
#[tauri::command]
async fn save_audit_log(entry: serde_json::Value) -> Result<(), String> {
    use std::fs;

    // Get audit log directory
    let audit_dir = dirs::home_dir()
        .ok_or("Could not determine home directory")?
        .join(".iris")
        .join("audit_logs");

    // Create directory if it doesn't exist
    fs::create_dir_all(&audit_dir)
        .map_err(|e| format!("Failed to create audit directory: {}", e))?;

    // Create month subdirectory
    let now = chrono::Utc::now();
    let month_dir = audit_dir.join(now.format("%Y-%m").to_string());
    fs::create_dir_all(&month_dir)
        .map_err(|e| format!("Failed to create month directory: {}", e))?;

    // Create filename
    let tool_name = entry
        .get("tool")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let risk_level = entry
        .get("risk")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let filename = format!(
        "{}_{}_{}_{}.json",
        now.format("%Y%m%d_%H%M%S"),
        tool_name.replace(" ", "_"),
        risk_level,
        uuid::Uuid::new_v4()
            .to_string()
            .split('-')
            .next()
            .unwrap_or("000")
    );

    let log_path = month_dir.join(&filename);

    // Write the audit entry
    let json_content = serde_json::to_string_pretty(&entry)
        .map_err(|e| format!("Failed to serialize audit entry: {}", e))?;

    fs::write(&log_path, json_content).map_err(|e| format!("Failed to write audit log: {}", e))?;

    log::info!("[Guardrails] Audit log saved: {:?}", log_path);
    Ok(())
}

// =============================================================================
// IRIS HUBS & FEATURES - Workspace Snapshots, War Room, Macros, Annotation
// =============================================================================

/// Get the IRIS data directory (~/.iris)
fn get_iris_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".iris"))
}

fn safe_storage_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 80 {
        return Err("Name must contain 1 to 80 characters".to_string());
    }
    if trimmed == "." || trimmed == ".." || trimmed.ends_with('.') || trimmed.ends_with(' ') {
        return Err("Name is not a valid persisted object name".to_string());
    }
    if trimmed.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err("Name contains a path separator or reserved character".to_string());
    }
    let device_stem = trimmed
        .split('.')
        .next()
        .unwrap_or(trimmed)
        .to_ascii_uppercase();
    let reserved = matches!(device_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (device_stem.starts_with("COM") || device_stem.starts_with("LPT"))
            && device_stem[3..]
                .parse::<u8>()
                .map(|n| (1..=9).contains(&n))
                .unwrap_or(false);
    if reserved {
        return Err("Name is reserved by Windows".to_string());
    }
    let normalized = trimmed
        .chars()
        .map(|c| if c.is_whitespace() { '_' } else { c })
        .collect::<String>()
        .to_lowercase();
    Ok(normalized)
}

fn contained_storage_path(
    root: &std::path::Path,
    name: &str,
    extension: &str,
) -> Result<std::path::PathBuf, String> {
    let safe = safe_storage_name(name)?;
    let destination = root.join(format!("{safe}.{extension}"));
    if !destination.starts_with(root) {
        return Err("Persisted object path escapes its storage root".to_string());
    }
    Ok(destination)
}

/// Initialize IRIS directory structure
#[tauri::command]
async fn init_iris_directories() -> Result<String, String> {
    use std::fs;

    let iris_dir = get_iris_dir()?;
    let subdirs = ["workspaces", "layouts", "macros", "jarvis"];

    for subdir in &subdirs {
        let path = iris_dir.join(subdir);
        fs::create_dir_all(&path).map_err(|e| format!("Failed to create {}: {}", subdir, e))?;
    }

    log::info!("[IRIS] Directory structure initialized at {:?}", iris_dir);
    Ok(format!("IRIS directories initialized at {:?}", iris_dir))
}

// ==================== WORKSPACE SNAPSHOTS ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowSnapshot {
    pub title: String,
    pub app_name: String,
    pub exe_path: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_maximized: bool,
    pub is_minimized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    pub name: String,
    pub created_at: String,
    pub windows: Vec<WindowSnapshot>,
}

/// Get list of all open windows with their positions
#[tauri::command]
async fn get_all_windows_snapshot() -> Result<Vec<WindowSnapshot>, String> {
    use std::process::Command;

    // PowerShell script to get all visible windows with positions
    let script = r#"
        Add-Type @'
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        using System.Collections.Generic;
        using System.Diagnostics;

        public class WindowInfo {
            [DllImport("user32.dll")]
            public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
            [DllImport("user32.dll")]
            public static extern bool IsWindowVisible(IntPtr hWnd);
            [DllImport("user32.dll")]
            public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
            [DllImport("user32.dll")]
            public static extern int GetWindowTextLength(IntPtr hWnd);
            [DllImport("user32.dll")]
            public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
            [DllImport("user32.dll")]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
            [DllImport("user32.dll")]
            public static extern bool IsIconic(IntPtr hWnd);
            [DllImport("user32.dll")]
            public static extern bool IsZoomed(IntPtr hWnd);

            public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

            [StructLayout(LayoutKind.Sequential)]
            public struct RECT { public int Left, Top, Right, Bottom; }

            public static List<string> GetWindows() {
                var windows = new List<string>();
                EnumWindows((hWnd, lParam) => {
                    if (!IsWindowVisible(hWnd)) return true;
                    int length = GetWindowTextLength(hWnd);
                    if (length == 0) return true;

                    StringBuilder sb = new StringBuilder(length + 1);
                    GetWindowText(hWnd, sb, sb.Capacity);
                    string title = sb.ToString();
                    if (string.IsNullOrWhiteSpace(title)) return true;

                    RECT rect;
                    GetWindowRect(hWnd, out rect);

                    uint pid;
                    GetWindowThreadProcessId(hWnd, out pid);

                    try {
                        var proc = Process.GetProcessById((int)pid);
                        string exePath = "";
                        try { exePath = proc.MainModule.FileName; } catch {}

                        bool isMin = IsIconic(hWnd);
                        bool isMax = IsZoomed(hWnd);

                        windows.Add(string.Format("{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8}",
                            title.Replace("|", "-"),
                            proc.ProcessName,
                            exePath.Replace("|", "-"),
                            rect.Left, rect.Top,
                            rect.Right - rect.Left,
                            rect.Bottom - rect.Top,
                            isMax ? "1" : "0",
                            isMin ? "1" : "0"
                        ));
                    } catch {}
                    return true;
                }, IntPtr.Zero);
                return windows;
            }
        }
'@
        [WindowInfo]::GetWindows() | ForEach-Object { $_ }
    "#;

    let output = Command::new("powershell")
        .args(&["-NoProfile", "-Command", script])
        .output()
        .map_err(|e| format!("Failed to enumerate windows: {}", e))?;

    let output_str = String::from_utf8_lossy(&output.stdout);
    let mut windows = Vec::new();

    for line in output_str.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() >= 9 {
            windows.push(WindowSnapshot {
                title: parts[0].to_string(),
                app_name: parts[1].to_string(),
                exe_path: if parts[2].is_empty() {
                    None
                } else {
                    Some(parts[2].to_string())
                },
                x: parts[3].parse().unwrap_or(0),
                y: parts[4].parse().unwrap_or(0),
                width: parts[5].parse().unwrap_or(800),
                height: parts[6].parse().unwrap_or(600),
                is_maximized: parts[7] == "1",
                is_minimized: parts[8] == "1",
            });
        }
    }

    // Filter out system windows
    let filtered: Vec<WindowSnapshot> = windows
        .into_iter()
        .filter(|w| {
            ![
                "Program Manager",
                "IRIS",
                "Settings",
                "Microsoft Text Input Application",
            ]
            .contains(&w.title.as_str())
                && !w.app_name.to_lowercase().contains("shellexperiencehost")
                && !w.app_name.to_lowercase().contains("searchhost")
        })
        .collect();

    log::info!("[Workspace] Found {} windows", filtered.len());
    Ok(filtered)
}

/// Save current workspace snapshot
#[tauri::command]
async fn save_workspace(name: String) -> Result<String, String> {
    use std::fs;

    let windows = get_all_windows_snapshot().await?;

    let snapshot = WorkspaceSnapshot {
        name: name.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        windows,
    };

    let iris_dir = get_iris_dir()?;
    let workspaces_dir = iris_dir.join("workspaces");
    fs::create_dir_all(&workspaces_dir).ok();

    let file_path = contained_storage_path(&workspaces_dir, &name, "json")?;
    let json = serde_json::to_string_pretty(&snapshot)
        .map_err(|e| format!("Failed to serialize workspace: {}", e))?;

    fs::write(&file_path, json).map_err(|e| format!("Failed to save workspace: {}", e))?;

    log::info!(
        "[Workspace] Saved '{}' with {} windows",
        name,
        snapshot.windows.len()
    );
    Ok(format!(
        "Workspace '{}' saved with {} windows",
        name,
        snapshot.windows.len()
    ))
}

/// Load a workspace snapshot - launches apps and positions windows
async fn load_workspace(name: String) -> Result<String, String> {
    use std::fs;
    use std::process::Command;

    let iris_dir = get_iris_dir()?;
    let file_path = contained_storage_path(&iris_dir.join("workspaces"), &name, "json")?;

    if !file_path.exists() {
        return Err(format!("Workspace '{}' not found", name));
    }

    let content =
        fs::read_to_string(&file_path).map_err(|e| format!("Failed to read workspace: {}", e))?;

    let snapshot: WorkspaceSnapshot =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse workspace: {}", e))?;

    let mut launched = 0;
    let mut positioned = 0;

    for window in &snapshot.windows {
        // Try to launch the app if we have the exe path
        if let Some(ref exe_path) = window.exe_path {
            if std::path::Path::new(exe_path).exists() {
                match Command::new(exe_path).spawn() {
                    Ok(_) => {
                        launched += 1;
                        // Wait a bit for the window to appear
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                    Err(e) => log::warn!("[Workspace] Failed to launch {}: {}", exe_path, e),
                }
            }
        }

        // Position the window using PowerShell
        let script = format!(
            r#"
            Add-Type @'
            using System;
            using System.Runtime.InteropServices;
            using System.Text;
            public class WinPos {{
                [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
                [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
                [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
                [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
                [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
                [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
                public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

                public static bool PositionWindow(string titleContains, int x, int y, int w, int h, bool maximize) {{
                    bool found = false;
                    EnumWindows((hWnd, lParam) => {{
                        if (!IsWindowVisible(hWnd)) return true;
                        StringBuilder sb = new StringBuilder(256);
                        GetWindowText(hWnd, sb, 256);
                        if (sb.ToString().Contains(titleContains)) {{
                            if (maximize) {{
                                ShowWindow(hWnd, 3); // SW_MAXIMIZE
                            }} else {{
                                SetWindowPos(hWnd, IntPtr.Zero, x, y, w, h, 0x0040); // SWP_SHOWWINDOW
                            }}
                            found = true;
                            return false;
                        }}
                        return true;
                    }}, IntPtr.Zero);
                    return found;
                }}
            }}
'@
            [WinPos]::PositionWindow($env:IRIS_WINDOW_TITLE, {}, {}, {}, {}, ${})
            "#,
            window.x,
            window.y,
            window.width,
            window.height,
            if window.is_maximized { "true" } else { "false" }
        );

        if let Ok(output) =
            powershell_with_data(&script, &[("IRIS_WINDOW_TITLE", &window.title)]).output()
        {
            if String::from_utf8_lossy(&output.stdout).contains("True") {
                positioned += 1;
            }
        }
    }

    log::info!(
        "[Workspace] Loaded '{}': launched {}, positioned {}",
        name,
        launched,
        positioned
    );
    Ok(format!(
        "Workspace '{}' loaded: {} apps launched, {} windows positioned",
        name, launched, positioned
    ))
}

/// List all saved workspaces
#[tauri::command]
async fn list_workspaces() -> Result<Vec<String>, String> {
    use std::fs;

    let iris_dir = get_iris_dir()?;
    let workspaces_dir = iris_dir.join("workspaces");

    if !workspaces_dir.exists() {
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(workspaces_dir).map_err(|e| format!("Failed to read workspaces: {}", e))?;

    let mut workspaces = Vec::new();
    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.extension().map(|e| e == "json").unwrap_or(false) {
                if let Some(stem) = path.file_stem() {
                    workspaces.push(stem.to_string_lossy().to_string());
                }
            }
        }
    }

    Ok(workspaces)
}

/// Delete a workspace
async fn delete_workspace(name: String) -> Result<String, String> {
    use std::fs;

    let iris_dir = get_iris_dir()?;
    let file_path = contained_storage_path(&iris_dir.join("workspaces"), &name, "json")?;

    if !file_path.exists() {
        return Err(format!("Workspace '{}' not found", name));
    }

    fs::remove_file(&file_path).map_err(|e| format!("Failed to delete workspace: {}", e))?;

    log::info!("[Workspace] Deleted '{}'", name);
    Ok(format!("Workspace '{}' deleted", name))
}

// ==================== WAR ROOM LAYOUTS ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutZone {
    pub app_pattern: String, // Regex or app name to match
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub monitor: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutPreset {
    pub name: String,
    pub description: Option<String>,
    pub zones: Vec<LayoutZone>,
}

/// Save current window positions as a layout
#[tauri::command]
async fn save_layout(name: String) -> Result<String, String> {
    use std::fs;

    let windows = get_all_windows_snapshot().await?;

    let zones: Vec<LayoutZone> = windows
        .into_iter()
        .map(|w| LayoutZone {
            app_pattern: w.app_name,
            x: w.x,
            y: w.y,
            width: w.width,
            height: w.height,
            monitor: 0, // TODO: detect which monitor
        })
        .collect();

    let layout = LayoutPreset {
        name: name.clone(),
        description: None,
        zones,
    };

    let iris_dir = get_iris_dir()?;
    let layouts_dir = iris_dir.join("layouts");
    fs::create_dir_all(&layouts_dir).ok();

    let file_path = contained_storage_path(&layouts_dir, &name, "json")?;
    let json = serde_json::to_string_pretty(&layout)
        .map_err(|e| format!("Failed to serialize layout: {}", e))?;

    fs::write(&file_path, json).map_err(|e| format!("Failed to save layout: {}", e))?;

    log::info!(
        "[Layout] Saved '{}' with {} zones",
        name,
        layout.zones.len()
    );
    Ok(format!(
        "Layout '{}' saved with {} zones",
        name,
        layout.zones.len()
    ))
}

/// Load a layout and position matching windows
#[tauri::command]
async fn load_layout(name: String) -> Result<String, String> {
    use std::fs;

    let iris_dir = get_iris_dir()?;
    let file_path = contained_storage_path(&iris_dir.join("layouts"), &name, "json")?;

    if !file_path.exists() {
        return Err(format!("Layout '{}' not found", name));
    }

    let content =
        fs::read_to_string(&file_path).map_err(|e| format!("Failed to read layout: {}", e))?;

    let layout: LayoutPreset =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse layout: {}", e))?;

    let mut positioned = 0;

    for zone in &layout.zones {
        // Position windows matching this app pattern
        let script = format!(
            r#"
            Add-Type @'
            using System;
            using System.Runtime.InteropServices;
            using System.Text;
            using System.Diagnostics;
            public class LayoutPos {{
                [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
                [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
                [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
                [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
                public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

                public static int PositionByApp(string appPattern, int x, int y, int w, int h) {{
                    int count = 0;
                    EnumWindows((hWnd, lParam) => {{
                        if (!IsWindowVisible(hWnd)) return true;
                        uint pid;
                        GetWindowThreadProcessId(hWnd, out pid);
                        try {{
                            var proc = Process.GetProcessById((int)pid);
                            if (proc.ProcessName.ToLower().Contains(appPattern.ToLower())) {{
                                SetWindowPos(hWnd, IntPtr.Zero, x, y, w, h, 0x0040);
                                count++;
                            }}
                        }} catch {{}}
                        return true;
                    }}, IntPtr.Zero);
                    return count;
                }}
            }}
'@
            [LayoutPos]::PositionByApp($env:IRIS_APP_PATTERN, {}, {}, {}, {})
            "#,
            zone.x, zone.y, zone.width, zone.height
        );

        if let Ok(output) =
            powershell_with_data(&script, &[("IRIS_APP_PATTERN", &zone.app_pattern)]).output()
        {
            if let Ok(count) = String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<i32>()
            {
                positioned += count;
            }
        }
    }

    log::info!(
        "[Layout] Applied '{}': positioned {} windows",
        name,
        positioned
    );
    Ok(format!(
        "Layout '{}' applied: {} windows positioned",
        name, positioned
    ))
}

/// List all saved layouts
#[tauri::command]
async fn list_layouts() -> Result<Vec<String>, String> {
    use std::fs;

    let iris_dir = get_iris_dir()?;
    let layouts_dir = iris_dir.join("layouts");

    if !layouts_dir.exists() {
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(layouts_dir).map_err(|e| format!("Failed to read layouts: {}", e))?;

    let mut layouts = Vec::new();
    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.extension().map(|e| e == "json").unwrap_or(false) {
                if let Some(stem) = path.file_stem() {
                    layouts.push(stem.to_string_lossy().to_string());
                }
            }
        }
    }

    Ok(layouts)
}

// ==================== THE GAUNTLET (MACROS) ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacroStep {
    pub action: String,
    pub params: Option<serde_json::Value>,
    pub delay_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacroDefinition {
    pub name: String,
    pub trigger: String,
    pub aliases: Option<Vec<String>>,
    pub description: Option<String>,
    pub steps: Vec<MacroStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacroInfo {
    pub name: String,
    pub trigger: String,
    pub aliases: Vec<String>,
    pub description: Option<String>,
    pub step_count: usize,
}

/// List all macros
#[tauri::command]
async fn list_macros() -> Result<Vec<MacroInfo>, String> {
    use std::fs;

    let iris_dir = get_iris_dir()?;
    let macros_dir = iris_dir.join("macros");

    if !macros_dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(macros_dir).map_err(|e| format!("Failed to read macros: {}", e))?;

    let mut macros = Vec::new();
    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            let ext = path.extension().and_then(|e| e.to_str());
            if ext == Some("yaml") || ext == Some("yml") || ext == Some("json") {
                if let Ok(content) = fs::read_to_string(&path) {
                    // Try YAML first, then JSON
                    let macro_def: Option<MacroDefinition> = if ext == Some("json") {
                        serde_json::from_str(&content).ok()
                    } else {
                        serde_yaml::from_str(&content).ok()
                    };

                    if let Some(def) = macro_def {
                        macros.push(MacroInfo {
                            name: def.name,
                            trigger: def.trigger,
                            aliases: def.aliases.unwrap_or_default(),
                            description: def.description,
                            step_count: def.steps.len(),
                        });
                    }
                }
            }
        }
    }

    Ok(macros)
}

/// Get a macro by name or trigger
#[tauri::command]
async fn get_macro(name_or_trigger: String) -> Result<MacroDefinition, String> {
    use std::fs;

    let iris_dir = get_iris_dir()?;
    let macros_dir = iris_dir.join("macros");

    if !macros_dir.exists() {
        return Err("No macros directory".to_string());
    }

    let search = name_or_trigger.to_lowercase();

    let entries = fs::read_dir(macros_dir).map_err(|e| format!("Failed to read macros: {}", e))?;

    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            let ext = path.extension().and_then(|e| e.to_str());
            if ext == Some("yaml") || ext == Some("yml") || ext == Some("json") {
                if let Ok(content) = fs::read_to_string(&path) {
                    let macro_def: Option<MacroDefinition> = if ext == Some("json") {
                        serde_json::from_str(&content).ok()
                    } else {
                        serde_yaml::from_str(&content).ok()
                    };

                    if let Some(def) = macro_def {
                        // Match by name, trigger, or aliases
                        if def.name.to_lowercase() == search
                            || def.trigger.to_lowercase() == search
                            || def
                                .aliases
                                .as_ref()
                                .map(|a| a.iter().any(|alias| alias.to_lowercase() == search))
                                .unwrap_or(false)
                        {
                            return Ok(def);
                        }
                    }
                }
            }
        }
    }

    Err(format!("Macro '{}' not found", name_or_trigger))
}

/// Save a macro
#[tauri::command]
async fn save_macro(name: String, yaml_content: String) -> Result<String, String> {
    use std::fs;

    let iris_dir = get_iris_dir()?;
    let macros_dir = iris_dir.join("macros");
    fs::create_dir_all(&macros_dir).ok();

    // Validate the YAML
    let _: MacroDefinition =
        serde_yaml::from_str(&yaml_content).map_err(|e| format!("Invalid macro YAML: {}", e))?;

    let file_path = contained_storage_path(&macros_dir, &name, "yaml")?;
    fs::write(&file_path, yaml_content).map_err(|e| format!("Failed to save macro: {}", e))?;

    log::info!("[Macro] Saved '{}'", name);
    Ok(format!("Macro '{}' saved", name))
}

// ==================== SCREEN ANNOTATION ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Annotation {
    pub id: String,
    pub annotation_type: String, // "circle", "arrow", "highlight", "text"
    pub x: i32,
    pub y: i32,
    pub x2: Option<i32>, // For arrows, end point
    pub y2: Option<i32>,
    pub radius: Option<u32>, // For circles
    pub width: Option<u32>,  // For highlights
    pub height: Option<u32>,
    pub color: Option<String>,
    pub text: Option<String>,
    pub auto_fade_ms: Option<u64>,
}

lazy_static::lazy_static! {
    static ref ANNOTATIONS: Mutex<Vec<Annotation>> = Mutex::new(Vec::new());
}

/// Show the annotation overlay window
#[tauri::command]
async fn show_annotation_overlay<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("annotation") {
        window.show().map_err(|e| e.to_string())?;
        // CRITICAL: Make window click-through so user can interact with stuff underneath
        window
            .set_ignore_cursor_events(true)
            .map_err(|e| e.to_string())?;
        // Don't set focus - we want it to be a passive overlay
    } else {
        log::warn!("[Annotation] Annotation window not found");
    }
    Ok(())
}

/// Hide the annotation overlay window
#[tauri::command]
async fn hide_annotation_overlay<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("annotation") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Add an annotation to the overlay
/// Add an annotation to the overlay
#[tauri::command]
async fn add_annotation<R: Runtime>(
    app: AppHandle<R>,
    annotation: Annotation,
) -> Result<String, String> {
    let id = annotation.id.clone();
    let mut final_annotation = annotation.clone();
    let mut monitor_offset_x = 0;
    let mut monitor_offset_y = 0;

    // Multi-monitor handling: Move window to the target monitor
    if let Some(window) = app.get_webview_window("annotation") {
        if let Ok(monitors) = window.available_monitors() {
            let x = annotation.x;
            let y = annotation.y;

            // Find monitor that contains the annotation point
            let target_monitor = monitors.into_iter().find(|m| {
                let pos = m.position();
                let size = m.size();
                x >= pos.x
                    && x < pos.x + (size.width as i32)
                    && y >= pos.y
                    && y < pos.y + (size.height as i32)
            });

            if let Some(monitor) = target_monitor {
                let pos = monitor.position();
                let size = monitor.size();

                log::info!(
                    "[Annotation] Target Monitor: {:?} at {:?} size {:?}",
                    monitor.name(),
                    pos,
                    size
                );

                // Move and resize window to cover this monitor
                // We use Physical positions/sizes which set_position/set_size expect
                let _ = window.set_position(*pos);
                let _ = window.set_size(*size);

                // Track offset to adjust coordinates for the webview (which sees 0,0 as top-left of window)
                monitor_offset_x = pos.x;
                monitor_offset_y = pos.y;
            } else {
                log::warn!(
                    "[Annotation] Point {},{} not on any known monitor, using default placement",
                    x,
                    y
                );
            }
        }

        // Show window and ensure it's on top
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        log::warn!("[Annotation] Annotation window not found");
    }

    // Adjust coordinates to be relative to the window origin
    final_annotation.x -= monitor_offset_x;
    final_annotation.y -= monitor_offset_y;
    if let Some(x2) = final_annotation.x2 {
        final_annotation.x2 = Some(x2 - monitor_offset_x);
    }
    if let Some(y2) = final_annotation.y2 {
        final_annotation.y2 = Some(y2 - monitor_offset_y);
    }

    {
        let mut annotations = ANNOTATIONS.lock().unwrap();
        annotations.push(final_annotation.clone());
    }

    // Give it a moment to wake up/render if it was hidden
    // Note: React async listener setup takes time - 2000ms gives enough buffer
    // The window.show() triggers React mount, then listen() is async with .then()
    std::thread::sleep(std::time::Duration::from_millis(2000));

    // Emit event directly to the annotation window (not broadcast)
    log::info!(
        "[Annotation] Emitting annotation-add event to annotation window for: {}",
        id
    );
    if let Some(window) = app.get_webview_window("annotation") {
        window
            .emit("annotation-add", &final_annotation)
            .map_err(|e| e.to_string())?;
    } else {
        log::warn!("[Annotation] Could not find annotation window to emit event!");
        // Fallback to broadcast
        app.emit("annotation-add", &final_annotation)
            .map_err(|e| e.to_string())?;
    }

    // Auto-fade if specified
    if let Some(fade_ms) = final_annotation.auto_fade_ms {
        let app_clone = app.clone();
        let id_clone = id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(fade_ms));
            let _ = tauri::async_runtime::block_on(remove_annotation(app_clone, id_clone));
        });
    }

    log::info!(
        "[Annotation] Added: {:?} at local {},{}",
        id,
        final_annotation.x,
        final_annotation.y
    );
    Ok(id)
}

/// Remove a specific annotation
#[tauri::command]
async fn remove_annotation<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    {
        let mut annotations = ANNOTATIONS.lock().unwrap();
        annotations.retain(|a| a.id != id);
    }

    app.emit("annotation-remove", &id)
        .map_err(|e| e.to_string())?;

    // If no more annotations, hide the overlay
    let count = ANNOTATIONS.lock().unwrap().len();
    if count == 0 {
        hide_annotation_overlay(app).await?;
    }

    Ok(())
}

/// Clear all annotations
#[tauri::command]
async fn clear_annotations<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    {
        let mut annotations = ANNOTATIONS.lock().unwrap();
        annotations.clear();
    }

    app.emit("annotation-clear", ())
        .map_err(|e| e.to_string())?;
    hide_annotation_overlay(app).await?;

    log::info!("[Annotation] Cleared all");
    Ok(())
}

/// Get all current annotations
#[tauri::command]
async fn get_annotations() -> Result<Vec<Annotation>, String> {
    let annotations = ANNOTATIONS.lock().unwrap();
    Ok(annotations.clone())
}

/// Show the Grid Calibrator window
#[tauri::command]
async fn show_grid_calibrator<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("grid-calibrator") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        log::info!("[GridCalibrator] Window shown");
    } else {
        log::warn!("[GridCalibrator] Window not found");
        return Err("Grid Calibrator window not found".to_string());
    }
    Ok(())
}

/// Hide the Grid Calibrator window
#[tauri::command]
async fn hide_grid_calibrator<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("grid-calibrator") {
        window.hide().map_err(|e| e.to_string())?;
        log::info!("[GridCalibrator] Window hidden");
    }
    Ok(())
}

/// Toggle debug grid overlay
#[tauri::command]
async fn toggle_debug_grid<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    // Make sure annotation overlay is visible
    show_annotation_overlay(app.clone()).await?;

    // Emit toggle event specifically to annotation window
    if let Some(window) = app.get_webview_window("annotation") {
        window
            .emit("debug-grid-toggle", ())
            .map_err(|e| e.to_string())?;
        log::info!("[Annotation] Emitted debug-grid-toggle to annotation window");
    } else {
        log::warn!("[Annotation] Could not find annotation window for debug grid toggle");
    }

    log::info!("[Annotation] Toggled debug grid");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load local development configuration without ever exposing secrets to the renderer.
    let _ = dotenvy::dotenv();
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "canvas" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let icon_bytes = include_bytes!("../icons/32x32.png");
            let icon_image = image::load_from_memory(icon_bytes)
                .expect("Failed to decode tray icon")
                .to_rgba8();
            let (width, height) = icon_image.dimensions();
            let icon = Image::new_owned(icon_image.into_raw(), width, height);
            let show_item = MenuItemBuilder::with_id("show", "Show IRIS").build(app)?;
            let hide_item = MenuItemBuilder::with_id("hide", "Hide IRIS").build(app)?;
            let separator = MenuItemBuilder::with_id("sep", "---------")
                .enabled(false)
                .build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit IRIS").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&show_item, &hide_item, &separator, &quit_item])
                .build()?;
            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("IRIS Desktop - Press Ctrl+Shift+I to toggle")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;
            let shortcut_toggle_iris =
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyI);
            let shortcut_debug_grid =
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyG);
            let app_handle = app.handle().clone();
            let app_handle_grid = app.handle().clone();
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |_app, shortcut_pressed, event| {
                        if event.state == ShortcutState::Pressed {
                            if shortcut_pressed == &shortcut_toggle_iris {
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    if window.is_visible().unwrap_or(false) {
                                        let _ = window.hide();
                                    } else {
                                        let _ = window.show();
                                        let _ = window.set_focus();
                                    }
                                }
                            } else if shortcut_pressed == &shortcut_debug_grid {
                                // Toggle debug grid overlay
                                let handle = app_handle_grid.clone();
                                std::thread::spawn(move || {
                                    let rt = tokio::runtime::Runtime::new()
                                        .expect("Failed to create runtime");
                                    rt.block_on(async {
                                        let _ = toggle_debug_grid(handle).await;
                                    });
                                });
                            }
                        }
                    })
                    .build(),
            )?;
            // Try to register shortcuts, but don't crash if they're already registered
            if let Err(e) = app.global_shortcut().register(shortcut_toggle_iris) {
                log::warn!("Failed to register Ctrl+Shift+I shortcut: {}", e);
            }
            if let Err(e) = app.global_shortcut().register(shortcut_debug_grid) {
                log::warn!("Failed to register Ctrl+Shift+G shortcut: {}", e);
            }
            let window = app.get_webview_window("main").unwrap();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let _ = window.show();
                let _ = window.set_focus();
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture_screen,
            capture_screen_by_index,
            get_screen_count,
            capture_all_displays,
            toggle_window,
            show_window,
            hide_window,
            minimize_window,
            show_canvas_window,
            set_always_on_top,
            set_click_through,
            quit_app,
            move_window,
            // Monitor control
            get_monitors,
            move_to_monitor,
            list_audio_devices,
            start_audio_capture,
            stop_audio_capture,
            // Echo cancellation (AEC)
            aec_set_reference,
            aec_clear_reference,
            aec_is_active,
            // System utilities
            get_system_stats,
            set_volume,
            adjust_volume,
            media_control,
            // Background system monitor (Phase 3: Proactive alerts)
            start_system_monitor,
            stop_system_monitor,
            is_system_monitor_running,
            minimize_all_windows,
            show_desktop,
            save_screenshot,
            get_time,
            get_date,
            open_folder,
            // New utilities
            set_brightness,
            adjust_brightness,
            get_wifi_status,
            save_note,
            model_chat,
            show_notification,
            // Mouse/Input control (Agency)
            get_mouse_position,
            // Keyboard control
            // Context awareness
            get_active_window,
            get_open_windows,
            get_screen_info,
            // Window manipulation
            minimize_window_by_title,
            maximize_window_by_title,
            restore_window_by_title,
            set_window_position,
            capture_window_by_title,
            // Scroll control
            scroll_horizontal,
            // Clipboard
            set_clipboard_text,
            // Guardrails - audit logging and file operations
            save_audit_log,
            count_folder_items,
            get_home_dir,
            // IRIS Hubs & Features
            init_iris_directories,
            get_all_windows_snapshot,
            // Workspace Snapshots
            save_workspace,
            list_workspaces,
            request_tool_approval,
            execute_sensitive_tool,
            request_control_session,
            cancel_control_session,
            execute_control_tool,
            launch_allowlisted_app,
            // War Room Layouts
            save_layout,
            load_layout,
            list_layouts,
            // The Gauntlet (Macros)
            list_macros,
            get_macro,
            save_macro,
            // Screen Annotation
            show_annotation_overlay,
            hide_annotation_overlay,
            add_annotation,
            remove_annotation,
            clear_annotations,
            get_annotations,
            toggle_debug_grid,
            // Grid Calibrator
            show_grid_calibrator,
            hide_grid_calibrator,
            capability_foundry::foundry_discover,
            capability_foundry::foundry_cancel_discovery,
            capability_foundry::foundry_import_openapi,
            capability_foundry::foundry_import_graphql,
            capability_foundry::foundry_import_har,
            capability_foundry::foundry_import_html,
            capability_foundry::foundry_get_candidate,
            capability_foundry::foundry_reject_candidate,
            capability_foundry::foundry_install_candidate,
            capability_foundry::foundry_list_packages,
            capability_foundry::foundry_list_tools,
            capability_foundry::foundry_set_package_enabled,
            capability_foundry::foundry_uninstall_package,
            capability_foundry::foundry_request_approval,
            capability_foundry::foundry_execute,
            capability_foundry::foundry_check_drift,
            capability_foundry::foundry_history,
            capability_foundry::foundry_mcp_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_relative_traversal_and_wildcards() {
        assert!(validate_local_path("..\\secret.txt", true).is_err());
        assert!(validate_local_path("C:\\Users\\test\\*.txt", true).is_err());
        assert!(validate_local_path("relative.txt", true).is_err());
    }

    #[test]
    fn resolves_a_regular_file_without_following_a_symlink() {
        let path =
            std::env::temp_dir().join(format!("iris-security-test-{}.txt", uuid::Uuid::new_v4()));
        fs::write(&path, "safe test data").expect("create temporary test file");
        let resolved = validate_local_path(path.to_str().expect("temporary path is UTF-8"), true)
            .expect("regular file should resolve");
        assert!(resolved.is_file());
        fs::remove_file(path).expect("remove temporary test file");
    }

    fn request(tool: &str, arguments: serde_json::Value) -> NativeToolRequest {
        NativeToolRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            tool: tool.to_string(),
            arguments,
        }
    }

    #[test]
    fn unknown_and_malformed_native_tools_fail_closed() {
        assert!(
            validate_native_tool_request(&request("not_registered", serde_json::json!({})))
                .is_err()
        );
        assert!(
            validate_native_tool_request(&request("open_url", serde_json::json!({"url": 3})))
                .is_err()
        );
        assert!(validate_native_tool_request(&request(
            "open_url",
            serde_json::json!({"url": "javascript:alert(1)"})
        ))
        .is_err());
    }

    #[test]
    fn missing_denied_and_expired_approvals_fail_closed() {
        TOOL_APPROVALS.lock().unwrap().clear();
        let req = request(
            "open_url",
            serde_json::json!({"url": "https://example.test"}),
        );
        let risk = validate_native_tool_request(&req).unwrap();
        assert!(consume_approval("denied-or-missing", &req, risk, 10).is_err());
        let id = create_approval(&req, risk, 10);
        assert!(
            consume_approval(&id, &req, risk, 10 + APPROVAL_TTL_SECONDS + 1)
                .unwrap_err()
                .contains("expired")
        );
    }

    #[test]
    fn approval_is_single_use_and_cannot_be_replayed() {
        TOOL_APPROVALS.lock().unwrap().clear();
        let req = request(
            "open_url",
            serde_json::json!({"url": "https://example.test"}),
        );
        let risk = validate_native_tool_request(&req).unwrap();
        let id = create_approval(&req, risk, 10);
        consume_approval(&id, &req, risk, 11).unwrap();
        assert!(consume_approval(&id, &req, risk, 12).is_err());
    }

    #[test]
    fn approval_is_bound_to_tool_and_normalized_arguments() {
        TOOL_APPROVALS.lock().unwrap().clear();
        let approved = request(
            "open_url",
            serde_json::json!({"url": "https://example.test/a"}),
        );
        let modified = request(
            "open_url",
            serde_json::json!({"url": "https://example.test/b"}),
        );
        let risk = validate_native_tool_request(&approved).unwrap();
        let id = create_approval(&approved, risk, 10);
        assert!(consume_approval(&id, &modified, risk, 11).is_err());

        let id = create_approval(&approved, risk, 10);
        let other = request("web_search", serde_json::json!({"query": "example"}));
        assert!(consume_approval(&id, &other, NativeRisk::High, 11).is_err());
    }

    #[test]
    fn hostile_powershell_values_are_environment_data_not_script_source() {
        let hostile = "'\"$()$(Get-Process)`;|&{}\n\r";
        let command = powershell_with_data(
            "Write-Output $env:IRIS_TEST_VALUE",
            &[("IRIS_TEST_VALUE", hostile)],
        );
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!args.join(" ").contains(hostile));
        let env_value = command
            .get_envs()
            .find(|(name, _)| *name == "IRIS_TEST_VALUE")
            .and_then(|(_, value)| value)
            .unwrap();
        assert_eq!(env_value.to_string_lossy(), hostile);
    }

    #[test]
    fn utf8_truncation_stops_at_a_character_boundary() {
        let content = format!("{}éTAIL", "a".repeat(99_999));
        let end = utf8_boundary_at_or_before(&content, 100_000);
        assert_eq!(end, 99_999);
        assert!(content.is_char_boundary(end));
        assert_eq!(&content[end..], "éTAIL");
    }

    #[tokio::test]
    async fn destructive_file_operations_use_only_temporary_fixtures() {
        let root =
            std::env::temp_dir().join(format!("iris-destructive-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("delete-me.txt");
        fs::write(&file, "fixture").unwrap();
        delete_file(file.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert!(!file.exists());
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn provider_origin_policy_rejects_remote_http_and_accepts_localhost_http() {
        assert!(validate_provider_url("http://attacker.example/v1", true).is_err());
        assert!(validate_provider_url("http://192.168.1.10:8080/v1", false).is_err());
        assert!(validate_provider_url("https://provider.example/v1", true).is_ok());
        assert!(validate_provider_url("http://127.0.0.1:11434/v1", true).is_ok());
        assert!(validate_provider_url("http://localhost:1234/v1", false).is_ok());
        assert!(validate_provider_url("https://user:secret@provider.example/v1", true).is_err());
        assert!(validate_provider_url("not a url", true).is_err());
    }

    #[test]
    fn persisted_names_reject_traversal_absolute_unc_reserved_and_overlong_values() {
        for hostile in [
            "../../outside",
            "..\\..\\outside",
            "C:\\outside",
            "\\\\server\\share",
            "NUL",
            "con.txt",
            "COM1",
            "LPT9",
            "bad:name",
            "bad/name",
        ] {
            assert!(
                safe_storage_name(hostile).is_err(),
                "accepted hostile name: {hostile}"
            );
        }
        assert!(safe_storage_name(&"x".repeat(81)).is_err());
        assert_eq!(
            safe_storage_name("Normal Unicode æ—¥æœ¬").unwrap(),
            "normal_unicode_æ—¥æœ¬"
        );
        let root = std::env::temp_dir().join("iris-name-test");
        assert!(contained_storage_path(&root, "normal name", "json")
            .unwrap()
            .starts_with(&root));
    }

    fn test_window(executable: &str, process_id: u32, window_handle: isize) -> WindowIdentity {
        WindowIdentity {
            process_id,
            window_handle,
            executable: executable.into(),
            window_title: "notes.txt - Notepad".into(),
            bounds: WindowBounds {
                left: 10,
                top: 20,
                right: 500,
                bottom: 400,
            },
        }
    }

    fn test_control_session(target: WindowIdentity) -> ControlSession {
        ControlSession {
            expires_at: 1_120,
            purpose: "edit notes".into(),
            target,
        }
    }

    #[test]
    fn control_session_allows_matching_target_and_foreground() {
        let target = test_window(r"C:\Windows\System32\notepad.exe", 42, 101);
        let session = test_control_session(target.clone());
        assert!(validate_session_binding(&session, &target, Some(&target), 1_000).is_ok());
    }

    #[test]
    fn control_session_rejects_cross_application_foreground() {
        let target = test_window(r"C:\Windows\System32\notepad.exe", 42, 101);
        let calculator = test_window(r"C:\Windows\System32\calc.exe", 43, 102);
        let session = test_control_session(target.clone());
        assert!(validate_session_binding(&session, &target, Some(&calculator), 1_000).is_err());
    }

    #[test]
    fn control_session_rejects_expired_authority() {
        let target = test_window(r"C:\Windows\System32\notepad.exe", 42, 101);
        let session = test_control_session(target.clone());
        assert!(validate_session_binding(&session, &target, Some(&target), 1_120).is_err());
    }

    #[test]
    fn control_session_rejects_target_process_or_window_exit() {
        let target = test_window(r"C:\Windows\System32\notepad.exe", 42, 101);
        let session = test_control_session(target);
        assert!(validate_session_snapshot(&session, None, None, 1_000)
            .unwrap_err()
            .contains("exited"));
    }

    #[test]
    fn control_session_rejects_pid_hwnd_or_executable_reuse() {
        let target = test_window(r"C:\Windows\System32\notepad.exe", 42, 101);
        let session = test_control_session(target.clone());
        for changed in [
            test_window(r"C:\Windows\System32\notepad.exe", 43, 101),
            test_window(r"C:\Windows\System32\notepad.exe", 42, 102),
            test_window(r"C:\Windows\System32\calc.exe", 42, 101),
        ] {
            assert!(validate_session_binding(&session, &changed, Some(&target), 1_000).is_err());
        }
    }

    #[test]
    fn control_session_rejects_mouse_coordinates_outside_target() {
        let target = WindowIdentity {
            process_id: 42,
            window_handle: 101,
            executable: r"C:\Windows\System32\notepad.exe".into(),
            window_title: "notes.txt - Notepad".into(),
            bounds: WindowBounds {
                left: 10,
                top: 20,
                right: 500,
                bottom: 400,
            },
        };
        let session = test_control_session(target);
        assert!(validate_control_point(&session, 10, 20).is_ok());
        assert!(validate_control_point(&session, 499, 399).is_ok());
        assert!(validate_control_point(&session, 500, 399).is_err());
    }

    #[test]
    fn existing_terminal_identities_are_forbidden_before_authorization() {
        for executable in [
            "cmd.exe",
            "powershell.exe",
            "pwsh.exe",
            "WindowsTerminal.exe",
            "wt.exe",
            "bash.exe",
            "wsl.exe",
            "git-bash.exe",
            "mintty.exe",
        ] {
            assert!(
                terminal_identity(executable, "ordinary title"),
                "allowed {executable}"
            );
        }
        for title in [
            "Command Prompt",
            "Windows PowerShell",
            "Windows Terminal",
            "Git Bash",
            "WSL",
        ] {
            assert!(
                terminal_identity("unknown.exe", title),
                "allowed title {title}"
            );
        }
        assert!(!terminal_identity("notepad.exe", "notes.txt - Notepad"));
    }

    #[tokio::test]
    async fn terminal_applications_are_absent_from_normal_launching() {
        for terminal in [
            "cmd",
            "cmd.exe",
            "powershell",
            "powershell.exe",
            "pwsh",
            "Windows Terminal",
            "wt",
            "Git Bash",
            "bash",
            "wsl",
        ] {
            assert!(
                launch_app(terminal.to_string()).await.is_err(),
                "terminal was allowed: {terminal}"
            );
        }
    }
}
