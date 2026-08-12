# IRIS Capability Foundry

Capability Foundry compiles an explicitly authorized web surface into a deterministic, declarative capability package. It does not generate or execute Python, JavaScript, shell, PowerShell, or arbitrary Rust code.

> Synthesized capability does not imply synthesized authority.

## Flow

```text
authorized discovery or import
  -> normalized schemas, routes, evidence, and risk
  -> quarantined candidate and fixture validation
  -> native human installation review
  -> app-data package registry
  -> dynamic Tool Registry definitions
  -> native Capability Host
  -> schema, hash, origin, risk, approval, and credential checks
  -> bounded HTTP request
  -> fail-closed response sanitization
  -> structured result and non-secret audit event
```

Compilation and installation are separate. The model may identify a missing tool and recommend discovery, but only the trusted local UI can request a native installation confirmation. A single installation is limited natively to 20 capabilities so every installed name, method, endpoint, and risk is shown on the trusted approval surface. Larger sets must be installed as separate reviewed packages. The package cannot lower its own risk, approve itself, broaden its origin, attach credentials, or overwrite a built-in tool.

## Discovery and normalization

The trusted Rust runtime supports bounded probes for common OpenAPI and Swagger documents, plus detection of `sitemap.xml`, `robots.txt`, `llms.txt`, JSON-LD, GraphQL candidates, HTML, and forms. It can compile OpenAPI/Swagger, GraphQL introspection, bounded form metadata, and authorized HAR observations. HAR credentials and sensitive fields are redacted before evidence persistence.

OpenAPI `$ref` resolution is local-document only, depth bounded, cycle checked, and rejects unsupported composition. The supported JSON Schema subset is `type`, `properties`, `required`, `items`, `enum`, numeric bounds, string-length bounds, `pattern`, and boolean `additionalProperties`. Unsupported authority-widening schema keywords are rejected.

Target content is untrusted data. Target-authored descriptions are not copied into provider-visible tool descriptions. Evidence records source, provenance, confidence, and a content fingerprint without retaining raw target payloads.

## Package format

Installed package directories contain:

```text
capability.json
normalized-capabilities.json
evidence-map.json
risk-policy.json
routes.json
tests.json
drift-baseline.json
manifest.json
```

Canonical JSON and SHA-256 bind target origin, schemas, methods, routes, risk, permissions, and evidence fingerprints. This is a package hash/content fingerprint, not a publisher signature. The hash is recomputed on every load; a mismatch produces `CAPABILITY_PACKAGE_TAMPERED` and disables the package.

Packages and the registry live under the OS application-data directory in `IRIS/capabilities`, never in the source tree. Packages contain no raw secret.

## Network and execution boundary

Only HTTP(S) is accepted. Normal remote origins require HTTPS. An explicit local-network grant is required for localhost/private fixtures and private hostnames such as `printer.local`. The requested scheme, hostname, and port remain the visible package origin, while the native-approved DNS address set is separately included in the package hash. Execution re-resolves and compares the exact set before every request; changed DNS fails closed. URL credentials and malformed URLs are rejected. Loopback, link-local, cloud metadata, RFC1918, IPv6 local/private, and mapped private addresses are denied without that exact local grant; multicast and unspecified addresses remain denied universally.

The origin is bound by scheme, host, and port. Redirect handling is manual, same-origin only, credential-free, and limited to three redirects. Response size, content type, request duration, and discovery request count are bounded. The renderer never supplies an arbitrary execution URL or method.

State-changing calls require a native one-use approval bound to package ID, capability ID, package hash, method, endpoint, target origin, risk, and normalized argument hash. It expires after 90 seconds. Replay, argument changes, and use by a different tool fail.

Purchase and regulated candidates are critical and disabled by default. Unknown behavior is disabled until reviewed. GraphQL mutations require exact approval; unknown GraphQL operations are not enabled.

## Credentials and data flow

Packages use structural `credential_handle` references only. Raw credentials are prohibited from packages, renderer state, logs, HAR evidence, and tool results. Authenticated execution is intentionally disabled until an OS-protected credential backend is configured; there is no plaintext fallback.

Responses pass through size/type checks, classification, and a self-contained sanitizer. Authorization values, cookies, bearer tokens, API keys, password-like fields, private keys, credential-bearing URLs, email, and phone data are redacted. Invalid UTF-8, invalid declared JSON, excessive nesting, oversized data, or sanitizer failure returns `SANITIZATION_FAILED`; raw response data is never returned as fallback.

## MCP

`iris-capability-host` is one generic MCP-compatible STDIO host. It implements JSON-RPC `initialize`, `tools/list`, and `tools/call`. It loads an approved package and uses the same schema, hash, origin, risk, execution, and sanitizer implementation as desktop calls. It opens no listener. A write call that cannot obtain local human approval returns `APPROVAL_REQUIRED`.

Connection shape:

```json
{
  "command": "iris-desktop",
  "args": ["--capability-host", "--package", "<package-id>"]
}
```

## Drift

Rescanning creates another candidate; it does not mutate the installed package. Drift compares origin, method, endpoint, schemas, authentication, risk, evidence, and confidence. Additive output drift is reported. Origin changes, authentication changes, risk increases, method/endpoint changes, and input widening require attention. Material write drift suspends the installed package until human review and reinstallation.

## Deterministic demo

From the repository root:

```powershell
node scripts/foundry-fixture-server.mjs
npm run tauri:dev
```

Open **Capability Foundry**, choose **Discover**, enter `http://localhost:4319`, request the explicit native local-network grant, and select **Inspect site**. The fixture compiler produces these exact tools:

```text
foundry_localhost_getshipments
foundry_localhost_getdeliveryoptions
foundry_localhost_rescheduledelivery
```

Review and install the three candidates through the native dialog. Refreshing the Installed tab loads the same names into the dynamic registry. With the mock provider, invoke the read tool using `mock tool: foundry_localhost_getshipments {}`. A write invocation such as `mock tool: foundry_localhost_rescheduledelivery {"id":"shipment-1","date":"2030-01-01"}` opens an exact native approval and executes once; calling it without approval returns `APPROVAL_REQUIRED`.

To demonstrate drift, stop the fixture and restart it with `node scripts/foundry-fixture-server.mjs --drift`, discover again, then use the Drift tab to compare the new candidate. The write capability is suspended.

Launch the MCP host for an installed package:

```powershell
cargo run --manifest-path src-tauri/Cargo.toml --bin iris-capability-host -- --package <package-id>
```

Send newline-delimited MCP JSON-RPC requests for `initialize`, `tools/list`, and `tools/call` on standard input. `tools/list` reports the same `foundry_localhost_*` names; a read `tools/call` succeeds, while the write tool returns `APPROVAL_REQUIRED` without an exact local approval.

## Dependency note

Capability Foundry adds one direct crate dependency: `regex` 1.12.2, pinned exactly and licensed MIT OR Apache-2.0. Networking, hashing, serialization, async runtime, URL parsing, and application-data paths reuse dependencies already present in IRIS. No new npm runtime package is added.
