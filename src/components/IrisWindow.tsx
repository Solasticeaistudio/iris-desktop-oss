import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn, sleep } from '../lib/utils';
import { useIrisState, type IrisState } from '../hooks/useIrisState';
import { useSolstice } from '../hooks/useSolstice';
import { useVoice } from '../hooks/useVoice';
import { useNativeAudio, type NativeAudioDevice } from '../hooks/useNativeAudio';
import { useWebcam } from '../hooks/useWebcam';
import { useSystemMonitor, type IrisSpeakEvent } from '../hooks/useSystemMonitor';
import { usePresence, useGestureResponses, type Gesture } from '../hooks/usePresence';
import { useGestureActions, type GestureType } from '../hooks/useGestureActions';
// CodeCanvas moved to separate window
import { FloatingMessageStack } from './FloatingMessageStack';
import { IrisParticles, type IrisParticlesRef } from './IrisParticles';
import { toolRegistry, setAuditContext, clearAuditContext, executeSensitiveTool, executeControlTool } from '../lib/toolRegistry';
import { ToolBuilderPanel } from './ToolBuilderPanel';
import { VoiceSettingsPanel } from './VoiceSettingsPanel';
import { ReasoningSettingsPanel } from './ReasoningSettingsPanel';
import type { ProviderToolCall } from '../lib/modelProvider';
import {
  isDeterministicMockToolCommand,
  isNonSpeechTranscript,
  parseScreenCaptureRequest,
  parseSpeakRequest,
} from '../lib/interactionRouting';
import {
  DEFAULT_VOICE_SETTINGS,
  getVoiceStatus,
  isVoiceInputReady,
  shouldSpeakVoiceReplies,
  transcribeVoice,
  type VoiceStatus,
} from '../lib/voice';

interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
}

