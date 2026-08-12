# Architecture

IRIS is a local desktop application. The React renderer presents conversation, settings, annotations, workspaces, and tool status. Tauri exposes a deliberately selected set of native commands. The Rust runtime owns operating-system access, provider HTTP requests, local state, risk-sensitive validation, and audit persistence.

## Execution lifecycle

```text
Observation
    ↓
Reasoning through the configured model provider
    ↓
Structured tool proposal
    ↓
Tool lookup and schema validation
    ↓
Risk classification and policy decision
    ↓
Local human approval when required
    ↓
Native Tauri command
    ↓
Sanitized result and local audit event
    ↓
Next observation
```

The provider returns text and optional structured tool calls. `runAgentLoop` executes calls sequentially, appends provider-neutral `tool` messages with matching call IDs, and asks the provider to continue until it returns final text. The loop stops after 8 tool rounds, more than 4 calls in one response, 3 consecutive tool failures, cancellation, or 120 seconds.

The renderer never authorizes a native capability. Reversible computer control follows `renderer -> resolve target HWND/PID/executable -> native dialog naming that target -> execute_control_tool -> revalidate identity/foreground/bounds -> private implementation`. Authorization expires after 120 seconds, ends when the target disappears or changes identity, and is subordinate to tool-specific policy. Switching applications requires a new authorization. Allowlisted app launching is separate because a target window must exist before input authority can be granted. Sensitive/high/critical requests follow `renderer -> request_tool_approval -> native validation -> native dialog -> bound approval token -> execute_sensitive_tool -> private implementation`. Tokens bind request ID, tool, normalized arguments, and risk, expire after 90 seconds, and are consumed once. Dangerous and raw keyboard/mouse implementation functions are not direct Tauri commands.

Provider endpoint, model, and API key are read together in Rust from the process environment or `.env`; renderer requests contain none of those values. Remote credentialed origins require HTTPS, localhost HTTP has an explicit exception, and provider redirects are disabled. Provider responses are treated as untrusted data.

Workspaces, layouts, macros, and notes use shared persisted-name validation that rejects traversal, separators, reserved device names, absolute/UNC paths, and overlong names before containment under their storage root. The runtime does not start an inbound HTTP, WebSocket, relay, or companion server.

The canonical visual renderer is the asset-free procedural sphere in `IrisParticles.tsx`. Imported model loaders, model manifests, selectable character forms, and the obsolete Holopoint model view are not part of v0.1.
