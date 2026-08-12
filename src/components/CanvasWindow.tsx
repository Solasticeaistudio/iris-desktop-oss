import React, { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { CodeCanvas, type CanvasData } from './CodeCanvas';
import { getCurrentWindow } from '@tauri-apps/api/window';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: Error | null }> {
    constructor(props: { children: React.ReactNode }) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error) {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error("Canvas Window Crash:", error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="h-screen w-full flex flex-col items-center justify-center bg-red-950 text-white p-8">
                    <h1 className="text-2xl font-bold mb-4">Canvas Crashed</h1>
                    <pre className="bg-black/50 p-4 rounded text-xs overflow-auto max-w-full">
                        {this.state.error?.toString()}
                    </pre>
                </div>
            );
        }

        return this.props.children;
    }
}

export function CanvasWindow() {
    const [data, setData] = useState<CanvasData | null>(null);
    const appWindow = getCurrentWindow();

    useEffect(() => {
        // Start hidden by default (JS-based to ensure process runs)
        appWindow.hide().catch(console.error);

        const checkStorage = () => {
            const stored = localStorage.getItem('iris_canvas_data');
            if (stored) {
                try {
                    const newData = JSON.parse(stored);
                    setData(prev => {
                        if (prev?.timestamp !== newData.timestamp) {
                            console.log('[CANVAS] Syncing new data:', newData);
                            if (newData.isVisible) {
                                if (newData.isVisible) {
                                    console.log('[CANVAS] Showing window');
                                    appWindow.show();
                                    appWindow.setFocus();
                                }
                            }
                            return newData;
                        }
                        return prev;
                    });
                } catch (e) {
                    console.error("Failed to parse canvas data", e);
                }
            }
        };

        checkStorage();
        const interval = setInterval(checkStorage, 1000);

        const handleStorageChange = (e: StorageEvent) => {
            if (e.key === 'iris_canvas_data') {
                checkStorage();
            }
        };
        window.addEventListener('storage', handleStorageChange);

        const unlistenPromise = listen<CanvasData>('update-canvas', (event) => {
            console.log('[CANVAS] Received direct event:', event.payload);
            localStorage.setItem('iris_canvas_data', JSON.stringify({ ...event.payload, timestamp: Date.now() }));
            checkStorage();
        });

        // Intercept Close Event to keep window alive in background
        const unlistenClose = appWindow.onCloseRequested(async (event) => {
            event.preventDefault(); // Prevent native close
            await appWindow.hide(); // Hide instead
        });

        return () => {
            clearInterval(interval);
            window.removeEventListener('storage', handleStorageChange);
            unlistenPromise.then(f => f());
            unlistenClose.then(f => f());
        };
    }, []);

    // Window control handlers removed - using native decorations

    if (!data) {
        return (
            <div
                className="h-screen w-full bg-slate-950 flex items-center justify-center text-white/50 font-mono text-sm"
            >
                Waiting for content...
            </div>
        );
    }

    return (
        <div className="h-screen w-full bg-slate-950 flex flex-col overflow-hidden">
            {/* Native Title Bar enabled in tauri.conf.json */}

            {/* Content Area - Takes remaining space */}
            <div className="flex-1 overflow-hidden">
                <ErrorBoundary>
                    <CodeCanvas
                        isVisible={true}
                        data={data}
                        onClose={() => { }}
                        isStandalone={true}
                    />
                </ErrorBoundary>
            </div>
        </div>
    );
}
