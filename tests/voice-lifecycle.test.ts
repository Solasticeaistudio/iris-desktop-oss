import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  DEFAULT_VOICE_SETTINGS,
  isVoiceInputReady,
  shouldSpeakVoiceReplies,
  type VoiceStatus,
} from '../src/lib/voice';

const status = (overrides: Partial<VoiceStatus> = {}): VoiceStatus => ({
  settings: DEFAULT_VOICE_SETTINGS,
  openai: { configured: false, source: 'none' },
  elevenlabs: { configured: false, source: 'none' },
  secureStorageAvailable: true,
  ...overrides,
});

test('voice input readiness requires both an STT provider and its credential', () => {
  assert.equal(isVoiceInputReady(status()), false);
  assert.equal(isVoiceInputReady(status({
    settings: { ...DEFAULT_VOICE_SETTINGS, sttProvider: 'elevenlabs' },
  })), false);
  assert.equal(isVoiceInputReady(status({
    settings: { ...DEFAULT_VOICE_SETTINGS, sttProvider: 'elevenlabs' },
    elevenlabs: { configured: true, source: 'os_keyring' },
  })), true);
});

test('spoken replies are controlled by TTS settings, not microphone capture state', () => {
  assert.equal(shouldSpeakVoiceReplies(DEFAULT_VOICE_SETTINGS), true);
  assert.equal(shouldSpeakVoiceReplies({ ...DEFAULT_VOICE_SETTINGS, ttsProvider: 'elevenlabs' }), true);
  assert.equal(shouldSpeakVoiceReplies({ ...DEFAULT_VOICE_SETTINGS, ttsProvider: 'disabled' }), false);
});

test('Gemini/provider responses do not gate TTS on the tap-to-talk microphone flag', async () => {
  const source = await readFile(new URL('../src/components/IrisWindow.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(voiceRepliesEnabled && cleanText && speakRef\.current\)/);
  assert.doesNotMatch(source, /if \(voiceEnabled && cleanText && speakRef\.current\)/);
});

test('voice settings distinguish stored credentials from an activated STT provider', async () => {
  const panel = await readFile(new URL('../src/components/VoiceSettingsPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /Saving a credential does not activate that provider/);
  assert.match(panel, /Listening:/);
  assert.match(panel, /Save voice settings/);
});

test('deterministic time and repeat responses enter configured speech output', async () => {
  const source = await readFile(new URL('../src/components/IrisWindow.tsx', import.meta.url), 'utf8');
  assert.match(source, /const speakRequest = parseSpeakRequest\(message\)/);
  assert.match(source, /if \(voiceRepliesEnabled\) await speakRef\.current\(speakRequest\)/);
  assert.match(source, /if \(voiceRepliesEnabled\) await speakRef\.current\(response\)/);
});
