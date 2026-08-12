import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('control sessions are bound to HWND PID and executable identity', async () => {
  const rust = await read('src-tauri/src/lib.rs');
  assert.match(rust, /struct ControlSession[\s\S]*target: WindowIdentity/);
  assert.match(rust, /struct WindowIdentity[\s\S]*process_id: u32[\s\S]*window_handle: isize[\s\S]*executable: String/);
  assert.match(rust, /GetWindowThreadProcessId/);
  assert.match(rust, /QueryFullProcessImageNameW/);
  assert.match(rust, /CONTROL_SESSION_TARGET_MISMATCH/);
});

test('control input requires foreground validation and mouse containment', async () => {
  const rust = await read('src-tauri/src/lib.rs');
  const dispatcher = rust.slice(rust.indexOf('async fn execute_control_tool'), rust.indexOf('fn powershell_with_data'));
  assert.match(dispatcher, /require_foreground = tool != "focus_window"/);
  assert.match(dispatcher, /validate_control_point/);
  assert.match(dispatcher, /NEW_CONTROL_AUTHORIZATION_REQUIRED/);
  assert.equal(dispatcher.includes('"launch_app" if'), false);
});

test('existing terminal identities are denied independently of launch aliases', async () => {
  const rust = await read('src-tauri/src/lib.rs');
  for (const executable of ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'windowsterminal.exe', 'wt.exe', 'bash.exe', 'wsl.exe', 'git-bash.exe', 'mintty.exe']) {
    assert.equal(rust.toLowerCase().includes(`"${executable}"`), true, `missing terminal identity ${executable}`);
  }
  assert.match(rust, /terminal_identity\(&target\.executable, &target\.window_title\)/);
});

test('MediaPipe JS and locally prepared WASM assets share one exact version', async () => {
  const [pkg, lock, manifest, presence] = await Promise.all([
    read('package.json').then(JSON.parse),
    read('package-lock.json').then(JSON.parse),
    read('public/mediapipe/wasm/version.json').then(JSON.parse),
    read('src/hooks/usePresence.ts'),
  ]);
  const configured = pkg.dependencies['@mediapipe/tasks-vision'];
  const locked = lock.packages['node_modules/@mediapipe/tasks-vision'].version;
  assert.equal(configured, locked);
  assert.equal(manifest.version, locked);
  assert.match(presence, /MEDIAPIPE_WASM_ROOT = '\/mediapipe\/wasm'/);
  assert.equal(presence.includes('cdn.jsdelivr.net'), false);
  const files = await readdir(new URL('../public/mediapipe/wasm/', import.meta.url));
  for (const required of manifest.files) assert.equal(files.includes(required), true, `missing ${required}`);
});

test('CSP allows local MediaPipe scripts without a jsDelivr exception', async () => {
  const config = await read('src-tauri/tauri.conf.json');
  assert.match(config, /script-src 'self'/);
  assert.equal(config.includes('cdn.jsdelivr.net'), false);
  assert.match(config, /connect-src[^;]*https:\/\/storage\.googleapis\.com/);
});
