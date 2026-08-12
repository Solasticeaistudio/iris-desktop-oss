/**
 * useGestureActions - Gesture-to-Action Binding System
 *
 * Maps gestures to actual system actions, not just voice responses.
 * Supports:
 * - Action bindings (screenshot, mute, confirm, etc.)
 * - Hold detection (gesture must be held for X ms)
 * - Cooldowns (prevent rapid-fire triggers)
 * - Customizable bindings
 */

import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Extended gesture types including new ones
export type GestureType =
  | 'wave'           // Waving hand (greeting)
  | 'thumbs_up'      // Thumbs up (confirm/approve)
  | 'thumbs_down'    // Thumbs down (reject/disapprove)
  | 'peace'          // Peace sign / V sign
  | 'fist'           // Closed fist (bump/ready)
  | 'open_palm'      // Open palm (stop/attention)
  | 'point'          // Pointing (look at this)
  | 'shush'          // Finger to lips (be quiet)
  | 'ok_sign'        // OK hand gesture (confirm)
  | 'rock'           // Rock sign / horns
  | 'pinch'          // Pinch gesture (zoom/select)
  | 'call_me'        // Phone gesture (thumb + pinky)
  | 'swipe_left'     // Hand swipe left (dismiss/back)
  | 'swipe_right'    // Hand swipe right (next/forward)
  | 'swipe_up'       // Hand swipe up (scroll up/volume up)
  | 'swipe_down'     // Hand swipe down (scroll down/volume down)
  | 'grab'           // Grabbing motion (hold)
  | 'release'        // Opening from fist (drop)
  | 'unknown';

// Action types that gestures can trigger
export type GestureAction =
  | 'none'                    // No action
  | 'speak_response'          // Speak a voice response
  | 'mute_toggle'             // Toggle microphone mute
  | 'interrupt_speech'        // Stop IRIS from talking
  | 'take_screenshot'         // Capture screen
  | 'confirm'                 // Confirm current action
  | 'cancel'                  // Cancel current action
  | 'scroll_up'               // Scroll up
  | 'scroll_down'             // Scroll down
  | 'volume_up'               // Increase volume
  | 'volume_down'             // Decrease volume
  | 'play_pause'              // Toggle media playback
  | 'next_track'              // Next media track
  | 'prev_track'              // Previous media track
  | 'show_iris'               // Bring IRIS to front
  | 'hide_iris'               // Minimize IRIS
  | 'start_listening'         // Activate voice input
  | 'stop_listening'          // Deactivate voice input
  | 'send_message'            // Send current typed message
  | 'clear_chat'              // Clear chat history
  | 'open_settings'           // Open settings panel
  | 'close_settings'          // Close settings panel
  | 'custom';                 // Custom action (handled by callback)

// Configuration for a gesture binding
export interface GestureBinding {
  gesture: GestureType;
  action: GestureAction;
  holdDuration?: number;      // ms to hold gesture before triggering (default: 0)
  cooldown?: number;          // ms before gesture can trigger again (default: 500)
  enabled?: boolean;          // Whether this binding is active
  voiceResponse?: string;     // Optional voice response
  customHandler?: () => void; // Custom action handler
  requiresConfirmation?: boolean; // Show confirmation before executing
  visualFeedback?: boolean;   // Show visual indicator when triggered
}

