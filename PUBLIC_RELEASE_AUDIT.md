# Public release audit

## Release-completion audit — 2026-08-19

This is the source-grounded status for the working tree prepared from `main` at
`3718b92fd19b44251bb62d16efd02a70ff699e30`, before a release commit is made.
It supersedes older counts, dependency-audit claims, and candidate status where
they differ.

| Gate | Status | Evidence |
| --- | --- | --- |
| Canonical repository namespace | PASS | `origin`, README, getting-started instructions, and Cargo metadata use `https://github.com/solsticeaistudio/iris-desktop-oss`. No old-namespace references remain in the current source tree. |
| Post-audit natural screen vision | PASS | Current HEAD's routing is covered by the Node suite: a natural screen-vision request captures the requested monitor and submits that freshly captured frame in the same reasoning turn. |
| Frontend install/build/tests | PASS | `npm ci` recreated MediaPipe 0.10.35 assets; `npm run build` succeeded (2,987 modules); `npm test` passed 63/63. |
| Frontend lint and dependency audit | PASS | `npm run lint` exited 0 with 81 existing warnings; `npm audit --audit-level=low` reported 0 vulnerabilities. |
| Rust formatting/tests/Clippy | PASS | Rust 1.92.0: `cargo fmt --check` passed; `cargo test` passed 69 unit plus 6 integration tests, and was repeated three times after fixing test-root isolation; `cargo clippy --all-targets --all-features` exited 0 with 36 existing warnings. |
| Foundry test isolation | PASS | The Foundry execution integration tests now add a process-local atomic sequence to time-derived temporary roots, preventing parallel-test directory collisions. |
| Rust dependency audit | PASS | `cargo audit` 0.22.2 reports 0 known vulnerabilities after direct `reqwest` was updated from 0.11.27 to 0.12.28, replacing vulnerable `h2` 0.3.27 with 0.4.17. It reports 17 unmaintained and 3 unsound informational warnings; none is a vulnerability result. |
| Windows production package | PASS | `npm run tauri:build` completed locally and produced ignored v0.2.0 MSI and NSIS artifacts. |
| Public boundary, secret, and listener scans | PASS | No credential-shaped values or old GitHub namespace strings found. No application inbound listener/bind implementation found; `TcpListener` usage is limited to local Rust test fixtures. Private-runtime term hits are package names or explicit boundary/removal documentation, not runtime dependencies. |
| Tauri, approval, and CSP posture | PASS | Generated-command manifest and auxiliary ACL tests pass; direct keyboard/mouse, destructive actions, and provider destination substitution remain absent from renderer IPC. CSP is restrictive and has no `unsafe-eval`; the Node/Rust suites cover approval, session binding, credential, filesystem, clipboard, Foundry, and provider failure-closed paths. |
| Live Gemini reasoning | PASS | User-owned credential smoke test passed: live reasoning and natural screen vision used a current capture; changed screen content was reflected rather than stale visual context. No credential was recorded in the repository or release evidence. |
| Live ElevenLabs STT/TTS | PASS | User-owned credential smoke test passed: tap-to-talk transcription, audible TTS response, and interruption/barge-in behavior. No credential was recorded in the repository or release evidence. |
| Live OpenAI/optional provider | NOT TESTED — OPTIONAL | No user-owned credential was supplied. It is not a v0.2 release gate when the optional provider remains optional. |
| Exact candidate CI/artifact provenance | MANUAL TEST REQUIRED | CI must run on the eventual release commit and artifacts must be rebuilt from its exact tag. |

The remaining release gates are review of this working-tree diff, a final
commit, and CI/artifact verification on that exact commit. They are not passed
by this audit.

## IRIS OSS v0.2.0 candidate update — 2026-08-13

This section supplements the original hardening record below. It covers the current voice-first interaction, in-app reasoning configuration, secure credential storage, and user-documentation candidate before live provider smoke testing and CI on the final commit.

