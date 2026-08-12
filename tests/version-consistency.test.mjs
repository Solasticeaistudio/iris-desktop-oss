import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const EXPECTED_VERSION = '0.2.0';

async function text(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

test('primary product version sources remain consistent', async () => {
  const packageJson = JSON.parse(await text('../package.json'));
  const packageLock = JSON.parse(await text('../package-lock.json'));
  const tauri = JSON.parse(await text('../src-tauri/tauri.conf.json'));
  const cargo = await text('../src-tauri/Cargo.toml');
  const mcp = await text('../src-tauri/src/capability_foundry/mcp.rs');
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const versions = {
    packageJson: packageJson.version,
    packageLock: packageLock.version,
    packageLockRoot: packageLock.packages?.['']?.version,
    cargoToml: cargoVersion,
    tauriConfig: tauri.version,
  };
  assert.deepEqual(
    new Set(Object.values(versions)),
    new Set([EXPECTED_VERSION]),
    `IRIS_VERSION_MISMATCH: ${JSON.stringify(versions)}`,
  );
  assert.match(
    mcp,
    /"version":env!\("CARGO_PKG_VERSION"\)/,
    'IRIS_VERSION_MISMATCH: MCP serverInfo must use the Cargo package version',
  );
});
