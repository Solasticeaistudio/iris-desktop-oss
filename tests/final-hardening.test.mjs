import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('application command manifest and auxiliary window ACLs are explicit', async () => {
  const [build, main, auxiliary, annotation, grid] = await Promise.all([
    read('src-tauri/build.rs'), read('src-tauri/capabilities/default.json'),
    read('src-tauri/capabilities/auxiliary.json'), read('src-tauri/capabilities/annotation.json'),
    read('src-tauri/capabilities/grid-calibrator.json'),
  ]);
  assert.match(build, /AppManifest::new\(\)\.commands\(COMMANDS\)/);
  assert.match(main, /allow-main-commands/);
  assert.deepEqual(JSON.parse(auxiliary).windows, ['canvas']);
  assert.deepEqual(JSON.parse(annotation).windows, ['annotation']);
  assert.deepEqual(JSON.parse(grid).windows, ['grid-calibrator']);
  assert.equal(annotation.includes('allow-main-commands'), false);
  assert.equal(grid.includes('allow-main-commands'), false);
});

test('renderer cannot substitute the native credential destination', async () => {
  const [provider, rust] = await Promise.all([read('src/lib/modelProvider.ts'), read('src-tauri/src/lib.rs')]);
  const requestBody = provider.slice(provider.indexOf("invoke<NativeModelResponse>('model_chat'"), provider.indexOf('return normalizeResponse'));
  assert.equal(/baseUrl|base_url/.test(requestBody), false);
  const requestStruct = rust.slice(rust.indexOf('struct ModelChatRequest'), rust.indexOf('fn validate_provider_url'));
  assert.equal(/base_url|model:/.test(requestStruct), false);
  assert.match(rust, /redirect\(reqwest::redirect::Policy::none\(\)\)/);
});

test('direct keyboard and mouse implementation commands are not renderer IPC', async () => {
  const rust = await read('src-tauri/src/lib.rs');
  const handler = rust.slice(rust.indexOf('tauri::generate_handler!['), rust.indexOf('])', rust.indexOf('tauri::generate_handler![')));
  for (const command of ['launch_app', 'type_text', 'press_key', 'press_key_combo', 'click_mouse', 'double_click', 'right_click', 'move_mouse_to', 'focus_window_by_title', 'scroll']) {
    assert.equal(new RegExp(`\\b${command}\\s*,`).test(handler), false, `${command} must be behind a control session`);
  }
  assert.match(handler, /request_control_session/);
  assert.match(handler, /execute_control_tool/);
});

test('the procedural sphere has no imported 3D model asset dependency', async () => {
  const particles = await read('src/components/IrisParticles.tsx');
  const forbidden = ['GLTF', 'STL'].map((prefix) => `${prefix}Loader`).concat(['morphTo' + 'Form', 'getAvailable' + 'Forms', 'forms/' + 'manifest']);
  assert.equal(forbidden.some((term) => particles.includes(term)), false);
  const publicEntries = await readdir(new URL('../public/', import.meta.url), { recursive: true });
  assert.equal(publicEntries.some((name) => /\.(?:glb|gltf|stl)$/i.test(String(name))), false);
});
