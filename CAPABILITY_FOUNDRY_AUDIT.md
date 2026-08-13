# IRIS Capability Foundry Audit

Audit date: 2026-08-12

Scope: `iris-desktop-oss-foundry` final authority, identity, regression, and source-package validation. This audit supplements `PUBLIC_RELEASE_AUDIT.md`; it does not replace the existing IRIS evidence.

Security invariant:

> IRIS may synthesize capabilities, but synthesized capabilities do not synthesize authority.

## Authority and package identity

The installation flow selects capability IDs, enforces a native maximum of 20, constructs the final declarative package, normalizes generated names, calculates the final package ID and SHA-256 content hash, validates schemas and collisions, and then presents that exact object in a native confirmation dialog. The confirmation individually displays every installed tool name, method, endpoint, risk, and approval requirement, plus the final origin, approved local addresses where applicable, network scope, credential requirements, package ID, and package hash. The same 20-capability bound is enforced again during approval binding and persistence. Immediately before persistence, Rust recomputes the binding and package hash. A changed hash, origin, approved DNS identity, capability set, risk, endpoint, method, schema, or scope fails with `INSTALL_PACKAGE_CHANGED_AFTER_APPROVAL`.

Maximum capabilities per trusted installation: **20**

Every capability installed in a package is individually displayed on the trusted native approval surface: **YES**

Local/private discovery uses a native `DiscoveryGrant` bound to one normalized scheme, host, port, initial DNS address set, 60-second expiry, and ten-request limit. A renderer boolean is only a request for native authorization. The approved address set is copied into the discovered package, included in its content hash and trusted installation review, and compared with fresh DNS resolution before every execution request. This supports private hostnames without rewriting the human-visible hostname. Public HTTP, public resolution under a local grant, DNS identity changes, port or host changes, expiry, limit exhaustion, cross-origin redirects, cloud metadata addresses, and unsupported schemes fail closed.

Generated tool names use `foundry_<origin>_<operation>`, lowercase provider-safe slugging, a 64-character limit, and deterministic eight-character SHA-256 suffixes for truncation or same-slug operations. Collision checks run before installation against built-ins, reserved governance/MCP names, installed packages, and the final package itself.

## Audit gates

| Gate | Result | Evidence |
|---|---|---|
| Arachne runtime independence | PASS | Runtime scan has no Arachne import or path; clean source copy builds without Arachne access. |
| Python runtime independence | PASS | No Python process, package, or runtime dependency is required. |
| OpenAPI compiler | PASS | Behavioral compilation, local-ref, semantic-risk, schema, and end-to-end tests. |
| GraphQL compiler | PASS | Query/mutation behavioral tests; mutations and consequential query fields remain governed. |
| HTML/form compiler | PASS | Bounded form extraction test; write forms remain reviewed candidates. |
| HAR observation compiler | PASS | Behavioral HAR normalization and GraphQL observation tests. |
| Sensitive observation redaction | PASS | Dummy authorization, bearer, token, cookie, private-key, and response fixtures are redacted. |
| Fail-closed sanitization | PASS | Invalid UTF-8, excessive size/nesting, and sanitizer failures do not return raw data. |
| SSRF defense | PASS | Scheme, credentials, loopback/private defaults, IPv4/IPv6 link-local, unroutable, and metadata tests. |
| Origin enforcement | PASS | Scheme, host, port, endpoint interpolation, DNS-set, and installed-package validation tests. |
| Redirect enforcement | PASS | No automatic redirects; deterministic local cross-origin redirect test rejects. |
| Local-network native authorization | PASS | Renderer self-authorization rejection and exact native grant behavioral tests. |
| Final-package installation binding | PASS | Exact persistence plus endpoint/schema/risk/tool/origin post-approval mutation tests. |
| Exact trusted install review | PASS | Native-dialog test verifies exact name, method, endpoint, origin, package ID, and hash. |
| Trusted installation review complete | PASS | Native 20-capability maximum is checked before final construction and again before approval/persistence. |
| Maximum capabilities per install | 20 | Exactly 20 are displayed and accepted; 21 are rejected before persistence. |
| Every installed capability displayed natively | PASS | No truncation or hidden remainder is permitted. |
| LAN hostname discovery/execution consistency | PASS | Requested hostname remains the origin; approved addresses are hash-bound and revalidated at execution. |
| Public HTTP blocked | PASS | Public HTTP lacks local package authority and returns `HTTPS_REQUIRED`. |
| Private hostname DNS validation | PASS | Private resolution succeeds only for the exact approved address set; change returns `CAPABILITY_TARGET_CHANGED`. |
| Metadata service blocked | PASS | Metadata addresses remain rejected regardless of local authorization. |
| Version metadata consistency | PASS | Automated test checks package.json, package-lock root, Cargo.toml, Tauri config, and MCP Cargo-derived version at 0.2.0. |
| Foundry demo documentation | PASS | Compiler test proves all three documented fixture tool names match generated output. |
| Package tamper detection | PASS | Modified package disables on registry load; MCP also verifies installed identity. |
| Semantic GET risk detection | PASS | Destructive/action GET fixtures are HIGH and approval-required; checkout/payment remain CRITICAL and disabled. |
| Generated tool namespace | PASS | Every generated tool is normalized under reserved `foundry_`. |
| Tool collision protection | PASS | Same-slug suffix, built-in isolation, installed duplicate, and registry-refresh tests. |
| Dynamic registry loading | PASS | Rust-backed `loadFromBackend` and refresh integration tests. |
| JSON Schema validation | PASS | Rust and TypeScript full-subset validation tests. |
| Write approval binding | PASS | Exact package/capability/origin/method/endpoint/argument hash, single-use, replay, and mutation tests. |
| MCP initialize | PASS | Actual STDIO subprocess test. |
| MCP tools/list | PASS | Actual installed-package STDIO subprocess test. |
| MCP tools/call | PASS | Installed read tool executes through Rust and returns a sanitized result. |
| MCP write bypass | PASS | Write call without local approval returns `APPROVAL_REQUIRED`. |
| Drift detection | PASS | Stable, additive schema, endpoint, origin, and risk scenarios. |
| Material write drift suspension | PASS | Write endpoint changes suspend authority and require review. |
| Private Solstice runtime scan | PASS | No Artemis, Nemesis, DeltaStore, Proxenos, wallet, metering, or Solstice gateway runtime hit. |
| Secret scan | PASS | Hits are empty placeholders, documentation examples, detector patterns, or explicit `test-secret-value` fixtures. |
| Clean-copy verification | PASS | Fresh source-only copy: `npm ci`, build, Node tests, and Rust tests. |

