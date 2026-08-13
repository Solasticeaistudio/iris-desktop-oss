# Troubleshooting

Start with the exact error message and the mode you launched: development (`npm run tauri:dev`) or release (`npm run tauri:build` followed by the release executable). These modes are not interchangeable.

## `localhost refused to connect`

Cause: a development Tauri executable was launched without its Vite server.

Fix:

```powershell
Set-Location C:\dev\iris-desktop-oss
npm run tauri:dev
```

For a standalone executable, first create a release build:

```powershell
npm run tauri:build
& ".\src-tauri\target\release\iris-desktop.exe"
```

Do not launch `src-tauri\target\debug\iris-desktop.exe` directly.

## IRIS says it cannot reason

The offline mock is selected. It validates the agent/tool path but does not answer general questions.

1. Open the gear icon.
2. Select Gemini, OpenAI, or Custom/local under **Reasoning provider**.
3. Save the provider and model.
4. Save the provider key if required.
5. Click **Test**.

If the provider returns an unknown-model error, enter a model ID enabled for that account. Provider model availability changes independently of IRIS.

## Reasoning connection test fails

Check:

- the key belongs to the selected provider;
- the account has quota/credits and API access;
- the model ID is valid for the account;
- the machine can reach the fixed provider origin;
- a custom remote URL uses HTTPS;
- a local URL uses explicit `localhost` or `127.0.0.1` and the local server is running;
- a proxy, VPN, firewall, or TLS inspection product is not blocking native requests.

The Test action checks the OpenAI-compatible `/models` route. A custom server that supports chat but not model listing can fail this test; confirm its API documentation before treating that as an IRIS defect.

## Microphone produces no transcript

1. Confirm Windows **Settings → Privacy & security → Microphone** permits desktop apps.
2. Select the correct microphone in IRIS Settings.
3. Confirm the STT provider key is configured separately from the reasoning key.
4. Click **Save voice settings** after choosing the STT provider; saving a credential alone does not activate it.
5. Confirm the Voice panel says **Listening: ready**.
6. Use tap-to-talk, speak clearly for at least a short sentence, and wait for the utterance to end.
7. Check provider quota and networking.

Tap-to-talk returns to standby after one utterance. Cloud wake-word mode requires continuous native listening and cloud transcription of detected utterances.

## IRIS does not speak

- Select **System speech** to test without cloud credentials.
- Confirm the selected Windows voice is installed.
- For OpenAI/ElevenLabs, save the TTS provider key in Voice settings.
- For ElevenLabs, confirm the voice ID belongs to the account and the key has text-to-speech permission.
- Check Windows output device and volume.

Listening and spoken replies are independent. Tap-to-talk returns the microphone to standby after one utterance, but IRIS still speaks reasoning responses whenever **Spoken replies** is not set to **Silent**.

Paid TTS failure may fall back to system speech.

## Screenshot is missing or blank

There are two capture paths:

- Chat capture attaches a frame in memory to the next reasoning request and does not create a file.
- The `take_screenshot` tool saves a PNG under Pictures/Screenshots.

If a vision request does not work:

- use a reasoning provider/model that accepts image content;
- make sure a screenshot preview/attachment is present before sending;
- test the primary monitor first;
- verify Windows display scaling and multi-monitor arrangement;
- avoid minimized, protected, DRM, or secure-desktop content, which Windows may return blank.

## Global shortcut does nothing

`Ctrl+Shift+I` toggles IRIS and `Ctrl+Shift+G` toggles the developer grid. Another program may already own either global shortcut. Use the IRIS tray icon to show/hide the app. Restart IRIS after closing the conflicting program if you want to retry registration.

## Native approval is not visible

Approval is a separate trusted Windows dialog. Check the taskbar or use `Alt+Tab`. The current Foundry installation flow temporarily lowers the always-on-top IRIS window so the trusted dialog can be reached. If no dialog appears, deny/cancel the request and retry with IRIS visible.

Never approve an action just to clear a dialog. Read the tool, target, arguments, and risk first.

## Computer control is denied

Expected reasons include:

- the target window no longer exists;
- its PID, HWND, or executable changed;
- a different application is foreground;
- pointer coordinates are outside the approved window;
- the 120-second session expired;
- the target is a terminal/shell application;
- the requested action needs a separate exact high-risk approval.

Re-authorize the exact safe application. Do not try to bypass target validation.

## Foundry shows packages but zero dynamic tools

Use the Foundry **Installed** tab and refresh after installation. Disabled, tampered, colliding, or materially drifted packages do not register executable tools. The header's package count and dynamic-tool count describe different things.

For the deterministic fixture demo, follow [Capability Foundry → Deterministic demo](CAPABILITY_FOUNDRY.md#deterministic-demo). The fixture server must remain running on `http://localhost:4319` while read tools execute.

## Foundry write tool does not execute

Writes require an exact native approval. The approval binds package, package hash, capability, method, endpoint, origin, risk, and argument hash. Approval is short-lived and single-use. Replays and modified arguments are intentionally rejected.

## Build fails before Rust compilation

Run a clean locked install:

```powershell
npm ci
npm run build
```

Confirm Node.js 20+ and that generated MediaPipe assets were prepared. Do not commit `node_modules`, `dist`, or `public/mediapipe/wasm`.

## Rust/Tauri build fails on Windows

Confirm:

```powershell
rustc --version
cargo --version
```

The release metadata expects Rust 1.92.0. Install Microsoft C++ Build Tools with **Desktop development with C++** and WebView2 according to the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). MSI packaging can require the Windows VBSCRIPT optional feature.

If disk usage grows, inspect before deleting anything:

```powershell
Get-ChildItem .\src-tauri\target -Force
```

`src-tauri\target`, `node_modules`, and `dist` are reproducible build output. Never run broad cleanup commands against a parent repository containing private projects.

## Reporting a problem

Before opening an issue:

1. Remove API keys, tokens, personal paths, screenshots, and private data.
2. Include Windows version, launch mode, Node/Rust versions, and the exact command.
3. Include the shortest reproducible steps and the exact sanitized error.
4. State whether the offline mock reproduces the issue.
5. For security issues, follow [SECURITY.md](../SECURITY.md) instead of opening a public exploit report.
