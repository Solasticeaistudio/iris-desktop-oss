# Security policy

IRIS is a desktop automation runtime and should be treated as security-sensitive software. It is not guaranteed to be secure, and users should review prompts, tools, provider endpoints, and permissions before use.

## Reporting a vulnerability

Do not open a public issue for an unpatched security vulnerability. Contact the maintainers through the security contact configured for the repository after publication. Until a public security address exists, use a private repository contact or maintainer channel and include reproduction steps, affected version, platform, impact, and a suggested mitigation.

Please do not include API keys, personal files, credentials, or screenshots containing private data in a report.

## Security expectations

Changes that add native commands, filesystem operations, external communication, shell/process control, provider handling, or approval logic require tests and a threat-model review. Remote control is intentionally absent in v0.2.0.

See [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