## Validation results

- `npm ci`: PASS — 361 packages added; 362 audited; MediaPipe 0.10.35 regenerated.
- `npm run build`: PASS — 2,987 modules.
- `npm run lint`: PASS — zero errors; 81 warning-debt findings.
- `npm test`: PASS — 52/52, including Foundry, voice, reasoning, and documentation regressions.
- `npm audit`: PASS — 0 vulnerabilities.
- `cargo fmt --check`: PASS.
- `cargo clippy --all-targets --all-features`: PASS; warning debt is pre-existing IRIS code.
- `cargo test`: PASS — 69 unit and 6 Foundry integration tests; 0 failed.
- Foundry behavioral tests: PASS — 48/48; existing IRIS regressions: PASS — 46/46.
- `npm run tauri:build`: PASS — v0.2.0 application, MSI, and NSIS built for validation only.
- Rust dependency remediation: PASS — Tauri 2.11.5 and targeted parent/transitive updates remove all known RustSec vulnerability findings from the locked graph.
- `cargo audit` 0.22.2: PASS — zero known vulnerabilities; remaining unmaintained/unsound warnings are inventoried separately and are not active vulnerability findings.

### RustSec informational warning inventory

- Unmaintained: 18 — the Tauri Linux GTK3 stack (`atk`, `gdk`, `gtk` and their sys/macros variants), plus transitive build/parser crates `fxhash`, `proc-macro-error`, `rustls-pemfile`, and the six `unic-*` crates.
- Unsound: 3 — `glib` 0.18.5 in Tauri's non-Windows GTK stack, `memmap2` 0.8.0 in Enigo's non-Windows XKB path, and `rand` 0.7.3 in Tauri's HTML-parser build graph.
- Yanked: 0.

These warnings are not known-vulnerability findings. The unsound entries are confined to non-Windows or build-time paths; the unmaintained `rustls-pemfile` remains in reqwest's active graph, while the other unmaintained entries are platform/build-parser debt. Current compatible Tauri and IRIS direct dependencies do not remove them without a substantial upstream/platform migration; they remain visible for continued monitoring and are not suppressed by audit configuration.

## Runtime boundary

Python, Playwright, Chromium, Arachne source, private Solstice services, arbitrary generated code, purchase execution, regulated action execution, and inbound Foundry listeners are not required or enabled. MCP remains STDIO and uses the same installed-package hash, schema, risk, approval, origin, sanitization, and audit boundaries as in-app execution.
