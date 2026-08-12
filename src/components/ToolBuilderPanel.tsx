import { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Check, Copy, Loader2, RefreshCw, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { foundryClient } from '../lib/capabilityFoundry/client';
import { riskColor } from '../lib/capabilityFoundry/risk';
import type { CapabilityPackage, InstalledCapability } from '../lib/capabilityFoundry/types';
import { toolRegistry } from '../lib/toolRegistry';

interface ToolBuilderPanelProps { isOpen: boolean; onClose: () => void }
type Tab = 'Installed' | 'Discover' | 'Candidates' | 'Evidence' | 'Drift';
type ImportKind = 'openapi' | 'graphql' | 'har' | 'html';

export function ToolBuilderPanel({ isOpen, onClose }: ToolBuilderPanelProps) {
  const [tab, setTab] = useState<Tab>('Installed');
  const [target, setTarget] = useState('https://');
  const [allowLocal, setAllowLocal] = useState(false);
  const [candidate, setCandidate] = useState<CapabilityPackage | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [installed, setInstalled] = useState<InstalledCapability[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importKind, setImportKind] = useState<ImportKind>('openapi');
  const [importText, setImportText] = useState('');
  const [mcp, setMcp] = useState<Record<string, unknown> | null>(null);
  const [driftResult, setDriftResult] = useState<Record<string, unknown> | null>(null);

  const tools = useMemo(() => toolRegistry.list(), [installed, candidate]);
  const refresh = async () => {
    const [packages, events] = await Promise.all([foundryClient.list(), foundryClient.history()]);
    setInstalled(packages); setHistory(events); await toolRegistry.refresh();
  };

  useEffect(() => {
    if (!isOpen) return;
    refresh().catch((cause) => setError(String(cause)));
    const unlisten = listen<string>('capability-foundry-progress', (event) => setProgress(event.payload));
    return () => { unlisten.then((fn) => fn()).catch(() => undefined); };
  }, [isOpen]);

  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); setProgress(''); }
  };

  const discover = () => act(async () => {
    const result = await foundryClient.discover(target, allowLocal);
    if (!result.package) throw new Error(`No executable candidate was compiled. Detected: ${result.detectedSurfaces.join(', ') || 'none'}`);
    setCandidate(result.package); setSelected(new Set(result.package.capabilities.map((item) => item.id)));
    setNotice(`Detected ${result.detectedSurfaces.join(', ')} in ${result.requestsMade} bounded requests.`); setTab('Candidates');
  });

  const importCandidate = () => act(async () => {
    if (!importText.trim()) throw new Error('Paste an authorized OpenAPI, GraphQL introspection, HAR, or HTML artifact.');
    let packageValue: CapabilityPackage;
    if (importKind === 'html') packageValue = await foundryClient.importHtml(importText, target, allowLocal);
    else {
      const document = JSON.parse(importText) as unknown;
      if (importKind === 'openapi') packageValue = await foundryClient.importOpenApi(document, target, allowLocal);
      else if (importKind === 'graphql') packageValue = await foundryClient.importGraphQl(document, target, allowLocal);
      else packageValue = await foundryClient.importHar(document, target, allowLocal);
    }
    setCandidate(packageValue); setSelected(new Set(packageValue.capabilities.map((item) => item.id))); setTab('Candidates');
  });

  const install = () => candidate && act(async () => {
    await foundryClient.install(candidate.packageId, [...selected]);
    await refresh(); setNotice('Selected capabilities installed after native review.'); setTab('Installed');
  });

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="flex max-h-[88vh] w-[980px] flex-col rounded-xl border border-white/10 bg-gray-950 shadow-2xl">
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div><h2 className="text-sm font-semibold text-white">IRIS Capability Foundry</h2><p className="text-xs text-white/50">Synthesized capability does not imply synthesized authority.</p></div>
          <button onClick={onClose} className="text-white/60 hover:text-white" aria-label="Close Capability Foundry"><X size={18}/></button>
        </header>
        <nav className="flex gap-1 border-b border-white/10 px-5 py-2">
          {(['Installed','Discover','Candidates','Evidence','Drift'] as Tab[]).map((name) => <button key={name} onClick={() => setTab(name)} className={`rounded px-3 py-1.5 text-xs ${tab === name ? 'bg-cyan-500/20 text-cyan-200' : 'text-white/50 hover:text-white'}`}>{name}</button>)}
        </nav>
        {(error || notice || progress) && <div className={`mx-5 mt-4 rounded border px-3 py-2 text-xs ${error ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-cyan-500/20 bg-cyan-500/10 text-cyan-100'}`}>{error || progress || notice}</div>}
        <main className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === 'Discover' && <div className="space-y-5">
            <section className="rounded-lg border border-white/10 bg-white/[.03] p-4">
              <label className="text-xs font-medium text-white">Explicitly authorized target</label>
              <div className="mt-2 flex gap-2"><input value={target} onChange={(event) => setTarget(event.target.value)} className="flex-1 rounded border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white outline-none focus:border-cyan-500/50" placeholder="https://shipping.example"/><button disabled={busy} onClick={discover} className="flex items-center gap-2 rounded bg-cyan-600 px-4 py-2 text-xs text-white disabled:opacity-50">{busy?<Loader2 className="animate-spin" size={14}/>:<Search size={14}/>}Inspect site</button></div>
              <label className="mt-3 flex items-center gap-2 text-xs text-white/60"><input type="checkbox" checked={allowLocal} onChange={(event) => setAllowLocal(event.target.checked)}/>Request native authorization for this exact local/private origin</label>
              {busy && <button onClick={() => foundryClient.cancel()} className="mt-3 text-xs text-red-300">Cancel outstanding discovery</button>}
              <p className="mt-3 text-[11px] text-white/40">HTTP/HTTPS only. Remote targets require HTTPS. Redirects are same-origin and bounded; private addresses are rejected unless separately granted.</p>
            </section>
            <section className="rounded-lg border border-white/10 bg-white/[.03] p-4">
              <div className="flex items-center gap-2"><select value={importKind} onChange={(event) => setImportKind(event.target.value as ImportKind)} className="rounded border border-white/10 bg-gray-900 px-2 py-2 text-xs text-white"><option value="openapi">Import OpenAPI / Swagger</option><option value="graphql">Import GraphQL introspection</option><option value="har">Import authorized HAR</option><option value="html">Import HTML/forms</option></select><button disabled={busy} onClick={importCandidate} className="rounded border border-white/15 px-3 py-2 text-xs text-white/80">Compile artifact</button></div>
              <textarea value={importText} onChange={(event) => setImportText(event.target.value)} className="mt-3 h-40 w-full rounded border border-white/10 bg-black/30 p-3 font-mono text-[11px] text-white/70" placeholder={importKind === 'html' ? '<html>…' : '{ "openapi": "3.0.3", … }'}/>
              <p className="mt-2 text-[11px] text-white/40">Imported observations are redacted before evidence persistence. Captured authentication is never converted into a credential.</p>
            </section>
          </div>}

          {tab === 'Candidates' && (!candidate ? <Empty text="Discover or import an authorized target to create a quarantined candidate."/> : <div className="space-y-3">
            <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-4 text-xs text-white/70"><div><b className="text-white">Target:</b> {candidate.targetOrigin}</div><div className="mt-1"><b className="text-white">Network:</b> {candidate.networkScope.origin} only · same-origin redirects</div><div className="mt-1 break-all"><b className="text-white">Package hash:</b> <span className="font-mono">{candidate.contentHash}</span></div><div className="mt-1"><b className="text-white">Credentials:</b> {candidate.credentialRequirements.length ? 'handle required; authenticated execution currently disabled' : 'none'}</div></div>
            {candidate.capabilities.map((capability) => <article key={capability.id} className="rounded-lg border border-white/10 bg-white/[.03] p-4">
              <div className="flex items-start gap-3"><input type="checkbox" checked={selected.has(capability.id)} onChange={(event) => { const next=new Set(selected); if(event.target.checked) next.add(capability.id); else next.delete(capability.id); setSelected(next); }}/><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-cyan-200">{capability.toolName}</span><span className="rounded bg-white/5 px-2 py-0.5 font-mono text-[10px] text-white/60">{capability.method} {capability.endpoint}</span><span className={`text-[10px] uppercase ${riskColor(capability.riskLevel)}`}>{capability.riskLevel}{capability.approvalRequired?' · approval':''}</span></div><p className="mt-2 text-xs text-white/60">{capability.description}</p><div className="mt-2 text-[11px] text-white/40">Source {capability.sourceMode} · confidence {capability.confidence.toFixed(2)} · auth {capability.authRequired?'required':'none'} · data {capability.dataClassification}</div><details className="mt-2"><summary className="cursor-pointer text-[11px] text-cyan-300/70">Inspect schemas</summary><pre className="mt-2 overflow-auto rounded bg-black/30 p-2 text-[10px] text-white/50">{JSON.stringify({input:capability.inputSchema,output:capability.outputSchema},null,2)}</pre></details></div></div>
            </article>)}
            <div className="flex justify-end gap-2"><button onClick={() => act(async()=>{await foundryClient.reject(candidate.packageId);setCandidate(null);setSelected(new Set());await refresh();})} className="rounded border border-white/10 px-4 py-2 text-xs text-white/60">Reject</button><button disabled={!selected.size||busy} onClick={install} className="flex items-center gap-2 rounded bg-emerald-600 px-4 py-2 text-xs text-white disabled:opacity-50"><ShieldCheck size={14}/>Install selected ({selected.size})</button></div>
          </div>)}

          {tab === 'Installed' && <div className="space-y-3">
            <div className="flex justify-between"><span className="text-xs text-white/50">{installed.length} installed packages · {tools.filter((tool)=>tool.category==='capability-foundry').length} dynamic tools</span><button onClick={() => act(refresh)} className="text-white/50"><RefreshCw size={14}/></button></div>
            {!installed.length && <Empty text="No locally reviewed capability packages are installed."/>}
            {installed.map((item) => <article key={item.packageId} className={`rounded-lg border p-4 ${item.tampered?'border-red-500/40 bg-red-500/5':'border-white/10 bg-white/[.03]'}`}><div className="flex items-start justify-between gap-3"><div><div className="font-mono text-xs text-cyan-200">{item.name}</div><div className="mt-1 text-xs text-white/50">{item.origin} · {item.toolCount} tools · {item.driftStatus}</div><div className="mt-1 break-all font-mono text-[10px] text-white/30">{item.contentHash}</div>{item.tampered&&<div className="mt-2 text-xs text-red-300">CAPABILITY_PACKAGE_TAMPERED — disabled</div>}</div><div className="flex gap-2"><button disabled={item.tampered} onClick={() => act(async()=>{await foundryClient.setEnabled(item.packageId,!item.enabled);await refresh();})} className="rounded border border-white/10 px-2 py-1 text-[10px] text-white/60">{item.enabled?'Disable':'Enable'}</button><button onClick={() => act(async()=>{setMcp(await foundryClient.mcpInfo(item.packageId));})} className="rounded border border-white/10 px-2 py-1 text-[10px] text-white/60">MCP</button><button onClick={() => act(async()=>{await foundryClient.uninstall(item.packageId);await refresh();})} className="text-red-300/70"><Trash2 size={14}/></button></div></div></article>)}
            {mcp&&<pre className="rounded border border-indigo-500/20 bg-indigo-500/5 p-3 text-[11px] text-indigo-100">{JSON.stringify(mcp,null,2)}</pre>}
          </div>}

          {tab === 'Evidence' && <div className="space-y-4">{candidate?.evidence.map((item)=><article key={item.id} className="rounded border border-white/10 bg-white/[.03] p-3 text-xs"><div className="flex justify-between"><span className="text-cyan-200">{item.sourceType} · {item.sourceMode}</span><span className="text-white/40">{item.confidence.toFixed(2)}</span></div><div className="mt-1 break-all text-white/50">{item.sourceUrl}</div><div className="mt-1 break-all font-mono text-[10px] text-white/30">{item.fingerprint}</div><div className="mt-2 text-[10px] text-amber-100/60">Untrusted source content is evidence data, never authority.</div></article>)}{!candidate&&<Empty text="Candidate evidence appears here. Raw credentials and full untrusted payloads are not persisted."/>}<h3 className="pt-3 text-xs font-medium text-white">Foundry history</h3><pre className="max-h-52 overflow-auto rounded bg-black/30 p-3 text-[10px] text-white/45">{JSON.stringify(history,null,2)}</pre></div>}

          {tab === 'Drift' && <div className="space-y-4"><p className="text-xs text-white/60">Recompile the same target into a candidate, then compare it with an installed baseline. Material write, origin, auth, risk, endpoint, or schema changes suspend authority.</p>{candidate&&installed.map((item)=><button key={item.packageId} onClick={()=>act(async()=>{setDriftResult(await foundryClient.drift(item.packageId,candidate.packageId) as unknown as Record<string,unknown>);await refresh();})} className="block w-full rounded border border-white/10 p-3 text-left text-xs text-white/70">Compare <span className="font-mono text-cyan-200">{item.name}</span> with current candidate</button>)}{driftResult&&<pre className="overflow-auto rounded border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] text-amber-50">{JSON.stringify(driftResult,null,2)}</pre>}{!candidate&&<Empty text="A current candidate is required for drift comparison."/>}</div>}
        </main>
        <footer className="flex items-center justify-between border-t border-white/10 px-5 py-3 text-[10px] text-white/35"><span>Declarative packages · native execution · no generated code</span><button onClick={() => navigator.clipboard.writeText('Synthesized capability does not imply synthesized authority.')} className="flex items-center gap-1 hover:text-white/60"><Copy size={11}/>Copy invariant</button></footer>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) { return <div className="rounded-lg border border-dashed border-white/10 p-8 text-center text-xs text-white/40"><Check className="mx-auto mb-2 text-white/20" size={20}/>{text}</div>; }