// Default gesture bindings
export const DEFAULT_GESTURE_BINDINGS: GestureBinding[] = [
  // Greetings & Acknowledgments
  {
    gesture: 'wave',
    action: 'speak_response',
    voiceResponse: "Hey there! I see you waving. What can I do for you?",
    cooldown: 5000,
    visualFeedback: true,
  },
  {
    gesture: 'open_palm',
    action: 'start_listening',
    holdDuration: 500,
    voiceResponse: "I'm listening...",
    cooldown: 1000,
    visualFeedback: true,
  },

  // Confirmation/Rejection
  {
    gesture: 'thumbs_up',
    action: 'confirm',
    holdDuration: 300,
    voiceResponse: "Got it!",
    cooldown: 1000,
    visualFeedback: true,
  },
  {
    gesture: 'thumbs_down',
    action: 'cancel',
    holdDuration: 300,
    voiceResponse: "Okay, I'll cancel that.",
    cooldown: 1000,
    visualFeedback: true,
  },
  {
    gesture: 'ok_sign',
    action: 'confirm',
    holdDuration: 200,
    voiceResponse: "Perfect!",
    cooldown: 1000,
    visualFeedback: true,
  },

  // Control
  {
    gesture: 'shush',
    action: 'interrupt_speech',
    holdDuration: 0,
    cooldown: 500,
    visualFeedback: true,
  },
  {
    gesture: 'fist',
    action: 'mute_toggle',
    holdDuration: 500,
    voiceResponse: "Microphone toggled.",
    cooldown: 1000,
    visualFeedback: true,
  },
  {
    gesture: 'point',
    action: 'take_screenshot',
    holdDuration: 800,
    voiceResponse: "Taking a screenshot of where you're pointing.",
    cooldown: 2000,
    visualFeedback: true,
  },

  // Media Control
  {
    gesture: 'peace',
    action: 'play_pause',
    holdDuration: 300,
    cooldown: 1000,
    visualFeedback: true,
  },
  {
    gesture: 'swipe_right',
    action: 'next_track',
    cooldown: 500,
    visualFeedback: true,
  },
  {
    gesture: 'swipe_left',
    action: 'prev_track',
    cooldown: 500,
    visualFeedback: true,
  },
  {
    gesture: 'swipe_up',
    action: 'volume_up',
    cooldown: 300,
    visualFeedback: true,
  },
  {
    gesture: 'swipe_down',
    action: 'volume_down',
    cooldown: 300,
    visualFeedback: true,
  },

  // Fun
  {
    gesture: 'rock',
    action: 'speak_response',
    voiceResponse: "Rock on! 🤘",
    cooldown: 3000,
    visualFeedback: true,
  },
  {
    gesture: 'call_me',
    action: 'speak_response',
    voiceResponse: "Call me anytime!",
    cooldown: 5000,
    visualFeedback: true,
  },
];

// Gesture hold state tracking
interface GestureHoldState {
  gesture: GestureType | null;
  startTime: number | null;
  triggered: boolean;
}

// Action execution callbacks
export interface GestureActionHandlers {
  onSpeak?: (text: string) => void;
  onMuteToggle?: () => void;
  onInterruptSpeech?: () => void;
  onTakeScreenshot?: () => Promise<void>;
  onConfirm?: () => void;
  onCancel?: () => void;
  onScrollUp?: () => void;
  onScrollDown?: () => void;
  onVolumeUp?: () => void;
  onVolumeDown?: () => void;
  onPlayPause?: () => void;
  onNextTrack?: () => void;
  onPrevTrack?: () => void;
  onShowIris?: () => void;
  onHideIris?: () => void;
  onStartListening?: () => void;
  onStopListening?: () => void;
  onSendMessage?: () => void;
  onClearChat?: () => void;
  onOpenSettings?: () => void;
  onCloseSettings?: () => void;
  onVisualFeedback?: (gesture: GestureType, action: GestureAction) => void;
}

export interface UseGestureActionsOptions {
  bindings?: GestureBinding[];
  handlers?: GestureActionHandlers;
  enabled?: boolean;
}

