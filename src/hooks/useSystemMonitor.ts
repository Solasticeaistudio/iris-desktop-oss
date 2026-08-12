import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface SystemStats {
  cpu_usage: number;
  memory_used_gb: number;
  memory_total_gb: number;
  memory_percent: number;
  battery_percent: number | null;
  battery_charging: boolean | null;
}

export interface SystemAlert {
  alert_type: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  value: number;
  threshold: number;
}

export interface IrisSpeakEvent {
  text: string;
  priority: 'low' | 'normal' | 'high';
}

export interface MonitorThresholds {
  battery_low?: number;
  battery_critical?: number;
  memory_high?: number;
  memory_critical?: number;
  cpu_high?: number;
  cpu_sustained_seconds?: number;
}

interface UseSystemMonitorOptions {
  enabled?: boolean;
  thresholds?: MonitorThresholds;
  onAlert?: (alert: SystemAlert) => void;
  onSpeak?: (event: IrisSpeakEvent) => void;
  onStatsUpdate?: (stats: SystemStats) => void;
}

export function useSystemMonitor({
  enabled = true,
  thresholds,
  onAlert,
  onSpeak,
  onStatsUpdate,
}: UseSystemMonitorOptions = {}) {
  const [isRunning, setIsRunning] = useState(false);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [lastAlert, setLastAlert] = useState<SystemAlert | null>(null);
  const speakQueueRef = useRef<IrisSpeakEvent[]>([]);
  const isSpeakingRef = useRef(false);

  // Process speak queue (ensures we don't overlap speech)
  const processSpeakQueue = useCallback(async () => {
    if (isSpeakingRef.current || speakQueueRef.current.length === 0) return;

    isSpeakingRef.current = true;
    const event = speakQueueRef.current.shift();

    if (event && onSpeak) {
      console.log('[SystemMonitor] Speaking:', event.text);
      await onSpeak(event);
    }

    isSpeakingRef.current = false;

    // Process next item if queue has more
    if (speakQueueRef.current.length > 0) {
      setTimeout(processSpeakQueue, 500);
    }
  }, [onSpeak]);

  // Queue speech (prioritized)
  const queueSpeak = useCallback((event: IrisSpeakEvent) => {
    // High priority goes to front, low priority goes to back
    if (event.priority === 'high') {
      speakQueueRef.current.unshift(event);
    } else {
      speakQueueRef.current.push(event);
    }
    processSpeakQueue();
  }, [processSpeakQueue]);

  // Start the monitor
  const startMonitor = useCallback(async () => {
    try {
      console.log('[SystemMonitor] Starting with thresholds:', thresholds);
      await invoke('start_system_monitor', { thresholds: thresholds || null });
      setIsRunning(true);
      console.log('[SystemMonitor] Started successfully');
    } catch (e) {
      console.error('[SystemMonitor] Failed to start:', e);
    }
  }, [thresholds]);

  // Stop the monitor
  const stopMonitor = useCallback(async () => {
    try {
      await invoke('stop_system_monitor');
      setIsRunning(false);
      console.log('[SystemMonitor] Stopped');
    } catch (e) {
      console.error('[SystemMonitor] Failed to stop:', e);
    }
  }, []);

  // Get current stats manually
  const getStats = useCallback(async (): Promise<SystemStats | null> => {
    try {
      const result = await invoke<SystemStats>('get_system_stats');
      setStats(result);
      return result;
    } catch (e) {
      console.error('[SystemMonitor] Failed to get stats:', e);
      return null;
    }
  }, []);

  // Check if monitor is running
  const checkRunning = useCallback(async () => {
    try {
      const running = await invoke<boolean>('is_system_monitor_running');
      setIsRunning(running);
      return running;
    } catch (e) {
      console.error('[SystemMonitor] Failed to check status:', e);
      return false;
    }
  }, []);

  // Setup event listeners and auto-start
  useEffect(() => {
    if (!enabled) return;

    const unlisteners: UnlistenFn[] = [];

    const setup = async () => {
      // Listen for system stats updates
      const unlistenStats = await listen<SystemStats>('system-stats', (event) => {
        setStats(event.payload);
        onStatsUpdate?.(event.payload);
      });
      unlisteners.push(unlistenStats);

      // Listen for system alerts
      const unlistenAlert = await listen<SystemAlert>('system-alert', (event) => {
        console.log('[SystemMonitor] Alert received:', event.payload);
        setLastAlert(event.payload);
        onAlert?.(event.payload);
      });
      unlisteners.push(unlistenAlert);

      // Listen for IRIS speak requests (proactive speech)
      const unlistenSpeak = await listen<IrisSpeakEvent>('iris-speak', (event) => {
        console.log('[SystemMonitor] Speak request:', event.payload);
        queueSpeak(event.payload);
      });
      unlisteners.push(unlistenSpeak);

      // Check if already running, if not start it
      const alreadyRunning = await checkRunning();
      if (!alreadyRunning) {
        await startMonitor();
      }
    };

    setup();

    return () => {
      unlisteners.forEach((unlisten) => unlisten());
      // Note: We don't stop the monitor on unmount - it should keep running
      // Only stop it explicitly when the app closes
    };
  }, [enabled, onAlert, onStatsUpdate, queueSpeak, checkRunning, startMonitor]);

  return {
    isRunning,
    stats,
    lastAlert,
    startMonitor,
    stopMonitor,
    getStats,
    checkRunning,
  };
}

// Helper hook for getting formatted system info string
export function useFormattedSystemInfo(stats: SystemStats | null): string {
  if (!stats) return '';

  const parts: string[] = [];

  parts.push(`CPU: ${stats.cpu_usage.toFixed(0)}%`);
  parts.push(`RAM: ${stats.memory_used_gb.toFixed(1)}/${stats.memory_total_gb.toFixed(1)}GB (${stats.memory_percent.toFixed(0)}%)`);

  if (stats.battery_percent !== null) {
    const charging = stats.battery_charging ? ' ⚡' : '';
    parts.push(`Battery: ${stats.battery_percent}%${charging}`);
  }

  return parts.join(' | ');
}
