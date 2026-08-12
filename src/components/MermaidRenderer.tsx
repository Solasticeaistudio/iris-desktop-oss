import React from 'react';

interface MermaidRendererProps { code: string }

// OSS v0.1 deliberately displays provider-generated Mermaid as inert source.
// Re-enabling diagrams requires a sanitizer-backed renderer and security review.
export const MermaidRenderer: React.FC<MermaidRendererProps> = ({ code }) => (
  <div className="w-full h-full overflow-auto p-4 bg-slate-950 text-slate-200">
    <div className="text-xs text-amber-300 mb-3">Diagram preview is disabled for untrusted model output.</div>
    <pre className="whitespace-pre-wrap break-words text-xs font-mono">{code}</pre>
  </div>
);

export default MermaidRenderer;
