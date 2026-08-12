# Security model

IRIS uses defense in depth rather than claiming absolute security.

## Trust boundaries

- The user is the final authority for high-impact actions.
- Model providers and model output are untrusted.
- Web pages, screenshots, clipboard text, and application content are untrusted prompt input.
- The React renderer is less trusted than the Rust runtime and should request only explicit Tauri commands.
- The TypeScript registry validates model requests, but native Tauri ACLs, dispatchers, control sessions, and bound approvals are the authority boundary.
- Rust native commands are the operating-system boundary.
- The filesystem and operating system remain outside IRIS's control.
- Outbound provider HTTP is configured only at the native boundary and must be treated as an external service.

## Protections

## Native authority and GUI authority

IRIS has two complementary control planes:

```text
USER INTENT
      ↓
TARGET-BOUND GUI AUTHORIZATION
      ↓
WINDOW / PID / EXECUTABLE VALIDATION
      ↓
GUI INTERACTION
```

and:

```text
MODEL TOOL REQUEST
      ↓
IRIS NATIVE POLICY
      ↓
RISK CLASSIFICATION
      ↓
BOUND APPROVAL
      ↓
NATIVE CAPABILITY
```

Native authority covers capabilities directly implemented by IRIS, including sensitive reads, destructive filesystem operations, shell/terminal execution, power operations, and other privileged native actions. These capabilities are governed directly by the Rust policy and approval boundary.

GUI authority is temporary and scoped to an explicitly authorized application window, owning PID, HWND, and executable identity. Target binding constrains where IRIS may act; it does not universally determine what every third-party application's UI interaction means. An authorized application may expose integrated terminals, consoles, extensions, account controls, communications, purchases, administrative interfaces, or other consequential functionality. Users should review the target and purpose before authorizing GUI control.

- Unknown tools fail closed.
- Structured arguments are checked against the registered schema before handlers run.
- Tool risk and approval metadata are defined in code, not inferred solely from tool names.
- High and critical actions use a native local prompt showing the request ID, tool, risk, and arguments. Approval records are held in Rust memory, expire after 90 seconds, are bound to a hash of the exact normalized request, and are single-use.
- Renderer code and model output are not trusted to authorize native destructive actions. Sensitive execution crosses the guarded Rust dispatcher; private implementations are not direct Tauri commands.
- Custom application-command permissions are generated from an explicit app manifest. The main, canvas, annotation, and grid-calibrator windows have separate capability sets; auxiliary windows do not inherit main-window commands.
- Mouse, keyboard, focus, scrolling, and high-risk drag operations cross the native policy boundary. A 120-second control session is bound to one HWND, owning PID, and executable path. The approval dialog names the target. Identity and target existence are checked before every action; keyboard and scrolling also require that exact window to be foreground, while mouse coordinates must remain within its current bounds. Target switching requires new authorization. Terminal/shell executables and friendly terminal titles are rejected before approval. Allowlisted application launching creates no input authority; a later input action must bind to the launched window after it exists. The session cannot authorize unrelated high/critical tools.
- A control session restricts the application/window IRIS may manipulate; it is not a guarantee that every application-local effect is harmless. Visual Studio Code, Cursor, and other IDEs/editors may contain integrated terminals, debug consoles, extension systems, Git controls, or remote-development surfaces. Direct terminal/shell targets remain prohibited, but an application-local terminal or equivalent control is a residual semantic risk that target binding cannot universally infer.
- Arbitrary file and clipboard reads are privacy-sensitive high-risk tools. Each requires an exact, single-use approval. Automatic clipboard polling is disabled and clipboard values are not audited.
- Provider endpoint, model, and credential are loaded together from native environment configuration. Remote credentials require HTTPS, localhost HTTP is narrowly allowed, and redirects are disabled.
- PowerShell scripts are fixed source. Runtime text is passed as environment data; typing uses the native input library instead of PowerShell.
- Provider-generated Mermaid, SVG, and HTML are displayed as inert source in v0.1. CSP blocks eval, objects, forms, and arbitrary origins.
- CSP permits inline styles because the React animation/layout code emits style attributes; it does not permit inline scripts, `unsafe-eval`, or remote script origins. MediaPipe 0.10.35 WASM is copied from the exactly pinned installed package during `npm ci` and loaded locally. Only its face/hand task models use the narrowly allowed `https://storage.googleapis.com` renderer connection origin; model-provider traffic remains native.
- Filesystem paths must be absolute, existing, non-wildcard paths without parent traversal; symlink targets are rejected for destructive operations.
- Arbitrary shell execution is not registered or exposed as a Tauri command.
- Application launching uses an allowlist that excludes command prompts, PowerShell, Windows Terminal, Git Bash, Bash, WSL, and unknown names.
- URLs are restricted to credential-free HTTP(S) URLs before opening.
- Audit records contain sanitized arguments and outcomes, not API keys or passwords.
- No remote control or remote approval listener starts in v0.1.

## Limitations

Approval prompts cannot protect a user who approves an unsafe request. Native applications, the operating system, malicious content, compromised dependencies, and a compromised model provider remain meaningful risks. Audit logs are local records, not tamper-proof evidence. Users should review tool definitions, provider endpoints, permissions, and logs before running IRIS with sensitive data.
