# Open-source boundary

IRIS OSS v0.1 contains the local desktop-agent runtime: perception primitives, native computer control, structured tools, local policy and approval, local continuity, and provider integration.

The application does not require Solstice-hosted intelligence, hosted memory, managed OAuth, commercial connectors, cloud relay, fleet management, or a mobile companion. Those capabilities may exist in other Solstice products, but they are not runtime prerequisites here.

The public boundary is intentionally useful rather than a placeholder. Developers can run the mock provider offline, point the generic provider at a compatible hosted or local inference service, add reviewed local tools, and inspect the execution path. Any future hosted integration should be an optional provider or adapter and must not weaken local policy enforcement.

## Capability Foundry

Capability Foundry is self-contained Rust and TypeScript. It compiles authorized OpenAPI, Swagger, GraphQL introspection, forms, and imported HAR observations into declarative packages that execute through IRIS's native policy boundary. Required `services.artemis.arachne` runtime dependency: **NONE**. Required Python, hosted tenant, Solstice gateway, Nemesis, Proxenos, DeltaStore, Shadow Wallet, or metering runtime dependency: **NONE**.

The design is derived from the Arachne capability-compilation architecture created by Solstice AI Studio. Only general models and algorithms were reimplemented; no private service, customer artifact, credential, or hosted infrastructure is included. See [ARACHNE_EXTRACTION.md](ARACHNE_EXTRACTION.md).