export function useGestureActions({
  bindings = DEFAULT_GESTURE_BINDINGS,
  handlers = {},
  enabled = true,
}: UseGestureActionsOptions = {}) {
  const [lastTriggeredAction, setLastTriggeredAction] = useState<{
    gesture: GestureType;
    action: GestureAction;
    timestamp: number;
  } | null>(null);

  // Track gesture hold states
  const holdStateRef = useRef<GestureHoldState>({
    gesture: null,
    startTime: null,
    triggered: false,
  });

  // Track cooldowns
  const cooldownsRef = useRef<Map<GestureType, number>>(new Map());

  // Check if gesture is on cooldown
  const isOnCooldown = useCallback((gesture: GestureType): boolean => {
    const lastTrigger = cooldownsRef.current.get(gesture);
    if (!lastTrigger) return false;

    const binding = bindings.find(b => b.gesture === gesture);
    const cooldown = binding?.cooldown ?? 500;

    return Date.now() - lastTrigger < cooldown;
  }, [bindings]);

  // Execute an action
  const executeAction = useCallback(async (binding: GestureBinding) => {
    if (!enabled) return;
    if (binding.enabled === false) return;
    if (isOnCooldown(binding.gesture)) return;

    // Set cooldown
    cooldownsRef.current.set(binding.gesture, Date.now());

    // Visual feedback
    if (binding.visualFeedback && handlers.onVisualFeedback) {
      handlers.onVisualFeedback(binding.gesture, binding.action);
    }

    // Track triggered action
    setLastTriggeredAction({
      gesture: binding.gesture,
      action: binding.action,
      timestamp: Date.now(),
    });

    console.log(`[GestureActions] Executing: ${binding.gesture} -> ${binding.action}`);

    // Execute the action
    switch (binding.action) {
      case 'speak_response':
        if (binding.voiceResponse && handlers.onSpeak) {
          handlers.onSpeak(binding.voiceResponse);
        }
        break;

      case 'mute_toggle':
        handlers.onMuteToggle?.();
        if (binding.voiceResponse && handlers.onSpeak) {
          handlers.onSpeak(binding.voiceResponse);
        }
        break;

      case 'interrupt_speech':
        handlers.onInterruptSpeech?.();
        break;

      case 'take_screenshot':
        await handlers.onTakeScreenshot?.();
        if (binding.voiceResponse && handlers.onSpeak) {
          handlers.onSpeak(binding.voiceResponse);
        }
        break;

      case 'confirm':
        handlers.onConfirm?.();
        if (binding.voiceResponse && handlers.onSpeak) {
          handlers.onSpeak(binding.voiceResponse);
        }
        break;

      case 'cancel':
        handlers.onCancel?.();
        if (binding.voiceResponse && handlers.onSpeak) {
          handlers.onSpeak(binding.voiceResponse);
        }
        break;

      case 'scroll_up':
        handlers.onScrollUp?.();
        break;

      case 'scroll_down':
        handlers.onScrollDown?.();
        break;

      case 'volume_up':
        handlers.onVolumeUp?.();
        try {
          await invoke('adjust_volume', { delta: 5 });
        } catch (e) {
          console.warn('[GestureActions] Volume control not available:', e);
        }
        break;

      case 'volume_down':
        handlers.onVolumeDown?.();
        try {
          await invoke('adjust_volume', { delta: -5 });
        } catch (e) {
          console.warn('[GestureActions] Volume control not available:', e);
        }
        break;

      case 'play_pause':
        handlers.onPlayPause?.();
        try {
          await invoke('media_play_pause');
        } catch (e) {
          console.warn('[GestureActions] Media control not available:', e);
        }
        break;

      case 'next_track':
        handlers.onNextTrack?.();
        try {
          await invoke('media_next');
        } catch (e) {
          console.warn('[GestureActions] Media control not available:', e);
        }
        break;

      case 'prev_track':
        handlers.onPrevTrack?.();
        try {
          await invoke('media_previous');
        } catch (e) {
          console.warn('[GestureActions] Media control not available:', e);
        }
        break;

      case 'show_iris':
        handlers.onShowIris?.();
        break;

      case 'hide_iris':
        handlers.onHideIris?.();
        break;

      case 'start_listening':
        handlers.onStartListening?.();
        if (binding.voiceResponse && handlers.onSpeak) {
          handlers.onSpeak(binding.voiceResponse);
        }
        break;

      case 'stop_listening':
        handlers.onStopListening?.();
        break;

      case 'send_message':
        handlers.onSendMessage?.();
        break;

      case 'clear_chat':
        handlers.onClearChat?.();
        break;

      case 'open_settings':
        handlers.onOpenSettings?.();
        break;

      case 'close_settings':
        handlers.onCloseSettings?.();
        break;

      case 'custom':
        binding.customHandler?.();
        break;

      case 'none':
      default:
        break;
    }
  }, [enabled, handlers, bindings, isOnCooldown]);

  // Process a detected gesture
  const processGesture = useCallback((gesture: GestureType) => {
    if (!enabled || gesture === 'unknown') return;

    const binding = bindings.find(b => b.gesture === gesture && b.enabled !== false);
    if (!binding) return;

    const now = Date.now();
    const holdState = holdStateRef.current;
    const holdDuration = binding.holdDuration ?? 0;

    // If this is a new gesture
    if (holdState.gesture !== gesture) {
      holdStateRef.current = {
        gesture,
        startTime: now,
        triggered: false,
      };

      // If no hold required, execute immediately
      if (holdDuration === 0) {
        executeAction(binding);
        holdStateRef.current.triggered = true;
      }
      return;
    }

    // Same gesture continuing - check hold duration
    if (!holdState.triggered && holdState.startTime) {
      const heldFor = now - holdState.startTime;
      if (heldFor >= holdDuration) {
        executeAction(binding);
        holdStateRef.current.triggered = true;
      }
    }
  }, [enabled, bindings, executeAction]);

  // Clear gesture state (called when hand is no longer detected)
  const clearGesture = useCallback(() => {
    holdStateRef.current = {
      gesture: null,
      startTime: null,
      triggered: false,
    };
  }, []);

  // Get binding for a gesture
  const getBinding = useCallback((gesture: GestureType): GestureBinding | undefined => {
    return bindings.find(b => b.gesture === gesture);
  }, [bindings]);

  // Update a binding
  const [customBindings, setCustomBindings] = useState<GestureBinding[]>(bindings);

  const updateBinding = useCallback((gesture: GestureType, updates: Partial<GestureBinding>) => {
    setCustomBindings(prev => {
      const index = prev.findIndex(b => b.gesture === gesture);
      if (index === -1) return prev;

      const newBindings = [...prev];
      newBindings[index] = { ...newBindings[index], ...updates };
      return newBindings;
    });
  }, []);

  // Get hold progress (0-1) for current gesture
  const getHoldProgress = useCallback((): number => {
    const holdState = holdStateRef.current;
    if (!holdState.gesture || !holdState.startTime) return 0;

    const binding = bindings.find(b => b.gesture === holdState.gesture);
    const holdDuration = binding?.holdDuration ?? 0;
    if (holdDuration === 0) return 1;

    const heldFor = Date.now() - holdState.startTime;
    return Math.min(1, heldFor / holdDuration);
  }, [bindings]);

  return {
    processGesture,
    clearGesture,
    getBinding,
    updateBinding,
    getHoldProgress,
    lastTriggeredAction,
    bindings: customBindings,
    isOnCooldown,
  };
}

