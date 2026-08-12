import { useState, useRef, useCallback, useEffect } from 'react';

export interface VideoDevice {
  deviceId: string;
  label: string;
}

// Get list of available video input devices
export async function getVideoDevices(): Promise<VideoDevice[]> {
  try {
    // Need to request permission first to get device labels
    await navigator.mediaDevices.getUserMedia({ video: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(d => d.kind === 'videoinput')
      .map(d => ({
        deviceId: d.deviceId,
        label: d.label || `Camera ${d.deviceId.substring(0, 8)}`,
      }));
  } catch (e) {
    console.error('[Webcam] Failed to enumerate devices:', e);
    return [];
  }
}

interface UseWebcamOptions {
  deviceId?: string; // Specific camera device ID
  width?: number;    // Desired width (default 1280)
  height?: number;   // Desired height (default 720)
  onFrame?: (imageData: string) => void; // Callback when frame is captured
  autoStart?: boolean; // Start camera automatically (default false)
}

export function useWebcam({
  deviceId,
  width = 1280,
  height = 720,
  onFrame,
  autoStart = false,
}: UseWebcamOptions = {}) {
  const [isActive, setIsActive] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentDevice, setCurrentDevice] = useState<string | null>(null);

  // Refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Initialize video stream
  const startVideo = useCallback(async (specificDeviceId?: string) => {
    try {
      setError(null);

      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: width },
        height: { ideal: height },
        facingMode: 'user', // Front camera by default
      };

      // Use specific device if provided
      const targetDeviceId = specificDeviceId || deviceId;
      if (targetDeviceId) {
        videoConstraints.deviceId = { exact: targetDeviceId };
        console.log('[Webcam] Using specific device:', targetDeviceId);
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
      });

      streamRef.current = stream;

      // If we have a video element ref, attach the stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // Track which device we're using
      const videoTrack = stream.getVideoTracks()[0];
      const settings = videoTrack.getSettings();
      setCurrentDevice(settings.deviceId || targetDeviceId || 'default');

      console.log('[Webcam] Video stream initialized');
      console.log('[Webcam] Track settings:', {
        width: settings.width,
        height: settings.height,
        deviceId: settings.deviceId,
        facingMode: settings.facingMode,
      });

      setIsActive(true);
      return true;
    } catch (e) {
      console.error('[Webcam] Failed to initialize video:', e);
      setError(e instanceof Error ? e.message : 'Camera access denied');
      return false;
    }
  }, [deviceId, width, height]);

  // Stop video stream
  const stopVideo = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log('[Webcam] Stopped track:', track.label);
      });
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsActive(false);
    setCurrentDevice(null);
    console.log('[Webcam] Video stream stopped');
  }, []);

  // Capture a single frame as base64
  const captureFrame = useCallback(async (format: 'jpeg' | 'png' = 'jpeg', quality: number = 0.8): Promise<string | null> => {
    // Check stream directly instead of isActive state (React state updates are async)
    if (!videoRef.current || !streamRef.current) {
      console.warn('[Webcam] Cannot capture frame - video not active (videoRef:', !!videoRef.current, ', streamRef:', !!streamRef.current, ')');
      return null;
    }

    setIsCapturing(true);

    try {
      // Create canvas if needed
      if (!canvasRef.current) {
        canvasRef.current = document.createElement('canvas');
      }

      const video = videoRef.current;
      const canvas = canvasRef.current;

      // Match canvas size to video dimensions
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      // Draw current video frame to canvas
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Could not get canvas context');
      }

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Convert to base64
      const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
      const dataUrl = canvas.toDataURL(mimeType, quality);

      // Extract base64 portion (remove data:image/xxx;base64, prefix)
      const base64 = dataUrl.split(',')[1];

      console.log('[Webcam] Frame captured:', {
        width: canvas.width,
        height: canvas.height,
        format,
        size: Math.round(base64.length * 0.75 / 1024) + 'KB',
      });

      // Call callback if provided
      onFrame?.(base64);

      return base64;
    } catch (e) {
      console.error('[Webcam] Failed to capture frame:', e);
      return null;
    } finally {
      setIsCapturing(false);
    }
  }, [onFrame]);  // Removed isActive dep - we check streamRef directly now

  // Capture frame as Blob (useful for FormData uploads)
  const captureFrameAsBlob = useCallback(async (format: 'jpeg' | 'png' = 'jpeg', quality: number = 0.8): Promise<Blob | null> => {
    if (!videoRef.current || !isActive) {
      console.warn('[Webcam] Cannot capture frame - video not active');
      return null;
    }

    return new Promise((resolve) => {
      try {
        if (!canvasRef.current) {
          canvasRef.current = document.createElement('canvas');
        }

        const video = videoRef.current!;
        const canvas = canvasRef.current;

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
        canvas.toBlob((blob) => {
          resolve(blob);
        }, mimeType, quality);
      } catch (e) {
        console.error('[Webcam] Failed to capture frame as blob:', e);
        resolve(null);
      }
    });
  }, [isActive]);

  // Switch to a different camera
  const switchCamera = useCallback(async (newDeviceId: string) => {
    stopVideo();
    await startVideo(newDeviceId);
  }, [stopVideo, startVideo]);

  // Toggle camera on/off
  const toggleVideo = useCallback(async () => {
    if (isActive) {
      stopVideo();
    } else {
      await startVideo();
    }
  }, [isActive, stopVideo, startVideo]);

  // Auto-start if requested
  useEffect(() => {
    if (autoStart) {
      startVideo();
    }

    return () => {
      stopVideo();
    };
  }, [autoStart]);

  // Set video element ref (for attaching to a <video> element)
  const setVideoElement = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;

    // If we already have a stream, attach it
    if (element && streamRef.current) {
      element.srcObject = streamRef.current;
      element.play().catch(console.error);
    }
  }, []);

  return {
    // State
    isActive,
    isCapturing,
    error,
    currentDevice,

    // Actions
    startVideo,
    stopVideo,
    toggleVideo,
    captureFrame,
    captureFrameAsBlob,
    switchCamera,

    // Refs
    videoRef,
    setVideoElement,
  };
}
