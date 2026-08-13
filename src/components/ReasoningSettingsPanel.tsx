import { useEffect, useState } from 'react';
import { BrainCircuit, KeyRound, Save, ShieldCheck, Trash2, Wifi } from 'lucide-react';
import {
  DEFAULT_REASONING_STATUS,
  clearReasoningCredential,
  getReasoningStatus,
  saveReasoningSettings,
  setReasoningCredential,
  testReasoningConnection,
  type ReasoningProvider,
  type ReasoningSettings,
  type ReasoningStatus,
} from '../lib/reasoning';

interface ReasoningSettingsPanelProps {
  onProviderChange: () => Promise<void>;
}

const DEFAULT_MODELS: Record<ReasoningProvider, string> = {
  mock: 'offline-mock',
  gemini: 'gemini-3.6-flash',
  openai: 'gpt-5-mini',
  custom: 'llama3.2',
};

export function ReasoningSettingsPanel({ onProviderChange }: ReasoningSettingsPanelProps) {
  const [status, setStatus] = useState<ReasoningStatus>(DEFAULT_REASONING_STATUS);
  const [draft, setDraft] = useState<ReasoningSettings>(DEFAULT_REASONING_STATUS.settings);
  const [credential, setCredential] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getReasoningStatus()
      .then((next) => {
        setStatus(next);
        setDraft(next.settings);
      })
      .catch((error) => setMessage(String(error)));
  }, []);

  const acceptStatus = async (next: ReasoningStatus) => {
    setStatus(next);
    setDraft(next.settings);
    await onProviderChange();
  };

  const perform = async (operation: () => Promise<ReasoningStatus>, success: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await operation();
      await acceptStatus(next);
      setMessage(success);
      return true;
    } catch (error) {
      setMessage(String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = () => perform(
    () => saveReasoningSettings(draft),
    draft.provider === 'mock' ? 'Offline mock provider selected.' : 'Reasoning provider saved.',
  );

  const storeCredential = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await saveReasoningSettings(draft);
      setStatus(saved);
      const next = await setReasoningCredential(credential);
      await acceptStatus(next);
      setCredential('');
      setMessage('Reasoning credential stored in Windows Credential Manager.');
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await saveReasoningSettings(draft);
      await acceptStatus(next);
      setMessage(await testReasoningConnection());
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const selectProvider = (provider: ReasoningProvider) => {
    setDraft((current) => ({
      ...current,
      provider,
      model: DEFAULT_MODELS[provider],
      customBaseUrl: provider === 'custom' ? (current.customBaseUrl || 'http://127.0.0.1:11434/v1') : '',
    }));
  };

  const requiresCredential = draft.provider === 'gemini' || draft.provider === 'openai';
  const statusMatchesDraft = status.settings.provider === draft.provider
    && (draft.provider !== 'custom' || status.settings.customBaseUrl.replace(/\/$/, '') === draft.customBaseUrl.replace(/\/$/, ''));
  const credentialConfigured = statusMatchesDraft && status.credential.configured;
  const canStoreCredential = draft.provider !== 'mock' && status.secureStorageAvailable && credential.length >= 8;

  return (
    <div className="space-y-3 border-t border-white/10 pt-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-1 text-xs font-semibold text-cyan-100"><BrainCircuit size={14} /> Reasoning provider</div>
          <div className="text-[10px] text-white/35">Native endpoint binding &middot; protected API key</div>
        </div>
        <ShieldCheck size={16} className={status.secureStorageAvailable ? 'text-emerald-400' : 'text-amber-400'} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-white/45">Provider</label>
          <select value={draft.provider} onChange={(event) => selectProvider(event.target.value as ReasoningProvider)} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white">
            <option value="mock">Offline mock</option>
            <option value="gemini">Google Gemini</option>
            <option value="openai">OpenAI</option>
            <option value="custom">Custom / local</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-white/45">Model</label>
          <input disabled={draft.provider === 'mock'} value={draft.model} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white disabled:opacity-40" />
        </div>
      </div>

      {draft.provider === 'custom' && (
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-white/45">OpenAI-compatible base URL</label>
          <input value={draft.customBaseUrl} onChange={(event) => setDraft((current) => ({ ...current, customBaseUrl: event.target.value }))} placeholder="https://provider.example/v1" className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white" />
          <p className="mt-1 text-[9px] text-white/30">Remote endpoints require HTTPS. Plain HTTP is restricted to localhost.</p>
        </div>
      )}

      {draft.provider !== 'mock' && (
        <div className="space-y-2 rounded-lg border border-white/10 bg-black/20 p-2">
          <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-white/45"><KeyRound size={12} /> API credential</div>
          {!status.secureStorageAvailable && <p className="text-[9px] text-amber-300">OS-protected storage is unavailable. Use environment variables; plaintext fallback is disabled.</p>}
          <div className="flex gap-1">
            <input type="password" autoComplete="off" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder={`API key - ${credentialConfigured ? status.credential.source : 'not configured'}`} className="min-w-0 flex-1 rounded border border-white/10 bg-black/40 px-2 py-1 text-[10px] text-white" />
            <button disabled={busy || !canStoreCredential} onClick={() => void storeCredential()} className="rounded bg-cyan-500/15 px-2 text-[10px] text-cyan-200 disabled:opacity-30">Save key</button>
            {credentialConfigured && status.credential.source === 'os_keyring' && <button title="Remove reasoning key" onClick={() => void perform(clearReasoningCredential, 'Reasoning credential removed.')} className="rounded px-1 text-white/40 hover:text-red-300"><Trash2 size={12} /></button>}
          </div>
          {requiresCredential && !credentialConfigured && <p className="text-[9px] text-amber-300">This provider requires an API key before it can reason.</p>}
        </div>
      )}

      <div className="rounded bg-black/20 p-2 text-[9px] text-white/35">
        <div>Endpoint: {draft.provider === 'mock' ? 'offline' : (status.settings.provider === draft.provider ? status.endpoint : 'saved after confirmation')}</div>
        <div>Configuration: {status.configurationSource}</div>
      </div>

      {message && <p className="break-words rounded bg-black/30 p-2 text-[9px] text-amber-100/80">{message}</p>}

      <div className="flex gap-2">
        <button disabled={busy} onClick={() => void save()} className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-cyan-500/20 px-2 py-1.5 text-[10px] font-semibold text-cyan-100 disabled:opacity-40"><Save size={12} /> Save provider</button>
        <button disabled={busy} onClick={() => void testConnection()} className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-white/10 px-2 py-1.5 text-[10px] text-white/70 disabled:opacity-40"><Wifi size={12} /> Test</button>
      </div>
    </div>
  );
}
