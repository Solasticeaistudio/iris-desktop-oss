import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('reasoning presets bind credentials to fixed native origins', async () => {
  const rust = await read('src-tauri/src/reasoning.rs');
  assert.match(rust, /https:\/\/generativelanguage\.googleapis\.com\/v1beta\/openai/);
  assert.match(rust, /https:\/\/api\.openai\.com\/v1/);
  assert.match(rust, /credential_username/);
  assert.match(rust, /Sha256::digest/);
  assert.match(rust, /redirect\(Policy::none\(\)\)/);
  assert.doesNotMatch(rust, /pub\s+api_key|pub\s+credential_value/);
});

test('environment credentials cannot follow app-configured custom endpoints', async () => {
  const rust = await read('src-tauri/src/reasoning.rs');
  assert.match(rust, /source == ConfigurationSource::Environment/);
  assert.match(rust, /environment\.or_else\(\|\| stored_credential\(settings\)\)/);
  assert.ok(rust.includes('format!("custom-{:x}"'));
});

test('renderer can set or clear but cannot retrieve reasoning secrets or destinations per request', async () => {
  const [client, provider, panel] = await Promise.all([
    read('src/lib/reasoning.ts'),
    read('src/lib/modelProvider.ts'),
    read('src/components/ReasoningSettingsPanel.tsx'),
  ]);
  assert.match(client, /reasoning_set_credential/);
  assert.match(client, /reasoning_clear_credential/);
  assert.doesNotMatch(client, /reasoning_get_credential/);
  assert.doesNotMatch(provider, /baseUrl|apiKey|credential/);
  assert.doesNotMatch(provider, /localStorage\.getItem\('iris-model-provider'\)/);
  assert.match(panel, /type="password"/);
});

test('reasoning native commands are restricted to the primary renderer', async () => {
  const [main, auxiliary, annotation] = await Promise.all([
    read('src-tauri/permissions/main.toml'),
    read('src-tauri/capabilities/auxiliary.json'),
    read('src-tauri/capabilities/annotation.json'),
  ]);
  for (const command of ['reasoning_get_status', 'reasoning_save_settings', 'reasoning_set_credential', 'reasoning_clear_credential', 'reasoning_test_connection']) {
    assert.match(main, new RegExp(`"${command}"`));
    assert.doesNotMatch(auxiliary + annotation, new RegExp(command));
  }
});

test('model responses are bounded before JSON parsing', async () => {
  const [rust, provider] = await Promise.all([
    read('src-tauri/src/lib.rs'),
    read('src/lib/modelProvider.ts'),
  ]);
  assert.match(rust, /MAX_PROVIDER_RESPONSE_BYTES/);
  assert.match(rust, /Provider response exceeded the 4 MiB limit/);
  assert.match(rust, /serde_json::from_slice\(&payload_bytes\)/);
  assert.match(provider, /response\.choices\?\.\[0\]\?\.message/);
});
