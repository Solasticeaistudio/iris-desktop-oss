# IRIS documentation

This directory documents IRIS Desktop v0.2.0 as it is implemented in this repository. Start with the user guides, then move into security or contributor material when you need more detail.

## Start here

| I want to... | Read |
| --- | --- |
| Install IRIS and complete the first setup | [Getting started](GETTING_STARTED.md) |
| Understand what IRIS can and cannot do | [Capabilities](CAPABILITIES.md) |
| Configure reasoning, voice, keys, and local storage | [Configuration](CONFIGURATION.md) |
| Fix a startup, provider, voice, capture, or build problem | [Troubleshooting](TROUBLESHOOTING.md) |
| Configure speech input and output in depth | [Voice](VOICE.md) |
| Discover and install governed web capabilities | [Capability Foundry](CAPABILITY_FOUNDRY.md) |

## Security and privacy

- [Security policy](../SECURITY.md) — supported versions and vulnerability reporting.
- [Security model](SECURITY_MODEL.md) — trust boundaries and enforced controls.
- [Threat model](THREAT_MODEL.md) — assets, threats, mitigations, and limitations.
- [Open-source boundary](OPEN_SOURCE_BOUNDARY.md) — what is intentionally absent from OSS.
- [Capability Foundry audit](../CAPABILITY_FOUNDRY_AUDIT.md) — Foundry validation evidence.

## Architecture and contributors

- [Architecture](ARCHITECTURE.md)
- [Tool development](TOOLS.md)
- [Provider development](PROVIDERS.md)
- [Reasoning providers](REASONING_PROVIDERS.md)
- [Annotation system](ANNOTATION_SYSTEM.md)
- [Arachne extraction](ARACHNE_EXTRACTION.md)
- [Contributing](../CONTRIBUTING.md)

## Release evidence

- [Public release audit](../PUBLIC_RELEASE_AUDIT.md)
- [Release checklist](../RELEASE_CHECKLIST.md)
- [Removal manifest](../REMOVAL_MANIFEST.md)

Documentation describes the current source tree, not a promise of future behavior. When documentation and executable behavior disagree, open an issue and treat the implementation and native security boundary as authoritative.
