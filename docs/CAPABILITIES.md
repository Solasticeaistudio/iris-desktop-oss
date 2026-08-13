# IRIS capabilities

This page describes IRIS Desktop v0.2.0 behavior verified in the current source tree. It separates core capabilities, model-visible tools, local/experimental features, and functionality intentionally outside the OSS release.

## Capability labels

| Label | Meaning |
| --- | --- |
| Supported | Implemented, wired into the application, and covered by current validation. |
| Configured | Supported after the user supplies a provider, key, target, or explicit permission. |
| Experimental | Implemented and usable, but platform coverage, UX, or automated coverage is incomplete. |
| Developer/demo | Intended primarily for deterministic development or integration testing. |
| Not included | Deliberately absent from the v0.2.0 OSS runtime. |

## At a glance

| Domain | Status | What is available |
| --- | --- | --- |
| Typed conversation | Supported | Chat history for the current session, Markdown rendering, cancellation, and bounded model/tool loops. |
| Reasoning providers | Configured | Offline mock, Gemini, OpenAI, and custom/local OpenAI-compatible endpoints. |
| Voice | Configured | Native microphone capture, VAD/AEC, cloud STT, system/cloud TTS, tap-to-talk, and opt-in cloud wake phrase. |
| Screen understanding | Configured | Monitor capture, multi-monitor selection, screenshot attachment, and vision-capable provider requests. |
| Computer control | Configured | Target-bound mouse, keyboard, scrolling, focus, and allowlisted application launching. |
| Local utilities | Supported | Volume, media, brightness, notifications, clipboard writes, approved reads, file/folder operations, and screenshots. |
| Workspace snapshots | Experimental | Save open applications/window geometry; approved restore and local listing. |
| Layouts and macros | Experimental | Local persisted layouts and YAML/JSON macro sequences routed through registered tools. |
| Canvas and annotations | Experimental | Separate artifact window plus local circles, arrows, highlights, text, and grid overlay. |
| Webcam/presence/gestures | Experimental | Camera preview and local MediaPipe-based face/hand processing. |
| Capability Foundry | Supported | Governed compilation and installation of declarative web capabilities with dynamic tool registration. |
| MCP | Developer/demo | Generic STDIO capability host for installed Foundry packages; no listener by default. |
| Remote/mobile control | Not included | No remote approval, cloud relay, or mobile companion runtime. |

## Conversation and reasoning

Typed and transcribed voice messages converge on the same agent loop. The configured model sees the system preamble, recent in-memory conversation context, optional screenshot/camera context, and validated tool definitions. Tool results return to the model until it answers or a safety limit is reached.

The loop is bounded to eight tool rounds, four calls in one model response, three consecutive tool failures, and 120 seconds per request. The offline mock supports deterministic tests but is not a general-purpose model.

Provider support:

- Gemini through a fixed native Google OpenAI-compatible origin.
- OpenAI through a fixed native OpenAI origin.
- A custom OpenAI-compatible base URL, with HTTPS required remotely and plain HTTP limited to localhost.
- Vision content when the selected provider/model supports OpenAI-style image messages.
- Structured OpenAI-compatible function/tool calls.

See [Reasoning providers](REASONING_PROVIDERS.md).

## Voice-first interaction

IRIS can:

- enumerate and select native microphone devices;
- detect voice activity and create bounded WAV utterances;
- transcribe with OpenAI or ElevenLabs;
- speak through an installed Windows voice, OpenAI, or ElevenLabs;
- use tap-to-talk as the default interaction;
- optionally transcribe utterances for cloud wake-phrase detection;
- interrupt speech and return to listening/standby;
- drive the procedural sphere from user and IRIS audio levels.

Voice does not bypass policy. A spoken request has exactly the same tool schemas, approvals, and native restrictions as a typed request. A local wake-word model and offline speech recognition are not bundled. See [Voice](VOICE.md).

## Screen, camera, and perception

IRIS supports active-monitor capture, one-based monitor selection, capture of all displays with metadata, and screenshot attachment to a conversation. The chat-capture path keeps the image in memory until it is sent and then clears the pending attachment. The save-screenshot tool writes a local PNG.

Camera preview and MediaPipe face/hand processing are present but experimental. MediaPipe JavaScript and WASM come from the pinned npm dependency; task models are fetched from Google's storage origin when those features are used. Camera frames and screenshots may be sent to the configured reasoning provider when included in a request. They are not model authority.

## Computer control

Computer control is Windows-specific and target-bound:

1. IRIS identifies the intended existing application window.
2. A native dialog displays the target.
3. Approval creates a session bound to the HWND, process ID, and executable identity for at most 120 seconds.
4. Every input action revalidates target existence and identity.
5. Keyboard and scrolling require the approved target to be foreground; pointer coordinates must remain inside it.

Changing applications requires a new session. Direct terminal/shell targets are blocked. A control session does not authorize high-risk native tools, sensitive reads, destructive file operations, or arbitrary shell execution.

## Built-in model tools

The current registry exposes 34 built-in names. `open_app` is a compatibility alias for `launch_app`; both share the same native launching path.

