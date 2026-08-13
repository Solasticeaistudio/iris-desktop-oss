import { invoke } from '@tauri-apps/api/core';

export type VoiceInputMode = 'tap_to_talk' | 'cloud_wake';
export type SttProvider = 'disabled' | 'openai' | 'elevenlabs';
export type TtsProvider = 'disabled' | 'system' | 'openai' | 'elevenlabs';

export interface VoiceSettings {
  inputMode: VoiceInputMode;
  sttProvider: SttProvider;
  sttModel: string;
  ttsProvider: TtsProvider;
  ttsModel: string;
  voice: string;
  elevenlabsVoiceId: string;
  language: string;
  speed: number;
  wakeWords: string[];
}

export interface CredentialStatus {
  configured: boolean;
  source: 'none' | 'environment' | 'os_keyring';
}

export interface VoiceStatus {
  settings: VoiceSettings;
  openai: CredentialStatus;
  elevenlabs: CredentialStatus;
  secureStorageAvailable: boolean;
}

export interface TranscriptionResponse {
  text: string;
  provider: string;
}

export interface SpeechResponse {
  provider: 'system' | 'openai' | 'elevenlabs';
  audioBase64?: string;
  mimeType?: string;
  sampleRate?: number;
  systemVoice?: string;
  speed: number;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  inputMode: 'tap_to_talk',
  sttProvider: 'disabled',
  sttModel: 'whisper-1',
  ttsProvider: 'system',
  ttsModel: 'gpt-4o-mini-tts',
  voice: 'alloy',
  elevenlabsVoiceId: '',
  language: 'en',
  speed: 1,
  wakeWords: ['hey iris', 'iris'],
};

interface ActiveAudioPlayback {
  audio: HTMLAudioElement;
  finish: (error?: Error) => void;
}

let activeAudioPlayback: ActiveAudioPlayback | null = null;
let finishSystemSpeech: (() => void) | null = null;

export const getVoiceStatus = () => invoke<VoiceStatus>('voice_get_status');

export const saveVoiceSettings = (settings: VoiceSettings) =>
  invoke<VoiceStatus>('voice_save_settings', { settings });

export const setVoiceCredential = (provider: 'openai' | 'elevenlabs', credential: string) =>
  invoke<VoiceStatus>('voice_set_credential', { provider, credential });

export const clearVoiceCredential = (provider: 'openai' | 'elevenlabs') =>
  invoke<VoiceStatus>('voice_clear_credential', { provider });

export const transcribeVoice = (audioBase64: string) =>
  invoke<TranscriptionResponse>('voice_transcribe', { audioBase64 });

export const synthesizeVoice = (text: string) =>
  invoke<SpeechResponse>('voice_synthesize', { text });

function base64Bytes(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesBase64(bytes: Uint8Array): string {
  let result = '';
  const chunk = 8192;
  for (let index = 0; index < bytes.length; index += chunk) {
    result += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return window.btoa(result);
}

async function setAecReference(bytes: Uint8Array): Promise<void> {
  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
    const copy = new Uint8Array(bytes).buffer;
    const decoded = await context.decodeAudioData(copy);
    const samples = decoded.getChannelData(0);
    await invoke('aec_set_reference', {
      audioBase64: bytesBase64(new Uint8Array(samples.buffer)),
      sampleRate: decoded.sampleRate,
    });
  } catch {
    // AEC is defense in depth; playback still works if a codec cannot be decoded.
  } finally {
    await context?.close().catch(() => undefined);
  }
}

function speakWithSystemVoice(text: string, voiceName?: string, speed = 1): Promise<void> {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) {
      resolve();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    const selected = window.speechSynthesis
      .getVoices()
      .find((voice) => voice.name === voiceName || voice.voiceURI === voiceName);
    if (selected) utterance.voice = selected;
    utterance.rate = speed;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (finishSystemSpeech === finish) finishSystemSpeech = null;
      resolve();
    };
    finishSystemSpeech = finish;
    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}

export async function playSpeechResponse(
  text: string,
  response: SpeechResponse,
  onLevel?: (level: number) => void,
): Promise<void> {
  if (response.provider === 'system' || !response.audioBase64) {
    onLevel?.(0.45);
    await speakWithSystemVoice(text, response.systemVoice, response.speed);
    onLevel?.(0);
    return;
  }

  stopVoicePlayback();
  const bytes = base64Bytes(response.audioBase64);
  await setAecReference(bytes);
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: response.mimeType || 'audio/wav' }));
  const audio = new Audio(url);
  onLevel?.(0.5);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve();
      };
      activeAudioPlayback = { audio, finish };
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error('VOICE_AUDIO_PLAYBACK_FAILED'));
      audio.play().catch(reject);
    });
  } finally {
    if (activeAudioPlayback?.audio === audio) activeAudioPlayback = null;
    onLevel?.(0);
    URL.revokeObjectURL(url);
    await invoke('aec_clear_reference').catch(() => undefined);
  }
}

export function stopVoicePlayback(): void {
  const active = activeAudioPlayback;
  activeAudioPlayback = null;
  active?.audio.pause();
  active?.finish();
  const finishSpeech = finishSystemSpeech;
  finishSystemSpeech = null;
  finishSpeech?.();
  window.speechSynthesis?.cancel();
  void invoke('aec_clear_reference').catch(() => undefined);
}
