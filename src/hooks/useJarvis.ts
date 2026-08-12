/**
 * useJarvis - JARVIS Mode for IRIS
 *
 * Proactive intelligence that observes and speaks up when relevant.
 * Monitors system state, patterns, and context to offer helpful insights.
 *
 * Triggers:
 * - Battery < 20% → "Battery getting low"
 * - Meeting in 5 min → "You have a call shortly"
 * - Same error 3x → "I've seen this before"
 * - Idle > 2 hours → "You've been at it a while"
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

// Types
export interface JarvisConfig {
  enabled: boolean;
  // Thresholds
  batteryLowThreshold: number;      // Default: 20%
  batteryCriticalThreshold: number;  // Default: 10%
  idleAlertMinutes: number;          // Default: 120 (2 hours)
  meetingReminderMinutes: number;    // Default: 5
  // Cooldowns (ms)
  batteryCooldown: number;           // Default: 300000 (5 min)
  idleCooldown: number;              // Default: 1800000 (30 min)
  // Features
  enableBatteryAlerts: boolean;
  enableIdleAlerts: boolean;
  enableMeetingReminders: boolean;
  enablePatternDetection: boolean;
  enableContextualTips: boolean;
}

export interface JarvisTrigger {
  id: string;
  type: 'battery' | 'meeting' | 'idle' | 'pattern' | 'context' | 'custom';
  priority: 'low' | 'normal' | 'high';
  message: string;
  data?: Record<string, unknown>;
}

export interface UseJarvisOptions {
  enabled?: boolean;
  config?: Partial<JarvisConfig>;
  onSpeak?: (text: string, priority?: string) => Promise<void>;
  onTrigger?: (trigger: JarvisTrigger) => void;
}

// Default configuration
const DEFAULT_CONFIG: JarvisConfig = {
  enabled: true,
  batteryLowThreshold: 20,
  batteryCriticalThreshold: 10,
  idleAlertMinutes: 120,
  meetingReminderMinutes: 5,
  batteryCooldown: 300000,
  idleCooldown: 1800000,
  enableBatteryAlerts: true,
  enableIdleAlerts: true,
  enableMeetingReminders: true,
  enablePatternDetection: true,
  enableContextualTips: true,
};

// Battery messages (randomized for natural feel)
const BATTERY_LOW_MESSAGES = [
  "Heads up - your battery is getting low.",
  "Your battery is at {level}%. You might want to plug in soon.",
  "Battery's running low. Grab your charger when you get a chance.",
];

const BATTERY_CRITICAL_MESSAGES = [
  "Warning - battery is critically low at {level}%!",
  "Your battery is about to die. Please plug in immediately.",
  "Critical battery warning. Save your work and connect to power.",
];

const IDLE_MESSAGES = [
  "You've been at it for a while. Maybe take a quick break?",
  "Just a friendly reminder - you've been working for {hours} hours straight.",
  "Consider stretching or grabbing some water. You've been focused for a while.",
];

const PLUGGED_IN_MESSAGES = [
  "I see you've plugged in. Good call.",
  "Charging now. Crisis averted.",
  "Power connected. You're all set.",
];

export function useJarvis(options: UseJarvisOptions = {}) {
  const { enabled = true, config: configOverrides, onSpeak, onTrigger } = options;

  const [config, setConfig] = useState<JarvisConfig>({ ...DEFAULT_CONFIG, ...configOverrides });
  const [isActive, setIsActive] = useState(enabled && config.enabled);
  const [lastTrigger, setLastTrigger] = useState<JarvisTrigger | null>(null);

  // Cooldown tracking
  const lastBatteryAlert = useRef<number>(0);
  const lastIdleAlert = useRef<number>(0);
  const lastBatteryLevel = useRef<number | null>(null);
  const wasCharging = useRef<boolean>(false);

  // Activity tracking
  const lastActivityTime = useRef<number>(Date.now());

  // Pattern detection
  const recentErrors = useRef<Map<string, number>>(new Map());

  // Helper to pick random message
  const pickMessage = useCallback((messages: string[], vars: Record<string, string | number> = {}): string => {
    let msg = messages[Math.floor(Math.random() * messages.length)];
    for (const [key, value] of Object.entries(vars)) {
      msg = msg.replace(`{${key}}`, String(value));
    }
    return msg;
  }, []);

  // Fire a trigger
  const fireTrigger = useCallback(async (trigger: JarvisTrigger) => {
    console.log('[JARVIS] Trigger fired:', trigger);
    setLastTrigger(trigger);

    if (onTrigger) {
      onTrigger(trigger);
    }

    if (onSpeak) {
      await onSpeak(trigger.message, trigger.priority);
    }

    // Emit event for other listeners
    emit('jarvis-trigger', trigger);
  }, [onTrigger, onSpeak]);

  // Check battery status
  const checkBattery = useCallback(async (battery: number, charging: boolean) => {
    if (!config.enableBatteryAlerts || !isActive) return;

    const now = Date.now();

    // Check if just plugged in after being low
    if (charging && !wasCharging.current && lastBatteryLevel.current !== null && lastBatteryLevel.current <= config.batteryLowThreshold) {
      fireTrigger({
        id: `battery-plugged-${now}`,
        type: 'battery',
        priority: 'low',
        message: pickMessage(PLUGGED_IN_MESSAGES),
        data: { level: battery }
      });
    }

    wasCharging.current = charging;
    lastBatteryLevel.current = battery;

    // Don't alert if charging
    if (charging) return;

    // Check cooldown
    if (now - lastBatteryAlert.current < config.batteryCooldown) return;

    // Critical battery
    if (battery <= config.batteryCriticalThreshold) {
      lastBatteryAlert.current = now;
      fireTrigger({
        id: `battery-critical-${now}`,
        type: 'battery',
        priority: 'high',
        message: pickMessage(BATTERY_CRITICAL_MESSAGES, { level: battery }),
        data: { level: battery, critical: true }
      });
    }
    // Low battery
    else if (battery <= config.batteryLowThreshold) {
      lastBatteryAlert.current = now;
      fireTrigger({
        id: `battery-low-${now}`,
        type: 'battery',
        priority: 'normal',
        message: pickMessage(BATTERY_LOW_MESSAGES, { level: battery }),
        data: { level: battery, critical: false }
      });
    }
  }, [config, isActive, fireTrigger, pickMessage]);

  // Check idle time
  const checkIdleTime = useCallback(() => {
    if (!config.enableIdleAlerts || !isActive) return;

    const now = Date.now();
    const idleMs = now - lastActivityTime.current;
    const idleMinutes = idleMs / 60000;

    // Check cooldown
    if (now - lastIdleAlert.current < config.idleCooldown) return;

    if (idleMinutes >= config.idleAlertMinutes) {
      lastIdleAlert.current = now;
      const hours = Math.round(idleMinutes / 60 * 10) / 10;
      fireTrigger({
        id: `idle-${now}`,
        type: 'idle',
        priority: 'low',
        message: pickMessage(IDLE_MESSAGES, { hours }),
        data: { idleMinutes, hours }
      });
    }
  }, [config, isActive, fireTrigger, pickMessage]);

  // Track pattern (for error detection)
  const trackPattern = useCallback((pattern: string) => {
    if (!config.enablePatternDetection || !isActive) return;

    const count = (recentErrors.current.get(pattern) || 0) + 1;
    recentErrors.current.set(pattern, count);

    // Clear old patterns after 5 minutes
    setTimeout(() => {
      recentErrors.current.delete(pattern);
    }, 300000);

    // Alert if same error 3+ times
    if (count === 3) {
      fireTrigger({
        id: `pattern-${Date.now()}`,
        type: 'pattern',
        priority: 'normal',
        message: `I've noticed "${pattern}" happening repeatedly. Want me to help troubleshoot?`,
        data: { pattern, count }
      });
    }
  }, [config, isActive, fireTrigger]);

  // Mark user activity
  const markActivity = useCallback(() => {
    lastActivityTime.current = Date.now();
  }, []);

  // Enable/disable JARVIS
  const setEnabled = useCallback((value: boolean) => {
    setConfig(prev => ({ ...prev, enabled: value }));
    setIsActive(value);
  }, []);

  // Update config
  const updateConfig = useCallback((updates: Partial<JarvisConfig>) => {
    setConfig(prev => ({ ...prev, ...updates }));
  }, []);

  // Listen for system events
  useEffect(() => {
    if (!isActive) return;

    const unlisteners: UnlistenFn[] = [];

    // Listen for system stats updates
    listen<{ battery_percent?: number; battery_charging?: boolean }>('system-stats', (event) => {
      const { battery_percent, battery_charging } = event.payload;
      if (battery_percent !== undefined) {
        checkBattery(battery_percent, battery_charging || false);
      }
    }).then(unlisten => unlisteners.push(unlisten));

    // Listen for iris-speak events (from system monitor)
    listen<{ text: string; priority?: string }>('iris-speak', (event) => {
      if (onSpeak) {
        onSpeak(event.payload.text, event.payload.priority);
      }
    }).then(unlisten => unlisteners.push(unlisten));

    // Listen for jarvis-trigger events from other sources
    listen<JarvisTrigger>('jarvis-trigger', (event) => {
      if (onTrigger) {
        onTrigger(event.payload);
      }
    }).then(unlisten => unlisteners.push(unlisten));

    // Listen for user activity (keyboard/mouse)
    listen('user-activity', () => {
      markActivity();
    }).then(unlisten => unlisteners.push(unlisten));

    // Listen for calendar reminders
    listen<{ summary: string; minutes_until: number }>('calendar-reminder', (event) => {
      if (config.enableMeetingReminders) {
        fireTrigger({
          id: `meeting-${Date.now()}`,
          type: 'meeting',
          priority: 'normal',
          message: `You have "${event.payload.summary}" starting in ${event.payload.minutes_until} minutes.`,
          data: event.payload
        });
      }
    }).then(unlisten => unlisteners.push(unlisten));

    // Listen for error patterns
    listen<{ error: string }>('error-occurred', (event) => {
      trackPattern(event.payload.error);
    }).then(unlisten => unlisteners.push(unlisten));

    return () => {
      unlisteners.forEach(fn => fn());
    };
  }, [isActive, checkBattery, markActivity, trackPattern, fireTrigger, onSpeak, onTrigger, config.enableMeetingReminders]);

  // Idle check interval
  useEffect(() => {
    if (!isActive || !config.enableIdleAlerts) return;

    const interval = setInterval(checkIdleTime, 60000); // Check every minute
    return () => clearInterval(interval);
  }, [isActive, config.enableIdleAlerts, checkIdleTime]);

  // Initialize system monitor if not running
  useEffect(() => {
    if (!isActive) return;

    invoke('is_system_monitor_running').then((running: unknown) => {
      if (!running) {
        invoke('start_system_monitor', {
          thresholds: {
            battery_low: config.batteryLowThreshold,
            battery_critical: config.batteryCriticalThreshold,
            memory_high: 85,
            memory_critical: 95,
            cpu_high: 90,
            cpu_sustained_seconds: 30,
          }
        }).catch(console.error);
      }
    }).catch(console.error);

    return () => {
      invoke('stop_system_monitor').catch(console.error);
    };
  }, [isActive, config.batteryLowThreshold, config.batteryCriticalThreshold]);

  return {
    isActive,
    config,
    lastTrigger,
    setEnabled,
    updateConfig,
    markActivity,
    trackPattern,
    // Manual trigger for testing
    testTrigger: (message: string, type: JarvisTrigger['type'] = 'custom', priority: JarvisTrigger['priority'] = 'normal') => {
      fireTrigger({
        id: `test-${Date.now()}`,
        type,
        priority,
        message,
      });
    },
  };
}

export default useJarvis;
