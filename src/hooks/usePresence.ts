/**
 * usePresence - Phase 4 Vision Upgrade: Presence Detection
 *
 * Uses MediaPipe for:
 * - Face detection (presence awareness)
 * - Hand tracking (gesture recognition)
 * - Attention detection (is user looking at screen)
 * - Motion tracking (swipes, waves)
 *
 * This allows IRIS to be aware of the user's presence and respond accordingly:
 * - Wake up when user sits down
 * - Notice when user is looking at screen
 * - Recognize gestures like wave, thumbs up, shush, swipes
 *
 * REQUIREMENTS:
 * - npm install @mediapipe/tasks-vision
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { GestureType } from './useGestureActions';

// Re-export GestureType for convenience
export type { GestureType };

// Legacy type alias for backwards compatibility
export type Gesture = GestureType;

// Types for MediaPipe results
export interface FaceDetection {
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  confidence: number;
  landmarks?: Array<{ x: number; y: number; z?: number }>;
}

export interface HandDetection {
  handedness: 'Left' | 'Right';
  confidence: number;
  landmarks: Array<{ x: number; y: number; z: number }>;
}

export interface PresenceState {
  isPresent: boolean;          // Is someone in frame
  faceDetected: boolean;       // Is a face detected
  faceLookingAtScreen: boolean; // Is the face oriented toward the screen
  handDetected: boolean;       // Is a hand detected
  currentGesture: GestureType | null;
  presenceDuration: number;    // How long the person has been present (ms)
  absenceDuration: number;     // How long since last presence (ms)
  handPosition: { x: number; y: number } | null; // Current hand position (normalized 0-1)
  gestureConfidence: number;   // Confidence in the detected gesture (0-1)
}

interface UsePresenceOptions {
  enabled?: boolean;
  videoElement?: HTMLVideoElement | null;
  onPresenceChange?: (isPresent: boolean) => void;
  onGesture?: (gesture: GestureType) => void;
  onAttention?: (isLooking: boolean) => void;
  onHandMove?: (position: { x: number; y: number }, velocity: { x: number; y: number }) => void;
  // Tuning parameters
  gestureHoldFrames?: number;      // Frames to hold a gesture before triggering (default: 3)
  swipeThreshold?: number;         // Min velocity for swipe detection (default: 0.15)
  swipeCooldown?: number;          // ms between swipe detections (default: 500)
  detectionFps?: number;           // Target FPS for detection loop (default: 12) - lower = less CPU
}

// MediaPipe model paths. WASM is bundled from the exact installed JS package;
// only the task model files are fetched from Google's narrowly allowed origin.
const MEDIAPIPE_WASM_ROOT = '/mediapipe/wasm';
const FACE_DETECTOR_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
const HAND_LANDMARKER_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Hand landmark indices (21 points per hand)
// https://developers.google.com/mediapipe/solutions/vision/hand_landmarker
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_TIP = 12;
const RING_MCP = 13;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_TIP = 20;

// Motion history for tracking
interface MotionFrame {
  timestamp: number;
  wristPos: { x: number; y: number };
  palmCenter: { x: number; y: number };
}

export function usePresence({
  enabled = true,
  videoElement,
  onPresenceChange,
  onGesture,
  onAttention,
  onHandMove,
  gestureHoldFrames = 3,
  swipeThreshold = 0.15,
  swipeCooldown = 500,
  detectionFps = 12, // 12 FPS is plenty for presence - saves CPU/GPU
}: UsePresenceOptions = {}) {
  const [state, setState] = useState<PresenceState>({
    isPresent: false,
    faceDetected: false,
    faceLookingAtScreen: false,
    handDetected: false,
    currentGesture: null,
    presenceDuration: 0,
    absenceDuration: 0,
    handPosition: null,
    gestureConfidence: 0,
  });

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMediaPipeLoaded, setIsMediaPipeLoaded] = useState(false);

  // Refs for MediaPipe objects
  const faceDetectorRef = useRef<any>(null);
  const handLandmarkerRef = useRef<any>(null);
  const animationFrameRef = useRef<number>(0);
  const presenceStartRef = useRef<number | null>(null);
  const absenceStartRef = useRef<number | null>(null);

  // Gesture tracking refs
  const lastGestureRef = useRef<GestureType | null>(null);
  const gestureHoldCountRef = useRef<number>(0);
  const gestureDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Motion tracking refs
  const motionHistoryRef = useRef<MotionFrame[]>([]);
  const lastSwipeTimeRef = useRef<number>(0);
  const MOTION_HISTORY_SIZE = 10; // Keep last 10 frames

  // Frame rate limiting refs
  const lastDetectionTimeRef = useRef<number>(0);

  // Load MediaPipe models
  const loadMediaPipe = useCallback(async () => {
    if (isMediaPipeLoaded) return true;

    setIsLoading(true);
    setError(null);

    try {
      // Dynamically import MediaPipe
      const vision = await import('@mediapipe/tasks-vision');
      const { FaceDetector, HandLandmarker, FilesetResolver } = vision;

      // Initialize the vision wasm
      const wasmFileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);

      // Create face detector
      faceDetectorRef.current = await FaceDetector.createFromOptions(wasmFileset, {
        baseOptions: {
          modelAssetPath: FACE_DETECTOR_MODEL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.5,
      });

      // Create hand landmarker
      handLandmarkerRef.current = await HandLandmarker.createFromOptions(wasmFileset, {
        baseOptions: {
          modelAssetPath: HAND_LANDMARKER_MODEL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      setIsMediaPipeLoaded(true);
      console.log('[Presence] MediaPipe loaded successfully');
      return true;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Failed to load MediaPipe';
      setError(errorMsg);
      console.error('[Presence] Failed to load MediaPipe:', e);

      if (errorMsg.includes("Cannot find module '@mediapipe/tasks-vision'")) {
        console.warn('[Presence] MediaPipe not installed. Run: npm install @mediapipe/tasks-vision');
      }
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [isMediaPipeLoaded]);

  // Calculate palm center from landmarks
  const getPalmCenter = useCallback((landmarks: Array<{ x: number; y: number; z: number }>) => {
    const palmLandmarks = [WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP];
    const sum = palmLandmarks.reduce(
      (acc, idx) => ({
        x: acc.x + landmarks[idx].x,
        y: acc.y + landmarks[idx].y,
      }),
      { x: 0, y: 0 }
    );
    return {
      x: sum.x / palmLandmarks.length,
      y: sum.y / palmLandmarks.length,
    };
  }, []);

  // Detect swipe gestures from motion history
  const detectSwipe = useCallback((): GestureType | null => {
    const now = Date.now();
    if (now - lastSwipeTimeRef.current < swipeCooldown) return null;

    const history = motionHistoryRef.current;
    if (history.length < 5) return null;

    // Get recent positions (last 5 frames, ~150ms at 30fps)
    const recent = history.slice(-5);
    const oldest = recent[0];
    const newest = recent[recent.length - 1];

    const deltaTime = (newest.timestamp - oldest.timestamp) / 1000; // seconds
    if (deltaTime < 0.05) return null; // Too fast, might be noise

    const deltaX = newest.palmCenter.x - oldest.palmCenter.x;
    const deltaY = newest.palmCenter.y - oldest.palmCenter.y;

    const velocityX = deltaX / deltaTime;
    const velocityY = deltaY / deltaTime;

    // Check for swipes (velocity > threshold)
    if (Math.abs(velocityX) > swipeThreshold && Math.abs(velocityX) > Math.abs(velocityY)) {
      lastSwipeTimeRef.current = now;
      return velocityX > 0 ? 'swipe_right' : 'swipe_left';
    }

    if (Math.abs(velocityY) > swipeThreshold && Math.abs(velocityY) > Math.abs(velocityX)) {
      lastSwipeTimeRef.current = now;
      return velocityY > 0 ? 'swipe_down' : 'swipe_up';
    }

    return null;
  }, [swipeCooldown, swipeThreshold]);

  // Detect wave gesture from motion history
  const detectWave = useCallback((_landmarks: Array<{ x: number; y: number; z: number }>): boolean => {
    const history = motionHistoryRef.current;
    if (history.length < 8) return false;

    // Check for oscillating X movement (waving)
    const recent = history.slice(-8);
    let directionChanges = 0;
    let lastDirection = 0;

    for (let i = 1; i < recent.length; i++) {
      const dx = recent[i].wristPos.x - recent[i - 1].wristPos.x;
      const direction = Math.sign(dx);

      if (direction !== 0 && direction !== lastDirection && lastDirection !== 0) {
        directionChanges++;
      }
      if (direction !== 0) lastDirection = direction;
    }

    // Wave = at least 2 direction changes + open palm
    return directionChanges >= 2;
  }, []);

  // Detect gesture from hand landmarks
  const detectGesture = useCallback((landmarks: Array<{ x: number; y: number; z: number }>): { gesture: GestureType; confidence: number } => {
    if (landmarks.length < 21) return { gesture: 'unknown', confidence: 0 };

    const wrist = landmarks[WRIST];
    const thumbTip = landmarks[THUMB_TIP];
    const indexTip = landmarks[INDEX_TIP];
    const indexMcp = landmarks[INDEX_MCP];
    const middleTip = landmarks[MIDDLE_TIP];
    const middleMcp = landmarks[MIDDLE_MCP];
    const ringTip = landmarks[RING_TIP];
    const ringMcp = landmarks[RING_MCP];
    const pinkyTip = landmarks[PINKY_TIP];
    const pinkyMcp = landmarks[PINKY_MCP];

    // Calculate finger extension (tip higher/further than MCP)
    const isIndexExtended = indexTip.y < indexMcp.y - 0.04;
    const isMiddleExtended = middleTip.y < middleMcp.y - 0.04;
    const isRingExtended = ringTip.y < ringMcp.y - 0.04;
    const isPinkyExtended = pinkyTip.y < pinkyMcp.y - 0.04;

    // Thumb extension (horizontal distance from wrist)
    const thumbExtension = Math.abs(thumbTip.x - wrist.x);
    const isThumbExtended = thumbExtension > 0.08;
    const isThumbUp = isThumbExtended && thumbTip.y < wrist.y - 0.08;
    const isThumbDown = isThumbExtended && thumbTip.y > wrist.y + 0.08;
    const isThumbOut = isThumbExtended && Math.abs(thumbTip.y - wrist.y) < 0.1;

    // Count extended fingers (excluding thumb)
    const extendedFingers = [isIndexExtended, isMiddleExtended, isRingExtended, isPinkyExtended];
    const extendedCount = extendedFingers.filter(Boolean).length;

    // Check for pinch (thumb and index tips close together)
    const thumbIndexDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
    const isPinching = thumbIndexDist < 0.05;

    // Check for OK sign (thumb and index form circle, others extended)
    const isOkSign = isPinching && isMiddleExtended && isRingExtended && isPinkyExtended;

    // Check for finger-to-lips (shush) - index tip near face center, above wrist
    const isShush = isIndexExtended && !isMiddleExtended && !isRingExtended && !isPinkyExtended &&
      indexTip.y < wrist.y - 0.15 && Math.abs(indexTip.x - 0.5) < 0.15;

    // Check for rock sign (index and pinky extended, middle and ring curled)
    const isRock = isIndexExtended && !isMiddleExtended && !isRingExtended && isPinkyExtended && isThumbOut;

    // Check for call me (thumb and pinky extended, others curled)
    const isCallMe = !isIndexExtended && !isMiddleExtended && !isRingExtended && isPinkyExtended && isThumbOut;

    // Detect gestures in order of specificity
    let gesture: GestureType = 'unknown';
    let confidence = 0;

    // Check for wave first (requires motion + open palm)
    if (extendedCount >= 3 && isThumbExtended && detectWave(landmarks)) {
      gesture = 'wave';
      confidence = 0.85;
    }
    // Shush - high priority
    else if (isShush) {
      gesture = 'shush';
      confidence = 0.9;
    }
    // OK sign
    else if (isOkSign) {
      gesture = 'ok_sign';
      confidence = 0.85;
    }
    // Pinch (without other fingers extended)
    else if (isPinching && extendedCount <= 1) {
      gesture = 'pinch';
      confidence = 0.8;
    }
    // Rock sign
    else if (isRock) {
      gesture = 'rock';
      confidence = 0.85;
    }
    // Call me
    else if (isCallMe) {
      gesture = 'call_me';
      confidence = 0.8;
    }
    // Thumbs up
    else if (isThumbUp && extendedCount === 0) {
      gesture = 'thumbs_up';
      confidence = 0.9;
    }
    // Thumbs down
    else if (isThumbDown && extendedCount === 0) {
      gesture = 'thumbs_down';
      confidence = 0.9;
    }
    // Peace sign (V)
    else if (isIndexExtended && isMiddleExtended && !isRingExtended && !isPinkyExtended && !isThumbExtended) {
      gesture = 'peace';
      confidence = 0.85;
    }
    // Pointing
    else if (isIndexExtended && !isMiddleExtended && !isRingExtended && !isPinkyExtended) {
      gesture = 'point';
      confidence = 0.85;
    }
    // Open palm
    else if (extendedCount >= 4 && isThumbExtended) {
      gesture = 'open_palm';
      confidence = 0.8;
    }
    // Fist
    else if (extendedCount === 0 && !isThumbExtended) {
      gesture = 'fist';
      confidence = 0.85;
    }

    return { gesture, confidence };
  }, [detectWave]);

  // Main detection loop
  const runDetection = useCallback(async () => {
    if (!enabled || !videoElement || !faceDetectorRef.current) {
      return;
    }

    const now = Date.now();

    // Frame rate limiting - skip if not enough time has passed
    const minFrameInterval = 1000 / detectionFps;
    if (now - lastDetectionTimeRef.current < minFrameInterval) {
      // Schedule next check but skip this detection
      animationFrameRef.current = requestAnimationFrame(runDetection);
      return;
    }
    lastDetectionTimeRef.current = now;
    let faceDetected = false;
    let faceLookingAtScreen = false;
    let handDetected = false;
    let currentGesture: GestureType | null = null;
    let handPosition: { x: number; y: number } | null = null;
    let gestureConfidence = 0;

    try {
      // Face detection
      if (faceDetectorRef.current && videoElement.readyState >= 2) {
        const faceResults = faceDetectorRef.current.detectForVideo(videoElement, now);

        if (faceResults.detections && faceResults.detections.length > 0) {
          faceDetected = true;

          const face = faceResults.detections[0];
          const bbox = face.boundingBox;
          const centerX = bbox.originX + bbox.width / 2;
          const videoWidth = videoElement.videoWidth;

          faceLookingAtScreen = centerX > videoWidth * 0.25 && centerX < videoWidth * 0.75;
        }
      }

      // Hand detection
      if (handLandmarkerRef.current && videoElement.readyState >= 2) {
        const handResults = handLandmarkerRef.current.detectForVideo(videoElement, now);

        if (handResults.landmarks && handResults.landmarks.length > 0) {
          handDetected = true;
          const landmarks = handResults.landmarks[0];

          // Calculate hand position
          const palmCenter = getPalmCenter(landmarks);
          handPosition = palmCenter;

          // Update motion history
          motionHistoryRef.current.push({
            timestamp: now,
            wristPos: { x: landmarks[WRIST].x, y: landmarks[WRIST].y },
            palmCenter,
          });

          // Keep only recent history
          if (motionHistoryRef.current.length > MOTION_HISTORY_SIZE) {
            motionHistoryRef.current.shift();
          }

          // Calculate velocity for onHandMove callback
          if (onHandMove && motionHistoryRef.current.length >= 2) {
            const prev = motionHistoryRef.current[motionHistoryRef.current.length - 2];
            const dt = (now - prev.timestamp) / 1000;
            if (dt > 0) {
              const velocity = {
                x: (palmCenter.x - prev.palmCenter.x) / dt,
                y: (palmCenter.y - prev.palmCenter.y) / dt,
              };
              onHandMove(palmCenter, velocity);
            }
          }

          // Check for swipe first
          const swipeGesture = detectSwipe();
          if (swipeGesture) {
            currentGesture = swipeGesture;
            gestureConfidence = 0.9;
          } else {
            // Detect static gesture
            const detection = detectGesture(landmarks);
            currentGesture = detection.gesture;
            gestureConfidence = detection.confidence;
          }
        } else {
          // No hand detected - clear motion history
          motionHistoryRef.current = [];
        }
      }
    } catch (e) {
      console.error('[Presence] Detection error:', e);
    }

    // Update presence state
    const isPresent = faceDetected || handDetected;
    const wasPresent = state.isPresent;

    // Track presence/absence duration
    let presenceDuration = 0;
    let absenceDuration = 0;

    if (isPresent && !wasPresent) {
      presenceStartRef.current = now;
      absenceStartRef.current = null;
      onPresenceChange?.(true);
    } else if (!isPresent && wasPresent) {
      absenceStartRef.current = now;
      presenceStartRef.current = null;
      onPresenceChange?.(false);
    }

    if (presenceStartRef.current) {
      presenceDuration = now - presenceStartRef.current;
    }
    if (absenceStartRef.current) {
      absenceDuration = now - absenceStartRef.current;
    }

    // Handle gesture changes with hold requirement
    if (currentGesture && currentGesture !== 'unknown') {
      if (currentGesture === lastGestureRef.current) {
        // Same gesture - increment hold count
        gestureHoldCountRef.current++;

        // Trigger if held long enough
        if (gestureHoldCountRef.current === gestureHoldFrames) {
          if (gestureDebounceRef.current) {
            clearTimeout(gestureDebounceRef.current);
          }

          gestureDebounceRef.current = setTimeout(() => {
            onGesture?.(currentGesture!);
            console.log('[Presence] Gesture confirmed:', currentGesture);
          }, 50);
        }
      } else {
        // New gesture - reset hold count
        gestureHoldCountRef.current = 1;
        lastGestureRef.current = currentGesture;
      }
    } else {
      // No gesture or unknown - reset
      gestureHoldCountRef.current = 0;
      lastGestureRef.current = null;
    }

    // Handle attention changes
    if (faceLookingAtScreen !== state.faceLookingAtScreen) {
      onAttention?.(faceLookingAtScreen);
    }

    setState({
      isPresent,
      faceDetected,
      faceLookingAtScreen,
      handDetected,
      currentGesture,
      presenceDuration,
      absenceDuration,
      handPosition,
      gestureConfidence,
    });

    // Continue loop
    if (enabled) {
      animationFrameRef.current = requestAnimationFrame(runDetection);
    }
  }, [enabled, videoElement, state, detectGesture, detectSwipe, getPalmCenter, gestureHoldFrames, detectionFps, onPresenceChange, onGesture, onAttention, onHandMove]);

  // Initialize and start detection
  useEffect(() => {
    if (!enabled) return;

    let isMounted = true;

    const init = async () => {
      const loaded = await loadMediaPipe();
      if (!loaded || !isMounted) return;

      if (videoElement) {
        runDetection();
      }
    };

    init();

    return () => {
      isMounted = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (gestureDebounceRef.current) {
        clearTimeout(gestureDebounceRef.current);
      }
    };
  }, [enabled, videoElement, loadMediaPipe, runDetection]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (faceDetectorRef.current) {
        faceDetectorRef.current.close?.();
      }
      if (handLandmarkerRef.current) {
        handLandmarkerRef.current.close?.();
      }
    };
  }, []);

  return {
    ...state,
    isLoading,
    error,
    isMediaPipeLoaded,
    loadMediaPipe,
  };
}

// Helper hook to get gesture-based IRIS responses (legacy compatibility)
export function useGestureResponses() {
  const getResponse = useCallback((gesture: GestureType): string | null => {
    switch (gesture) {
      case 'wave':
        return "Hey there! I see you waving.";
      case 'thumbs_up':
        return "Glad you approve!";
      case 'thumbs_down':
        return "I'll try to do better.";
      case 'peace':
        return "Peace!";
      case 'open_palm':
        return "I see you. What can I help with?";
      case 'point':
        return "You're pointing at something. Should I take a look?";
      case 'shush':
        return null; // Silent acknowledgment - IRIS goes quiet
      case 'fist':
        return "Fist bump! Let's do this.";
      case 'ok_sign':
        return "Perfect!";
      case 'rock':
        return "Rock on! 🤘";
      case 'call_me':
        return "Call me anytime!";
      case 'pinch':
        return null; // Usually used for control, not verbal response
      case 'swipe_left':
      case 'swipe_right':
      case 'swipe_up':
      case 'swipe_down':
        return null; // Swipes are actions, not verbal
      default:
        return null;
    }
  }, []);

  return { getResponse };
}
