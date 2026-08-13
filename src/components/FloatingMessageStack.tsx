import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Loader2, Mic, MicOff, X, ChevronRight, Camera } from 'lucide-react';
import { cn } from '../lib/utils';
import type { Message } from '../hooks/useIrisState';

interface FloatingMessageStackProps {
    messages: Message[];
    isLoading: boolean;
    screenshot: string | null;
    onSendMessage: (message: string) => void;
    onRemoveScreenshot: () => void;
    onCaptureScreen: () => void;
    voiceEnabled: boolean;
    onToggleVoice: () => void;
    showInput: boolean; // Whether to show the input pill
    onToggleInput: () => void;
    onToggleSettings: () => void;
    onVisibilityChange?: (visible: boolean) => void;
}

export function FloatingMessageStack({
    messages,
    isLoading,
    screenshot,
    onSendMessage,
    onRemoveScreenshot,
    onCaptureScreen,
    voiceEnabled,
    onToggleVoice,
    showInput,
    onToggleInput,
    onToggleSettings,
    onVisibilityChange,
}: FloatingMessageStackProps) {
    const [input, setInput] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    // Get only the interactions (user + iris pairs ideally, but just last N for now)
    // We want to show a max of 2 "interactions" or just 2 bubbles.
    // The user asked for "two messages show at once".
    // We want to show a max of 2 "interactions" or just 2 bubbles.
    // The user asked for "two messages show at once".
    // This is now handled by the max-h constraint on the container.

    const handleSubmit = () => {

        const trimmed = input.trim();
        if (!trimmed || isLoading) return;
        onSendMessage(trimmed);
        setInput('');
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSubmit();
        }
    };

    // Auto-focus input when shown
    useEffect(() => {
        if (showInput && inputRef.current) {
            inputRef.current.focus();
        }
    }, [showInput]);

    const [isChatVisible, setIsChatVisible] = useState(false);
    const [isHovering, setIsHovering] = useState(false);
    const [isFocused, setIsFocused] = useState(false); // Track input focus

    // Notify parent of visibility changes AND sync with canvas via localStorage
    useEffect(() => {
        onVisibilityChange?.(isChatVisible);
        // Write to localStorage so canvas window can sync its fade
        localStorage.setItem('iris_chat_visible', JSON.stringify({ visible: isChatVisible, timestamp: Date.now() }));
    }, [isChatVisible, onVisibilityChange]);

    // Auto-fade logic
    useEffect(() => {
        // Keep visible if hovering or INTENDING to type (focused)
        // We do NOT use showInput here, because we want it to fade even if the input is "open"
        // but the user is ignoring it (not hovering, not typing).
        if (isHovering || isFocused) {
            setIsChatVisible(true);
            return;
        }

        // Show initially/on-message, then fade
        setIsChatVisible(true);
        const timer = setTimeout(() => {
            setIsChatVisible(false);
        }, 3000); // 3 seconds timeout

        return () => clearTimeout(timer);
    }, [messages, isFocused, isHovering]); // Removed showInput dependency

    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll disabled - was cutting off first message
    // useEffect(() => {
    //     if (scrollRef.current) {
    //         scrollRef.current.scrollTo({
    //             top: scrollRef.current.scrollHeight,
    //             behavior: 'smooth'
    //         });
    //     }
    // }, [messages.length, isChatVisible]);

    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center pr-8 w-full transition-opacity duration-1000",
                isChatVisible ? "opacity-100" : "opacity-0 pointer-events-none"
            )}
        >
            <div
                ref={scrollRef}
                className="flex flex-col gap-4 w-full items-center pointer-events-auto overflow-y-auto max-h-96 px-4 pt-4 pb-6 no-scrollbar transition-all"
                onMouseEnter={() => setIsHovering(true)}
                onMouseLeave={() => setIsHovering(false)}
                style={{
                    scrollbarWidth: 'none', // Firefox
                    msOverflowStyle: 'none', // IE/Edge
                }}
            >
                {/* Embed style tag for Webkit scrollbar hiding locally */}
                <style>{`
                    .no-scrollbar::-webkit-scrollbar {
                        display: none;
                    }
                `}</style>

                <AnimatePresence mode="popLayout" initial={false}>
                    {messages.map((msg) => (
                        <motion.div
                            key={msg.id}
                            layout
                            initial={{ opacity: 0, x: 20, scale: 0.8 }}
                            animate={{
                                opacity: 1,
                                x: 0,
                                scale: 1,
                                filter: 'blur(0px)',
                                transition: { type: 'spring', stiffness: 300, damping: 25 }
                            }}
                            exit={{ opacity: 0, scale: 0.8 }}
                            className={cn(
                                "pointer-events-auto relative group max-w-[300px] text-center shrink-0"
                            )}
                        >
                            <div
                                className={cn(
                                    "px-6 py-4 break-words font-medium text-base shadow-black/50 drop-shadow-md text-shadow-sm",
                                    msg.role === 'iris'
                                        ? "text-cyan-200"
                                        : "text-white"
                                )}
                            >
                                {/* Message Content */}
                                <div className="leading-normal tracking-wide whitespace-pre-wrap text-left">
                                    {msg.content.replace(/\*\w+:[^*]*\*/g, '').trim()}
                                </div>

                                {/* Role Label (Tiny) */}
                                <div className={cn(
                                    "absolute -bottom-4 text-[10px] uppercase tracking-wider font-bold opacity-0 group-hover:opacity-100 transition-opacity",
                                    msg.role === 'iris' ? "left-2 text-cyan-400" : "right-2 text-white/40"
                                )}>
                                    {msg.role === 'iris' ? 'IRIS' : 'YOU'}
                                </div>
                            </div>
                        </motion.div>
                    ))}

                    {/* Loading / Thinking Indicator */}
                    {isLoading && (
                        <motion.div
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.8 }}
                            className="pointer-events-auto mt-2"
                        >
                            <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-cyan-500/10 border border-cyan-500/20 backdrop-blur-md">
                                <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />
                                <span className="text-xs text-cyan-300 font-medium">Thinking...</span>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Input Pill - Below messages, aligned mid/right */}
            <div
                className="mt-6 pointer-events-auto flex flex-col items-end relative"
                onMouseEnter={() => setIsHovering(true)}
                onMouseLeave={() => setIsHovering(false)}
            >
                <AnimatePresence>
                    {showInput ? (
                        <motion.div
                            initial={{ width: 40, opacity: 0 }}
                            animate={{ width: 320, opacity: 1 }}
                            exit={{ width: 40, opacity: 0 }}
                            className="flex items-center gap-2 bg-black/80 backdrop-blur-xl border border-white/10 rounded-full px-2 py-2 shadow-2xl overflow-hidden"
                        >
                            <button
                                onClick={onToggleInput}
                                className="p-2 rounded-full hover:bg-white/10 text-white/50 hover:text-white transition-colors"
                                title="Close Input"
                            >
                                <ChevronRight size={16} />
                            </button>

                            <input
                                ref={inputRef}
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                onFocus={() => setIsFocused(true)}
                                onBlur={() => setIsFocused(false)}
                                placeholder="Message Iris..."
                                className="flex-1 bg-transparent border-none outline-none text-white text-sm placeholder-white/30 min-w-0"
                            />

                            <div className="flex items-center gap-1 border-l border-white/10 pl-2">
                                <button
                                    onClick={onCaptureScreen}
                                    className="p-2 rounded-full hover:bg-white/10 text-white/40 hover:text-cyan-400 transition-colors"
                                    title="Capture primary monitor for the next message"
                                >
                                    <Camera size={14} />
                                </button>
                                <button
                                    onClick={onToggleVoice}
                                    className={cn(
                                        "p-2 rounded-full transition-all",
                                        voiceEnabled ? "bg-cyan-500/20 text-cyan-400" : "hover:bg-white/10 text-white/40"
                                    )}
                                    title="Toggle Voice"
                                >
                                    {voiceEnabled ? <Mic size={14} /> : <MicOff size={14} />}
                                </button>

                                <button
                                    onClick={handleSubmit}
                                    disabled={!input.trim()}
                                    className={cn(
                                        "p-2 rounded-full transition-all",
                                        input.trim()
                                            ? "bg-cyan-500 text-black hover:bg-cyan-400"
                                            : "bg-white/5 text-white/20"
                                    )}
                                >
                                    <Send size={14} />
                                </button>

                                {/* Settings trigger (hidden but useful) */}
                                <button
                                    onClick={onToggleSettings}
                                    className="p-2 rounded-full hover:bg-white/10 text-white/20 hover:text-white transition-colors"
                                >
                                    <div className="w-1 h-1 rounded-full bg-current" />
                                    <div className="w-1 h-1 rounded-full bg-current my-[2px]" />
                                    <div className="w-1 h-1 rounded-full bg-current" />
                                </button>
                            </div>
                        </motion.div>
                    ) : (
                        <motion.button
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            whileHover={{ scale: 1.1 }}
                            onClick={onToggleInput}
                            title="Open Chat"
                            className="p-3 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/30 backdrop-blur-md transition-all group"
                        >
                            <Send size={16} className="text-white/40 group-hover:text-cyan-400" />
                        </motion.button>
                    )}
                </AnimatePresence>

                {/* Floating Screenshot Preview */}
                {screenshot && (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="absolute bottom-full mb-3 right-0 pointer-events-auto"
                    >
                        <div className="relative group">
                            <img
                                src={screenshot ? `data:image/jpeg;base64,${screenshot}` : undefined}
                                className="w-32 rounded-lg border border-white/20 shadow-lg"
                                alt="Screenshot"
                            />
                            <button
                                onClick={onRemoveScreenshot}
                                className="absolute -top-2 -right-2 p-1 bg-red-500 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                                <X size={10} />
                            </button>
                        </div>
                    </motion.div>
                )}
            </div>
        </div>
    );
}
