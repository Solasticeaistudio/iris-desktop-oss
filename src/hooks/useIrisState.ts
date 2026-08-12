import { useCallback, useState } from 'react';

export type IrisState = 'idle' | 'listening' | 'thinking' | 'delivering' | 'success' | 'error';

export interface Message {
  id: string;
  content: string;
  role: 'user' | 'iris' | 'system';
  timestamp: Date;
}

export interface IrisStateHook {
  state: IrisState;
  messages: Message[];
  isConnected: boolean;
  screenshot: string | null;
  isExec: boolean;
  setState: (state: IrisState) => void;
  addMessage: (content: string, role: 'user' | 'iris' | 'system', broadcastToCompanion?: boolean) => void;
  clearMessages: () => void;
  setScreenshot: (screenshot: string | null) => void;
  setConnected: (connected: boolean) => void;
  setExec: (isExec: boolean) => void;
}

const MAX_MESSAGES = 50;

export function useIrisState(): IrisStateHook {
  const [state, setState] = useState<IrisState>('idle');
  const [messages, setMessages] = useState<Message[]>([{
    id: '1',
    content: "Hello! I'm IRIS, your local desktop agent. How can I help you today?",
    role: 'iris',
    timestamp: new Date(),
  }]);
  const [isConnected, setConnected] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [isExec, setExec] = useState(false);

  const addMessage = useCallback((content: string, role: 'user' | 'iris' | 'system', _broadcastToCompanion = false) => {
    const newMessage: Message = { id: `${Date.now()}-${Math.random()}`, content, role, timestamp: new Date() };
    setMessages((previous) => [...previous, newMessage].slice(-MAX_MESSAGES));
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([{
      id: `${Date.now()}`,
      content: 'Chat cleared. How can I assist you?',
      role: 'iris',
      timestamp: new Date(),
    }]);
  }, []);

  return { state, messages, isConnected, screenshot, isExec, setState, addMessage, clearMessages, setScreenshot, setConnected, setExec };
}