| Tool | Risk | Native requirement |
| --- | --- | --- |
| `launch_app`, `open_app` | Medium | Non-terminal application allowlist; later input needs target authorization. |
| `close_app` | High | Exact single-use native approval. |
| `open_url` | High | Exact HTTP(S) URL approval. |
| `open_folder` | Low | Existing absolute folder path. |
| `web_search` | High | Exact search approval before browser navigation. |
| `type_text` | Medium | Active target-bound control session. |
| `press_key_combo` | Medium | Active target-bound control session. |
| `move_mouse`, `click`, `double_click`, `right_click` | Medium | Active target-bound session and pointer containment. |
| `scroll`, `focus_window` | Medium | Active target-bound session and foreground validation. |
| `drag` | High | Target-bound session plus exact single-use approval. |
| `set_volume`, `adjust_volume` | Low | Bounded local system operation. |
| `media_control` | Medium | Bounded local media operation. |
| `set_brightness`, `adjust_brightness` | Medium | Bounded local display operation. |
| `toggle_wifi` | High | Exact single-use native approval. |
| `take_screenshot` | Low | Local capture to the Pictures/Screenshots directory. |
| `read_clipboard` | High | Exact single-use privacy approval; polling is disabled. |
| `copy_to_clipboard` | Medium | Replaces local clipboard text. |
| `read_file` | High | Existing absolute UTF-8 file, path validation, and privacy approval. |
| `show_notification` | Low | Local notification only. |
| `save_workspace` | Medium | Stores visible window/application metadata locally. |
| `load_workspace` | High | Exact approval before launching/repositioning applications. |
| `list_workspaces` | Low | Reads local snapshot names. |
| `add_annotation`, `clear_annotations` | Medium | Local annotation overlay. |
| `delete_file` | High | Exact path validation and single-use approval. |
| `delete_folder`, `clear_folder` | Critical | Exact path validation and single-use approval; protected roots blocked. |

Unknown tools and malformed or extra arguments fail closed. High/critical approvals expire after 90 seconds, are bound to the tool and normalized arguments, and are consumed once.

## Workspaces, layouts, and macros

Workspace snapshots store application/process identity, executable path when available, window title, bounds, minimized/maximized state, name, and timestamp under `~/.iris/workspaces`. Restore attempts to relaunch known executable paths and reposition matching windows. It does not preserve unsaved document contents, browser session state, or application-internal state.

Layouts are a related local window-arrangement feature stored under `~/.iris/layouts`. Macros are YAML or JSON definitions under `~/.iris/macros`. Macro steps are translated to registered Tool Registry calls, so schema checks, target sessions, and native approvals still apply. Macros are sequential and local; they are not a durable job scheduler and do not resume after a crash.

These systems are useful but experimental. Review files before use and test against disposable applications/data.

## Canvas and annotations

Canvas is a separate Tauri window for locally displayed artifacts. Canvas state is currently stored in WebView local storage and is not a versioned project/workspace format. Provider-generated executable HTML/JavaScript is not granted native authority; the restrictive CSP prevents arbitrary remote script execution.

The annotation overlay supports circles, arrows, highlights, text, pointer-style annotations, clearing, and a developer grid. Auxiliary windows have narrower Tauri command permissions than the main window.

## Capability Foundry and dynamic tools

Capability Foundry can discover or import OpenAPI/Swagger, GraphQL metadata, bounded HTML/forms, and authorized HAR observations. It normalizes candidates into declarative packages containing schemas, evidence, routes, risk, network scope, tests, and a content hash.

Installation is separate from compilation. Every installed capability appears in a trusted native review; one package is limited to 20 capabilities. Installed tools use the reserved `foundry_` namespace and cannot overwrite built-ins. Execution stays in Rust and enforces package hash, schema, origin, DNS/network policy, risk, approval, and sanitization.

Foundry supports unauthenticated capabilities fully. Credential handles are structural, but authenticated execution remains disabled unless the secure credential path is configured; packages never contain raw secrets. See [Capability Foundry](CAPABILITY_FOUNDRY.md).

## Local persistence

| Data | Location class | Notes |
| --- | --- | --- |
| Reasoning settings | `%LOCALAPPDATA%\IRIS\reasoning\config.json` | No API key. |
| Voice settings | `%LOCALAPPDATA%\IRIS\voice\config.json` | No API key. |
| Provider keys | Windows Credential Manager | Renderer receives status only. |
| Foundry packages | `%LOCALAPPDATA%\IRIS\capabilities` | Declarative packages, hashes, evidence, and registry; no raw credentials. |
| Workspaces/layouts/macros | `%USERPROFILE%\.iris` | User-authored local JSON/YAML state. |
| Audit records | `%USERPROFILE%\.iris\audit_logs` | Sanitized execution metadata; not tamper-proof. |
| Canvas/grid preferences | WebView local storage | Local UI state; do not treat as a secure store. |
| Conversation | Process memory | Current-session messages are not a durable memory system. |

## Network and privacy summary

| Action | Data that may leave the machine |
| --- | --- |
| Cloud reasoning | Prompt, recent conversation, tool schemas/results, and explicitly attached screenshot/camera context. |
| Cloud speech-to-text | Recorded utterance audio. |
| Cloud text-to-speech | IRIS response text. |
| Presence/gesture models | Model files are downloaded; camera processing is intended to remain local unless a frame is attached to reasoning. |
| Foundry discovery | Bounded requests to the explicitly authorized target origin. |
| Foundry execution | Validated capability request to its installed origin. |

Review provider privacy and billing terms before use. Do not display secrets while sending screen context.

## Intentionally not included

IRIS OSS v0.2.0 does not include:

- arbitrary shell, PowerShell, Python, JavaScript, or generated-code execution;
- remote desktop control, a remote approval listener, cloud relay, or mobile companion;
- hosted Solstice memory, private Artemis/Arachne services, or private tenant infrastructure;
- Gmail, Outlook, calendar, or other private hosted connectors;
- a plugin marketplace;
- purchase or regulated-action execution through Foundry;
- a bundled local LLM, offline STT, or local wake-word model;
- cryptographically tamper-proof audit receipts;
- a durable autonomous background-agent/job runtime.

See [Open-source boundary](OPEN_SOURCE_BOUNDARY.md) and [Security model](SECURITY_MODEL.md) for the rationale and residual limitations.
