# Getting started with IRIS Desktop

This guide takes a new Windows user from a clean machine to a working IRIS conversation. IRIS v0.2.0 is a pre-release, developer-oriented desktop application. Windows 10/11 is the supported platform; macOS and Linux remain experimental because important native capabilities are Windows-specific.

## What you need

- [Node.js](https://nodejs.org/en/download) 20 or newer, including npm.
- Rust 1.92.0 installed through [rustup](https://rustup.rs/).
- Microsoft C++ Build Tools with **Desktop development with C++** selected.
- Microsoft Edge WebView2. It is normally already present on current Windows 10/11 systems.
- Git.

The official [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) explains the Windows C++ and WebView2 requirements. Building MSI packages may also require the Windows VBSCRIPT optional feature.

Verify the command-line tools in PowerShell:

```powershell
node --version
npm --version
rustc --version
cargo --version
git --version
```

## Install from source

Clone the public repository and install the exact locked npm dependencies:

```powershell
Set-Location C:\dev
git clone https://github.com/solsticeaistudio/iris-desktop-oss.git
Set-Location .\iris-desktop-oss
npm ci
```

`npm ci` also copies the exactly pinned MediaPipe WASM runtime from `@mediapipe/tasks-vision` into the ignored local runtime-assets directory. It does not require Python, Arachne, or a private Solstice service.

Start IRIS in development mode:

```powershell
npm run tauri:dev
```

Keep that PowerShell window open while IRIS runs. Development mode starts the Vite frontend server and the native Tauri process together.

> Do not launch `src-tauri\target\debug\iris-desktop.exe` by itself. A development executable expects the Vite server and otherwise shows `localhost refused to connect`.

## First-run setup

### 1. Open Settings

Click the gear icon in the IRIS controls. Settings contains separate sections for reasoning and voice. API keys are password fields and cannot be read back from the renderer after storage.

### 2. Choose a reasoning provider

| Provider | Best for | Key required? |
| --- | --- | --- |
| Offline mock | Deterministic tests and Capability Foundry demos | No |
| Google Gemini | General cloud reasoning through Google's OpenAI-compatible endpoint | Yes |
| OpenAI | General cloud reasoning and vision/tool calls | Yes |
| Custom / local | An OpenAI-compatible local or hosted model | Depends on server |

For Gemini or OpenAI:

1. Select the provider.
2. Confirm the model name.
3. Click **Save provider**.
4. Paste the API key and click **Save key**.
5. Click **Test**.

Create keys only through the provider's official account pages: [Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key) or [OpenAI API keys](https://platform.openai.com/api-keys). Keys saved in the app are stored in Windows Credential Manager. Reasoning and voice credentials are intentionally separate, even when both use OpenAI.

The offline mock confirms plumbing but does not perform general reasoning. If IRIS says to configure an OpenAI-compatible provider, select a real reasoning provider in Settings.

### 3. Send a typed message

Try a non-destructive prompt first:

```text
Explain what you can do, and do not call any tools.
```

Then try a local read-only utility:

```text
What time is it?
```

IRIS sends recent conversation context and registered tool schemas to the selected reasoning provider. Model output is treated as untrusted; a model cannot grant itself native authority.

### 4. Configure voice

In **Settings → Voice**:

1. Select a microphone.
2. Choose OpenAI or ElevenLabs for speech-to-text and save that provider's key.
3. Choose Windows system speech, OpenAI, or ElevenLabs for speech output.
4. Click **Save voice settings**. Saving a key alone does not activate the selected provider.
5. Confirm the status reads **Listening: ready** and leave **Tap to talk** selected for the first test.
6. Close Settings, click the microphone, speak one sentence, and wait for transcription.

Voice input enters the same reasoning, tool, and approval path as typed input. Cloud wake-word mode is optional and sends detected utterances to the selected transcription service, which can consume credits and expose ambient speech. See [Voice](VOICE.md).

### 5. Try screen context

Use the screenshot control in the chat or type:

```text
Take a screenshot and describe what you see.
```

Chat capture is held in memory and attached to that model request; it is not necessarily saved as a file. The `take_screenshot` tool is a different action that saves a PNG under the user's Pictures/Screenshots directory.

Natural questions such as `Can you see what's on my screen?` also capture the primary monitor and submit that frame in the same reasoning turn. Mention `monitor 2` or another one-based monitor number to inspect a different display.

Screenshots leave the machine when attached to a cloud reasoning request. Review the screen first and avoid exposing credentials or sensitive applications.

### 6. Understand native approvals

Ask IRIS to interact with a safe test application, such as Notepad. Computer input requires a native authorization bound to a specific existing window, process, and executable for at most 120 seconds. High-risk actions receive a separate exact, single-use native prompt.

Read the prompt carefully. Denial is a normal outcome and prevents execution. Direct terminal/shell windows are not eligible computer-control targets.

## Window and tray controls

- Click the tray icon to show or hide IRIS.
- Right-click the tray icon for **Show**, **Hide**, and **Quit**.
- `Ctrl+Shift+I` toggles the main IRIS window when Windows grants the global shortcut.
- `Ctrl+Shift+G` toggles the developer grid overlay.

If a global shortcut is already claimed by another application, use the tray icon instead.

## Build a release executable locally

```powershell
npm run tauri:build
```

Expected outputs:

```text
src-tauri\target\release\iris-desktop.exe
src-tauri\target\release\bundle\msi\IRIS Desktop_0.2.0_x64_en-US.msi
src-tauri\target\release\bundle\nsis\IRIS Desktop_0.2.0_x64-setup.exe
```

Local binaries may be unsigned. Windows SmartScreen warnings are expected for unsigned development builds. Verify the source and build the application yourself; do not distribute an unsigned local build as an official IRIS release.

## Validate your checkout

```powershell
npm run build
npm run lint
npm test
npm audit

Push-Location src-tauri
cargo fmt --check
cargo clippy --all-targets --all-features
cargo test
cargo audit
Pop-Location
```

The repository currently has known non-fatal lint and Rust advisory warning debt; commands must still return success and report no known npm/RustSec vulnerabilities before release work proceeds.

## Where to go next

- [Capabilities](CAPABILITIES.md) explains the supported tool and feature surface.
- [Configuration](CONFIGURATION.md) lists provider, network, credential, and storage behavior.
- [Troubleshooting](TROUBLESHOOTING.md) covers common startup and provider failures.
- [Security model](SECURITY_MODEL.md) explains why approvals and target binding exist.