// Evaluate the small arithmetic language used by the local calculator intent.
// Model/user text must never be passed to JavaScript eval or a shell.
function evaluateArithmeticExpression(input: string): number {
  if (input.length > 100 || !/^[0-9+\-*/().^\s]+$/.test(input)) {
    throw new Error('Unsupported arithmetic expression');
  }
  let index = 0;
  const skip = () => { while (/\s/.test(input[index] || '')) index += 1; };
  const primary = (): number => {
    skip();
    if (input[index] === '(') {
      index += 1;
      const value = expression();
      skip();
      if (input[index++] !== ')') throw new Error('Unbalanced parentheses');
      return value;
    }
    const match = input.slice(index).match(/^\d+(?:\.\d+)?/);
    if (!match) throw new Error('Expected a number');
    index += match[0].length;
    return Number(match[0]);
  };
  const power = (): number => {
    skip();
    if (input[index] === '+' || input[index] === '-') {
      const sign = input[index++] === '-' ? -1 : 1;
      return sign * power();
    }
    const left = primary();
    skip();
    if (input[index] === '^') {
      index += 1;
      return Math.pow(left, power());
    }
    return left;
  };
  const term = (): number => {
    let value = power();
    while (true) {
      skip();
      const operator = input[index];
      if (operator !== '*' && operator !== '/') break;
      index += 1;
      const right = power();
      if (operator === '/' && right === 0) throw new Error('Division by zero');
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  };
  function expression(): number {
    let value = term();
    while (true) {
      skip();
      const operator = input[index];
      if (operator !== '+' && operator !== '-') break;
      index += 1;
      const right = term();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }
  const result = expression();
  skip();
  if (index !== input.length || !Number.isFinite(result)) throw new Error('Invalid arithmetic expression');
  return result;
}

export function IrisWindow() {
  const {
    state,
    messages,
    screenshot,
    setState,
    addMessage,
    clearMessages,
    setScreenshot,
    setConnected,
    isExec,
    setExec,
  } = useIrisState();

  const [showSettings, setShowSettings] = useState(false);
  const [spearMode, setSpearMode] = useState(false); // Provider speed preference retained for UI compatibility
  const [showToolBuilder, setShowToolBuilder] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [irisAudioLevel, setIrisAudioLevel] = useState(0);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceLastError, setVoiceLastError] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>({
    settings: DEFAULT_VOICE_SETTINGS,
    openai: { configured: false, source: 'none' },
    elevenlabs: { configured: false, source: 'none' },
    secureStorageAvailable: false,
  });
  const [_isIrisSpeakingState, setIsIrisSpeakingState] = useState(false); // State version for disabling mic
  const [nativeDevices, setNativeDevices] = useState<NativeAudioDevice[]>([]);
  const [selectedNativeDevice, setSelectedNativeDevice] = useState<string>('');
  const [_webcamEnabled, _setWebcamEnabled] = useState(false);
  const appWindow = getCurrentWindow();

  useEffect(() => {
    getVoiceStatus()
      .then(setVoiceStatus)
      .catch((error) => setVoiceLastError(String(error)));
  }, []);

  // Initialize webcam for vision capabilities
  const webcam = useWebcam({
    width: 1280,
    height: 720,
    autoStart: false, // Only start when needed
  });
  // The hook returns this stable callback alongside an internal ref; this access
  // does not read ref.current during render.
  // eslint-disable-next-line react-hooks/refs
  const setWebcamVideoElement = webcam.setVideoElement;

  // Presence detection state - manual toggle (MediaPipe is heavy, don't auto-start)
  const [presenceEnabled, setPresenceEnabled] = useState(false);
  const [cameraPreviewOnly, setCameraPreviewOnly] = useState(false); // Lightweight cam preview without MediaPipe
  const visionCaptureActive = false; // Reserved for future vision capture UI
  const presenceVideoRef = useRef<HTMLVideoElement | null>(null);
  const [presenceVideoElement, setPresenceVideoElement] = useState<HTMLVideoElement | null>(null);
  const attachPresenceVideo = useCallback((element: HTMLVideoElement | null) => {
    presenceVideoRef.current = element;
    setPresenceVideoElement(element);
  }, []);

  // Draggable camera preview position (right: distance from right edge, bottom: distance from bottom)
  const [cameraPosition, setCameraPosition] = useState({ right: 95, bottom: 230 }); // Default: above Iris orb
  const [cameraSize, setCameraSize] = useState({ width: 200, height: 150 }); // Default size, resizable
  const [_isDraggingCamera, setIsDraggingCamera] = useState(false);
  const cameraDragStartRef = useRef({ mouseX: 0, mouseY: 0, startRight: 0, startBottom: 0 });
  // Note: useGestureResponses still available for legacy voice-only responses
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { getResponse: _getGestureResponse } = useGestureResponses();
  const lastPresenceRef = useRef<boolean>(false);
  const presenceGreetedRef = useRef<boolean>(false);

  // Gesture action feedback state
  const [gestureActionFeedback, setGestureActionFeedback] = useState<{
    gesture: GestureType;
    action: string;
  } | null>(null);

  // Gesture-to-Action binding system (Phase 4+: Robust Gesture Control)
  const gestureActions = useGestureActions({
    enabled: presenceEnabled,
    handlers: {
      onSpeak: (text) => {
        if (speakRef.current) {
          speakRef.current(text);
        }
      },
      onMuteToggle: () => {
        setVoiceEnabled(prev => !prev);
        console.log('[IRIS] Gesture: Mic toggled');
      },
      onInterruptSpeech: () => {
        if (voice) {
          voice.interruptSpeech();
        }
        console.log('[IRIS] Gesture: Speech interrupted');
      },
      onTakeScreenshot: async () => {
        try {
          const screenshotData = await invoke<ScreenshotResult>('capture_screen_by_index', { index: 0 });
          if (screenshotData.base64) {
            setScreenshot(screenshotData.base64);
            console.log('[IRIS] Gesture: Screenshot taken');
          }
        } catch (e) {
          console.error('[IRIS] Gesture screenshot failed:', e);
        }
      },
      onConfirm: () => {
        console.log('[IRIS] Gesture: Confirm action');
        // TODO: Wire to current pending action if any
      },
      onCancel: () => {
        console.log('[IRIS] Gesture: Cancel action');
        // TODO: Wire to current pending action if any
      },
      onVolumeUp: () => {
        console.log('[IRIS] Gesture: Volume up');
        // Tauri invoke is handled in useGestureActions
      },
      onVolumeDown: () => {
        console.log('[IRIS] Gesture: Volume down');
        // Tauri invoke is handled in useGestureActions
      },
      onPlayPause: () => {
        console.log('[IRIS] Gesture: Play/Pause');
        // Tauri invoke is handled in useGestureActions
      },
      onNextTrack: () => {
        console.log('[IRIS] Gesture: Next track');
        // Tauri invoke is handled in useGestureActions
      },
      onPrevTrack: () => {
        console.log('[IRIS] Gesture: Previous track');
        // Tauri invoke is handled in useGestureActions
      },
      onOpenSettings: () => {
        setShowSettings(true);
        console.log('[IRIS] Gesture: Opening settings');
      },
      onCloseSettings: () => {
        setShowSettings(false);
        console.log('[IRIS] Gesture: Closing settings');
      },
      onStartListening: () => {
        setVoiceEnabled(true);
        console.log('[IRIS] Gesture: Started listening');
      },
      onStopListening: () => {
        setVoiceEnabled(false);
        console.log('[IRIS] Gesture: Stopped listening');
      },
      onClearChat: () => {
        clearMessages();
        console.log('[IRIS] Gesture: Chat cleared');
      },
      onVisualFeedback: (gesture, action) => {
        setGestureActionFeedback({ gesture, action });
        // Auto-clear feedback after 2 seconds
        setTimeout(() => setGestureActionFeedback(null), 2000);
      },
    },
  });

  // Presence detection (Phase 4: Real Eyes)
  const presence = usePresence({
    enabled: presenceEnabled,
    videoElement: presenceVideoElement,
    onPresenceChange: async (isPresent) => {
      console.log('[IRIS] Presence changed:', isPresent);

      // Greet when user first appears (once per session)
      if (isPresent && !lastPresenceRef.current && !presenceGreetedRef.current) {
        presenceGreetedRef.current = true;
        if (speakRef.current) {
          await speakRef.current("I see you're here. Let me know if you need anything.");
        }
      }

      // Note when user leaves (after being present for a while)
      if (!isPresent && lastPresenceRef.current && presence.presenceDuration > 5000) {
        // User was present for more than 5 seconds then left
        console.log('[IRIS] User left after', presence.presenceDuration, 'ms');
      }

      lastPresenceRef.current = isPresent;
    },
    onGesture: (gesture: Gesture) => {
      console.log('[IRIS] Gesture detected:', gesture);
      // Process through the action binding system
      gestureActions.processGesture(gesture as GestureType);
    },
    onHandMove: (_position, velocity) => {
      // Hand movement tracking for advanced features
      // Could be used for cursor control, pointer effects, etc.
      if (Math.abs(velocity.x) > 0.5 || Math.abs(velocity.y) > 0.5) {
        console.log('[IRIS] Fast hand movement:', velocity);
      }
    },
    onAttention: (isLooking) => {
      console.log('[IRIS] User attention:', isLooking ? 'looking at screen' : 'looking away');
    },
  });

  // Check for vision intent (webcam-based "what do you see" queries)
  const checkVisionIntent = (text: string): boolean => {
    const lower = text.toLowerCase();

    // Exclude screen-related queries (those use screen capture, not webcam)
    const isScreenQuery = /(screen|monitor|display|page|window|desktop)/.test(lower);
    if (isScreenQuery) return false;

    // Vision trigger phrases for webcam
    const visionPatterns = [
      /what (do you |can you )?see/,           // "what do you see", "what can you see"
      /what('s| is) (this|that)/,              // "what's this", "what is that"
      /look at (this|that|me)/,                // "look at this", "look at me"
      /look through/,                          // "look through my webcam"
      /see through/,                           // "see through my camera"
      /can you see/,                           // "can you see..."
      /what am i (holding|showing|wearing)/,   // "what am I holding"
      /what i'?m (holding|showing|wearing)/,   // "what I'm holding" (contraction)
      /what.*(holding|showing)/,               // "tell me what i'm holding"
      /describe (this|that|what)/,             // "describe this"
      /identify (this|that)/,                  // "identify this"
      /take a (look|picture|photo)/,           // "take a look"
      /use (your |the |my )?(camera|webcam)/,  // "use your camera", "use my webcam"
      /(access|activate|turn on).*(camera|webcam)/, // "access my webcam"
      /show you/,                              // "let me show you"
      /through.*(camera|webcam)/,              // "through my webcam"
    ];

    return visionPatterns.some(pattern => pattern.test(lower));
  };

  // Check for clipboard intent - returns action type or null
  const checkClipboardIntent = (text: string): 'read' | 'copy' | null => {
    const lower = text.toLowerCase();

    // Read clipboard patterns
    const readPatterns = [
      /what('s| is| did i).*cop(y|ied)/,        // "what did I copy", "what's copied"
      /what('s| is) (in |on )?(my |the )?clipboard/,  // "what's in my clipboard"
      /read (my |the )?clipboard/,              // "read my clipboard"
      /show (me )?(my |the )?clipboard/,        // "show me my clipboard"
      /clipboard (content|contents)/,           // "clipboard contents"
      /paste.*what/,                            // "paste what I copied"
      /what('s| is) that i copied/,             // "what's that I copied"
    ];

    if (readPatterns.some(p => p.test(lower))) return 'read';

    // Copy to clipboard patterns (for future - copy Iris's response)
    const copyPatterns = [
      /copy (that|this|it)( to clipboard)?/,   // "copy that"
      /save (that|this|it) to clipboard/,      // "save that to clipboard"
    ];

    if (copyPatterns.some(p => p.test(lower))) return 'copy';

    return null;
  };

  // Check for benchmark intent - returns benchmark type or null
  const checkBenchmarkIntent = (text: string): { benchmark: string; demo: boolean } | null => {
    const lower = text.toLowerCase();

    // Must have benchmark-related keywords
    const benchmarkPatterns = [
      /(?:run|do|start|execute|launch)\s+(?:a\s+)?(?:the\s+)?(\w+)\s*(?:benchmark|eval|evaluation)/i,
      /(?:run|do|start|execute|launch)\s+(?:a\s+)?(?:the\s+)?benchmark(?:\s+(?:on\s+)?(\w+))?/i,
      /(\w+)\s*benchmark\s*(?:run|test)?/i,
      /benchmark\s+(?:the\s+)?(\w+)/i,
    ];

    for (const pattern of benchmarkPatterns) {
      const match = lower.match(pattern);
      if (match) {
        // Extract benchmark name
        let benchmarkName = (match[1] || 'truthfulqa').toLowerCase();

        // Map spoken names to actual benchmark names
        const benchmarkAliases: Record<string, string> = {
          'truthful': 'truthfulqa',
          'truthfulqa': 'truthfulqa',
          'truthful qa': 'truthfulqa',
          'truth': 'truthfulqa',
          'mmlu': 'mmlu',
          'knowledge': 'mmlu',
          'gsm': 'gsm8k',
          'gsm8k': 'gsm8k',
          'math': 'gsm8k',
          'humaneval': 'humaneval',
          'human eval': 'humaneval',
          'coding': 'humaneval',
          'code': 'humaneval',
          'all': 'all',
          'full': 'all',
          'everything': 'all',
        };

        benchmarkName = benchmarkAliases[benchmarkName] || benchmarkName;

        // Check for demo mode
        const isDemo = /demo|quick|fast|show/.test(lower);

        return { benchmark: benchmarkName, demo: isDemo };
      }
    }

    // Direct matches without the pattern
    if (/benchmark/.test(lower) && /(run|do|start|execute|launch)/.test(lower)) {
      return { benchmark: 'truthfulqa', demo: /demo|quick/.test(lower) };
    }

    return null;
  };

  // Check for volume control intent - returns action or null
  const checkVolumeIntent = (text: string): { action: 'set' | 'adjust'; value?: number; direction?: string } | null => {
    const lower = text.toLowerCase();

    // Set volume to specific level
    const setMatch = lower.match(/(?:set|change|make|put) (?:the )?volume (?:to |at )?(\d+)/);
    if (setMatch) {
      return { action: 'set', value: parseInt(setMatch[1]) };
    }

    // Adjust volume
    const upPatterns = /(?:turn|volume|crank|pump) (?:up|it up)|louder|raise (?:the )?volume|increase (?:the )?volume/;
    const downPatterns = /(?:turn|volume) (?:down|it down)|quieter|lower (?:the )?volume|decrease (?:the )?volume/;
    const mutePatterns = /mute|silence|quiet|shut up|hush/;

    if (upPatterns.test(lower)) return { action: 'adjust', direction: 'up' };
    if (downPatterns.test(lower)) return { action: 'adjust', direction: 'down' };
    if (mutePatterns.test(lower)) return { action: 'adjust', direction: 'mute' };

    return null;
  };

  // Check for media control intent - returns action or null
  const checkMediaIntent = (text: string): string | null => {
    const lower = text.toLowerCase();

    if (/(?:play|pause|resume|toggle)(?! .*(?:video|game|movie))/.test(lower) &&
      !/(play.*sound|play.*music|play.*song)/.test(lower)) {
      // Just "play" or "pause" without specifying what
      if (/\b(pause|stop playing)\b/.test(lower)) return 'pause';
      if (/\bresume\b/.test(lower)) return 'play';
      if (/\b(play|pause)\b/.test(lower) && lower.split(' ').length <= 3) return 'play_pause';
    }

    if (/\b(next|skip)\b.*(?:song|track|music)?/.test(lower)) return 'next';
    if (/\b(previous|prev|last|go back)\b.*(?:song|track|music)?/.test(lower)) return 'previous';
    if (/\b(stop)\b.*(?:music|playing)?/.test(lower)) return 'stop';

    return null;
  };

  // Check for system stats intent
  const checkSystemStatsIntent = (text: string): boolean => {
    const lower = text.toLowerCase();
    const patterns = [
      /(?:how much|what('s| is)) (?:my |the )?(?:cpu|processor|ram|memory|battery)/,
      /(?:system|computer) (?:stats|status|info|information)/,
      /(?:cpu|processor|ram|memory|battery) (?:usage|level|percent|status)/,
      /how('s| is) my (?:computer|system|battery) doing/,
    ];
    return patterns.some(p => p.test(lower));
  };

  // Check for lock/sleep intent
  const checkLockSleepIntent = (text: string): 'lock' | 'sleep' | null => {
    const lower = text.toLowerCase();

    if (/lock (?:the |my )?(?:computer|pc|screen|workstation)/.test(lower)) return 'lock';
    if (/(?:put|make) (?:the |my )?(?:computer|pc) to sleep/.test(lower)) return 'sleep';
    if (/sleep (?:mode|the computer)/.test(lower)) return 'sleep';
    if (/go to sleep/.test(lower) && /computer|pc/.test(lower)) return 'sleep';

    return null;
  };

  // Check for URL intent - returns URL or null
  const checkUrlIntent = (text: string): string | null => {
    const lower = text.toLowerCase();

    // "go to [url]", "open [url]", "navigate to [url]"
    const urlMatch = lower.match(/(?:go to|open|navigate to|visit|browse to)\s+([\w.-]+\.(?:com|org|net|io|dev|ai|co|edu|gov|app|xyz)(?:\/\S*)?)/i);
    if (urlMatch) {
      return urlMatch[1];
    }

    return null;
  };

  // Check for close application intent - returns app name or null
  const checkCloseAppIntent = (text: string): string | null => {
    const lower = text.toLowerCase();

    const closeMatch = lower.match(/(?:close|kill|quit|exit|terminate|stop)\s+(.+?)(?:\s+(?:for me|please|now))?$/);
    if (!closeMatch) return null;

    const appName = closeMatch[1].trim()
      .replace(/[?!.,;:]+$/g, '')
      .replace(/^(the|my|a)\s+/i, '')
      .replace(/\s+(app|application|program|window)$/i, '')
      .trim();

    // Don't close if it's a generic word
    if (['it', 'that', 'this', 'everything', 'all'].includes(appName)) return null;

    return appName;
  };

  // Check for show desktop / minimize all intent
  const checkDesktopIntent = (text: string): boolean => {
    const lower = text.toLowerCase();
    const patterns = [
      /show (?:me )?(?:the )?desktop/,
      /minimize (?:all|everything|all windows)/,
      /hide (?:all )?windows/,
      /clear (?:the )?(?:screen|desktop)/,
    ];
    return patterns.some(p => p.test(lower));
  };

  // Check for time/date intent
  const checkTimeIntent = (text: string): 'time' | 'date' | 'both' | null => {
    const lower = text.toLowerCase();

    const hasTime = /what(?:'s| is) the time|what time is it|current time|tell me the time/.test(lower);
    const hasDate = /what(?:'s| is) (?:the |today(?:'s)? )?date|what day is it|today(?:'s)? date/.test(lower);

    if (hasTime && hasDate) return 'both';
    if (hasTime) return 'time';
    if (hasDate) return 'date';

    return null;
  };

  // Check for screenshot save intent
  const checkScreenshotSaveIntent = (text: string): boolean => {
    const lower = text.toLowerCase();
    const patterns = [
      /(?:take|save|capture) (?:a )?screenshot/,
      /screenshot (?:this|the screen)/,
      /snap (?:a )?(?:picture|photo) of (?:the )?screen/,
    ];
    return patterns.some(p => p.test(lower));
  };

  // Check for timer intent - returns seconds or null
  const checkTimerIntent = (text: string): { seconds: number; label?: string } | null => {
    const lower = text.toLowerCase();

    // "set a timer for X minutes/seconds/hours" (with optional "can you", "could you", "please")
    const timerMatch = lower.match(/(?:can you |could you |please )?(?:set|start|create) (?:a |an? )?(?:timer|alarm|reminder) (?:for )?(\d+)\s*(second|sec|minute|min|hour|hr)s?/);
    if (timerMatch) {
      const value = parseInt(timerMatch[1]);
      const unit = timerMatch[2];
      let seconds = value;
      if (unit.startsWith('min')) seconds = value * 60;
      else if (unit.startsWith('hour') || unit === 'hr') seconds = value * 3600;
      return { seconds };
    }

    // "timer 5 minutes"
    const shortMatch = lower.match(/timer (\d+)\s*(second|sec|minute|min|hour|hr)s?/);
    if (shortMatch) {
      const value = parseInt(shortMatch[1]);
      const unit = shortMatch[2];
      let seconds = value;
      if (unit.startsWith('min')) seconds = value * 60;
      else if (unit.startsWith('hour') || unit === 'hr') seconds = value * 3600;
      return { seconds };
    }

    // "remind me in X minutes"
    const remindMatch = lower.match(/remind me in (\d+)\s*(second|sec|minute|min|hour|hr)s?/);
    if (remindMatch) {
      const value = parseInt(remindMatch[1]);
      const unit = remindMatch[2];
      let seconds = value;
      if (unit.startsWith('min')) seconds = value * 60;
      else if (unit.startsWith('hour') || unit === 'hr') seconds = value * 3600;
      return { seconds };
    }

    return null;
  };

  // Check for brightness intent
  const checkBrightnessIntent = (text: string): { action: 'set' | 'adjust'; value?: number; direction?: string } | null => {
    const lower = text.toLowerCase();

    // Set brightness to specific level
    const setMatch = lower.match(/(?:set|change|make|put) (?:the )?(?:brightness|screen) (?:to |at )?(\d+)/);
    if (setMatch) {
      return { action: 'set', value: parseInt(setMatch[1]) };
    }

    // Adjust brightness
    const upPatterns = /(?:turn|brightness|crank) (?:up|it up)|brighter|(?:increase|raise) (?:the )?brightness/;
    const downPatterns = /(?:turn|brightness) (?:down|it down)|dimmer|dim (?:the )?(?:screen|brightness)|(?:decrease|lower) (?:the )?brightness/;

    if (upPatterns.test(lower)) return { action: 'adjust', direction: 'up' };
    if (downPatterns.test(lower)) return { action: 'adjust', direction: 'down' };

    return null;
  };

  // Check for WiFi intent
  const checkWifiIntent = (text: string): 'enable' | 'disable' | 'toggle' | null => {
    const lower = text.toLowerCase();

    if (/(?:turn|switch|enable) (?:on )?(?:the )?wi-?fi|wi-?fi on|connect (?:to )?(?:the )?(?:wi-?fi|internet)/.test(lower)) return 'enable';
    if (/(?:turn|switch|disable) (?:off )?(?:the )?wi-?fi|wi-?fi off|disconnect (?:from )?(?:the )?(?:wi-?fi|internet)/.test(lower)) return 'disable';
    if (/toggle (?:the )?wi-?fi/.test(lower)) return 'toggle';

    return null;
  };

  // Check for notes intent - returns note content or null
  const checkNotesIntent = (text: string): string | null => {
    // "save a note: ..." or "note: ..." or "remember ..."
    const notePatterns = [
      /(?:save|make|take|create) (?:a )?note[:\s]+(.+)/i,
      /(?:note|memo)[:\s]+(.+)/i,
      /remember[:\s]+(.+)/i,
      /(?:write|jot) (?:down|this)[:\s]+(.+)/i,
    ];

    for (const pattern of notePatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return null;
  };

  // Check for calculator intent - returns expression or null
  const checkCalculatorIntent = (text: string): string | null => {
    const lower = text.toLowerCase();

    // "what's X plus Y", "calculate X times Y", etc.
    const calcPatterns = [
      /(?:what(?:'s| is)|calculate|compute|solve)\s+(.+)/i,
      /how much is\s+(.+)/i,
      /(\d+[\s]*[+\-*/x×÷%^][\s]*\d+(?:[\s]*[+\-*/x×÷%^][\s]*\d+)*)/i,
    ];

    for (const pattern of calcPatterns) {
      const match = lower.match(pattern);
      if (match && match[1]) {
        const expr = match[1].trim()
          .replace(/plus|and/g, '+')
          .replace(/minus|subtract/g, '-')
          .replace(/times|multiplied by|x|×/g, '*')
          .replace(/divided by|over|÷/g, '/')
          .replace(/percent of/g, '*0.01*')
          .replace(/percent|%/g, '*0.01')
          .replace(/squared/g, '**2')
          .replace(/cubed/g, '**3')
          .replace(/to the power of/g, '**')
          .replace(/[^\d+\-*/().^*\s]/g, '') // Remove non-math characters
          .trim();

        // Validate it looks like a math expression
        if (/^\d/.test(expr) && /[\d]$/.test(expr) && /[+\-*/^]/.test(expr)) {
          return expr;
        }
      }
    }

    return null;
  };

  // Check for dictation mode intent
  const checkDictationIntent = (text: string): 'start' | 'stop' | null => {
    const lower = text.toLowerCase();

    if (/(?:start|begin|enable) (?:dictation|dictating|typing|transcription)/.test(lower)) return 'start';
    if (/(?:stop|end|disable|finish) (?:dictation|dictating|typing|transcription)/.test(lower)) return 'stop';
    if (/type what i say|write what i say/.test(lower)) return 'start';

    return null;
  };

  // Dictation mode state
  const [isDictating, setIsDictating] = useState(false);

  // ==================== NEW IRIS HUBS & FEATURES INTENTS ====================

  // Check for hub intent - "pull up the baby monitor", "show me security cameras"
  const checkHubIntent = (text: string): string | null => {
    const lower = text.toLowerCase();

    // Hub trigger patterns
    const hubPatterns = [
      { pattern: /(?:pull up|open|show me|bring up|display).*(baby monitor|nursery|baby cam)/, hub: 'baby-monitor' },
      { pattern: /(?:pull up|open|show me|bring up|display).*(security|cameras|surveillance)/, hub: 'security' },
      { pattern: /(?:pull up|open|show me|bring up|display).*(system|resources|cpu|memory).*(?:hub|monitor|dashboard)?/, hub: 'system' },
      { pattern: /(?:pull up|open|show me|bring up|display).*(calendar|schedule|agenda).*(?:hub)?/, hub: 'calendar' },
      { pattern: /(?:pull up|open|show me|bring up|display).*(music|player|now playing).*(?:hub)?/, hub: 'music' },
      // Direct hub names
      { pattern: /(?:open|show|pull up)\s+(?:the\s+)?(\w+)\s+hub/, hub: '$1' },
    ];

    for (const { pattern, hub } of hubPatterns) {
      const match = lower.match(pattern);
      if (match) {
        // Handle dynamic hub name from capture group
        if (hub === '$1' && match[1]) {
          return match[1].toLowerCase();
        }
        return hub;
      }
    }

    return null;
  };

  // Check for workspace intent - "save workspace", "load workspace dev"
  const checkWorkspaceIntent = (text: string): { action: 'save' | 'load' | 'list' | 'delete'; name?: string } | null => {
    const lower = text.toLowerCase();

    // Save workspace
    const saveMatch = lower.match(/save (?:this |current )?workspace(?: as)? ["']?([a-z0-9_ -]+)["']?/);
    if (saveMatch) {
      return { action: 'save', name: saveMatch[1].trim() };
    }
    if (/save (?:this |the |my )?workspace/.test(lower)) {
      // No name provided - will use default
      return { action: 'save' };
    }

    // Load workspace
    const loadMatch = lower.match(/(?:load|restore|open) (?:the )?["']?([a-z0-9_ -]+)["']? workspace/);
    if (loadMatch) {
      return { action: 'load', name: loadMatch[1].trim() };
    }
    const loadMatch2 = lower.match(/(?:load|restore|open) workspace ["']?([a-z0-9_ -]+)["']?/);
    if (loadMatch2) {
      return { action: 'load', name: loadMatch2[1].trim() };
    }

    // List workspaces
    if (/(?:list|show|what) (?:my |the )?workspaces|what workspaces (?:do i |are there)/.test(lower)) {
      return { action: 'list' };
    }

    // Delete workspace
    const deleteMatch = lower.match(/(?:delete|remove) (?:the )?["']?([a-z0-9_ -]+)["']? workspace/);
    if (deleteMatch) {
      return { action: 'delete', name: deleteMatch[1].trim() };
    }

    return null;
  };

  // Check for layout/war room intent - "focus mode", "coding layout", "war room"
  const checkLayoutIntent = (text: string): { action: 'save' | 'load' | 'list'; name?: string } | null => {
    const lower = text.toLowerCase();

    // Preset layout aliases
    const presetLayouts: Record<string, string> = {
      'focus mode': 'focus',
      'focus': 'focus',
      'coding layout': 'coding',
      'coding mode': 'coding',
      'dev mode': 'coding',
      'war room': 'war-room',
      'warroom': 'war-room',
      'battle stations': 'war-room',
      'presentation mode': 'presentation',
      'gaming mode': 'gaming',
      'gaming layout': 'gaming',
    };

    // Check for preset layouts
    for (const [trigger, layoutName] of Object.entries(presetLayouts)) {
      if (lower.includes(trigger)) {
        return { action: 'load', name: layoutName };
      }
    }

    // Save layout
    const saveMatch = lower.match(/save (?:this |current )?layout(?: as)? ["']?([a-z0-9_ -]+)["']?/);
    if (saveMatch) {
      return { action: 'save', name: saveMatch[1].trim() };
    }
    if (/save (?:this |the )?layout/.test(lower)) {
      return { action: 'save' };
    }

    // Load layout
    const loadMatch = lower.match(/(?:load|apply|use) (?:the )?["']?([a-z0-9_ -]+)["']? layout/);
    if (loadMatch) {
      return { action: 'load', name: loadMatch[1].trim() };
    }

    // List layouts
    if (/(?:list|show|what) (?:my |the )?layouts|what layouts (?:do i |are there)/.test(lower)) {
      return { action: 'list' };
    }

    return null;
  };

  // Check for macro/gauntlet intent - "deploy", "ship it", "end of day"
  const checkMacroIntent = (text: string): string | null => {
    const lower = text.toLowerCase().trim().replace(/[?.!,]$/, '');

    // Common macro triggers (these would match user-defined macros)
    const commonTriggers = [
      'deploy', 'ship it', 'send it', 'push it',
      'end of day', 'end day', 'clock out', 'eod',
      'morning routine', 'good morning', 'wake up',
      'meeting mode', 'focus time', 'deep work',
      'break time', 'take a break',
      'demo mode', 'show mode',
      'execute the hedge', 'settle the thought process',
      'aestrea demo',
    ];

    for (const trigger of commonTriggers) {
      // More robust check: exact match, starts with, or contains the phrase
      const regex = new RegExp(`\\b${trigger}\\b`, 'i');
      if (regex.test(lower)) {
        return trigger;
      }
    }

    // Check for "run macro X" pattern
    const runMatch = lower.match(/(?:run|execute|trigger|fire) (?:the )?(?:macro )?["']?([a-z0-9_ -]+)["']?/);
    if (runMatch) {
      return runMatch[1].trim();
    }

    return null;
  };

  // Check for annotation intent - "circle that", "highlight this", "point there"
  const checkAnnotationIntent = (text: string): { type: string; target?: string } | null => {
    const lower = text.toLowerCase();

    // Circle
    if (/circle (?:that|this|it|the|there)/.test(lower)) {
      return { type: 'circle', target: 'cursor' };
    }

    // Arrow
    if (/(?:draw (?:an? )?)?arrow (?:to|from|here|there)/.test(lower)) {
      return { type: 'arrow', target: 'cursor' };
    }

    // Highlight
    if (/highlight (?:that|this|it|the|there|here)/.test(lower)) {
      return { type: 'highlight', target: 'cursor' };
    }

    // Point
    if (/(?:point|show me) (?:at|to|there|here)/.test(lower)) {
      return { type: 'pointer', target: 'cursor' };
    }

    // Clear annotations
    if (/(?:clear|remove|hide) (?:the )?(?:annotations?|drawings?|highlights?|circles?|arrows?)/.test(lower)) {
      return { type: 'clear' };
    }

    return null;
  };

  

  // Native model tool calls always enter the same registry/policy/audit path.
  const executeProviderTools = useCallback(async (calls: ProviderToolCall[], userCommand?: string): Promise<void> => {
    if (!calls.length) return;
    if (userCommand) {
      setAuditContext(userCommand, calls.map((call) => `${call.name}(${JSON.stringify(call.arguments)})`).join(', '), messages.slice(-6).map((message) => ({
        role: message.role,
        content: message.content || '',
        timestamp: new Date().toISOString(),
      })));
    }
    try {
      for (const call of calls) {
        const result = await toolRegistry.execute(call.name, call.arguments, {
          onWarning: (warning) => addMessage(warning, 'iris'),
        });
        if (!result.success) addMessage(`I couldn't complete ${call.name}: ${result.error || 'request rejected'}`, 'iris');
      }
    } finally {
      clearAuditContext();
    }
  }, [addMessage, messages]);

  // Model text is presentation-only. Actions are accepted exclusively through structured tool calls.
  const cleanResponseText = useCallback((text: string): string => text.trim(), []);

  

  // Active timers tracking
  const activeTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const timerIdCounter = useRef(0);

  // Track ghost mode state (click-through enabled)
  const [ghostMode, setGhostMode] = useState(false);

  // Handle visibility change - NO automatic click-through (caused lock-out issue)
  // Click-through is now controlled via voice command "ghost mode"
  const handleVisibilityChange = useCallback(async (_visible: boolean) => {
    // Just track visibility, don't toggle click-through automatically
    console.log(`[IRIS] Chat visibility: ${_visible}`);
  }, []);

  // Toggle ghost mode (click-through) - called by voice command
  const toggleGhostMode = useCallback(async (enable?: boolean) => {
    const newState = enable !== undefined ? enable : !ghostMode;
    try {
      await invoke('set_click_through', { ignore: newState });
      setGhostMode(newState);
      console.log(`[IRIS] Ghost mode: ${newState ? 'ON' : 'OFF'}`);
      return newState;
    } catch (e) {
      console.error('[IRIS] Failed to toggle ghost mode:', e);
      return ghostMode;
    }
  }, [ghostMode]);

  // Ensure window is visible and correct size on mount
  useEffect(() => {
    const initWindow = async () => {
      try {
        await appWindow.setSize(new LogicalSize(800, 600));
        await appWindow.center(); // FORCE CENTER to recover from off-screen
        console.log("Window centered and resized");
      } catch (e) {
        console.error("Window init error:", e);
      }
    };
    initWindow();
  }, [appWindow]);

  // Clean up any orphaned camera streams on mount
  useEffect(() => {
    const cleanupOrphanedStreams = async () => {
      try {
        // Get all media devices and stop any active tracks
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        console.log(`[IRIS] Found ${videoDevices.length} video devices, checking for orphaned streams...`);

        // Try to get and immediately release any active streams
        // This forces the camera to release if it was held by a previous session
        if (videoDevices.length > 0 && !presenceEnabled && !cameraPreviewOnly) {
          try {
            const testStream = await navigator.mediaDevices.getUserMedia({ video: true });
            testStream.getTracks().forEach(track => {
              track.stop();
              console.log(`[IRIS] Stopped orphaned track: ${track.label}`);
            });
          } catch (e) {
            // Camera might not be available, that's fine
            console.log('[IRIS] No orphaned camera stream to clean up');
          }
        }
      } catch (e) {
        console.warn('[IRIS] Camera cleanup check failed:', e);
      }
    };

    // Run cleanup after a short delay to let the app initialize
    const timer = setTimeout(cleanupOrphanedStreams, 1000);
    return () => clearTimeout(timer);
  }, []); // Only run once on mount

  // Initialize the local model-provider connection
  const solstice = useSolstice({
    onConnect: () => setConnected(true),
    onDisconnect: () => setConnected(false),
    onStateChange: (newState: IrisState) => setState(newState),
    onExec: (val) => setExec(val),
  });

  // Listen for macro narration/events from the Gauntlet.
  useEffect(() => {
    let unlistenSpeak: (() => void) | undefined;
    let unlistenStart: (() => void) | undefined;
    let unlistenComplete: (() => void) | undefined;

    const setup = async () => {
      unlistenSpeak = await listen<{ text: string }>('macro-speak', async (event) => {
        const text = event.payload?.text?.trim();
        if (!text) return;
        addMessage(text, 'iris');
        if (speakRef.current) {
          await speakRef.current(text);
        }
      });

      unlistenStart = await listen<{ name: string }>('macro-start', (event) => {
        const name = event.payload?.name;
        if (!name) return;
        console.log('[IRIS] Macro started:', name);
      });

      unlistenComplete = await listen<{ name: string; success: boolean }>('macro-complete', (event) => {
        console.log('[IRIS] Macro complete:', event.payload);
      });
    };

    setup().catch((error) => {
      console.error('[IRIS] Failed to register macro event listeners:', error);
    });

    return () => {
      unlistenSpeak?.();
      unlistenStart?.();
      unlistenComplete?.();
    };
  }, [addMessage]);

  // Wake words to listen for
  const wakeWords = voiceStatus.settings.wakeWords;
  const voiceInputReady = isVoiceInputReady(voiceStatus);
  const voiceRepliesEnabled = shouldSpeakVoiceReplies(voiceStatus.settings);

  // Ref to hold the speak function (defined after voice hook)
  const speakRef = useRef<(text: string) => Promise<void>>(async () => { });
  const handleSendMessageRef = useRef<((message: string) => Promise<void>) | null>(null);

  // Track last voice interaction for continuous conversation window
  const lastVoiceInteraction = useRef<number>(0);

  // Initialize voice system FIRST (for TTS)
  const voice = useVoice({
    wakeWords: [], // We handle wake words via native audio now
    onWakeWord: () => { },
    onTranscript: async () => { },
    onStateChange: () => { },
    onAudioLevel: () => { },
    onIrisAudioLevel: (level) => setIrisAudioLevel(level),
  });

  // Track if Iris is currently speaking to prevent echo loops
  const isIrisSpeaking = useRef(false);
  const isProcessingCommand = useRef(false); // Prevents overlapping voice command processing
  const lastSpokenText = useRef(''); // For specific echo cancellation
  const lastSpeechEndTime = useRef(0); // When IRIS finished speaking (for post-speech cooldown)
  const POST_SPEECH_COOLDOWN_MS = 2500; // Don't process audio for 2.5s after speech ends

  // Update speak ref when voice is ready - WRAPPER to track speaking state
  // nativeAudioRef allows us to stop capture synchronously before speaking
  const nativeAudioRef = useRef<{ stopCapture: () => Promise<void>; startCapture: (device?: string) => Promise<void> } | null>(null);

  // Particles ref for STL morphing
  const particlesRef = useRef<IrisParticlesRef>(null);

  useEffect(() => {
    speakRef.current = async (text: string) => {
      console.log('[IrisWindow] Iris engaging speech (BARGE-IN ENABLED - mic stays active)');
      isIrisSpeaking.current = true;
      setIsIrisSpeakingState(true); // Flag that IRIS is speaking (for barge-in detection)
      lastSpokenText.current = text; // Track what is being said for echo filtering

      // BARGE-IN: Keep mic capture ACTIVE during TTS
      // The barge-in logic in onAudioRecorded will detect user speech and interrupt
      // Echo cancellation (AEC + text comparison) filters out IRIS's own voice
      console.log('[IrisWindow] Mic staying active for barge-in detection');

      try {
        await voice.speak(text);
      } finally {
        // Record when speech ended for cooldown tracking
        lastSpeechEndTime.current = Date.now();
        console.log(`[IrisWindow] Iris speech complete, cooldown for ${POST_SPEECH_COOLDOWN_MS}ms`);

        // Keep isIrisSpeaking true during cooldown to help echo detection
        // Then clear after cooldown period
        setTimeout(async () => {
          isIrisSpeaking.current = false;
          setIsIrisSpeakingState(false);
          lastVoiceInteraction.current = Date.now();
          console.log('[IrisWindow] Post-speech cooldown complete, ready to listen');
        }, POST_SPEECH_COOLDOWN_MS);
      }
    };
  }, [voice.speak]);

  // System Monitor for proactive alerts (Phase 3: The Interrupter)
  // This monitors battery, CPU, memory and allows IRIS to proactively speak
  // DISABLED: Was spamming notifications - re-enable when throttling is fixed
  useSystemMonitor({
    enabled: false,
    thresholds: {
      battery_low: 20,
      battery_critical: 10,
      memory_high: 85,
      memory_critical: 95,
      cpu_high: 90,
      cpu_sustained_seconds: 30,
    },
    onAlert: (alert) => {
      console.log('[IRIS] System alert:', alert);
      // Show in desktop chat only - don't spam mobile with system alerts
      addMessage(`⚠️ ${alert.message}`, 'iris', false);
    },
    onSpeak: async (event: IrisSpeakEvent) => {
      // Proactive speech - IRIS initiates conversation
      console.log('[IRIS] Proactive speak:', event);
      if (speakRef.current) {
        await speakRef.current(event.text);
      }
    },
    onStatsUpdate: (stats) => {
      console.log('[IRIS] System stats:', stats);
      // Stats available for future UI display
    },
  });

  // Audio is transcribed by the Rust voice host. Provider destinations and
  // credentials never come from the renderer invocation.
  const transcribeAudio = useCallback(async (audioBase64: string): Promise<string | null> => {
    try {
      setState('thinking');
      const result = await transcribeVoice(audioBase64);
      setVoiceLastError(null);
      return result.text.trim() || null;
    } catch (error) {
      const message = String(error);
      console.error('[IRIS] Native transcription failed:', message);
      setVoiceLastError(message);
      setState('idle');
      return null;
    }
  }, [setState]);

  // Check for movement intent - returns position or null
  // Check for monitor/window control commands
  const checkMonitorIntent = (text: string): { action: string; target?: string } | null => {
    const lower = text.toLowerCase();

    // Ghost mode (click-through) - "go ghost", "ghost mode", "be transparent", "let me click through"
    if (/(ghost mode|go ghost|be transparent|click.?through|phase out|become invisible)/.test(lower) ||
      /(let me|allow).*(click|interact).*(through|behind)/.test(lower)) {
      return { action: 'ghost-on' };
    }

    // Exit ghost mode - "solid mode", "come back", "be solid", "stop ghost"
    if (/(solid mode|be solid|stop ghost|exit ghost|come back|be clickable|stop.?transparent)/.test(lower) ||
      /(can't|cannot|won't).*(click|interact)/.test(lower)) {
      return { action: 'ghost-off' };
    }

    // Turn off monitor(s) - Uses targeted SendMessage to desktop window (not HWND_BROADCAST)
    if (/(turn off|power off|shut off|black out).*(monitor|screen|display)/.test(lower) ||
      /(monitor|screen|display).*(off|dark|black)/.test(lower) ||
      /screens?.?off|displays?.?off|monitors?.?off/.test(lower)) {
      return { action: 'turn-off' };
    }

    // Move to specific numbered monitor: "jump to display 3", "go to monitor 2", "screen 1"
    const numberedMatch = lower.match(/(monitor|screen|display)\s*(\d+)|(jump|go|move|hop)\s*(to|over)?\s*(monitor|screen|display)?\s*(\d+)/);
    if (numberedMatch) {
      const num = numberedMatch[2] || numberedMatch[6];
      if (num) {
        return { action: 'switch', target: num };
      }
    }

    // Move to other/different monitor
    if (/(other|different|next|second|secondary).*(monitor|screen|display)/.test(lower) ||
      /(monitor|screen|display).*(other|switch|next|different)/.test(lower) ||
      /switch.*(monitor|screen|display)/.test(lower) ||
      /(move|go|jump|hop).*(to|over).*(other|next|second).*(monitor|screen|display)/.test(lower)) {
      return { action: 'switch', target: 'other' };
    }

    // Move to primary/main monitor
    if (/(primary|main|first).*(monitor|screen|display)/.test(lower) ||
      /(monitor|screen|display).*(primary|main|first)/.test(lower)) {
      return { action: 'switch', target: 'primary' };
    }

    // How many monitors?
    if (/(how many|count|number of).*(monitor|screen|display)/.test(lower) ||
      /monitors? connected/.test(lower)) {
      return { action: 'count' };
    }

    return null;
  };

  const checkMovementIntent = (text: string): string | null => {
    const lower = text.toLowerCase();

    // Must have a movement trigger word
    // Use word boundaries so ordinary prose like "handled" doesn't trigger "head".
    const hasMoveIntent = /\b(move|go to|scoot|slide|shift|get out|out of the way|come|step|head|position|relocate|nudge|a little|snap|half)\b/.test(lower);
    if (!hasMoveIntent) return null;

    // === SNAP TO HALF SCREEN ===
    if (/(snap.?left|left.?half|take the left|left side.*(half|snap))/.test(lower)) return 'snap-left';
    if (/(snap.?right|right.?half|take the right|right side.*(half|snap))/.test(lower)) return 'snap-right';

    // === CORNERS ===
    if (/top.?right|upper.?right/.test(lower)) return 'top-right';
    if (/top.?left|upper.?left/.test(lower)) return 'top-left';
    if (/bottom.?right|lower.?right/.test(lower)) return 'bottom-right';
    if (/bottom.?left|lower.?left/.test(lower)) return 'bottom-left';

    // === CENTER ===
    if (/\b(center|middle|centered)\b/.test(lower)) return 'center';

    // === EDGES (absolute positions) ===
    // Check for "left side" / "right side" etc. before checking simple directions
    if (/(left side|to the left$|on the left|far left)/.test(lower)) return 'left';
    if (/(right side|to the right$|on the right|far right)/.test(lower)) return 'right';
    if (/(top side|to the top$|at the top|up top)/.test(lower)) return 'top';
    if (/(bottom side|to the bottom$|at the bottom)/.test(lower)) return 'bottom';

    // === RELATIVE MOVEMENTS (nudge from current position) ===
    // "move up", "go up", "a little higher", "nudge up"
    if (/(move up|go up|higher|nudge up|scoot up|a little up|bit up)/.test(lower)) return 'up';
    if (/(move down|go down|lower|nudge down|scoot down|a little down|bit down)/.test(lower)) return 'down';
    if (/(move left|go left|nudge left|scoot left|a little left|bit left)/.test(lower) && !/bottom|top/.test(lower)) return 'move-left';
    if (/(move right|go right|nudge right|scoot right|a little right|bit right)/.test(lower) && !/bottom|top/.test(lower)) return 'move-right';

    // === DIAGONAL RELATIVE ===
    if (/(up and left|upper left direction)/.test(lower)) return 'up-left';
    if (/(up and right|upper right direction)/.test(lower)) return 'up-right';
    if (/(down and left|lower left direction)/.test(lower)) return 'down-left';
    if (/(down and right|lower right direction)/.test(lower)) return 'down-right';

    // === FUN ALIASES ===
    if (/(out of the way|in the way|away|move over|outta here|get away|step aside|blocking)/.test(lower)) return 'away';
    if (/(come back|go back|back home|home|return|back to center)/.test(lower)) return 'back';
    if (/(corner)/.test(lower)) return 'top-right'; // "go to a corner" defaults to top-right

    // Generic "move" without direction - default to away
    // Catches: "can you move", "please move", "move", "could you move", "you need to move", etc.
    if (/(can you move|could you move|please move|you move|just move|gotta move|\bmove\b.*\?$)/.test(lower)) return 'away';

    // If they just said "move" with no direction, default to away
    if (/^(hey )?(iris[,.]? )?(please )?(move|scoot)\.?$/.test(lower)) return 'away';

    return null;
  };

  // Handle voice command after wake word
  const handleVoiceCommand = useCallback(async (command: string) => {
    // Prevent overlapping command processing — if already handling a command, queue won't pile up
    if (isProcessingCommand.current) {
      console.log('[IRIS] Dropping command — already processing:', command);
      return;
    }
    isProcessingCommand.current = true;

    try {
    console.log('[IRIS] Processing voice command:', command);

    // Check for movement intent FIRST (handle locally, don't send to backend)
    const movementPosition = checkMovementIntent(command);
    if (movementPosition) {
      console.log('[IRIS] Movement detected, moving to:', movementPosition);
      addMessage(command, 'user');

      try {
        await invoke('move_window', { position: movementPosition });

        // Pick a fun response based on position
        const responses: Record<string, string[]> = {
          // Corners
          'top-right': ["Moving!", "On it!", "Scooting over!", "Top right, got it!"],
          'top-left': ["Moving to the left!", "Sliding over!", "Top left corner!"],
          'bottom-right': ["Going down!", "Bottom right!", "Tucking into the corner!"],
          'bottom-left': ["Bottom left it is!", "Moving!", "Down and to the left!"],
          // Center
          'center': ["Centering myself!", "Right in the middle!", "Front and center!"],
          // Edges
          'left': ["Moving to the left side!", "Left side!", "Over here!"],
          'right': ["Moving to the right side!", "Right side!", "Sliding right!"],
          'top': ["Going up top!", "To the top!", "Up here!"],
          'bottom': ["Going to the bottom!", "Down here!", "At the bottom!"],
          // Snap to half screen
          'snap-left': ["Snapping left!", "Taking the left half!", "Left side locked in!", "Half and half!"],
          'snap-right': ["Snapping right!", "Taking the right half!", "Right side locked in!", "Half and half!"],
          'left-half': ["Snapping left!", "Taking the left half!", "Left side locked in!"],
          'right-half': ["Snapping right!", "Taking the right half!", "Right side locked in!"],
          // Relative movements
          'up': ["Moving up!", "Going higher!", "Up a bit!"],
          'down': ["Moving down!", "Going lower!", "Down a bit!"],
          'move-left': ["Nudging left!", "A little to the left!", "Shifting left!"],
          'move-right': ["Nudging right!", "A little to the right!", "Shifting right!"],
          // Diagonal relative
          'up-left': ["Up and left!", "Diagonally!", "Moving!"],
          'up-right': ["Up and right!", "Diagonally!", "Moving!"],
          'down-left': ["Down and left!", "Diagonally!", "Moving!"],
          'down-right': ["Down and right!", "Diagonally!", "Moving!"],
          // Fun aliases
          'away': ["Out of your way!", "Stepping aside!", "I'll be over here!", "Moving!"],
          'back': ["Coming back!", "Returning home!", "Back to center!", "Here I am!"]
        };
        const responseOptions = responses[movementPosition] || ["Moving!", "On it!", "There!"];
        const response = responseOptions[Math.floor(Math.random() * responseOptions.length)];

        addMessage(response, 'iris');
        setState('delivering');
        await speakRef.current(response);
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Move window error:', error);
        addMessage("I couldn't move for some reason.", 'iris');
      }
      return; // Don't continue to backend query
    }

    // Check for monitor control intent (turn off, switch monitors)
    const monitorIntent = checkMonitorIntent(command);
    if (monitorIntent) {
      console.log('[IRIS] Monitor intent detected:', monitorIntent);
      addMessage(command, 'user');
      setState('thinking');

      try {
        if (monitorIntent.action === 'turn-off') {
          await executeSensitiveTool('turn_off_monitors', {});
          const responses = [
            "Turning off the monitors!",
            "Lights out!",
            "Going dark!",
            "Monitors off!",
          ];
          const response = responses[Math.floor(Math.random() * responses.length)];
          addMessage(response, 'iris');
          setState('delivering');
          await speakRef.current(response);
          setState('idle');
        } else if (monitorIntent.action === 'switch') {
          const result = await invoke<string>('move_to_monitor', { target: monitorIntent.target || 'other' });
          const responses = [
            "Jumping to the other screen!",
            "Switching monitors!",
            "Over here now!",
            result,
          ];
          const response = responses[Math.floor(Math.random() * responses.length)];
          addMessage(response, 'iris');
          setState('delivering');
          await speakRef.current(response);
          setState('idle');
        } else if (monitorIntent.action === 'count') {
          const monitors = await invoke<Array<{ index: number; name: string; width: number; height: number; is_primary: boolean }>>('get_monitors');
          const count = monitors.length;
          const response = count === 1
            ? "You have one monitor connected."
            : `You have ${count} monitors connected.`;
          addMessage(response, 'iris');
          setState('delivering');
          await speakRef.current(response);
          setState('idle');
        } else if (monitorIntent.action === 'ghost-on') {
          await toggleGhostMode(true);
          const responses = [
            "Going ghost! Say 'be solid' or 'come back' to interact with me again.",
            "Phasing out! I'll still hear you, just say 'solid mode' to click me again.",
            "Ghost mode on! Voice commands still work.",
          ];
          const response = responses[Math.floor(Math.random() * responses.length)];
          addMessage(response, 'iris');
          setState('delivering');
          await speakRef.current(response);
          setState('idle');
        } else if (monitorIntent.action === 'ghost-off') {
          await toggleGhostMode(false);
          const responses = [
            "I'm solid again!",
            "Back to normal!",
            "You can click me now!",
            "Ghost mode off!",
          ];
          const response = responses[Math.floor(Math.random() * responses.length)];
          addMessage(response, 'iris');
          setState('delivering');
          await speakRef.current(response);
          setState('idle');
        }
      } catch (error) {
        console.error('[IRIS] Monitor control error:', error);
        addMessage("I had trouble with that monitor command.", 'iris');
        setState('idle');
      }
      return; // Don't continue to backend query
    }

    // Structured model tool calls own action selection; keyword matching is intentionally disabled.
    // "see the open notepad" was being parsed as "open notepad"
    // const launchApp = checkLaunchIntent(command);
    // if (launchApp) { ... }

    // Check for clipboard intent (handle locally)
    const clipboardAction = checkClipboardIntent(command);
    if (clipboardAction) {
      console.log('[IRIS] Clipboard intent detected:', clipboardAction);
      addMessage(command, 'user');
      setState('thinking');

      try {
        if (clipboardAction === 'read') {
          // Read clipboard and tell user what's there
          const clipboardContent = await readText();

          if (!clipboardContent || clipboardContent.trim() === '') {
            const response = "Your clipboard is empty.";
            addMessage(response, 'iris');
            setState('delivering');
            await speakRef.current(response);
          } else {
            // Truncate for speech if too long
            const isLong = clipboardContent.length > 200;
            const preview = isLong ? clipboardContent.substring(0, 200) + '...' : clipboardContent;

            // Determine content type
            const isCode = /[{}\[\]();]|function|const|let|var|import|export|class|def |return /.test(clipboardContent);
            const isUrl = /^https?:\/\//.test(clipboardContent.trim());
            const isNumber = /^\d+\.?\d*$/.test(clipboardContent.trim());

            let contentType = 'text';
            if (isCode) contentType = 'code';
            else if (isUrl) contentType = 'a URL';
            else if (isNumber) contentType = 'a number';

            const spoken = isLong
              ? `You have ${contentType} on your clipboard. It's ${clipboardContent.length} characters long. Here's the start: ${preview}`
              : `You copied: ${clipboardContent}`;

            // Show full content in message, speak truncated
            addMessage(`📋 Clipboard (${clipboardContent.length} chars):\n\n${clipboardContent}`, 'iris');
            setState('delivering');
            await speakRef.current(spoken);
          }
        } else if (clipboardAction === 'copy') {
          // Copy last Iris response to clipboard
          const lastIrisMessage = messages.filter(m => m.role === 'iris').pop();
          if (lastIrisMessage) {
            await writeText(lastIrisMessage.content);
            const response = "Copied to your clipboard!";
            addMessage(response, 'iris');
            setState('delivering');
            await speakRef.current(response);
          } else {
            const response = "I don't have anything to copy yet.";
            addMessage(response, 'iris');
            setState('delivering');
            await speakRef.current(response);
          }
        }
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Clipboard error:', error);
        addMessage("I had trouble accessing the clipboard.", 'iris');
        setState('idle');
      }
      return; // Don't continue to backend query
    }

    // Check for volume control intent
    const volumeAction = checkVolumeIntent(command);
    if (volumeAction) {
      console.log('[IRIS] Volume intent detected:', volumeAction);
      addMessage(command, 'user');
      setState('thinking');

      try {
        let response: string;
        if (volumeAction.action === 'set' && volumeAction.value !== undefined) {
          await invoke('set_volume', { level: volumeAction.value });
          response = `Volume set to ${volumeAction.value}%`;
        } else if (volumeAction.direction) {
          await invoke('adjust_volume', { direction: volumeAction.direction });
          const actions: Record<string, string> = {
            'up': 'Turning it up!',
            'down': 'Lowering the volume.',
            'mute': 'Muted!',
          };
          response = actions[volumeAction.direction] || 'Volume adjusted!';
        } else {
          response = 'Volume adjusted!';
        }
        addMessage(response, 'iris');
        setState('delivering');
        await speakRef.current(response);
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Volume control error:', error);
        addMessage("I couldn't adjust the volume.", 'iris');
        setState('idle');
      }
      return;
    }

    // Check for media control intent
    const mediaAction = checkMediaIntent(command);
    if (mediaAction) {
      console.log('[IRIS] Media intent detected:', mediaAction);
      addMessage(command, 'user');
      setState('thinking');

      try {
        await invoke('media_control', { action: mediaAction });
        const responses: Record<string, string[]> = {
          'play_pause': ['Toggling playback!', 'Done!'],
          'play': ['Resuming playback!', 'Playing!'],
          'pause': ['Pausing!', 'Paused!'],
          'next': ['Skipping to next track!', 'Next!'],
          'previous': ['Going back!', 'Previous track!'],
          'stop': ['Stopping playback!', 'Stopped!'],
        };
        const options = responses[mediaAction] || ['Done!'];
        const response = options[Math.floor(Math.random() * options.length)];
        addMessage(response, 'iris');
        setState('delivering');
        await speakRef.current(response);
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Media control error:', error);
        addMessage("I couldn't control the media.", 'iris');
        setState('idle');
      }
      return;
    }

    // Benchmarks may not launch arbitrary processes from the desktop runtime.
    const benchmarkAction = checkBenchmarkIntent(command);
    if (benchmarkAction) {
      console.log('[IRIS] Benchmark intent detected:', benchmarkAction);
      addMessage(command, 'user');
      setState('thinking');

      try {
        addMessage('Benchmark launching is disabled in the OSS runtime because arbitrary process execution is disabled.', 'iris');
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Benchmark error:', error);
        addMessage("I had trouble starting the benchmark. Make sure the benchmark scripts are available.", 'iris');
        setState('idle');
      }
      return;
    }

    // Check for system stats intent
    if (checkSystemStatsIntent(command)) {
      console.log('[IRIS] System stats intent detected');
      addMessage(command, 'user');
      setState('thinking');

      try {
        const stats = await invoke<{
          cpu_usage: number;
          memory_used_gb: number;
          memory_total_gb: number;
          memory_percent: number;
          battery_percent: number | null;
          battery_charging: boolean | null;
        }>('get_system_stats');

        let response = `Your CPU is at ${Math.round(stats.cpu_usage)}%. `;
        response += `Memory usage is ${stats.memory_used_gb.toFixed(1)} out of ${stats.memory_total_gb.toFixed(1)} gigs, about ${Math.round(stats.memory_percent)}%.`;

        if (stats.battery_percent !== null) {
          response += ` Battery is at ${stats.battery_percent}%`;
          if (stats.battery_charging) {
            response += ' and charging.';
          } else {
            response += '.';
          }
        }

        addMessage(response, 'iris');
        setState('delivering');
        await speakRef.current(response);
        setState('idle');
      } catch (error) {
        console.error('[IRIS] System stats error:', error);
        addMessage("I couldn't get the system stats.", 'iris');
        setState('idle');
      }
      return;
    }

    // Check for lock/sleep intent
    const lockSleepAction = checkLockSleepIntent(command);
    if (lockSleepAction) {
      console.log('[IRIS] Lock/sleep intent detected:', lockSleepAction);
      addMessage(command, 'user');
      setState('thinking');

      try {
        if (lockSleepAction === 'lock') {
          const response = "Locking your computer!";
          addMessage(response, 'iris');
          setState('delivering');
          await speakRef.current(response);
          await executeSensitiveTool('lock_computer', {});
        } else {
          const response = "Putting your computer to sleep. Goodnight!";
          addMessage(response, 'iris');
          setState('delivering');
          await speakRef.current(response);
          await executeSensitiveTool('sleep_computer', {});
        }
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Lock/sleep error:', error);
        addMessage("I couldn't do that.", 'iris');
        setState('idle');
      }
      return;
    }

    // Check for URL intent (before search, as it's more specific)
    const urlToOpen = checkUrlIntent(command);
    if (urlToOpen) {
      console.log('[IRIS] URL intent detected:', urlToOpen);
      addMessage(command, 'user');
      setState('thinking');

      try {
        await executeSensitiveTool('open_url', { url: urlToOpen });
        const response = `Opening ${urlToOpen}!`;
        addMessage(response, 'iris');
        setState('delivering');
        await speakRef.current(response);
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Open URL error:', error);
        addMessage(`I couldn't open ${urlToOpen}.`, 'iris');
        setState('idle');
      }
      return;
    }

    // Structured model tool calls own action selection; keyword matching is intentionally disabled.
    // This was causing "google doc" to trigger searches
    // const searchQuery = checkSearchIntent(command);
    // if (searchQuery) { ... }

    // Check for close app intent
    const appToClose = checkCloseAppIntent(command);
    if (appToClose) {
      console.log('[IRIS] Close app intent detected:', appToClose);
      addMessage(command, 'user');
      setState('thinking');

      try {
        await executeSensitiveTool('close_app', { appName: appToClose });
        const response = `Closing ${appToClose}!`;
        addMessage(response, 'iris');
        setState('delivering');
        await speakRef.current(response);
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Close app error:', error);
        addMessage(`I couldn't close ${appToClose}. It might not be running.`, 'iris');
        setState('idle');
      }
      return;
    }

    // Check for show desktop intent
    if (checkDesktopIntent(command)) {
      console.log('[IRIS] Desktop intent detected');
      addMessage(command, 'user');
      setState('thinking');

      try {
        await invoke('minimize_all_windows');
        const responses = [
          "Showing your desktop!",
          "Minimizing everything!",
          "There's your desktop!",
        ];
        const response = responses[Math.floor(Math.random() * responses.length)];
        addMessage(response, 'iris');
        setState('delivering');
        await speakRef.current(response);
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Desktop error:', error);
        addMessage("I couldn't show the desktop.", 'iris');
        setState('idle');
      }
      return;
    }

    // Check for time/date intent
    const timeIntent = checkTimeIntent(command);
    if (timeIntent) {
      console.log('[IRIS] Time/date intent detected:', timeIntent);
      addMessage(command, 'user');
      setState('thinking');

      try {
        let response = '';
        if (timeIntent === 'time' || timeIntent === 'both') {
          const time = await invoke<string>('get_time');
          response = `It's ${time}`;
        }
        if (timeIntent === 'date' || timeIntent === 'both') {
          const date = await invoke<string>('get_date');
          response += response ? `, and today is ${date}.` : `Today is ${date}.`;
        }
        if (!response.endsWith('.')) response += '.';
        addMessage(response, 'iris');
        setState('delivering');
        await speakRef.current(response);
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Time/date error:', error);
        addMessage("I couldn't get the time.", 'iris');
        setState('idle');
      }
      return;
    }

    // Check for screenshot save intent
    if (checkScreenshotSaveIntent(command)) {
      console.log('[IRIS] Screenshot save intent detected');
      addMessage(command, 'user');
      setState('thinking');

      try {
        const result = await invoke<string>('save_screenshot', { path: null });
        const response = "Screenshot saved!";
        addMessage(`${response}\n${result}`, 'iris');
        setState('delivering');
        await speakRef.current(response);
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Screenshot save error:', error);
        addMessage("I couldn't save the screenshot.", 'iris');
        setState('idle');
      }
      return;
    }

    // Check for timer intent
    const timerIntent = checkTimerIntent(command);
    if (timerIntent) {
      console.log('[IRIS] Timer intent detected:', timerIntent.seconds, 'seconds');
      addMessage(command, 'user');
      setState('thinking');

      const timerId = timerIdCounter.current++;
      const formatTime = (s: number) => {
        if (s >= 3600) return `${Math.floor(s / 3600)} hour${s >= 7200 ? 's' : ''}`;
        if (s >= 60) return `${Math.floor(s / 60)} minute${s >= 120 ? 's' : ''}`;
        return `${s} second${s !== 1 ? 's' : ''}`;
      };

      const response = `Timer set for ${formatTime(timerIntent.seconds)}!`;
      addMessage(response, 'iris');
      setState('delivering');
      await speakRef.current(response);

      // Set the timer
      const timeout = setTimeout(async () => {
        activeTimers.current.delete(timerId);
        const alarmMsg = "Time's up!";
        addMessage(`⏰ ${alarmMsg}`, 'iris');

        // Show notification and speak
        try {
          await invoke('show_notification', { title: 'IRIS Timer', body: alarmMsg });
        } catch (e) {
          console.error('[IRIS] Notification error:', e);
        }
        await speakRef.current(alarmMsg);
      }, timerIntent.seconds * 1000);

      activeTimers.current.set(timerId, timeout);
      setState('idle');
      return;
    }

    // Check for brightness intent
    const brightnessAction = checkBrightnessIntent(command);
    if (brightnessAction) {
      console.log('[IRIS] Brightness intent detected:', brightnessAction);
      addMessage(command, 'user');
      setState('thinking');

      try {
        let response: string;
        if (brightnessAction.action === 'set' && brightnessAction.value !== undefined) {
          await invoke('set_brightness', { level: brightnessAction.value });
          response = `Brightness set to ${brightnessAction.value}%`;
        } else if (brightnessAction.direction) {
          await invoke('adjust_brightness', { direction: brightnessAction.direction });
          response = brightnessAction.direction === 'up' ? 'Brightening up!' : 'Dimming the screen.';
        } else {
          response = 'Brightness adjusted!';
        }
        addMessage(response, 'iris');
        setState('delivering');
        await speakRef.current(response);
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Brightness error:', error);
        addMessage("I couldn't adjust the brightness. This might not work on desktop monitors.", 'iris');
        setState('idle');
      }
      return;
    }

    // Check for WiFi intent
    const wifiAction = checkWifiIntent(command);
    if (wifiAction) {
      console.log('[IRIS] WiFi intent detected:', wifiAction);
      addMessage(command, 'user');
      setState('thinking');

      try {
        let enable: boolean;
        if (wifiAction === 'toggle') {
          const isOn = await invoke<boolean>('get_wifi_status');
          enable = !isOn;
        } else {
          enable = wifiAction === 'enable';
        }

        await executeSensitiveTool('toggle_wifi', { enable });
        const response = enable ? 'WiFi enabled!' : 'WiFi disabled!';
        addMessage(response, 'iris');
        setState('delivering');
        await speakRef.current(response);
        setState('idle');
      } catch (error) {
        console.error('[IRIS] WiFi error:', error);
        addMessage("I couldn't toggle the WiFi. You might need admin privileges.", 'iris');
        setState('idle');
      }
      return;
    }

    // Check for notes intent
    const noteContent = checkNotesIntent(command);
    if (noteContent) {
      console.log('[IRIS] Notes intent detected:', noteContent);
      addMessage(command, 'user');
      setState('thinking');

      try {
        await invoke<string>('save_note', { content: noteContent, filename: null });
        const response = "Got it! Note saved.";
        addMessage(`${response}\n📝 "${noteContent}"`, 'iris');
        setState('delivering');
        await speakRef.current(response);
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Notes error:', error);
        addMessage("I couldn't save the note.", 'iris');
        setState('idle');
      }
      return;
    }

    // Check for calculator intent
    const calcExpression = checkCalculatorIntent(command);
    if (calcExpression) {
      console.log('[IRIS] Calculator intent detected:', calcExpression);
      addMessage(command, 'user');
      setState('thinking');

      try {
        // Safely evaluate the expression
        const result = Function(`"use strict"; return (${calcExpression})`)();

        if (typeof result === 'number' && !isNaN(result)) {
          // Format nicely
          const formatted = Number.isInteger(result) ? result.toString() : result.toFixed(4).replace(/\.?0+$/, '');
          const response = `That equals ${formatted}`;
          addMessage(`🔢 ${calcExpression} = **${formatted}**`, 'iris');
          setState('delivering');
          await speakRef.current(response);
        } else {
          throw new Error('Invalid result');
        }
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Calculator error:', error);
        addMessage("I couldn't calculate that. Try something like 'what's 15 times 20'.", 'iris');
        setState('idle');
      }
      return;
    }

    // Check for dictation intent
    const dictationAction = checkDictationIntent(command);
    if (dictationAction) {
      console.log('[IRIS] Dictation intent detected:', dictationAction);
      addMessage(command, 'user');
      setState('thinking');

      if (dictationAction === 'start') {
        setIsDictating(true);
        const response = "Dictation mode on. I'll type everything you say. Say 'stop dictating' when done.";
        addMessage(response, 'iris');
        setState('delivering');
        await speakRef.current("Dictation mode on. I'll type what you say.");
      } else {
        setIsDictating(false);
        const response = "Dictation mode off.";
        addMessage(response, 'iris');
        setState('delivering');
        await speakRef.current(response);
      }
      setState('idle');
      return;
    }

    // ==================== NEW IRIS HUBS & FEATURES HANDLERS ====================

    // Check for hub intent - "pull up the baby monitor"
    const hubName = checkHubIntent(command);
    if (hubName) {
      console.log('[IRIS] Hub intent detected:', hubName);
      addMessage(command, 'user');
      setState('thinking');

      try {
        await invoke('open_hub', { hubName, useCanvas: true });
        const responses = [
          `Opening the ${hubName} hub!`,
          `Pulling up ${hubName}!`,
          `Here's the ${hubName} hub!`,
        ];
        const response = responses[Math.floor(Math.random() * responses.length)];
        addMessage(response, 'iris');
        setState('delivering');
        await speakRef.current(response);
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Hub error:', error);
        addMessage(`I couldn't open the ${hubName} hub.`, 'iris');
        setState('idle');
      }
      return;
    }

    // Check for workspace intent - "save workspace", "load workspace dev"
    const workspaceAction = checkWorkspaceIntent(command);
    if (workspaceAction) {
      console.log('[IRIS] Workspace intent detected:', workspaceAction);
      addMessage(command, 'user');
      setState('thinking');

      try {
        if (workspaceAction.action === 'save') {
          const name = workspaceAction.name || `workspace_${Date.now()}`;
          const result = await invoke<string>('save_workspace', { name });
          addMessage(result, 'iris');
          setState('delivering');
          await speakRef.current(`Workspace saved as ${name}!`);
        } else if (workspaceAction.action === 'load' && workspaceAction.name) {
          const response = await executeSensitiveTool('load_workspace', { name: workspaceAction.name });
          const result = typeof response === 'object' && response && 'result' in response ? String((response as { result: unknown }).result) : 'Workspace restored';
          addMessage(result, 'iris');
          setState('delivering');
          await speakRef.current(`Loading workspace ${workspaceAction.name}!`);
        } else if (workspaceAction.action === 'list') {
          const workspaces = await invoke<string[]>('list_workspaces');
          if (workspaces.length === 0) {
            const response = "You don't have any saved workspaces yet.";
            addMessage(response, 'iris');
            await speakRef.current(response);
          } else {
            const response = `You have ${workspaces.length} workspace${workspaces.length > 1 ? 's' : ''}: ${workspaces.join(', ')}`;
            addMessage(response, 'iris');
            await speakRef.current(response);
          }
          setState('delivering');
        } else if (workspaceAction.action === 'delete' && workspaceAction.name) {
          await executeSensitiveTool('delete_workspace', { name: workspaceAction.name });
          const response = `Workspace ${workspaceAction.name} deleted!`;
          addMessage(response, 'iris');
          setState('delivering');
          await speakRef.current(response);
        }
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Workspace error:', error);
        addMessage("I had trouble with that workspace operation.", 'iris');
        setState('idle');
      }
      return;
    }

    // Check for layout/war room intent - "focus mode", "coding layout"
    const layoutAction = checkLayoutIntent(command);
    if (layoutAction) {
      console.log('[IRIS] Layout intent detected:', layoutAction);
      addMessage(command, 'user');
      setState('thinking');

      try {
        if (layoutAction.action === 'save') {
          const name = layoutAction.name || `layout_${Date.now()}`;
          const result = await invoke<string>('save_layout', { name });
          addMessage(result, 'iris');
          setState('delivering');
          await speakRef.current(`Layout saved as ${name}!`);
        } else if (layoutAction.action === 'load' && layoutAction.name) {
          const result = await invoke<string>('load_layout', { name: layoutAction.name });
          const responses = [
            `${layoutAction.name} layout activated!`,
            `Switching to ${layoutAction.name} mode!`,
            `${layoutAction.name} layout applied!`,
          ];
          const response = responses[Math.floor(Math.random() * responses.length)];
          addMessage(`${response}\n${result}`, 'iris');
          setState('delivering');
          await speakRef.current(response);
        } else if (layoutAction.action === 'list') {
          const layouts = await invoke<string[]>('list_layouts');
          if (layouts.length === 0) {
            const response = "You don't have any saved layouts yet.";
            addMessage(response, 'iris');
            await speakRef.current(response);
          } else {
            const response = `You have ${layouts.length} layout${layouts.length > 1 ? 's' : ''}: ${layouts.join(', ')}`;
            addMessage(response, 'iris');
            await speakRef.current(response);
          }
          setState('delivering');
        }
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Layout error:', error);
        addMessage("I couldn't apply that layout.", 'iris');
        setState('idle');
      }
      return;
    }

    // Check for macro/gauntlet intent - "deploy", "ship it"
    const macroTrigger = checkMacroIntent(command);
    if (macroTrigger) {
      console.log('[IRIS] Macro intent detected:', macroTrigger);
      addMessage(command, 'user');
      setState('thinking');

      try {
        // Try to load and execute the macro
        const { matchMacroTrigger, executeMacro } = await import('../lib/macroEngine');
        const macro = await matchMacroTrigger(macroTrigger);

        if (macro) {
          const response = `Executing ${macro.name}!`;
          addMessage(response, 'iris');
          setState('delivering');
          await speakRef.current(response);

          // Execute the macro
          const result = await executeMacro(macro);

          if (result.success) {
            const doneMsg = `${macro.name} complete!`;
            addMessage(doneMsg, 'iris');
            await speakRef.current(doneMsg);
          } else {
            const errorMsg = `${macro.name} had some issues: ${result.errors.join(', ')}`;
            addMessage(errorMsg, 'iris');
            await speakRef.current("Macro finished with some issues.");
          }
        } else {
          // No macro found with that trigger
          const response = `I don't have a macro called "${macroTrigger}". You can create one in your macros folder.`;
          addMessage(response, 'iris');
          await speakRef.current("I don't have that macro set up.");
        }
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Macro error:', error);
        addMessage("I had trouble with that macro.", 'iris');
        setState('idle');
      }
      return;
    }

    // Check for annotation intent - "circle that", "highlight this"
    const annotationAction = checkAnnotationIntent(command);
    if (annotationAction) {
      console.log('[IRIS] Annotation intent detected:', annotationAction);
      addMessage(command, 'user');
      setState('thinking');

      try {
        if (annotationAction.type === 'clear') {
          await invoke('clear_annotations');
          const response = "Annotations cleared!";
          addMessage(response, 'iris');
          setState('delivering');
          await speakRef.current(response);
        } else {
          // Get mouse position for annotation
          const [mouseX, mouseY] = await invoke<[number, number]>('get_mouse_position');

          const annotation = {
            id: `annotation-${Date.now()}`,
            annotation_type: annotationAction.type,
            x: mouseX,
            y: mouseY,
            radius: annotationAction.type === 'circle' ? 80 : undefined,
            width: annotationAction.type === 'highlight' ? 200 : undefined,
            height: annotationAction.type === 'highlight' ? 100 : undefined,
            x2: annotationAction.type === 'arrow' ? mouseX + 150 : undefined,
            y2: annotationAction.type === 'arrow' ? mouseY + 100 : undefined,
            color: '#f97316',
            auto_fade_ms: 10000,
          };

          await invoke('add_annotation', { annotation });
          const responses = {
            'circle': "Circled!",
            'arrow': "Arrow drawn!",
            'highlight': "Highlighted!",
            'pointer': "Right there!",
          };
          const response = responses[annotationAction.type as keyof typeof responses] || "Done!";
          addMessage(response, 'iris');
          setState('delivering');
          await speakRef.current(response);
        }
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Annotation error:', error);
        addMessage("I couldn't add that annotation.", 'iris');
        setState('idle');
      }
      return;
    }

    // If in dictation mode, type out the command instead of processing it
    if (isDictating) {
      console.log('[IRIS] Dictation mode - typing:', command);
      try {
        await executeControlTool('type_text', { text: command + ' ' }, 'Type the user-dictated text into the focused application');
        // Don't add to messages or speak - just type silently
        setState('idle');
      } catch (error) {
        console.error('[IRIS] Dictation typing error:', error);
      }
      return;
    }

    // Check for webcam vision intent
    const isVisionQuery = checkVisionIntent(command);
    let webcamFrame: string | undefined;

    if (isVisionQuery) {
      console.log('[IRIS] Vision intent detected - capturing webcam frame...');
      addMessage(command, 'user');
      setState('thinking');

      // Try to capture from presence/preview video first (continuous vision mode)
      if ((presenceEnabled || cameraPreviewOnly) && presenceVideoRef.current?.srcObject && presenceVideoRef.current.videoWidth > 0) {
        console.log('[IRIS] Using presence video feed (continuous vision mode)');
        try {
          const canvas = document.createElement('canvas');
          canvas.width = presenceVideoRef.current.videoWidth;
          canvas.height = presenceVideoRef.current.videoHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(presenceVideoRef.current, 0, 0);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            webcamFrame = dataUrl.split(',')[1];
            console.log('[IRIS] Captured frame from presence feed, size:', webcamFrame.length);
          }
        } catch (e) {
          console.error('[IRIS] Failed to capture from presence feed:', e);
        }
      }

      // Fall back to on-demand webcam if presence capture failed
      if (!webcamFrame) {
        // Capture silently using a temporary hidden video element (no preview window)
        try {
          console.log('[IRIS] Starting silent webcam capture...');

          const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 1280, height: 720, facingMode: 'user' }
          });

          // Create a temporary hidden video element
          const tempVideo = document.createElement('video');
          tempVideo.srcObject = stream;
          tempVideo.autoplay = true;
          tempVideo.playsInline = true;
          tempVideo.muted = true;

          // Wait for video to be ready
          await new Promise<void>((resolve) => {
            tempVideo.onloadedmetadata = () => {
              tempVideo.play().then(() => resolve()).catch(() => resolve());
            };
            // Timeout fallback
            setTimeout(resolve, 3000);
          });

          // Wait for camera to warm up and get actual frames
          for (let i = 0; i < 15; i++) {
            await sleep(200);
            if (tempVideo.videoWidth > 0 && tempVideo.videoHeight > 0) {
              console.log('[IRIS] Silent video ready:', tempVideo.videoWidth, 'x', tempVideo.videoHeight);
              break;
            }
          }

          // Capture frame
          if (tempVideo.videoWidth > 0 && tempVideo.videoHeight > 0) {
            const canvas = document.createElement('canvas');
            canvas.width = tempVideo.videoWidth;
            canvas.height = tempVideo.videoHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(tempVideo, 0, 0);
              const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
              webcamFrame = dataUrl.split(',')[1];
              console.log('[IRIS] Silent frame captured, size:', webcamFrame.length);
            }
          }

          // Clean up immediately - no preview window
          stream.getTracks().forEach(t => t.stop());
          tempVideo.srcObject = null;

        } catch (e) {
          console.error('[IRIS] Failed to capture from webcam:', e);
          addMessage("I couldn't access your camera. Please check permissions.", 'iris');
          setState('idle');
          return;
        }
      }
    } else {
      addMessage(command, 'user');
    }

    setIsLoading(true);
    setState('thinking');
    emit('update-canvas', { isVisible: false });

    try {
      const { text, canvas, toolCalls } = await solstice.query(command, {
        screenshot: webcamFrame || screenshot || undefined,
        isWebcam: !!webcamFrame,  // Flag when using webcam frame
        history: messages.map(m => ({
          role: m.role === 'iris' ? 'model' : 'user',
          content: m.content
        }))
      });

      // Model text is presentation-only. Native actions arrive through structured tool calls.
      const cleanText = cleanResponseText(text);

      addMessage(cleanText, 'iris');
      setState('delivering');

      if (canvas) {
        console.log('[IRIS] Received canvas data, writing to localStorage:', canvas);
        localStorage.setItem('iris_canvas_data', JSON.stringify({ ...canvas, isVisible: true, timestamp: Date.now() }));
        // Also emit event for good measure (broadcast)
        emit('update-canvas', { ...canvas, isVisible: true });
        // Force wake up the canvas window
        invoke('show_canvas_window').catch(console.error);
      }

      if (toolCalls?.length) await executeProviderTools(toolCalls, command);

      // Speak the response via TTS (ref handles tracking isSpeaking state)
      await speakRef.current(cleanText); // Logic regarding session update is now inside the ref wrapper

      setState('success');
      await sleep(500);

      setState('success');
      await sleep(500);
      setState('idle');

      if (screenshot) {
        setScreenshot(null);
      }
    } catch (error) {
      console.error('[IRIS] Voice command error:', error);
      addMessage("I encountered an error. Please try again.", 'iris');
      setState('error');
      await sleep(1500);
      setState('idle');
    } finally {
      setIsLoading(false);
    }
    } finally {
      isProcessingCommand.current = false;
    }
  }, [solstice, screenshot, addMessage, setState, setScreenshot, setIsLoading, webcam, cleanResponseText, executeProviderTools]);

  // Initialize NATIVE audio capture (bypasses broken WebView2)
  // BARGE-IN: Mic stays enabled during IRIS speech for interruption detection
  // Echo cancellation (AEC + text comparison) filters IRIS's voice
  const nativeAudio = useNativeAudio({
    deviceName: selectedNativeDevice || undefined,
    enabled: voiceEnabled, // Keep mic on for barge-in - echo cancellation handles self-voice
    onSpeechDetected: (isSpeaking) => {
      // Visual feedback - show listening state when speech detected
      if (isSpeaking && state === 'idle' && voiceEnabled) {
        setState('listening');
      } else if (!isSpeaking && state === 'listening') {
        // Brief delay before returning to idle
        setTimeout(() => {
          if (state === 'listening') {
            setState('idle');
          }
        }, 500);
      }
    },
    onAudioRecorded: async (audioBase64: string, durationMs: number) => {
      if (!voiceEnabled) return;

      const tapToTalk = voiceStatus.settings.inputMode === 'tap_to_talk';

      // POST-SPEECH COOLDOWN: Reject audio captured too soon after IRIS finished speaking
      // This prevents her from hearing echoes of her own voice
      const timeSinceSpeech = Date.now() - lastSpeechEndTime.current;
      if (timeSinceSpeech < POST_SPEECH_COOLDOWN_MS && lastSpeechEndTime.current > 0) {
        console.log(`[IRIS] Rejecting audio - captured ${timeSinceSpeech}ms after speech (cooldown: ${POST_SPEECH_COOLDOWN_MS}ms)`);
        return;
      }

      console.log('[IRIS] Audio recorded, sending to STT...', durationMs, 'ms');
      const transcript = await transcribeAudio(audioBase64);

      if (tapToTalk) setVoiceEnabled(false);

      if (!transcript) {
        console.log('[IRIS] No transcript received');
        setState('idle');
        return;
      }

      if (isNonSpeechTranscript(transcript)) {
        console.log('[IRIS] Ignoring non-speech transcription event:', transcript);
        setState('idle');
        return;
      }

      console.log('[IRIS] Transcript:', transcript);
      const lowerTranscript = transcript.toLowerCase();

      if (tapToTalk) {
        if (handleSendMessageRef.current) await handleSendMessageRef.current(transcript);
        else await handleVoiceCommand(transcript);
        return;
      }

      // ECHO CANCELLATION / BARGE-IN LOGIC
      if (isIrisSpeaking.current) {
        // Check if the transcript is just Iris hearing herself
        const currentSpeech = lastSpokenText.current.toLowerCase();
        // Normalize strings (remove punctuation and extra whitespace)
        const cleanTranscript = lowerTranscript.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()'"?!]/g, "").replace(/\s+/g, " ").trim();
        const cleanSpeech = currentSpeech.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()'"?!]/g, "").replace(/\s+/g, " ").trim();

        // Check for echo: transcript is substring of speech OR words overlap significantly
        const transcriptWords = cleanTranscript.split(" ").filter(w => w.length > 2);
        const speechWords = cleanSpeech.split(" ").filter(w => w.length > 2);
        const matchingWords = transcriptWords.filter(w => speechWords.includes(w));
        const overlapRatio = transcriptWords.length > 0 ? matchingWords.length / transcriptWords.length : 0;

        // If substring match OR >50% word overlap, it's echo
        const isSubstringMatch = cleanSpeech.includes(cleanTranscript) && cleanTranscript.length > 5;
        const isWordOverlap = overlapRatio > 0.5 && transcriptWords.length > 2;

        if (isSubstringMatch || isWordOverlap) {
          console.log('[IRIS] Ignoring self-echo:', transcript, `(overlap: ${(overlapRatio * 100).toFixed(0)}%)`);
          return;
        }

        // It's a BARGE-IN (user interruption)
        console.log('[IRIS] BARGE-IN detected! User said:', transcript);
        voice.interruptSpeech(); // Stop TTS
        isIrisSpeaking.current = false;
        setIsIrisSpeakingState(false); // Update state too
        // Proceed to process the user's command
      }

      // Check for wake word
      const hasWakeWord = wakeWords.some(w => lowerTranscript.includes(w));
      const isActiveSession = (Date.now() - lastVoiceInteraction.current) < 30000;

      if (hasWakeWord) {
        console.log('[IRIS] Wake word detected!');
        lastVoiceInteraction.current = Date.now(); // Start active session
        // Don't auto-expand chat - let particles respond visually
        setState('listening');

        // Extract command after wake word (if any)
        let command = transcript;
        for (const wakeWord of wakeWords) {
          const idx = lowerTranscript.indexOf(wakeWord);
          if (idx !== -1) {
            command = transcript.substring(idx + wakeWord.length).trim();
            break;
          }
        }

        // Remove leading punctuation/words
        command = command.replace(/^[,.\s]+/, '').trim();

        if (command.length > 2) {
          // User said something after wake word - process it
          console.log('[IRIS] Command in same utterance:', command);
          if (handleSendMessageRef.current) await handleSendMessageRef.current(command);
          else await handleVoiceCommand(command);
        } else {
          // Just wake word - wait for next utterance
          console.log('[IRIS] Wake word only');
          // Play acknowledgment - Jarvis-style "Boss" variations
          const acknowledgments = [
            "Yeah boss?",
            "What's up?",
            "Hey! What do you need?",
            "I'm here!",
            "What can I do for you?",
            "Ready when you are!",
            "At your service!",
            "Listening!",
            "Go ahead!",
          ];
          const ack = acknowledgments[Math.floor(Math.random() * acknowledgments.length)];
          speakRef.current(ack);
        }
      } else if (isActiveSession && transcript.length > 2) {
        console.log('[IRIS] Active Session: Processing follow-up command');
        lastVoiceInteraction.current = Date.now(); // Extend session
        if (handleSendMessageRef.current) await handleSendMessageRef.current(transcript);
        else await handleVoiceCommand(transcript);
      } else {
        // No wake word and not active - return to idle
        setState('idle');
      }
    },
  });

  // Load settings from localStorage
  useEffect(() => {
    const savedNativeDevice = localStorage.getItem('iris-native-mic-device');
    if (savedNativeDevice) {
      setSelectedNativeDevice(savedNativeDevice);
    }
  }, []);

  // Wire up nativeAudioRef for synchronous stop/start in speak wrapper
  useEffect(() => {
    nativeAudioRef.current = {
      stopCapture: nativeAudio.stopCapture,
      startCapture: nativeAudio.startCapture,
    };
  }, [nativeAudio.stopCapture, nativeAudio.startCapture]);

  // Load native audio devices from Rust
  useEffect(() => {
    if (showSettings && nativeAudio.devices.length > 0) {
      setNativeDevices(nativeAudio.devices);
      console.log('[IRIS] Native audio devices:', nativeAudio.devices);
    }
  }, [showSettings, nativeAudio.devices]);

  // Save selected native microphone device
  const saveSelectedNativeDevice = async (deviceName: string) => {
    setSelectedNativeDevice(deviceName);
    localStorage.setItem('iris-native-mic-device', deviceName);
    // Restart native audio capture with new device
    await nativeAudio.stopCapture();
    await nativeAudio.startCapture(deviceName || undefined);
  };

  const captureScreenForChat = useCallback(async (displayIndex = 0) => {
    setState('thinking');
    try {
      const captured = await invoke<ScreenshotResult>('capture_screen_by_index', { index: displayIndex });
      if (!captured.base64 || captured.width < 1 || captured.height < 1) {
        throw new Error('Screen capture returned an empty frame');
      }
      setScreenshot(captured.base64);
      addMessage(
        `Screenshot captured from monitor ${displayIndex + 1} (${captured.width}×${captured.height}). It will be included with your next message.`,
        'iris',
      );
      setState('success');
    } catch (error) {
      console.error('[IRIS] Screen capture failed:', error);
      addMessage(`Screen capture failed: ${String(error)}`, 'iris');
      setState('error');
    } finally {
      window.setTimeout(() => setState('idle'), 500);
    }
  }, [addMessage, setScreenshot, setState]);

  // Handle sending messages (text input)
  const handleSendMessage = useCallback(
    async (message: string) => {
      const deterministicMockTool = isDeterministicMockToolCommand(message);
      // Check for webcam vision intent (same as voice handler)
      const isVisionQuery = !deterministicMockTool && checkVisionIntent(message);
      let webcamFrame: string | undefined;

      if (isVisionQuery) {
        console.log('[IRIS] Vision intent detected in text input - capturing webcam frame...');
        addMessage(message, 'user');
        setState('thinking');

        // Try to capture from presence/preview video first (continuous vision mode)
        if ((presenceEnabled || cameraPreviewOnly) && presenceVideoRef.current?.srcObject && presenceVideoRef.current.videoWidth > 0) {
          console.log('[IRIS] Using presence/preview video feed');
          try {
            const canvas = document.createElement('canvas');
            canvas.width = presenceVideoRef.current.videoWidth;
            canvas.height = presenceVideoRef.current.videoHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(presenceVideoRef.current, 0, 0);
              const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
              webcamFrame = dataUrl.split(',')[1];
              console.log('[IRIS] Captured frame from presence/preview feed, size:', webcamFrame.length);
            }
          } catch (e) {
            console.error('[IRIS] Failed to capture from presence feed:', e);
          }
        }

        // Fall back to on-demand webcam if presence capture failed
        if (!webcamFrame) {
          // Capture silently using a temporary hidden video element (no preview window)
          try {
            console.log('[IRIS] Starting silent webcam capture...');

            const stream = await navigator.mediaDevices.getUserMedia({
              video: { width: 1280, height: 720, facingMode: 'user' }
            });

            // Create a temporary hidden video element
            const tempVideo = document.createElement('video');
            tempVideo.srcObject = stream;
            tempVideo.autoplay = true;
            tempVideo.playsInline = true;
            tempVideo.muted = true;

            // Wait for video to be ready
            await new Promise<void>((resolve) => {
              tempVideo.onloadedmetadata = () => {
                tempVideo.play().then(() => resolve()).catch(() => resolve());
              };
              // Timeout fallback
              setTimeout(resolve, 3000);
            });

            // Wait for camera to warm up and get actual frames
            for (let i = 0; i < 15; i++) {
              await sleep(200);
              if (tempVideo.videoWidth > 0 && tempVideo.videoHeight > 0) {
                console.log('[IRIS] Silent video ready:', tempVideo.videoWidth, 'x', tempVideo.videoHeight);
                break;
              }
            }

            // Capture frame
            if (tempVideo.videoWidth > 0 && tempVideo.videoHeight > 0) {
              const canvas = document.createElement('canvas');
              canvas.width = tempVideo.videoWidth;
              canvas.height = tempVideo.videoHeight;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(tempVideo, 0, 0);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                webcamFrame = dataUrl.split(',')[1];
                console.log('[IRIS] Silent frame captured, size:', webcamFrame.length);
              }
            }

            // Clean up immediately - no preview window
            stream.getTracks().forEach(t => t.stop());
            tempVideo.srcObject = null;

          } catch (e) {
            console.error('[IRIS] Failed to capture from webcam:', e);
            addMessage("I couldn't access your camera. Please check permissions.", 'iris');
            setState('idle');
            return;
          }
        }
      } else if (!deterministicMockTool) {
        // Check for local intents BEFORE sending to backend (same as voice commands)

        // Provider speed preference toggle
        const lowerMessage = message.toLowerCase();

        const screenCaptureRequest = parseScreenCaptureRequest(message);
        if (screenCaptureRequest) {
          addMessage(message, 'user');
          await captureScreenForChat(screenCaptureRequest.displayIndex);
          return;
        }

        const speakRequest = parseSpeakRequest(message);
        if (speakRequest) {
          addMessage(message, 'user');
          addMessage(speakRequest, 'iris');
          setState('delivering');
          if (voiceRepliesEnabled) await speakRef.current(speakRequest);
          setState('idle');
          return;
        }

        // Check for macro/gauntlet intent
        const macroTrigger = checkMacroIntent(message);
        if (macroTrigger) {
          console.log('[IRIS] Macro intent detected in text:', macroTrigger);
          addMessage(message, 'user');
          setState('thinking');

          try {
            const { matchMacroTrigger, executeMacro } = await import('../lib/macroEngine');
            const macro = await matchMacroTrigger(macroTrigger);

            if (macro) {
              const response = `Executing ${macro.name}!`;
              addMessage(response, 'iris');
              setState('delivering');
              if (speakRef.current) {
                await speakRef.current(response);
              }

              // Execute the macro
              const result = await executeMacro(macro);

              if (result.success) {
                if (result.errors.length > 0) {
                  const errorMsg = `${macro.name} finished with some issues: ${result.errors.join(', ')}`;
                  addMessage(errorMsg, 'iris');
                  if (speakRef.current) {
                    await speakRef.current("Macro finished with some issues.");
                  }
                }
              } else {
                const errorMsg = `Macro failed: ${result.errors.join(', ')}`;
                addMessage(errorMsg, 'iris');
                if (speakRef.current) {
                  await speakRef.current("I had trouble running that macro.");
                }
              }
            } else {
              // No macro found for the trigger despite intent detection
              addMessage("I detected a macro intent but couldn't find the definition.", 'iris');
            }
            setState('idle');
          } catch (error) {
            console.error('[IRIS] Macro error:', error);
            addMessage("I had trouble with that macro.", 'iris');
            setState('idle');
          }
          return;
        }

        if (lowerMessage.includes('spear mode') || lowerMessage.includes('spearmode')) {
          setSpearMode(true);
          addMessage(message, 'user');
          addMessage("Fast provider mode activated.", 'iris');
          setState('idle');
          return;
        }
        if (lowerMessage.includes('phalanx mode') || lowerMessage.includes('phalanxmode')) {
          setSpearMode(false);
          addMessage(message, 'user');
          addMessage("Standard provider mode activated.", 'iris');
          setState('idle');
          return;
        }

        // Monitor control (turn off, switch, ghost mode)
        const monitorIntent = checkMonitorIntent(message);
        if (monitorIntent) {
          addMessage(message, 'user');
          setState('thinking');
          try {
            if (monitorIntent.action === 'turn-off') {
              await executeSensitiveTool('turn_off_monitors', {});
              addMessage("Turning off the monitors!", 'iris');
            } else if (monitorIntent.action === 'switch') {
              const result = await invoke<string>('move_to_monitor', { target: monitorIntent.target || 'other' });
              addMessage(result, 'iris');
            } else if (monitorIntent.action === 'count') {
              const monitors = await invoke<Array<{ index: number; name: string }>>('get_monitors');
              addMessage(monitors.length === 1 ? "You have one monitor connected." : `You have ${monitors.length} monitors connected.`, 'iris');
            } else if (monitorIntent.action === 'ghost-on') {
              await toggleGhostMode(true);
              addMessage("Going ghost! Say 'be solid' to interact with me again.", 'iris');
            } else if (monitorIntent.action === 'ghost-off') {
              await toggleGhostMode(false);
              addMessage("I'm solid again! You can click me now.", 'iris');
            }
            setState('idle');
          } catch (e) {
            console.error('[IRIS] Monitor intent error:', e);
            addMessage("I had trouble with that command.", 'iris');
            setState('idle');
          }
          return;
        }

        // Movement intent
        const movementPosition = checkMovementIntent(message);
        if (movementPosition) {
          addMessage(message, 'user');
          try {
            await invoke('move_window', { position: movementPosition });
            addMessage("Moving!", 'iris');
            if (speakRef.current) {
              await speakRef.current("Moving!");
            }
            setState('idle');
          } catch (e) {
            addMessage("I couldn't move.", 'iris');
            setState('idle');
          }
          return;
        }

        // Structured model tool calls own action selection; keyword matching is intentionally disabled.
        // const launchApp = checkLaunchIntent(message);
        // if (launchApp) { ... }

        // Clipboard intent
        const clipboardAction = checkClipboardIntent(message);
        if (clipboardAction) {
          addMessage(message, 'user');
          setState('thinking');
          try {
            if (clipboardAction === 'read') {
              const response = await executeSensitiveTool('read_clipboard', {});
              const text = typeof response === 'object' && response && 'result' in response
                ? String((response as { result: unknown }).result ?? '')
                : '';
              addMessage(text ? `Clipboard: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"` : "Clipboard is empty.", 'iris');
            }
            setState('idle');
          } catch (e) {
            addMessage("Couldn't access clipboard.", 'iris');
            setState('idle');
          }
          return;
        }

        // Volume intent
        const volumeAction = checkVolumeIntent(message);
        if (volumeAction) {
          addMessage(message, 'user');
          setState('thinking');
          try {
            if (volumeAction.action === 'set' && volumeAction.value !== undefined) {
              await invoke('set_volume', { level: volumeAction.value });
              addMessage(`Volume set to ${volumeAction.value}%.`, 'iris');
            } else if (volumeAction.action === 'adjust') {
              await invoke('adjust_volume', { direction: volumeAction.direction });
              addMessage(`Volume ${volumeAction.direction === 'up' ? 'increased' : 'decreased'}.`, 'iris');
            }
            setState('idle');
          } catch (e) {
            addMessage("Couldn't adjust volume.", 'iris');
            setState('idle');
          }
          return;
        }

        // Media control intent
        const mediaAction = checkMediaIntent(message);
        if (mediaAction) {
          addMessage(message, 'user');
          setState('thinking');
          try {
            await invoke('media_control', { action: mediaAction });
            addMessage(mediaAction === 'play' ? "Playing!" : mediaAction === 'pause' ? "Paused." : `Media: ${mediaAction}`, 'iris');
            setState('idle');
          } catch (e) {
            addMessage("Couldn't control media.", 'iris');
            setState('idle');
          }
          return;
        }

        // System stats intent
        if (checkSystemStatsIntent(message)) {
          addMessage(message, 'user');
          setState('thinking');
          try {
            const stats = await invoke<{ cpu: number; memory: number; battery?: number }>('get_system_stats');
            addMessage(`CPU: ${stats.cpu.toFixed(1)}%, Memory: ${stats.memory.toFixed(1)}%${stats.battery ? `, Battery: ${stats.battery}%` : ''}`, 'iris');
            setState('idle');
          } catch (e) {
            addMessage("Couldn't get system stats.", 'iris');
            setState('idle');
          }
          return;
        }

        // Lock/Sleep intent
        const lockSleepAction = checkLockSleepIntent(message);
        if (lockSleepAction) {
          addMessage(message, 'user');
          setState('thinking');
          try {
            if (lockSleepAction === 'lock') {
              await executeSensitiveTool('lock_computer', {});
              addMessage("Locking computer!", 'iris');
            } else {
              await executeSensitiveTool('sleep_computer', {});
              addMessage("Going to sleep!", 'iris');
            }
            setState('idle');
          } catch (e) {
            addMessage("Couldn't do that.", 'iris');
            setState('idle');
          }
          return;
        }

        // URL intent
        const urlToOpen = checkUrlIntent(message);
        if (urlToOpen) {
          addMessage(message, 'user');
          setState('thinking');
          try {
            await executeSensitiveTool('open_url', { url: urlToOpen });
            addMessage("Opening that link!", 'iris');
            setState('idle');
          } catch (e) {
            addMessage("Couldn't open URL.", 'iris');
            setState('idle');
          }
          return;
        }

        // Structured model tool calls own action selection; keyword matching is intentionally disabled.
        // const searchQuery = checkSearchIntent(message);
        // if (searchQuery) { ... }

        // Close app intent
        const appToClose = checkCloseAppIntent(message);
        if (appToClose) {
          addMessage(message, 'user');
          setState('thinking');
          try {
            await executeSensitiveTool('close_app', { appName: appToClose });
            addMessage(`Closed ${appToClose}.`, 'iris');
            setState('idle');
          } catch (e) {
            addMessage(`Couldn't close ${appToClose}.`, 'iris');
            setState('idle');
          }
          return;
        }

        // Show desktop intent
        if (checkDesktopIntent(message)) {
          addMessage(message, 'user');
          setState('thinking');
          try {
            await invoke('show_desktop');
            addMessage("Showing desktop!", 'iris');
            setState('idle');
          } catch (e) {
            addMessage("Couldn't show desktop.", 'iris');
            setState('idle');
          }
          return;
        }

        // Time/Date intent
        const timeIntent = checkTimeIntent(message);
        if (timeIntent) {
          addMessage(message, 'user');
          setState('thinking');
          try {
            let response = '';
            if (timeIntent === 'time' || timeIntent === 'both') {
              const time = await invoke<string>('get_time');
              response = `It's ${time}`;
            }
            if (timeIntent === 'date' || timeIntent === 'both') {
              const date = await invoke<string>('get_date');
              response += response ? `, and today is ${date}.` : `Today is ${date}.`;
            }
            if (!response.endsWith('.')) response += '.';
            addMessage(response, 'iris');
            setState('delivering');
            if (voiceRepliesEnabled) await speakRef.current(response);
            setState('idle');
          } catch (e) {
            addMessage("Couldn't get the time.", 'iris');
            setState('idle');
          }
          return;
        }

        // Brightness intent
        const brightnessAction = checkBrightnessIntent(message);
        if (brightnessAction) {
          addMessage(message, 'user');
          setState('thinking');
          try {
            if (brightnessAction.action === 'set' && brightnessAction.value !== undefined) {
              await invoke('set_brightness', { level: brightnessAction.value });
              addMessage(`Brightness set to ${brightnessAction.value}%.`, 'iris');
            } else if (brightnessAction.action === 'adjust') {
              await invoke('adjust_brightness', { direction: brightnessAction.direction });
              addMessage(`Brightness ${brightnessAction.direction === 'up' ? 'increased' : 'decreased'}.`, 'iris');
            }
            setState('idle');
          } catch (e) {
            addMessage("Couldn't adjust brightness.", 'iris');
            setState('idle');
          }
          return;
        }

        // WiFi intent
        const wifiAction = checkWifiIntent(message);
        if (wifiAction) {
          addMessage(message, 'user');
          setState('thinking');
          try {
            const enabled = wifiAction === 'toggle' ? !await invoke<boolean>('get_wifi_status') : wifiAction === 'enable';
            await executeSensitiveTool('toggle_wifi', { enable: enabled });
            addMessage(`WiFi ${wifiAction === 'enable' ? 'enabled' : wifiAction === 'disable' ? 'disabled' : 'toggled'}.`, 'iris');
            setState('idle');
          } catch (e) {
            addMessage("Couldn't control WiFi.", 'iris');
            setState('idle');
          }
          return;
        }

        // Calculator intent
        const calcExpression = checkCalculatorIntent(message);
        if (calcExpression) {
          addMessage(message, 'user');
          setState('thinking');
          try {
             
            const result = evaluateArithmeticExpression(calcExpression.replace(/x/gi, '*').replace(/[\u00f7]/g, '/'));
            addMessage(`${calcExpression} = ${result}`, 'iris');
            setState('idle');
          } catch (e) {
            addMessage("Couldn't calculate that.", 'iris');
            setState('idle');
          }
          return;
        }

        addMessage(message, 'user');
      } else {
        // Deterministic smoke-test/provider tool syntax must not be reinterpreted
        // by calculator, macro, URL, or other local natural-language handlers.
        addMessage(message, 'user');
      }

      setIsLoading(true);
      setState('thinking');
      // setCanvasData(null); // Clear previous canvas data
      emit('update-canvas', { isVisible: false });

      try {
        const { text, canvas, toolCalls } = await solstice.query(message, {
          screenshot: webcamFrame || screenshot || undefined,
          isWebcam: !!webcamFrame,  // Flag when using webcam frame
          spearMode: spearMode,  // Provider speed preference
          history: messages.map(m => ({
            role: m.role === 'iris' ? 'model' : 'user',
            content: m.content
          }))
        });

        // Model text is presentation-only. Native actions arrive through structured tool calls.
        const cleanText = cleanResponseText(text);

        setState('delivering');
        await sleep(500);

        addMessage(cleanText, 'iris');

        // Listening and speaking are independent. Tap-to-talk deliberately stops
        // microphone capture after one utterance, but the resulting reply should
        // still use the configured voice unless the user selected Silent.
        if (voiceRepliesEnabled && cleanText && speakRef.current) {
          // Don't await - let TTS happen in background so UI stays responsive
          speakRef.current(cleanText).catch(err => console.error('[IRIS] TTS error:', err));
        }

        if (canvas) {
          console.log('[IRIS] Received canvas data, writing to localStorage:', canvas);
          localStorage.setItem('iris_canvas_data', JSON.stringify({ ...canvas, isVisible: true, timestamp: Date.now() }));
          emit('update-canvas', { ...canvas, isVisible: true });
          // Force wake up the canvas window
          invoke('show_canvas_window').catch(console.error);
        }

        if (toolCalls?.length) await executeProviderTools(toolCalls, message);

        setState('success');
        await sleep(800);
        setState('idle');

        // Clear screenshot after sending
        if (screenshot) {
          setScreenshot(null);
        }
      } catch (error) {
        console.error('[IRIS] Error:', error);
        addMessage("I encountered an error. Please try again.", 'iris');
        setState('error');
        await sleep(1500);
        setState('idle');
      } finally {
        setIsLoading(false);
      }
    },
    [solstice, screenshot, addMessage, setState, setScreenshot, cleanResponseText, voiceRepliesEnabled, webcam, executeProviderTools, captureScreenForChat]
  );

  useEffect(() => {
    handleSendMessageRef.current = handleSendMessage;
    return () => {
      handleSendMessageRef.current = null;
    };
  }, [handleSendMessage]);



  // Handle dragging the orb
  const handleOrbMouseDown = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      await appWindow.startDragging();
    } catch (err) {
      console.error('Drag error:', err);
    }
  };

  // Window controls
  const handleHide = () => invoke('hide_window');

  // Keep expanded only while settings open (not during loading - let particles respond)
  useEffect(() => {
    if (showSettings) {
      // Settings logic if needed
    }
  }, [showSettings]);

  const [showInput, setShowInput] = useState(false);

  // Remote companion command ingestion is intentionally absent in OSS v0.1.

  // Companion scout, visual acquisition, and remote network discovery are disabled.

  // Companion context ingestion and remote visual acquisition are disabled in OSS v0.1.

  return (
    <div
      className="w-full h-full relative bg-transparent flex items-center justify-end overflow-hidden"
      style={{ background: 'transparent' }}
    >
      {/* Hidden video element for webcam capture */}
      {/* eslint-disable react-hooks/refs -- callback ref, not a ref.current read */}
      <video
        ref={setWebcamVideoElement}
        autoPlay
        playsInline
        muted
        className="hidden"
      />
      {/* eslint-enable react-hooks/refs */}

      {/* Draggable + resizable camera preview - shows PIP when enabled or during vision capture */}
      {(presenceEnabled || cameraPreviewOnly || visionCaptureActive) && (
        <div
          className="absolute z-50 select-none"
          style={{
            right: cameraPosition.right,
            bottom: cameraPosition.bottom,
            width: cameraSize.width,
            height: cameraSize.height,
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const edgeSize = 8;
            const onLeft = x < edgeSize;
            const onRight = x > rect.width - edgeSize;
            const onTop = y < edgeSize;
            const onBottom = y > rect.height - edgeSize;
            const isResize = onLeft || onRight || onTop || onBottom;

            if (isResize) {
              // Resize mode
              const startX = e.clientX;
              const startY = e.clientY;
              const startW = cameraSize.width;
              const startH = cameraSize.height;
              const startRight = cameraPosition.right;
              const startBottom = cameraPosition.bottom;
              const minW = 120;
              const minH = 90;

              const onMouseMove = (ev: MouseEvent) => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                let newW = startW;
                let newH = startH;
                let newRight = startRight;
                let newBottom = startBottom;

                // Resizing from left edge expands width and shifts position
                if (onLeft) {
                  newW = Math.max(minW, startW - dx);
                } else if (onRight) {
                  newW = Math.max(minW, startW + dx);
                  newRight = Math.max(0, startRight - dx);
                }
                if (onTop) {
                  newH = Math.max(minH, startH - dy);
                } else if (onBottom) {
                  newH = Math.max(minH, startH + dy);
                  newBottom = Math.max(0, startBottom - dy);
                }

                setCameraSize({ width: newW, height: newH });
                setCameraPosition({ right: newRight, bottom: newBottom });
              };
              const onMouseUp = () => {
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
              };
              window.addEventListener('mousemove', onMouseMove);
              window.addEventListener('mouseup', onMouseUp);
            } else {
              // Drag/move mode
              setIsDraggingCamera(true);
              cameraDragStartRef.current = {
                mouseX: e.clientX,
                mouseY: e.clientY,
                startRight: cameraPosition.right,
                startBottom: cameraPosition.bottom,
              };

              const onMouseMove = (ev: MouseEvent) => {
                const deltaX = ev.clientX - cameraDragStartRef.current.mouseX;
                const deltaY = ev.clientY - cameraDragStartRef.current.mouseY;
                setCameraPosition({
                  right: Math.max(0, cameraDragStartRef.current.startRight - deltaX),
                  bottom: Math.max(0, cameraDragStartRef.current.startBottom - deltaY),
                });
              };
              const onMouseUp = () => {
                setIsDraggingCamera(false);
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
              };
              window.addEventListener('mousemove', onMouseMove);
              window.addEventListener('mouseup', onMouseUp);
            }
          }}
          onMouseMove={(e) => {
            // Dynamic cursor based on position near edges
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const edge = 8;
            const onL = x < edge;
            const onR = x > rect.width - edge;
            const onT = y < edge;
            const onB = y > rect.height - edge;
            const el = e.currentTarget as HTMLElement;

            if ((onT && onL) || (onB && onR)) el.style.cursor = 'nwse-resize';
            else if ((onT && onR) || (onB && onL)) el.style.cursor = 'nesw-resize';
            else if (onL || onR) el.style.cursor = 'ew-resize';
            else if (onT || onB) el.style.cursor = 'ns-resize';
            else el.style.cursor = 'move';
          }}
        >
          <video
            ref={attachPresenceVideo}
            autoPlay
            playsInline
            muted
            className="rounded-lg border-2 border-cyan-500/60 shadow-lg shadow-cyan-500/30 object-cover"
            style={{ width: '100%', height: '100%' }}
          />
          {/* Corner resize indicators */}
          <div className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-cyan-400/50 rounded-tl-lg pointer-events-none" />
          <div className="absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2 border-cyan-400/50 rounded-tr-lg pointer-events-none" />
          <div className="absolute bottom-0 left-0 w-3 h-3 border-b-2 border-l-2 border-cyan-400/50 rounded-bl-lg pointer-events-none" />
          <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-cyan-400/50 rounded-br-lg pointer-events-none" />
        </div>
      )}

      {/* Gesture Action Feedback - shows when a gesture triggers an action */}
      <AnimatePresence>
        {gestureActionFeedback && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: -20 }}
            className="absolute top-8 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-cyan-500/20 backdrop-blur-xl border border-cyan-500/40 shadow-lg"
          >
            <div className="flex items-center gap-2 text-cyan-400 text-sm font-medium">
              <span className="text-lg">
                {gestureActionFeedback.gesture === 'thumbs_up' && '👍'}
                {gestureActionFeedback.gesture === 'thumbs_down' && '👎'}
                {gestureActionFeedback.gesture === 'wave' && '👋'}
                {gestureActionFeedback.gesture === 'peace' && '✌️'}
                {gestureActionFeedback.gesture === 'fist' && '✊'}
                {gestureActionFeedback.gesture === 'open_palm' && '🖐️'}
                {gestureActionFeedback.gesture === 'ok_sign' && '👌'}
                {gestureActionFeedback.gesture === 'rock' && '🤘'}
                {gestureActionFeedback.gesture === 'point' && '👆'}
                {gestureActionFeedback.gesture === 'shush' && '🤫'}
                {gestureActionFeedback.gesture === 'swipe_left' && '👈'}
                {gestureActionFeedback.gesture === 'swipe_right' && '👉'}
                {gestureActionFeedback.gesture === 'swipe_up' && '👆'}
                {gestureActionFeedback.gesture === 'swipe_down' && '👇'}
                {gestureActionFeedback.gesture === 'call_me' && '🤙'}
                {gestureActionFeedback.gesture === 'pinch' && '🤏'}
              </span>
              <span className="capitalize">{gestureActionFeedback.action.replace(/_/g, ' ')}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Message Stack - positioned flexibly to the left of the orb */}
      <div className="z-20 h-full flex items-center justify-end pointer-events-none">
        <FloatingMessageStack
          messages={messages}
          isLoading={isLoading}
          screenshot={screenshot}
          onSendMessage={handleSendMessage}
          onRemoveScreenshot={() => setScreenshot(null)}
          onCaptureScreen={() => void captureScreenForChat(0)}
          voiceEnabled={voiceEnabled}
          onToggleVoice={() => {
            console.log('[IrisWindow] Toggling voice, current:', voiceEnabled);
            if (!voiceEnabled && !voiceInputReady) {
              const provider = voiceStatus.settings.sttProvider;
              setVoiceLastError(provider === 'disabled'
                ? 'Choose OpenAI or ElevenLabs under Speech to text, save the provider credential, then save voice settings.'
                : `Save a ${provider === 'openai' ? 'OpenAI' : 'ElevenLabs'} credential before starting voice input.`);
              setShowSettings(true);
              return;
            }
            setVoiceEnabled(prev => !prev);
          }}
          showInput={showInput}
          onToggleInput={() => setShowInput(!showInput)}
          onToggleSettings={() => setShowSettings(!showSettings)}
          onVisibilityChange={handleVisibilityChange}
        />
      </div>

      {/* Settings Panel - Floating Top Left */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className="absolute top-10 left-6 z-50 max-h-[540px] w-96 overflow-y-auto rounded-2xl border border-white/15 bg-black/90 p-4 shadow-2xl backdrop-blur-xl"
          >
            <div className="space-y-3">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-bold text-white/70 uppercase tracking-widest">Settings</span>
                <button onClick={() => setShowSettings(false)} className="text-white/50 hover:text-white"><X size={14} /></button>
              </div>

              <div>
                <label className="text-xs text-white/50 block mb-1">
                  Microphone (Native)
                </label>
                <select
                  value={selectedNativeDevice}
                  onChange={(e) => saveSelectedNativeDevice(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-sm focus:outline-none focus:border-cyan-500/50"
                >
                  <option value="">Default Microphone</option>
                  {nativeDevices.map((device) => (
                    <option key={device.name} value={device.name}>
                      {device.name} {device.is_default ? '(Default)' : ''}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-white/30 mt-1">
                  {nativeAudio.isCapturing ? 'Capturing' : 'Stopped'} - Level: {Math.round(nativeAudio.audioLevel * 100)}%
                </p>
              </div>

              <ReasoningSettingsPanel onProviderChange={solstice.refreshProvider} />
              <VoiceSettingsPanel
                key={JSON.stringify(voiceStatus.settings)}
                status={voiceStatus}
                onStatusChange={(next) => {
                  setVoiceStatus(next);
                  setVoiceLastError(null);
                  if (next.settings.inputMode === 'tap_to_talk') setVoiceEnabled(false);
                }}
                lastError={voiceLastError || voice.error}
              />
              {/* Camera Preview Only - lightweight, no MediaPipe */}
              <div className="flex items-center justify-between">
                <label className="text-xs text-white/50">
                  Camera Preview
                  <span className="block text-[10px] text-white/30">Show webcam (no AI - low memory)</span>
                </label>
                <button
                  onClick={async () => {
                    if (!cameraPreviewOnly) {
                      // Start webcam preview only (no MediaPipe)
                      try {
                        // Turn off presence mode if it was on
                        if (presenceEnabled) {
                          setPresenceEnabled(false);
                        }
                        // IMPORTANT: Set state FIRST so video element renders
                        setCameraPreviewOnly(true);
                        // Wait for React to render the video element
                        await sleep(100);
                        // Now create and assign the stream
                        const stream = await navigator.mediaDevices.getUserMedia({
                          video: { width: 640, height: 480, facingMode: 'user' }
                        });
                        if (presenceVideoRef.current) {
                          presenceVideoRef.current.srcObject = stream;
                          console.log('[IRIS] Camera preview stream assigned');
                        } else {
                          console.error('[IRIS] Video element not ready for camera preview');
                          stream.getTracks().forEach(t => t.stop());
                          setCameraPreviewOnly(false);
                        }
                      } catch (e) {
                        console.error('[IRIS] Failed to start camera preview:', e);
                        setCameraPreviewOnly(false);
                      }
                    } else {
                      // Stop webcam
                      if (presenceVideoRef.current?.srcObject) {
                        const stream = presenceVideoRef.current.srcObject as MediaStream;
                        stream.getTracks().forEach(t => t.stop());
                        presenceVideoRef.current.srcObject = null;
                      }
                      setCameraPreviewOnly(false);
                    }
                  }}
                  className={cn(
                    "w-10 h-5 rounded-full transition-colors relative",
                    cameraPreviewOnly ? "bg-green-500" : "bg-white/20"
                  )}
                >
                  <div className={cn(
                    "w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform",
                    cameraPreviewOnly ? "translate-x-5" : "translate-x-0.5"
                  )} />
                </button>
              </div>

              {/* Presence Detection Toggle (Phase 4) - Heavy, uses MediaPipe */}
              <div className="flex items-center justify-between">
                <label className="text-xs text-white/50">
                  Presence Detection
                  <span className="block text-[10px] text-white/30">Face & gesture AI (high memory)</span>
                </label>
                <button
                  onClick={async () => {
                    if (!presenceEnabled) {
                      // Turn off camera preview if it was on (will be replaced)
                      if (cameraPreviewOnly) {
                        // Stop existing preview stream first
                        if (presenceVideoRef.current?.srcObject) {
                          const oldStream = presenceVideoRef.current.srcObject as MediaStream;
                          oldStream.getTracks().forEach(t => t.stop());
                          presenceVideoRef.current.srcObject = null;
                        }
                        setCameraPreviewOnly(false);
                      }
                      // IMPORTANT: Set state FIRST so video element renders
                      setPresenceEnabled(true);
                      // Wait for React to render the video element
                      await sleep(100);
                      // Start webcam for presence detection
                      try {
                        const stream = await navigator.mediaDevices.getUserMedia({
                          video: { width: 640, height: 480, facingMode: 'user' }
                        });
                        if (presenceVideoRef.current) {
                          presenceVideoRef.current.srcObject = stream;
                          console.log('[IRIS] Presence camera stream assigned');
                        } else {
                          console.error('[IRIS] Video element not ready for presence');
                          stream.getTracks().forEach(t => t.stop());
                          setPresenceEnabled(false);
                        }
                      } catch (e) {
                        console.error('[IRIS] Failed to start presence camera:', e);
                        setPresenceEnabled(false);
                      }
                    } else {
                      // Stop webcam
                      if (presenceVideoRef.current?.srcObject) {
                        const stream = presenceVideoRef.current.srcObject as MediaStream;
                        stream.getTracks().forEach(t => t.stop());
                        presenceVideoRef.current.srcObject = null;
                      }
                      setPresenceEnabled(false);
                    }
                  }}
                  className={cn(
                    "w-10 h-5 rounded-full transition-colors relative",
                    presenceEnabled ? "bg-cyan-500" : "bg-white/20"
                  )}
                >
                  <div className={cn(
                    "w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform",
                    presenceEnabled ? "translate-x-5" : "translate-x-0.5"
                  )} />
                </button>
              </div>
              {presenceEnabled && (
                <p className="text-[10px] text-white/30">
                  {presence.faceDetected ? '👤 Face detected' : '⋯ Looking for face'}
                  {presence.handDetected && ' | 🖐 Hand detected'}
                  {presence.currentGesture && presence.currentGesture !== 'unknown' && ` | Gesture: ${presence.currentGesture}`}
                </p>
              )}

              {/* Provider speed preference */}
              <div className="flex items-center justify-between">
                <label className="text-xs text-white/50">
                  Spear Mode
                  <span className="block text-[10px] text-white/30">Prefer faster provider responses</span>
                </label>
                <button
                  onClick={() => {
                    setSpearMode(!spearMode);
                    console.log(`[IRIS] ${!spearMode ? 'Spear' : 'Phalanx'} mode activated`);
                  }}
                  className={cn(
                    "w-10 h-5 rounded-full transition-colors relative",
                    spearMode ? "bg-cyan-500" : "bg-white/20"
                  )}
                >
                  <div className={cn(
                    "w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform",
                    spearMode ? "translate-x-5" : "translate-x-0.5"
                  )} />
                </button>
              </div>

              {/* Grid Calibrator Button */}
              <button
                onClick={async () => {
                  try {
                    await invoke('show_grid_calibrator');
                  } catch (e) {
                    console.error('[IRIS] Failed to open Grid Calibrator:', e);
                  }
                }}
                className="w-full mt-2 px-3 py-2 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 text-xs font-medium hover:bg-cyan-500/30 transition-colors"
              >
                Open Grid Calibrator (Fullscreen)
              </button>

              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  onClick={clearMessages}
                  className="text-xs px-2 py-1 rounded bg-white/5 text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                >
                  Clear History
                </button>
                <button
                  onClick={handleHide}
                  className="text-xs px-2 py-1 rounded bg-white/5 text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                >
                  Hide Window
                </button>
                <button
                  onClick={() => setShowToolBuilder(true)}
                  className="text-xs px-2 py-1 rounded bg-indigo-500/20 text-indigo-300 hover:text-indigo-200 hover:bg-indigo-500/30 transition-colors"
                >
                  Capability Foundry
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tool Builder Panel */}
      <ToolBuilderPanel
        isOpen={showToolBuilder}
        onClose={() => setShowToolBuilder(false)}
      />

      {/* Central Orb - Right Side (Draggable) */}
      <div
        className="relative z-10 mr-32"
      >
        {/* Backlight glow removed as per user request */}

        <div
          onMouseDown={handleOrbMouseDown}
          onClick={() => setShowInput(true)} // Clicking orb opens chat input
          className={cn(
            "cursor-pointer transition-all duration-300 w-48 h-48 active:scale-95"
          )}
          title="Click to chat, drag to move"
        >
          <IrisParticles
            ref={particlesRef}
            state={state}
            className="w-full h-full"
            particleCount={1500}
            audioLevel={voiceEnabled ? nativeAudio.audioLevel : 0}
            irisAudioLevel={irisAudioLevel}
            isExec={isExec}
          />
        </div>
      </div>


      {/* Code Canvas - Left Side */}
      {/* Code Canvas - Left Side - MOVED TO SEPARATE WINDOW */}
      {/* Local rendering removed for multi-window support */}

    </div >
  );
}
