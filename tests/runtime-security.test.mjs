import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('OSS runtime has no shell capability permission', async () => {
  const capability = await read('src-tauri/capabilities/default.json');
  assert.equal(capability.includes('shell:default'), false);
});

test('OSS runtime has no companion or relay source modules', async () => {
  const files = await Promise.all([
    read('src-tauri/src/lib.rs'),
    read('src/lib/toolRegistry.ts'),
    read('src/hooks/useSolstice.ts'),
  ]);
  assert.equal(files.some((source) => /companion_server|solstice_relay|request_companion_approval/.test(source)), false);
  assert.equal(files.some((source) => /api\/v1\/query|api\/v1\/stt|api\/v1\/tts/.test(source)), false);
});

test('tool registry fails closed for unknown tools', async () => {
  const registry = await read('src/lib/toolRegistry.ts');
  assert.match(registry, /Unknown tool/);
  assert.match(registry, /Execution denied/);
  assert.match(registry, /validateArguments/);
});

test('dangerous native implementations are absent from direct renderer IPC', async () => {
  const rust = await read('src-tauri/src/lib.rs');
  const handler = rust.slice(rust.indexOf('tauri::generate_handler!['), rust.indexOf('])', rust.indexOf('tauri::generate_handler![')));
  for (const command of ['delete_file', 'delete_folder', 'clear_folder', 'delete_workspace', 'lock_computer', 'sleep_computer', 'turn_off_monitors', 'open_url', 'web_search', 'close_application', 'toggle_wifi', 'drag_mouse']) {
    assert.equal(new RegExp(`\\b${command}\\s*,`).test(handler), false, `${command} must not be directly exposed`);
  }
  assert.match(handler, /request_tool_approval/);
  assert.match(handler, /execute_sensitive_tool/);
});

test('renderer does not inject raw provider HTML or SVG and CSP is restrictive', async () => {
  const [canvas, mermaid, config] = await Promise.all([read('src/components/CodeCanvas.tsx'), read('src/components/MermaidRenderer.tsx'), read('src-tauri/tauri.conf.json')]);
  assert.equal(canvas.includes('dangerouslySetInnerHTML'), false);
  assert.equal(mermaid.includes('dangerouslySetInnerHTML'), false);
  assert.equal(canvas.includes('srcDoc='), false);
  assert.match(config, /default-src 'self'/);
  assert.equal(config.includes('"csp": null'), false);
  assert.equal(config.includes('unsafe-eval'), false);
});