// Preset binding configurations
export const GESTURE_PRESETS = {
  // Minimal - just the essentials
  minimal: [
    { gesture: 'wave', action: 'speak_response', voiceResponse: "Hello!" },
    { gesture: 'thumbs_up', action: 'confirm' },
    { gesture: 'shush', action: 'interrupt_speech' },
  ] as GestureBinding[],

  // Media focused
  media: [
    { gesture: 'peace', action: 'play_pause', holdDuration: 300 },
    { gesture: 'swipe_right', action: 'next_track' },
    { gesture: 'swipe_left', action: 'prev_track' },
    { gesture: 'swipe_up', action: 'volume_up' },
    { gesture: 'swipe_down', action: 'volume_down' },
    { gesture: 'fist', action: 'mute_toggle', holdDuration: 500 },
    { gesture: 'shush', action: 'interrupt_speech' },
  ] as GestureBinding[],

  // Presentation mode
  presentation: [
    { gesture: 'open_palm', action: 'speak_response', voiceResponse: "Ready for your presentation.", holdDuration: 500 },
    { gesture: 'point', action: 'take_screenshot', holdDuration: 800 },
    { gesture: 'swipe_right', action: 'custom', customHandler: () => console.log('Next slide') },
    { gesture: 'swipe_left', action: 'custom', customHandler: () => console.log('Prev slide') },
    { gesture: 'thumbs_up', action: 'confirm' },
    { gesture: 'shush', action: 'interrupt_speech' },
  ] as GestureBinding[],

  // Accessibility focused
  accessibility: [
    { gesture: 'open_palm', action: 'start_listening', holdDuration: 300, voiceResponse: "I'm listening" },
    { gesture: 'fist', action: 'stop_listening', holdDuration: 300 },
    { gesture: 'thumbs_up', action: 'confirm', voiceResponse: "Confirmed" },
    { gesture: 'thumbs_down', action: 'cancel', voiceResponse: "Cancelled" },
    { gesture: 'wave', action: 'speak_response', voiceResponse: "Hello! Use an open palm to speak, thumbs up to confirm, thumbs down to cancel." },
    { gesture: 'shush', action: 'interrupt_speech' },
    { gesture: 'swipe_up', action: 'scroll_up' },
    { gesture: 'swipe_down', action: 'scroll_down' },
  ] as GestureBinding[],
};
