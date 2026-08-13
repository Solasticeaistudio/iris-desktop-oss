import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('voice provider credentials and destinations remain native-bound', async () => {
  const [rust, secureStore] = await Promise.all([
    read('src-tauri/src/voice.rs'),
    read('src-tauri/src/secure_store.rs'),
  ]);
  assert.match(rust, /https:\/\/api\.openai\.com/);
  assert.match(rust, /https:\/\/api\.elevenlabs\.io/);
  assert.match(rust, /redirect\(Policy::none\(\)\)/);
  assert.match(secureStore, /windows_native_keyring_store::Store/);
  assert.match(secureStore, /keyring_core::Entry/);
  assert.match(rust, /os_keyring|KEYRING_SERVICE/);
  assert.doesNotMatch(rust, /base_url:\s*String|endpoint:\s*String/);
});

test('renderer can configure but cannot retrieve voice credential values', async () => {
  const [client, panel] = await Promise.all([
    read('src/lib/voice.ts'),
    read('src/components/VoiceSettingsPanel.tsx'),
  ]);
  assert.match(client, /voice_set_credential/);
  assert.match(client, /voice_clear_credential/);
  assert.doesNotMatch(client, /voice_get_credential/);
  assert.match(panel, /type="password"/);
  assert.doesNotMatch(client + panel, /localStorage.*(?:key|credential|secret)/i);
});

test('voice input enters the governed typed-message path', async () => {
  const [window, panel] = await Promise.all([
    read('src/components/IrisWindow.tsx'),
    read('src/components/VoiceSettingsPanel.tsx'),
  ]);
  assert.match(window, /handleSendMessageRef\.current\(transcript\)/);
  assert.match(window, /handleSendMessageRef\.current\(command\)/);
  assert.match(window, /tap_to_talk/);
  assert.match(panel, /cloud_wake/);
});

test('cloud wake is explicit and tap to talk is the safe default', async () => {
  const [rust, panel] = await Promise.all([
    read('src-tauri/src/voice.rs'),
    read('src/components/VoiceSettingsPanel.tsx'),
  ]);
  assert.match(rust, /input_mode: "tap_to_talk"/);
  assert.match(rust, /stt_provider: "disabled"/);
  assert.match(panel, /Cloud wake continuously transcribes detected speech/);
  assert.match(panel, /Ambient speech is not uploaded/);
});

test('private voice IDs and private STT routes are absent', async () => {
  const files = await Promise.all([
    read('src/lib/config.ts'),
    read('src/lib/voice.ts'),
    read('src-tauri/src/voice.rs'),
    read('src/components/IrisWindow.tsx'),
  ]);
  const source = files.join('\n');
  const config = await read('src/lib/config.ts');
  assert.match(config, /voiceId:\s*''/);
  assert.doesNotMatch(source, /api\/v1\/(?:stt|tts)/);
  assert.doesNotMatch(source, /Solstice Endpoint/);
});

test('voice native commands are limited to the main renderer permission', async () => {
  const [main, auxiliary, annotation] = await Promise.all([
    read('src-tauri/permissions/main.toml'),
    read('src-tauri/capabilities/auxiliary.json'),
    read('src-tauri/capabilities/annotation.json'),
  ]);
  for (const command of ['voice_get_status', 'voice_save_settings', 'voice_set_credential', 'voice_transcribe', 'voice_synthesize']) {
    assert.match(main, new RegExp(`"${command}"`));
    assert.doesNotMatch(auxiliary + annotation, new RegExp(command));
  }
});

test('interrupting either cloud or system speech settles active playback', async () => {
  const client = await read('src/lib/voice.ts');
  assert.match(client, /active\?\.finish\(\)/);
  assert.match(client, /finishSpeech\?\.\(\)/);
  assert.match(client, /aec_clear_reference/);
});
