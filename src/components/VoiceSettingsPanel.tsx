import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { KeyRound, Save, ShieldCheck, Trash2, Volume2 } from 'lucide-react';
import {
  clearVoiceCredential,
  isVoiceInputReady,
  playSpeechResponse,
  saveVoiceSettings,
  setVoiceCredential,
  synthesizeVoice,
  type VoiceSettings,
  type VoiceStatus,
} from '../lib/voice';

interface VoiceSettingsPanelProps {
  status: VoiceStatus;
  onStatusChange: (status: VoiceStatus) => void;
  lastError?: string | null;
}

const OPENAI_STT_MODELS = ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'];
const OPENAI_TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'];
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'marin', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'cedar'];

function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-white/45">{children}</label>;
}

export function VoiceSettingsPanel({ status, onStatusChange, lastError }: VoiceSettingsPanelProps) {
  const [draft, setDraft] = useState<VoiceSettings>(status.settings);
  const [openaiKey, setOpenaiKey] = useState('');
  const [elevenlabsKey, setElevenlabsKey] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    const refresh = () => setSystemVoices(window.speechSynthesis?.getVoices() || []);
    refresh();
    window.speechSynthesis?.addEventListener('voiceschanged', refresh);
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', refresh);
  }, []);

  const credentialNeeded = useMemo(() => {
    const providers = new Set([draft.sttProvider, draft.ttsProvider]);
    return {
      openai: providers.has('openai'),
      elevenlabs: providers.has('elevenlabs'),
    };
  }, [draft.sttProvider, draft.ttsProvider]);
  const inputReady = isVoiceInputReady({ ...status, settings: draft });
  const hasUnsavedSettings = JSON.stringify(draft) !== JSON.stringify(status.settings);

  const update = <K extends keyof VoiceSettings>(key: K, value: VoiceSettings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const perform = async (operation: () => Promise<VoiceStatus>, success: string): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await operation();
      onStatusChange(next);
      setMessage(success);
      return true;
    } catch (error) {
      setMessage(String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = () => perform(() => saveVoiceSettings(draft), 'Voice settings saved.');

  const storeKey = async (provider: 'openai' | 'elevenlabs') => {
    const key = provider === 'openai' ? openaiKey : elevenlabsKey;
    const stored = await perform(() => setVoiceCredential(provider, key), `${provider === 'openai' ? 'OpenAI' : 'ElevenLabs'} credential stored in the OS vault.`);
    if (stored) {
      if (provider === 'openai') setOpenaiKey(''); else setElevenlabsKey('');
    }
  };

  const preview = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await saveVoiceSettings(draft);
      onStatusChange(saved);
      const speech = await synthesizeVoice('Hello. I am IRIS, ready when you are.');
      await playSpeechResponse('Hello. I am IRIS, ready when you are.', speech);
      setMessage('Voice preview complete.');
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-white/10 pt-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold text-cyan-100">Voice-first IRIS</div>
          <div className="text-[10px] text-white/35">Native capture · governed agent path · protected credentials</div>
        </div>
        <ShieldCheck size={16} className={status.secureStorageAvailable ? 'text-emerald-400' : 'text-amber-400'} />
      </div>

      <div className="grid grid-cols-2 gap-2 text-[9px]">
        <div className={`rounded border px-2 py-1 ${inputReady ? 'border-emerald-400/25 text-emerald-200' : 'border-amber-400/25 text-amber-200'}`}>
          Listening: {inputReady ? 'ready' : draft.sttProvider === 'disabled' ? 'STT disabled' : 'credential required'}
        </div>
        <div className={`rounded border px-2 py-1 ${draft.ttsProvider !== 'disabled' ? 'border-emerald-400/25 text-emerald-200' : 'border-white/10 text-white/40'}`}>
          Spoken replies: {draft.ttsProvider === 'disabled' ? 'silent' : draft.ttsProvider}
        </div>
      </div>

      <div>
        <FieldLabel>Listening mode</FieldLabel>
        <select value={draft.inputMode} onChange={(event) => update('inputMode', event.target.value as VoiceSettings['inputMode'])} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white">
          <option value="tap_to_talk">Tap to talk (recommended)</option>
          <option value="cloud_wake">Cloud wake word</option>
        </select>
        <p className="mt-1 text-[9px] leading-relaxed text-white/30">
          {draft.inputMode === 'cloud_wake'
            ? 'Cloud wake continuously transcribes detected speech. It can consume provider credits and sends utterances to the selected STT provider.'
            : 'Tap the microphone, speak once, and IRIS returns to standby. Ambient speech is not uploaded.'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <FieldLabel>Speech to text</FieldLabel>
          <select value={draft.sttProvider} onChange={(event) => {
            const provider = event.target.value as VoiceSettings['sttProvider'];
            setDraft((current) => ({ ...current, sttProvider: provider, sttModel: provider === 'elevenlabs' ? 'scribe_v2' : 'whisper-1' }));
          }} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white">
            <option value="disabled">Disabled</option>
            <option value="openai">OpenAI</option>
            <option value="elevenlabs">ElevenLabs</option>
          </select>
        </div>
        <div>
          <FieldLabel>STT model</FieldLabel>
          {draft.sttProvider === 'openai' ? (
            <select value={draft.sttModel} onChange={(event) => update('sttModel', event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white">
              {OPENAI_STT_MODELS.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          ) : (
            <input value={draft.sttModel} onChange={(event) => update('sttModel', event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white" />
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <FieldLabel>IRIS voice provider</FieldLabel>
          <select value={draft.ttsProvider} onChange={(event) => {
            const provider = event.target.value as VoiceSettings['ttsProvider'];
            setDraft((current) => ({ ...current, ttsProvider: provider, ttsModel: provider === 'elevenlabs' ? 'eleven_multilingual_v2' : 'gpt-4o-mini-tts' }));
          }} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white">
            <option value="system">System voice</option>
            <option value="openai">OpenAI</option>
            <option value="elevenlabs">ElevenLabs/custom</option>
            <option value="disabled">Silent</option>
          </select>
        </div>
        <div>
          <FieldLabel>Speech speed</FieldLabel>
          <input type="number" min="0.25" max="4" step="0.05" value={draft.speed} onChange={(event) => update('speed', Number(event.target.value))} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white" />
        </div>
      </div>

      {draft.ttsProvider === 'system' && (
        <div>
          <FieldLabel>Windows voice</FieldLabel>
          <select value={draft.voice} onChange={(event) => update('voice', event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white">
            <option value="">System default</option>
            {systemVoices.map((voice) => <option key={voice.voiceURI} value={voice.name}>{voice.name}</option>)}
          </select>
        </div>
      )}

      {draft.ttsProvider === 'openai' && (
        <div className="grid grid-cols-2 gap-2">
          <div><FieldLabel>TTS model</FieldLabel><select value={draft.ttsModel} onChange={(event) => update('ttsModel', event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white">{OPENAI_TTS_MODELS.map((model) => <option key={model}>{model}</option>)}</select></div>
          <div><FieldLabel>Voice / custom voice ID</FieldLabel><input list="openai-voices" value={draft.voice} onChange={(event) => update('voice', event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white" /><datalist id="openai-voices">{OPENAI_VOICES.map((voice) => <option key={voice} value={voice} />)}</datalist></div>
        </div>
      )}

      {draft.ttsProvider === 'elevenlabs' && (
        <div className="grid grid-cols-2 gap-2">
          <div><FieldLabel>Model</FieldLabel><input value={draft.ttsModel} onChange={(event) => update('ttsModel', event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white" /></div>
          <div><FieldLabel>Voice ID</FieldLabel><input value={draft.elevenlabsVoiceId} onChange={(event) => update('elevenlabsVoiceId', event.target.value)} placeholder="Your voice ID" className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white" /></div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div><FieldLabel>Language</FieldLabel><input value={draft.language} onChange={(event) => update('language', event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white" /></div>
        <div><FieldLabel>Wake phrases</FieldLabel><input value={draft.wakeWords.join(', ')} onChange={(event) => update('wakeWords', event.target.value.split(',').map((word) => word.trim()).filter(Boolean))} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white" /></div>
      </div>

      <div className="space-y-2 rounded-lg border border-white/10 bg-black/20 p-2">
        <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-white/45"><KeyRound size={12} /> Provider credentials</div>
        {!status.secureStorageAvailable && <p className="text-[9px] text-amber-300">OS-protected storage is unavailable. Use environment variables; plaintext fallback is disabled.</p>}
        <div className="flex gap-1">
          <input type="password" autoComplete="off" value={openaiKey} onChange={(event) => setOpenaiKey(event.target.value)} placeholder={`OpenAI key · ${status.openai.configured ? status.openai.source : 'not configured'}`} className="min-w-0 flex-1 rounded border border-white/10 bg-black/40 px-2 py-1 text-[10px] text-white" />
          <button disabled={busy || !openaiKey || !status.secureStorageAvailable} onClick={() => void storeKey('openai')} className="rounded bg-cyan-500/15 px-2 text-cyan-200 disabled:opacity-30">Save</button>
          {status.openai.configured && status.openai.source === 'os_keyring' && <button title="Remove OpenAI key" onClick={() => void perform(() => clearVoiceCredential('openai'), 'OpenAI credential removed.')} className="rounded px-1 text-white/40 hover:text-red-300"><Trash2 size={12} /></button>}
        </div>
        <div className="flex gap-1">
          <input type="password" autoComplete="off" value={elevenlabsKey} onChange={(event) => setElevenlabsKey(event.target.value)} placeholder={`ElevenLabs key · ${status.elevenlabs.configured ? status.elevenlabs.source : 'not configured'}`} className="min-w-0 flex-1 rounded border border-white/10 bg-black/40 px-2 py-1 text-[10px] text-white" />
          <button disabled={busy || !elevenlabsKey || !status.secureStorageAvailable} onClick={() => void storeKey('elevenlabs')} className="rounded bg-cyan-500/15 px-2 text-cyan-200 disabled:opacity-30">Save</button>
          {status.elevenlabs.configured && status.elevenlabs.source === 'os_keyring' && <button title="Remove ElevenLabs key" onClick={() => void perform(() => clearVoiceCredential('elevenlabs'), 'ElevenLabs credential removed.')} className="rounded px-1 text-white/40 hover:text-red-300"><Trash2 size={12} /></button>}
        </div>
        {(credentialNeeded.openai && !status.openai.configured) || (credentialNeeded.elevenlabs && !status.elevenlabs.configured) ? <p className="text-[9px] text-amber-300">The selected provider needs a configured credential before use.</p> : null}
      </div>

      {(message || lastError) && <p className="break-words rounded bg-black/30 p-2 text-[9px] text-amber-100/80">{message || lastError}</p>}

      {hasUnsavedSettings && (
        <p className="rounded border border-amber-400/20 bg-amber-400/5 p-2 text-[9px] text-amber-200">
          Provider or voice settings have not been saved yet. Saving a credential does not activate that provider.
        </p>
      )}

      <div className="flex gap-2">
        <button disabled={busy} onClick={() => void save()} className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-cyan-500/20 px-2 py-1.5 text-[10px] font-semibold text-cyan-100 disabled:opacity-40"><Save size={12} /> Save voice settings</button>
        <button disabled={busy || draft.ttsProvider === 'disabled'} onClick={() => void preview()} className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-white/10 px-2 py-1.5 text-[10px] text-white/70 disabled:opacity-40"><Volume2 size={12} /> Preview</button>
      </div>
    </div>
  );
}
