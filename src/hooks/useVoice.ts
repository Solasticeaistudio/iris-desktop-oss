import { useCallback, useEffect, useRef, useState } from 'react';
import { playSpeechResponse, stopVoicePlayback, synthesizeVoice } from '../lib/voice';

export type VoiceState = 'idle' | 'listening' | 'hearing' | 'processing' | 'speaking';

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface UseVoiceOptions {
  deviceId?: string;
  wakeWords?: string[];
  onWakeWord?: () => void;
  onTranscript?: (text: string) => void;
  onStateChange?: (state: VoiceState) => void;
  onAudioLevel?: (level: number) => void;
  onIrisAudioLevel?: (level: number) => void;
}

type RecognitionConstructor = new () => SpeechRecognitionLike;

export function useVoice({ onWakeWord, onTranscript, onStateChange, onAudioLevel, onIrisAudioLevel }: UseVoiceOptions) {
  const [state, setState] = useState<VoiceState>('idle');
  const [isAwake, setIsAwake] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const speakingRef = useRef(false);

  const updateState = useCallback((next: VoiceState) => {
    setState(next);
    onStateChange?.(next);
  }, [onStateChange]);

  const stopListening = useCallback(() => {
    try { recognitionRef.current?.stop(); } catch { /* already stopped */ }
    updateState('idle');
    onAudioLevel?.(0);
  }, [onAudioLevel, updateState]);

  const startListening = useCallback(() => {
    if (speakingRef.current || !isAwake) return;
    const browserWindow = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
    const Recognition = browserWindow.SpeechRecognition || browserWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setError('Browser speech recognition is unavailable. Type messages or configure a local speech adapter.');
      updateState('idle');
      return;
    }
    if (!recognitionRef.current) {
      const recognition = new Recognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-US';
      recognition.onresult = (event) => {
        const transcript = event.results[0]?.[0]?.transcript?.trim();
        if (transcript) {
          updateState('processing');
          onWakeWord?.();
          onTranscript?.(transcript);
        }
      };
      recognition.onend = () => {
        if (!speakingRef.current) updateState('idle');
      };
      recognition.onerror = () => {
        setError('Browser speech recognition failed.');
        updateState('idle');
      };
      recognitionRef.current = recognition;
    }
    try {
      recognitionRef.current.start();
      updateState('listening');
    } catch {
      // The browser throws if start is called while already listening.
    }
  }, [isAwake, onTranscript, onWakeWord, updateState]);

  const speak = useCallback(async (text: string): Promise<void> => {
    if (!text || typeof window === 'undefined') return;
    speakingRef.current = true;
    stopListening();
    updateState('speaking');
    onIrisAudioLevel?.(0.5);
    try {
      const response = await synthesizeVoice(text);
      await playSpeechResponse(text, response, onIrisAudioLevel);
      setError(null);
    } catch (voiceError) {
      const message = String(voiceError);
      if (message.includes('VOICE_TTS_DISABLED')) return;
      setError(message);
      // Keep IRIS conversational if a paid provider is unavailable or out of credit.
      if ('speechSynthesis' in window) {
        const fallback = new SpeechSynthesisUtterance(text);
        await new Promise<void>((resolve) => {
          fallback.onend = () => resolve();
          fallback.onerror = () => resolve();
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(fallback);
        });
      }
    } finally {
      speakingRef.current = false;
      onIrisAudioLevel?.(0);
      updateState('idle');
    }
  }, [onIrisAudioLevel, stopListening, updateState]);

  const interruptSpeech = useCallback(async () => {
    stopVoicePlayback();
    speakingRef.current = false;
    onIrisAudioLevel?.(0);
    updateState('idle');
  }, [onIrisAudioLevel, updateState]);

  const wake = useCallback(() => {
    setIsAwake(true);
    onWakeWord?.();
  }, [onWakeWord]);

  const sleep = useCallback(() => {
    setIsAwake(false);
    stopListening();
  }, [stopListening]);

  useEffect(() => () => {
    try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    stopVoicePlayback();
  }, []);

  return {
    state,
    isAwake,
    audioLevel: 0,
    irisAudioLevel: 0,
    error,
    speak,
    wake,
    sleep,
    startListening,
    stopListening,
    interruptSpeech,
  };
}
