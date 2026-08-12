# Arachne extraction matrix

Capability Foundry is a Rust/TypeScript reimplementation of reusable compiler concepts studied in the Arachne architecture. It does not copy or require the Arachne service tree at runtime.

| Arachne component | Purpose | Decision | IRIS destination | Security notes |
|---|---|---|---|---|
| `arachne/v2/models.py` | Normalized evidence, capabilities, routes, entities, risk | PORT concepts | `capability_foundry/models.rs` | Removed private compatibility fields; explicit fail-closed defaults |
| `arachne/v2/adapters.py` | Source adapters into normalized data | REIMPLEMENT | `compiler.rs` | Declarative Rust structures only |
| `arachne/v2/manifest.py` | Manifest/tool construction | REIMPLEMENT | `compiler.rs`, TypeScript Tool Registry | Full validated schema and stable namespace |
| `arachne/v2/validate.py` | Manifest validation | REIMPLEMENT | `schema.rs`, `storage.rs` | Unknown schema features rejected |
| `arachne/native.py` | OpenAPI, Swagger, GraphQL, metadata discovery | REIMPLEMENT | `discovery.rs`, `compiler.rs` | No permissive redirects; local `$ref` only; DNS/SSRF checks |
| `arachne/observed.py` | Request classification, inference, redaction, dedupe | REIMPLEMENT | `compiler.rs`, `sanitizer.rs` | HAR import only; credentials never adopted |
| `arachne/drift.py` | Fingerprints and material-change comparison | REIMPLEMENT | `drift.rs` | Material write drift removes authority |
| `arachne/crawler.py` | Bounded crawl concepts | REIMPLEMENT (bounded probes only) | `discovery.rs` | Original private-host and redirect behavior excluded |
| `arachne/js_crawler.py` | Browser-network observation | EXCLUDE runtime | HAR import | No Playwright or Chromium dependency |
| `arachne/extractors/html_extractor.py` | HTML metadata | REIMPLEMENT bounded detection | `discovery.rs` | Target content remains untrusted data |
| `arachne/extractors/form_extractor.py` | Form semantics | REIMPLEMENT bounded fields | `compiler.rs` | Forms become review candidates, not automatic writes |
| `arachne/site_intake.py` | Site intake/ownership | EXCLUDE ownership mock | native installation policy | Missing ownership never verifies a write |
| `arachne/compilers/agent_manifest_compiler.py` | Declarative action-to-tool mapping | PORT concept | `compiler.rs`, `toolRegistry.ts` | Generated data, not executable source |
| `arachne/runtime/mcp_server.py` | MCP tool exposure | REIMPLEMENT minimal standard MCP | `mcp.rs`, `iris-capability-host.rs` | STDIO only; same native host; writes denied without approval |
| `arachne/policy.py` | Domain policy | REIMPLEMENT | `risk.rs`, `execution.rs` | Removed backward-compatible `ownership_verified=True` behavior |

## Ported concepts

- Evidence provenance and confidence
- Normalized capability, route, entity, and risk records
- Native/OpenAPI/GraphQL discovery candidates
- Observed-request deduplication and bounded schema inference
- Declarative manifest-to-tool construction
- Content fingerprinting and drift comparison

## Reimplemented safeguards

- DNS-aware SSRF defense and origin-bound redirects
- Local-only `$ref` resolution with depth/cycle limits
- Full input schema enforcement at registry and native host
- Self-contained fail-closed sanitization
- Native installation confirmation and exact one-use write approval
- Tamper detection and collision protection
- Generic MCP STDIO host using the same execution boundary

## Excluded systems

Billing, metering, outreach, evidence-pack/customer artifacts, Shadow Wallet, DeltaStore, Proxenos, Nemesis, hosted gateways, tenant infrastructure, local secrets, private reporting, private Solstice connectors, generated customer data, and Python caches are excluded. No Arachne, Artemis, Python, Playwright, Chromium, or private Solstice runtime is required.

