# IRIS

**An open-source runtime for AI agents that can see, reason, and act on a computer.**

IRIS is a local Tauri desktop application that connects desktop perception, model reasoning, structured tools, native computer control, policy enforcement, human approval, and local auditability. It is intended for developers who want to inspect, modify, and run a real desktop-agent runtime on their own machine.

IRIS is not presented as perfectly secure or fully autonomous. Model output is treated as untrusted input, risky actions are gated, and remote control is disabled in v0.2.0.

Created by Solstice AI Studio.

## Visual identity

IRIS is represented by the procedural reactive particle sphere in `src/components/IrisParticles.tsx`. The sphere responds to idle, listening, thinking, speaking/delivering, success, and error states; microphone input and IRIS speech output independently affect its color, motion, rotation, and deformation. It requires no imported 3D model and IRIS does not ship a selectable character identity.

## What is included

- React/TypeScript desktop interface in a Tauri shell
- Rust native runtime for screen capture, monitor awareness, windows, input, clipboard, applications, workspaces, macros, and local state
- A model-provider boundary with a deterministic offline mock and configurable OpenAI-compatible HTTP provider
- In-app Gemini, OpenAI, and custom/local reasoning configuration with OS-vault credentials
- Structured tool schemas, argument validation, risk metadata, approval gates, and local audit records
- Native microphone capture with VAD/AEC, configurable OpenAI or ElevenLabs speech-to-text, and system/OpenAI/ElevenLabs speech output
- Local workspaces, macro storage, annotations, and history

The application does not require a Solstice-hosted service. Email, calendar, hosted memory, cloud relay, mobile companion control, and arbitrary shell execution are outside the v0.2.0 boundary.

## Start here

- **New user:** [Getting started](docs/GETTING_STARTED.md)
- **What IRIS can do:** [Capabilities](docs/CAPABILITIES.md)
- **Providers, API keys, and local data:** [Configuration](docs/CONFIGURATION.md)
- **Something is not working:** [Troubleshooting](docs/TROUBLESHOOTING.md)
- **All documentation:** [Documentation index](docs/README.md)

## Voice-first interaction

IRIS is designed as a conversational, voice-first desktop assistant. Native Rust audio capture performs microphone selection, voice activity detection, bounded utterance recording, and echo-reference handling. Transcription is performed by a provider selected in Settings: OpenAI (`whisper-1`, `gpt-4o-mini-transcribe`, or `gpt-4o-transcribe`) or ElevenLabs Scribe. Speech output can use an installed Windows system voice, OpenAI TTS, or an ElevenLabs/custom voice ID.

Tap-to-talk is the safe default: click the microphone, speak one utterance, and IRIS returns to standby. Cloud wake-word mode is opt-in because each detected utterance must be sent to the configured transcription provider before the wake phrase can be recognized, which can expose ambient speech and consume provider credits. A local wake-word model is not bundled in v0.2.0.

Voice credentials are stored in Windows Credential Manager and cannot be read back by the renderer. Environment variables are supported for source builds. Provider destinations are fixed in Rust, authenticated redirects are disabled, responses are bounded, and voice transcripts enter the same agent/tool/approval path as typed messages. See [docs/VOICE.md](docs/VOICE.md).

## Capability Foundry

When IRIS encounters a web system it does not have a tool for, Capability Foundry can inspect an explicitly authorized origin and compile machine-readable surfaces such as OpenAPI, Swagger, GraphQL introspection, forms, or imported network observations into a governed declarative capability package. Candidates include schemas, evidence fingerprints, network scope, risk, tests, and approval requirements. Nothing is installed until reviewed locally, and installed capabilities execute through the same Rust policy boundary as built-in tools. A single MCP-compatible STDIO host exposes approved packages without opening a listener or generating arbitrary server code.

Synthesized capability does not imply synthesized authority: a package cannot install itself, grant credentials, broaden its origin, lower risk, overwrite built-ins, or bypass native approval. Authenticated execution remains disabled until OS-protected credential storage is configured; there is no plaintext fallback. See [docs/CAPABILITY_FOUNDRY.md](docs/CAPABILITY_FOUNDRY.md) and [docs/ARACHNE_EXTRACTION.md](docs/ARACHNE_EXTRACTION.md).

## Architecture

```mermaid
flowchart TD
    U[User] --> I[IRIS Runtime]
    I --> P[Desktop Perception]
    I --> M[Model Provider]
    M --> T[Structured Tool Request]
    T --> V[Rust Native Validation]
    V --> G[Native Policy + Risk Gate]
    G -->|Allowed| E[Native Execution]
    G -->|Approval Required| A[Local Human Approval]
    A -->|Approved| E
    A -->|Denied| X[Denied Result]
    E --> R[Structured Tool Result]
    R --> M
    E --> O[Local Audit Log]
    X --> O
    O --> I
```

## Quickstart

### Prerequisites

