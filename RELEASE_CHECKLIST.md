# IRIS Desktop v0.2.0 release checklist

## Release-completion update — 2026-08-19

- [x] Correct canonical GitHub namespace in `origin`, public clone URLs, and Cargo metadata
- [x] Run clean dependency installation, production frontend build, lint, full Node suite, and npm audit
- [x] Run Rust format check, tests, Clippy, cargo audit, and local Windows Tauri package build
- [x] Re-audit Foundry, Tauri IPC/ACL, CSP, private-runtime, secret, listener, artifact, and version boundaries
- [x] Run Gemini reasoning/structured-tool smoke test with a user-owned credential
- [x] Run ElevenLabs STT and TTS smoke tests with a user-owned credential and permitted voice
- [ ] Review the current working-tree diff, create the final release commit, and verify CI on that exact commit
- [ ] Build/tag/release only from the verified exact commit; verify artifact provenance and hashes

- [x] Review README
- [ ] Review getting-started guide on a clean Windows account
- [x] Review capability and configuration documentation
- [x] Verify all internal documentation links
- [ ] Review SECURITY.md
- [ ] Review threat model
- [ ] Review Apache-2.0 licensing
- [ ] Review NOTICE
- [ ] Review trademark language
- [ ] Inspect secret-scan findings
- [ ] Inspect private-infrastructure scan
- [ ] Inspect network exposure
- [ ] Inspect dependency licenses
- [ ] Test fresh setup on a clean machine
- [x] Choose GitHub organization/repository
- [x] Replace the publication repository URL placeholder
- [ ] Inspect screenshots/assets
- [x] Create public repository
- [x] Run `cargo audit` 0.22.2 — zero known vulnerabilities after Rust dependency remediation; review informational warnings in the release audit
- [ ] Smoke-test Gemini reasoning and structured tool calls with a user-owned key
- [ ] Smoke-test ElevenLabs transcription and speech output with a user-owned key
- [ ] Push the final candidate and verify GitHub Actions/Dependabot on its exact commit
- [ ] Verify a clean clone and exact-commit source artifact
- [ ] Create v0.2.0 tag
- [ ] Publish release
- [ ] Announce project
