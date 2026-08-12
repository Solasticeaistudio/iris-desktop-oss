# Contributing to IRIS

## Setup

Install Node.js 20+, Rust 1.77.2+, the Tauri platform prerequisites, and the repository dependencies with `npm install`. Run the desktop app with `npm run tauri:dev`.

Before opening a pull request, run:

```bash
npm run build
npm run lint
npm test
cd src-tauri
cargo fmt --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

## Contributions

Keep provider-specific code behind `IrisModelProvider`. Add tools through the registry with strict schemas, explicit risk metadata, bounded results, native validation, audit behavior, and tests. Never add a low-risk alias for a dangerous native operation. Model output, clipboard text, webpages, and screenshots are untrusted.

Security-sensitive changes must describe the trust boundary, failure mode, approval behavior, and test coverage. Do not add network listeners, credentials, telemetry, remote execution, or private-service requirements without a separate security review.

Use the existing TypeScript and Rust formatting/linting tools. Keep pull requests focused, explain user-visible behavior, and include manual verification steps for desktop or platform-specific changes. Do not commit `.env`, generated output, local databases, logs, screenshots containing personal data, or dependency/build directories.