- Windows 10/11 is the supported v0.2.0 platform
- macOS and Linux are experimental/not yet supported because several native capabilities are Windows-specific
- Node.js 20 or newer and npm
- Rust 1.92.0 with the platform prerequisites listed in the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)
- WebView2 and the Windows native build prerequisites required by Tauri

Clone the repository and install the exact locked frontend dependencies:

```bash
git clone https://github.com/solsticeaistudio/iris-desktop-oss.git
cd iris-desktop-oss
npm ci
```

Start the desktop application, then use **Settings → Reasoning provider** to choose Gemini, OpenAI, a custom/local OpenAI-compatible provider, or the offline mock. Environment configuration remains available for source-build automation:

```bash
npm run tauri:dev
```

Useful validation commands:

```bash
npm run build
npm test
cd src-tauri
cargo test
cargo fmt --check
```

On Windows PowerShell, the equivalent clean start is:

```powershell
Copy-Item .env.example .env
npm ci
npm run tauri:dev
```

For a guided first launch, provider setup, voice setup, screen test, and native approval walkthrough, follow [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md).

## Model configuration

The default provider is offline and deterministic. Windows users should normally configure reasoning in the app, where credentials are stored in Windows Credential Manager:

```env
IRIS_MODEL_PROVIDER=mock
IRIS_API_KEY=
IRIS_BASE_URL=https://example.com/v1
IRIS_MODEL=your-model
```

For an OpenAI-compatible server, set:

```env
IRIS_MODEL_PROVIDER=openai-compatible
IRIS_API_KEY=your-api-key
IRIS_BASE_URL=https://example.com/v1
IRIS_MODEL=your-model
```

`IRIS_BASE_URL`, `IRIS_MODEL`, and `IRIS_API_KEY` are loaded together by the Rust runtime. The renderer cannot supply or replace the destination that receives the credential. Credentialed remote endpoints require HTTPS; explicit `http://localhost:<port>` and `http://127.0.0.1:<port>` endpoints are allowed for local inference. Redirects are disabled for provider requests so authorization headers cannot cross origins. Never commit `.env` or place credentials in documentation, tests, or screenshots.

Gemini and OpenAI presets use fixed native API origins. Custom-provider credentials are bound to a fingerprint of the complete configured base URL, and environment credentials cannot migrate to an app-configured custom endpoint. See [docs/REASONING_PROVIDERS.md](docs/REASONING_PROVIDERS.md).

Optional voice provider environment variables are `IRIS_OPENAI_API_KEY` and `IRIS_ELEVENLABS_API_KEY`. The standard `OPENAI_API_KEY` and `ELEVENLABS_API_KEY` names are accepted as fallbacks. The in-app Voice settings are preferred on Windows because they store credentials in the OS vault.

See [docs/PROVIDERS.md](docs/PROVIDERS.md) for the provider contract.

## Safety defaults

Basic reversible desktop actions require a native, user-authorized computer-control session lasting at most 120 seconds. Before approval, IRIS resolves and displays the exact target window. Every input action revalidates its HWND, owning PID, executable identity, and foreground status; mouse coordinates must remain inside the approved window. A different application requires a new authorization, and existing terminal/shell windows are ineligible targets. The session can be cancelled and cannot authorize sensitive reads or high/critical tools. Sensitive reads and high/critical actions require a separate native one-request approval that expires after 90 seconds, is bound to the tool and normalized arguments, and is consumed once. Clipboard polling is disabled. Arbitrary file and clipboard reads require exact-action approval. Renderer code and model output are not trusted to authorize destructive native work. Computer control is temporary and bound to a specific application window; direct destructive, sensitive, and privileged IRIS capabilities remain separately gated. Because applications can expose powerful functionality through their own interfaces, users should review the target and purpose before granting GUI control.

MediaPipe presence detection uses JavaScript and WASM from the same exactly pinned `@mediapipe/tasks-vision` package. `npm ci` prepares the package's WASM files locally under `public/mediapipe/wasm`; IRIS does not fetch MediaPipe runtime code from a CDN. Face and hand task models are still fetched from the narrowly allowed `storage.googleapis.com` origin when presence detection is used.

Tool results are returned to the provider in a bounded loop. IRIS allows at most 8 tool rounds, 4 calls per provider response, 3 consecutive tool failures, and 120 seconds per request before stopping with a terminal explanation.

See [SECURITY.md](SECURITY.md), [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md), and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Development

The tool registry is in `src/lib/toolRegistry.ts`; Capability Foundry lives in `src/lib/capabilityFoundry` and `src-tauri/src/capability_foundry`; the provider boundary is in `src/lib/modelProvider.ts`; native commands and validation live in `src-tauri/src/lib.rs`. Read [docs/TOOLS.md](docs/TOOLS.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/CAPABILITY_FOUNDRY.md](docs/CAPABILITY_FOUNDRY.md), and [CONTRIBUTING.md](CONTRIBUTING.md) before adding capabilities.

## License and trademarks

IRIS is released under the Apache License 2.0. The license does not grant permission to use the IRIS or Solstice names, logos, or marks to impersonate an official distribution. See [NOTICE](NOTICE) for the short trademark notice.
