# OSS removal manifest

## Hosted Solstice intelligence

- **Reason removed:** The public runtime must not require private hosted query, speech, memory, or routing endpoints.
- **OSS replacement/interface:** `IrisModelProvider`, with offline mock and generic OpenAI-compatible provider.
- **Potential future OSS work:** Additional reviewed provider adapters.

## Lethe, Mnemosyne, and hosted memory

- **Reason removed:** They were private hosted continuity services rather than local runtime components.
- **OSS replacement/interface:** Local history, workspaces, macros, and audit records.
- **Potential future OSS work:** A documented local memory adapter with explicit privacy controls.

## Managed Gmail, Calendar, OAuth, and private connectors

- **Reason removed:** These integrations depended on private backend routes, managed credentials, or enterprise connectors.
- **OSS replacement/interface:** Add local, separately reviewed tools or provider adapters through the public registry.
- **Potential future OSS work:** Community-maintained integrations with their own consent and security review.

## SIMA and commercial planning/administration

- **Reason removed:** Hosted simulation, fleet, entitlement, billing, and enterprise-management services are outside a local v0.1 runtime.
- **OSS replacement/interface:** Local risk metadata, schema validation, approval, and audit.
- **Potential future OSS work:** A local impact-preview API that cannot bypass policy.

## Mobile companion and cloud relay

- **Reason removed:** The previous pathway did not provide the authenticated pairing and request binding required for a public remote-control surface.
- **OSS replacement/interface:** Local approval in the desktop application.
- **Potential future OSS work:** Secure paired-device approval only after a complete authentication, authorization, replay, and transport design.

## Arbitrary shell execution

- **Reason removed:** Unrestricted model-driven shell access is too broad for conservative v0.1 defaults.
- **OSS replacement/interface:** Allowlisted native desktop primitives.
- **Potential future OSS work:** Narrow, platform-specific commands with explicit high/critical approval and dedicated tests.

