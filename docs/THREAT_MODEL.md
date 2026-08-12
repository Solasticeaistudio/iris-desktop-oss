# Threat model

## Assets

- User files and filesystem metadata
- Clipboard contents, screenshots, microphone input, and window context
- Provider credentials and model prompts
- Local workspaces, macros, history, and audit records
- The ability to control the desktop

## Threats and mitigations

## Application-local semantic authority

Target-bound computer control restricts the operating-system application/window that IRIS may manipulate. It does not provide universal semantic understanding of every control exposed by that application:

```text
target binding ≠ semantic harmlessness
```

An authorized application may expose integrated terminals, debug consoles, extension systems, account controls, external communications, purchases, file mutation, cloud-resource management, or administrative interfaces. Visual Studio Code, Cursor, and other IDEs/editors are examples because their own UI may contain powerful application-local surfaces. The user should authorize GUI control based on the target application's capabilities and the requested purpose. Direct terminal/shell applications remain ineligible targets, but an embedded terminal inside an otherwise authorized application remains a residual semantic risk.

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Prompt injection in a webpage or document | Context is untrusted; the system prompt requires structured tools and policy checks | A user may still approve a harmful action |
| Malicious model output | Registry lookup, strict argument validation, risk metadata, and approval | Bugs in a registered handler can still matter |
| Compromised provider or endpoint substitution | Credentials and endpoint are loaded together natively; remote credentials require HTTPS; redirects are disabled; renderer requests cannot supply an endpoint | The configured provider sees submitted prompts and approved tool results |
| File destruction or traversal | Absolute-path checks, wildcard rejection, canonicalization, and approval for deletion | A user can approve a broad valid path |
| Shell capability reconstructed from GUI primitives | No shell tool is shipped; terminal aliases cannot launch, existing shell/terminal executables cannot receive a session, and every input action is rebound to the approved PID/HWND/executable | A user-authorized non-terminal application may contain an integrated terminal, console, extension, or other powerful application-local surface |
| Focus theft or window/PID/HWND reuse | Identity is re-read before every action; keyboard/scroll require the approved foreground window; identity drift or target exit invalidates the session; mouse coordinates are contained to current target bounds | Windows can refuse focus changes, overlays can affect what a user sees, and GUI automation remains inherently sensitive |
| Sensitive read exfiltration | Arbitrary file and clipboard reads require exact-action native approval; clipboard polling is disabled | Approved content is intentionally available to the configured provider |
| Approval bypass | Native prompt; 90-second token bound to request/tool/arguments/risk; single-use consumption | OS-level UI spoofing or a compromised native process remains possible |
| Credential leakage | Keys are native-only, redacted from audit arguments, and excluded from the tree | Provider/network or host-process compromise is out of scope |
| Remote command abuse | No companion server, relay, remote approval, or inbound listener | Future networking must add authenticated pairing and request binding |
| Renderer/native abuse | Private implementations, generated application-command ACLs, per-window capabilities, guarded sensitive dispatcher, and bounded control dispatcher | Tauri/WebView or native process compromise remains in scope for review |
| Persisted-name traversal | Shared safe-name validation and storage-root containment for workspaces, layouts, macros, and notes | Local users can modify IRIS data files outside the application |
| PowerShell injection | Fixed scripts receive runtime strings only through environment data; hostile-value regression test | PowerShell itself remains part of the Windows attack surface |
| Active model markup | Raw HTML, SVG, and Mermaid are rendered as inert source; restrictive CSP | Future renderer changes could regress this boundary |
| Sensitive logs | Sanitized audit fields and local storage | Tool results or OS logs may still contain user data |
| Malicious future tools | Tool metadata and handlers must be reviewed; no unrestricted default | Contributors can introduce unsafe code |

## Future remote-control requirement

Any future companion feature must use authenticated pairing, per-request binding, replay protection, explicit authorization, and a loopback-only default until those controls are independently reviewed.
