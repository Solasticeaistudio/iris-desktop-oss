import React, { useEffect, useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { MermaidRenderer } from './MermaidRenderer';
import { ChartRenderer } from './ChartRenderer';

export interface CanvasData {
    code?: string;
    language?: string;
    visualization?: {
        type: 'svg' | 'chart';
        content?: string; // for svg
        data?: any; // for chart
        chartType?: 'bar' | 'line' | 'pie';
    };
    isVisible: boolean;
    timestamp?: number;
}

interface CodeCanvasProps {
    data: CanvasData | null;
    isVisible: boolean; // Added isVisible prop
    onClose: () => void;
    isStandalone?: boolean;
}

export const CodeCanvas: React.FC<CodeCanvasProps> = ({ data, isVisible, onClose, isStandalone = false }) => {
    const [codeContent, setCodeContent] = useState('');
    const [status, setStatus] = useState('ready');
    const codeEndRef = useRef<HTMLDivElement>(null);

    // Typing effect
    useEffect(() => {
        if (data?.code) {
            setStatus('writing...');
            let currentText = '';
            const fullText = data.code;
            let i = 0;

            const interval = setInterval(() => {
                if (i < fullText.length) {
                    currentText += fullText[i];
                    setCodeContent(currentText);
                    i++;
                } else {
                    clearInterval(interval);
                    setStatus('ready');
                }
            }, 10); // Typing speed

            return () => clearInterval(interval);
        }
    }, [data?.code]);

    // Auto-scroll
    useEffect(() => {
        if (codeEndRef.current) {
            codeEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [codeContent]);

    // If not visible, effects above still preserve hook ordering but no UI is rendered.
    if ((!isVisible && !isStandalone) || !data?.isVisible) return null;

    return (
        <motion.div
            initial={isStandalone ? { opacity: 0 } : { x: 300, opacity: 0 }}
            animate={isStandalone ? { opacity: 1 } : { x: 0, opacity: 1 }}
            exit={isStandalone ? { opacity: 0 } : { x: 300, opacity: 0 }}
            className={isStandalone
                ? "w-full h-full bg-slate-950 text-slate-200 flex flex-col" // Full window mode
                : "fixed right-0 top-0 bottom-0 w-[500px] bg-slate-900/95 backdrop-blur-xl border-l border-white/10 shadow-2xl p-6 flex flex-col z-50" // Sidebar mode
            }
        >
            {!isStandalone && ( // Close button only needed in sidebar mode
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 p-2 hover:bg-white/10 rounded-full transition-colors"
                >
                    <X className="w-5 h-5" />
                </button>
            )}

            {/* Header */}
            <div className="flex items-center gap-3 mb-6 p-4 border-b border-white/5">
                <div className="w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
                <h3 className="font-mono text-sm tracking-wider uppercase text-blue-400">
                    IRIS Code Canvas
                </h3>
            </div>

            {/* Code Area */}
            <div className="max-h-[180px] w-full overflow-y-auto border-b border-yellow-400/10 bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-gray-300 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-yellow-400/30">
                <pre className="whitespace-pre-wrap break-all">
                    {codeContent}
                    {status === 'writing...' && (
                        <span className="inline-block h-3.5 w-2 bg-yellow-400 align-middle animate-pulse ml-0.5" />
                    )}
                </pre>
                <div ref={codeEndRef} />
            </div>

            {/* Visual Area */}
            <div className="flex min-h-[200px] flex-1 items-center justify-center overflow-hidden p-3">
                {/* Terminal Renderer */}
                {data?.language === 'terminal' ? (
                    <div className="w-full h-full bg-black rounded-lg overflow-y-auto p-4 font-mono text-xs text-green-400">
                        {data.code ? (
                            <pre className="whitespace-pre-wrap break-all">
                                {data.code}
                            </pre>
                        ) : (
                            <div className="text-gray-500 italic">Waiting for local output...</div>
                        )}
                        {/* Cursor */}
                        <span className="inline-block w-2 h-4 bg-green-400 animate-pulse ml-1 align-middle"></span>
                    </div>
                ) : data?.language === 'mermaid' ? (
                    /* Mermaid Diagram Renderer */
                    <div className="w-full h-full bg-slate-900/50 rounded-lg overflow-auto">
                        <MermaidRenderer code={data.code || ''} />
                    </div>
                ) : data?.visualization ? (
                    <div className="w-full h-full flex items-center justify-center">
                        {/* Raw provider SVG is displayed as inert text in OSS v0.1. */}
                        {data.visualization.type === 'svg' && (
                            <pre className="w-full h-full overflow-auto whitespace-pre-wrap break-all p-4 text-xs font-mono text-slate-300">
                                {data.visualization.content || ''}
                            </pre>
                        )}
                        {/* Chart Renderer */}
                        {data.visualization.type === 'chart' && data.visualization.data && (
                            <div className="w-full h-full p-4">
                                <ChartRenderer config={data.visualization.data} />
                            </div>
                        )}
                    </div>
                ) : data?.language === 'html' ? (
                    <div className="w-full h-full bg-slate-950 rounded-lg overflow-auto p-4">
                        <div className="text-xs text-amber-300 mb-3">Active HTML preview is disabled for untrusted model output.</div>
                        <pre className="whitespace-pre-wrap break-all text-xs font-mono text-slate-300">{data.code}</pre>
                    </div>
                ) : data?.language === 'markdown' ? (
                    <div className="w-full h-full bg-slate-900/50 rounded-lg overflow-y-auto p-8 markdown-body prose prose-invert prose-sm max-w-none prose-headings:font-bold prose-headings:tracking-tight prose-a:text-blue-400 prose-code:text-yellow-400 prose-pre:bg-black/50 prose-pre:border prose-pre:border-white/10">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                        >
                            {data.code || ''}
                        </ReactMarkdown>
                    </div>
                ) : (
                    <div className="text-[11px] text-white/30 text-center">
                        Visualizations appear here
                    </div>
                )}
            </div>
        </motion.div >
    );
};