| Gate | Status | Evidence |
| --- | --- | --- |
| Voice implementation | PASS | Native bounded microphone capture, VAD/AEC, OpenAI/ElevenLabs STT, system/OpenAI/ElevenLabs TTS, tap-to-talk default, opt-in cloud wake phrase, and same-path typed/voice policy tests. |
| Reasoning configuration | PASS | In-app mock/Gemini/OpenAI/custom configuration, fixed native Gemini/OpenAI origins, hash-bound custom credentials, Windows Credential Manager storage, no renderer credential readback, and live provider refresh. |
| OpenAI-compatible response handling | PASS | Behavioral tests cover `choices[0].message`, structured tool calls, and malformed arguments failing closed before registry schema validation. |
| Voice/reasoning ACL | PASS | New native commands are present only in the primary-window application permission; auxiliary windows receive no provider or credential authority. |
| Documentation | PASS | Getting-started, capabilities, configuration, voice, reasoning, and troubleshooting guides are linked from README. Automated validation checks required guides, launch commands, and relative links; all 23 Markdown files have zero broken relative links. |
| Frontend build/lint/tests | PASS | Production build transforms 2,987 modules. ESLint exits zero with 81 warning-debt findings. Node suite: 52 passed, 0 failed. |
| Rust format/Clippy/tests | PASS | `cargo fmt --check` and standard Clippy pass. Rust: 69 unit plus 6 Foundry integration tests passed, 0 failed. |
| Dependency audit | PASS | `npm audit`: 0 vulnerabilities. `cargo audit` 0.22.2: 0 known vulnerabilities, 18 unmaintained warnings, 3 unsound informational warnings, and 0 yanked packages. |
| Windows package build | PASS | `npm run tauri:build` produced the v0.2.0 release executable, MSI, and NSIS locally; generated output remains ignored and unpublished. |
| Secret/private-runtime scan | PASS | Credential-pattern hits are empty environment examples or documented placeholders. No private Solstice runtime path or service dependency was introduced. |
| Gemini live reasoning | PENDING | Requires a user-owned Gemini key and account quota. Do not mark passed from static or mock-provider tests. |
| ElevenLabs live STT/TTS | PENDING | Requires a user-owned ElevenLabs key, permitted voice, and account quota. Do not mark passed from static tests. |
| OpenAI live provider | NOT RUN | No account credits are currently available. This is not required when Gemini reasoning and ElevenLabs voice are validated and OpenAI remains an optional provider. |
| Final immutable commit and CI | PENDING | The voice/reasoning and documentation changes must be committed, pushed, and pass GitHub Actions and Dependabot review before tagging. |
| Exact-commit source artifact | PENDING | Create only after final smoke tests and green CI. |

Current publication blockers: live Gemini reasoning smoke test, live ElevenLabs STT/TTS smoke test, final-commit CI, and exact-commit clean-copy/source-artifact verification.

## Historical OSS hardening evidence — 2026-08-12

The following table preserves the initial source-hardening evidence recorded before the v0.2.0 voice/reasoning candidate. Later results above supersede old counts and version labels where they differ.

