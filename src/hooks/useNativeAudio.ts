import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface NativeAudioDevice {
  name: string;
  is_default: boolean;
}

interface AudioLevelPayload {
  level: number;
  is_speech: boolean;
}

interface AudioRecordingPayload {
  audio_base64: string;
  duration_ms: number;
  sample_rate: number;
}

interface UseNativeAudioOptions {
  deviceName?: string;
  enabled?: boolean; // Add enabled prop
  onAudioLevel?: (level: number) => void;
  onSpeechDetected?: (isSpeaking: boolean) => void;
  onAudioRecorded?: (audioBase64: string, durationMs: number) => void;
}

export function useNativeAudio({
  deviceName,
  enabled = true, // Default to true
  onAudioLevel,
  onSpeechDetected,
  onAudioRecorded,
}: UseNativeAudioOptions = {}) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<NativeAudioDevice[]>([]);

  // Use refs to store callbacks so event listeners stay stable
  const onAudioLevelRef = useRef(onAudioLevel);
  const onSpeechDetectedRef = useRef(onSpeechDetected);
  const onAudioRecordedRef = useRef(onAudioRecorded);

  // Keep refs updated with latest callbacks
  useEffect(() => {
    onAudioLevelRef.current = onAudioLevel;
    onSpeechDetectedRef.current = onSpeechDetected;
    onAudioRecordedRef.current = onAudioRecorded;
  }, [onAudioLevel, onSpeechDetected, onAudioRecorded]);

  // List available audio devices
  const listDevices = useCallback(async () => {
    try {
      const deviceList = await invoke<NativeAudioDevice[]>('list_audio_devices');
      console.log('[NativeAudio] Available devices:', deviceList);
      setDevices(deviceList);
      return deviceList;
    } catch (e) {
      console.error('[NativeAudio] Failed to list devices:', e);
      setError(String(e));
      return [];
    }
  }, []);

  // Start audio capture
  const startCapture = useCallback(async (device?: string) => {
    try {
      console.log('[NativeAudio] Starting capture on device:', device || 'default');
      await invoke('start_audio_capture', { deviceName: device || null });
      setIsCapturing(true);
      setError(null);
      console.log('[NativeAudio] Capture started successfully!');
    } catch (e) {
      console.error('[NativeAudio] Failed to start capture:', e);
      setError(String(e));
    }
  }, []);

  // Stop audio capture
  const stopCapture = useCallback(async () => {
    try {
      await invoke('stop_audio_capture');
      setIsCapturing(false);
      setAudioLevel(0);
      setIsSpeaking(false);
      console.log('[NativeAudio] Capture stopped');
    } catch (e) {
      console.error('[NativeAudio] Failed to stop capture:', e);
    }
  }, []);

  // Refs for batching updates without causing re-renders on every event
  const pendingLevelRef = useRef<number | null>(null);
  const pendingSpeechRef = useRef<boolean | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastSpeechStateRef = useRef<boolean>(false);

  // Batch state updates using requestAnimationFrame
  const flushUpdates = useCallback(() => {
    if (pendingLevelRef.current !== null) {
      setAudioLevel(pendingLevelRef.current);
      onAudioLevelRef.current?.(pendingLevelRef.current);
      pendingLevelRef.current = null;
    }
    if (pendingSpeechRef.current !== null) {
      // Only update if speech state actually changed
      if (pendingSpeechRef.current !== lastSpeechStateRef.current) {
        setIsSpeaking(pendingSpeechRef.current);
        onSpeechDetectedRef.current?.(pendingSpeechRef.current);
        lastSpeechStateRef.current = pendingSpeechRef.current;
      }
      pendingSpeechRef.current = null;
    }
    rafIdRef.current = null;
  }, []); // No deps - uses refs

  // Listen for audio level events from Rust
  useEffect(() => {
    let unlistenLevel: (() => void) | null = null;
    let unlistenRecording: (() => void) | null = null;
    let eventCount = 0;

    const setupListeners = async () => {
      console.log('[NativeAudio] Setting up event listeners...');

      // Audio level events (for visualization) - batched via RAF
      unlistenLevel = await listen<AudioLevelPayload>('audio-level', (event) => {
        const { level, is_speech } = event.payload;
        eventCount++;

        // Log every 500th event to avoid spam (reduced from 100)
        if (eventCount % 500 === 1) {
          console.log('[NativeAudio] Level:', level.toFixed(4), 'Speech:', is_speech);
        }

        // Queue updates instead of setting state directly
        pendingLevelRef.current = level;
        pendingSpeechRef.current = is_speech;

        // Schedule flush on next animation frame (batches multiple events)
        if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(flushUpdates);
        }
      });

      // Audio recording events (when speech ends)
      unlistenRecording = await listen<AudioRecordingPayload>('audio-recording', (event) => {
        const { audio_base64, duration_ms, sample_rate } = event.payload;
        console.log('[NativeAudio] *** AUDIO RECORDING RECEIVED ***');
        console.log('[NativeAudio] Duration:', duration_ms, 'ms');
        console.log('[NativeAudio] Sample rate:', sample_rate, 'Hz');
        console.log('[NativeAudio] Base64 length:', audio_base64.length, 'chars');
        onAudioRecordedRef.current?.(audio_base64, duration_ms);
      });

      console.log('[NativeAudio] Event listeners registered!');
    };

    setupListeners();

    return () => {
      console.log('[NativeAudio] Cleaning up event listeners');
      if (unlistenLevel) unlistenLevel();
      if (unlistenRecording) unlistenRecording();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [flushUpdates]); // Stable deps only - callbacks are in refs

  // Track enabled state in ref for async access
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // Auto-start capture based on enabled prop
  useEffect(() => {
    let mounted = true;

    // Async function to handle start/stop sequence
    const updateCaptureState = async () => {
      if (enabled) {
        try {
          // Verify devices exist before starting (optional but good for safety)
          await listDevices();

          // Only start if still mounted and enabled
          // This prevents starting if the user quickly toggled off
          if (mounted && enabledRef.current) {
            await startCapture(deviceName);
          }
        } catch (e) {
          console.error('[NativeAudio] Failed to start capture:', e);
        }
      } else {
        // If disabled, ensure we are stopped
        await stopCapture();
      }
    };

    updateCaptureState();

    // Cleanup: always stop when unmounting or changing dependencies
    return () => {
      mounted = false;
      stopCapture();
    };
  }, [deviceName, enabled, startCapture, stopCapture, listDevices]);

  return {
    isCapturing,
    audioLevel,
    isSpeaking,
    error,
    devices,
    listDevices,
    startCapture,
    stopCapture,
  };
}
