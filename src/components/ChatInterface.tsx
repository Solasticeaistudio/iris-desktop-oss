import { useState, useRef, useEffect } from 'react';
import { Send, Camera, X, Loader2 } from 'lucide-react';
import { cn, formatTime } from '../lib/utils';
import type { Message } from '../hooks/useIrisState';

interface ChatInterfaceProps {
  messages: Message[];
  isLoading: boolean;
  screenshot: string | null;
  onSendMessage: (message: string) => void;
  onCaptureScreen: () => void;
  onRemoveScreenshot: () => void;
  onInputFocus: () => void;
  onInputBlur: () => void;
}

export function ChatInterface({
  messages,
  isLoading,
  screenshot,
  onSendMessage,
  onCaptureScreen,
  onRemoveScreenshot,
  onInputFocus,
  onInputBlur,
}: ChatInterfaceProps) {
  const [input, setInput] = useState('');
  const chatFeedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (chatFeedRef.current) {
      chatFeedRef.current.scrollTop = chatFeedRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    onSendMessage(trimmed);
    setInput('');

    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // Auto-resize
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Chat Messages */}
      <div
        ref={chatFeedRef}
        className="chat-feed flex-1 overflow-y-auto px-4 py-3 space-y-3"
      >
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              'message rounded-lg px-3 py-2',
              msg.role === 'iris' && 'message-iris',
              msg.role === 'user' && 'message-user',
              msg.role === 'system' && 'text-center text-sm text-white/50 italic'
            )}
          >
            <div className="text-white/90 text-sm whitespace-pre-wrap break-words">
              {msg.content}
            </div>
            <div className="text-white/40 text-xs mt-1">
              {msg.role === 'iris' ? 'IRIS' : msg.role === 'user' ? 'You' : ''} •{' '}
              {formatTime(msg.timestamp)}
            </div>
          </div>
        ))}

        {/* Typing indicator */}
        {isLoading && (
          <div className="message message-iris rounded-lg px-3 py-2">
            <div className="typing-indicator">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        )}
      </div>

      {/* Screenshot Preview */}
      {screenshot && (
        <div className="px-4 pb-2">
          <div className="screenshot-preview">
            <img src={screenshot} alt="Screenshot" />
            <button
              onClick={onRemoveScreenshot}
              className="remove-btn"
              title="Remove screenshot"
            >
              <X size={14} className="text-white" />
            </button>
          </div>
        </div>
      )}

      {/* Input Area */}
      <div className="px-4 pb-4">
        <div className="input-area rounded-xl flex items-end gap-2 p-2">
          {/* Screenshot button */}
          <button
            onClick={onCaptureScreen}
            className="btn-icon flex-shrink-0"
            title="Capture screen (screenshot)"
            disabled={isLoading}
          >
            <Camera size={18} className="text-white/70" />
          </button>

          {/* Text input */}
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={onInputFocus}
            onBlur={onInputBlur}
            placeholder="Ask IRIS anything..."
            rows={1}
            className="flex-1 text-sm px-2 py-1.5 max-h-[120px]"
            disabled={isLoading}
          />

          {/* Send button */}
          <button
            onClick={handleSubmit}
            className={cn(
              'btn-icon flex-shrink-0',
              input.trim() && !isLoading && 'bg-gradient-to-r from-cyan-500 to-purple-500 border-transparent'
            )}
            disabled={!input.trim() || isLoading}
            title="Send message"
          >
            {isLoading ? (
              <Loader2 size={18} className="text-white/70 animate-spin" />
            ) : (
              <Send size={18} className={cn('text-white/70', input.trim() && 'text-white')} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