| Gate | Status | Evidence |
| --- | --- | --- |
| Canonical IRIS integrity | PASS | Scoped canonical status remained the same 39 entries; branch `feat/mnemosyne-memory-benchmark-v0.2` and HEAD `30e7f578ecfccefccf45678bbff6571986eade01` are unchanged. |
| Tauri application-command ACL | PASS | `build.rs` declares all 79 registered commands through `AppManifest::commands`; main uses `allow-main-commands`; generated ACL compiles in release mode. The added launch command is narrowly allowlisted and creates no control session. |
| Auxiliary-window least privilege | PASS | Canvas receives only core event/window access; annotation receives only `get_annotations`/`clear_annotations`; grid calibrator receives only `hide_grid_calibrator`; none receives main command access. Behavioral/static ACL test passes. |
| Provider credential/origin binding | PASS | Renderer model request has no base URL, model, or credential. Rust loads `IRIS_BASE_URL`, `IRIS_MODEL`, and `IRIS_API_KEY` together, validates URL semantics, requires remote HTTPS, and allows HTTP only on localhost/127.0.0.1. Rust and Node tests pass. |
| Cross-origin auth redirect defense | PASS | Native reqwest client uses `Policy::none`; provider redirects, including cross-origin redirects, are rejected before any follow-up request. |
| Terminal composition defense | PASS | Command prompt, PowerShell, pwsh, Windows Terminal, Git Bash, Bash, and WSL aliases are absent from the launch allowlist; all ten rejection cases pass. |
| Computer-control authorization | PASS | Mouse, keyboard, focus, scrolling, and drag implementations remain private. Sessions last at most 120 seconds and bind one existing HWND, PID, and executable; app launch grants no input authority. Rust behavioral tests cover same-target success, cross-app denial, expiry, exit, identity reuse, and coordinate containment. |
| GUI authority semantics documented | PASS | README, `docs/SECURITY_MODEL.md`, `docs/THREAT_MODEL.md`, and `docs/TOOLS.md` state that target binding constrains where IRIS acts, not the semantic consequence of every target-application UI action. |
| Native vs GUI authority distinction | PASS | Documentation separates native IRIS capabilities governed directly by Rust policy from temporary, target-bound GUI interaction governed by HWND/PID/executable and foreground validation. |
| Integrated-terminal limitation documented | PASS | Visual Studio Code, Cursor, and other IDE/editor integrated terminals, consoles, extensions, and similar application-local surfaces are documented as residual semantic risk; direct terminal targets remain blocked. |
| Control dialog wording accurate | PASS | Native dialog names the application/window/PID/HWND and duration, states the scope is this window, preserves separate direct-native protections, and warns that the application's own interface may expose consequential behavior. |
| Target-bound security claims precise | PASS | No documentation claims target binding guarantees harmless application behavior; the dialog and threat model use the distinction `target binding ≠ semantic harmlessness`. |
| Control-session target binding | PASS | Approval resolves and displays the exact application, title, PID, and HWND. Every action re-reads HWND/PID/executable; mismatches fail with `CONTROL_SESSION_TARGET_MISMATCH` and invalidate the session. |
| Existing terminal control defense | PASS | Session creation rejects cmd, PowerShell, pwsh, Windows Terminal, wt, Bash, WSL, Git Bash, and mintty executable identities plus defensive friendly-title matches. Native behavioral test covers all listed identities. |
| Foreground input validation | PASS | Type, key, key-combo, scroll, mouse, and drag require the approved foreground identity. Focus can target only the already approved window; another window returns `NEW_CONTROL_AUTHORIZATION_REQUIRED`. |
| Mouse target containment | PASS | Move, click, double-click, right-click, and both high-risk drag endpoints must fall within the current approved window bounds; boundary behavioral test passes. |
| Control-session expiry | PASS | Expiry is enforced natively at 120 seconds; expired-session behavioral test passes. |
| Target-exit invalidation | PASS | Missing window/process observations fail closed and remove the native session. Target-exit and PID/HWND/executable-reuse tests pass. |
| Sensitive file read policy | PASS | `read_file` is High risk and private; an exact request/path receives native validation and a bound single-use approval before reading. Traversal/wildcard/symlink tests pass. |
| Clipboard privacy policy | PASS | Automatic clipboard monitor/toast removed. Clipboard reads are private High-risk operations with per-read approval; clipboard content is not logged. |
| Legacy text action execution removed | PASS | Text-response parser/executor and call sites were removed. Regression test confirms command-looking text is returned unchanged and executes zero tools. |
| Persisted-name containment | PASS | Shared Rust validator covers notes, workspaces, layouts, and macros; separators, traversal, absolute/UNC paths, reserved devices, and >80-character names fail. Unicode and normal-name containment tests pass. |
| Reactive sphere retained | PASS | `IrisParticles.tsx` retains procedural sphere/ring/scatter/converge behavior, state colors, rainbow thinking ripple, microphone response, IRIS speech response, pulsing, rotation, success, and error states. Two deterministic identity tests and production build pass. |
| Alternate IRIS identities removed | PASS | Animated character component, model/form selection/morphing code, manifest, model loaders, and Holopoint model view/window/command were removed. Final `mew`, `chibi`, and `baymax` source scan has zero hits. |
| Built-in GLB/GLTF/STL assets | PASS | Final public source counts: GLB 0, GLTF 0, STL 0. Three.js is retained for the procedural sphere. |
| MediaPipe JS/WASM consistency | PASS | Package and lockfile pin `@mediapipe/tasks-vision` 0.10.35 exactly. The deterministic preparation script refuses package/installed-version mismatch and records 0.10.35 in the generated asset manifest. |
| MediaPipe runtime asset availability | PASS | `npm ci`/postinstall and prebuild copy all six WASM loader/runtime files from the installed package to `public/mediapipe/wasm`; focused Node test verifies every manifest entry. |
| MediaPipe clean-copy initialization | PASS | Clean-copy `npm ci` reproduces the local WASM set from the lockfile before build/tests; no jsDelivr runtime URL remains. Task model files remain on the explicitly documented Google Storage origin. |
| CSP after MediaPipe changes | PASS | `default-src 'self'`; `script-src 'self'`; no jsDelivr, `unsafe-eval`, object, form, or broad wildcard source. `connect-src` retains only self/Tauri IPC and `https://storage.googleapis.com` for face/hand task models. |
| Reactive sphere regression | PASS | Procedural identity tests cover all six states and both user/IRIS audio color inputs. Production build transforms `IrisParticles` without GLB/GLTF/STL assets. |
| Native destructive policy | PASS | Dangerous implementations and raw input implementations are absent from direct renderer IPC. Exact native approval binding, expiry, denial, mismatch, and replay tests pass. |
| Agent tool-result loop | PASS | Sequential provider-neutral tool messages preserve call IDs; limits are 8 rounds, 4 calls/round, 3 consecutive failures, 120 seconds, plus cancellation. Eleven agent-loop/integration tests pass. |
| PowerShell injection audit | PASS | Runtime strings are passed as environment data to fixed scripts; hostile quote/subexpression/metacharacter test confirms data never appears in command arguments. |
| Raw HTML/SVG handling | PASS | Production code has no `dangerouslySetInnerHTML` or `srcDoc`; model Mermaid/SVG/HTML is inert source. |
| Secret scan | PASS | `rg` scans for provider/cloud/GitHub keys, private keys, bearer credentials, passwords, tokens, database URLs, environment files, logs, DBs, paths, email, and phone patterns. Hits were placeholders, variable names, lockfile checksums, and intentional secret-detection regexes; no credential or personal data found. |
| Network exposure | PASS | Listener scan found no inbound TCP/WebSocket/HTTP server or `0.0.0.0` binding. Runtime inbound listeners: none. Outbound traffic is native model HTTP plus pinned MediaPipe/model resources. |
| Private runtime dependencies | PASS | Remaining Solstice references are attribution, package identifiers, historical hook names, and explicit boundary documentation. No Solstice endpoint, relay, companion server, managed OAuth, Lethe, Mnemosyne, SIMA, or Artemis runtime requirement exists. |
| npm dependency audit | PASS | Final full `npm audit` result: 0 critical, 0 high, 0 moderate, 0 low; clean install audited 363 packages. |
| Cargo dependency audit | REVIEW | `cargo-audit` is not installed. Cargo lockfile compiled in check, test, Clippy, and release profiles; manual advisory scan was not a substitute for `cargo audit`. This is a manual review item, not a known exploitable blocker. |
| Generated Tauri permission artifacts | PASS | `src-tauri/permissions/autogenerated/` contains only Tauri-generated files, is ignored by `.gitignore`, and was regenerated during the successful `npm run tauri:build`. Manual `main.toml`, `annotation.toml`, and `grid-calibrator.toml` remain source definitions. |
| Public Git-tree hygiene | PASS | Git inventory and ignore rules exclude dependencies, build output, generated MediaPipe WASM, generated Tauri permission output, installers, logs, `.env`, and local data. No unexpected generated/private files are included in the public source set. |
| Frontend build/lint/tests | PASS | Build: 2,980 modules, zero errors. ESLint exits 0 with 80 pre-existing warnings. Tests: 27 passed, 0 failed, including five focused surgical-hardening checks. |
| Rust format/test/Clippy | PASS | `cargo fmt --check` passed. Rust tests: 19 passed, 0 failed, including seven control-session behaviors. Standard Clippy passed with 35 warnings; strict `-D warnings` is not configured. |
| Tauri build | PASS | Release build produced v0.1.0 MSI and NSIS installers with locally prepared MediaPipe 0.10.35 assets; generated binaries and target output were removed from the public source tree afterward. |
| Clean-copy verification | PASS | Fresh external copy completed `npm ci` (which recreated all six MediaPipe WASM files), frontend build, all 27 Node tests, and all 19 Rust tests. Canonical/private path scan returned zero runtime hits. |
| Source cleanup | PASS | Current public Git inventory and cleaned working tree contain 101 non-ignored OSS files / 1,582,892 bytes after removing dependencies, build output, generated MediaPipe assets, and generated Tauri ACL/schema output; those artifacts remain ignored and reproducible. |

Historical non-blocking quality debt at the time of this table: Vite reported a large 1.58 MB main chunk, ESLint reported 80 legacy warnings, and Clippy reported 36 style warnings. The current cargo-audit result is recorded in the v0.2.0 candidate update above.

Historical publication blockers for that hardening pass: none. Use the current candidate blockers above for release decisions.
