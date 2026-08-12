/**
 * AnnotationOverlay - Screen Annotation Component
 *
 * Transparent overlay where IRIS can draw to show things to the user.
 * Supports circles, arrows, highlights, and text annotations.
 *
 * Voice commands:
 * - "Circle that button"
 * - "Arrow from here to there"
 * - "Highlight this area"
 */

import { useState, useEffect, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { motion, AnimatePresence } from 'framer-motion';

// Types
export interface Annotation {
  id: string;
  annotation_type: 'circle' | 'arrow' | 'highlight' | 'text' | 'pointer';
  x: number;
  y: number;
  x2?: number;  // For arrows, end point
  y2?: number;
  radius?: number;  // For circles
  width?: number;   // For highlights
  height?: number;
  color?: string;
  text?: string;
  auto_fade_ms?: number;
}

interface AnnotationOverlayProps {
  className?: string;
}

// Grid configuration - MUST match IrisWindow.tsx
const GRID_CONFIG = {
  columns: {
    // Desktop icon area (75px spacing)
    A: 35,
    B: 110,
    C: 185,
    // Main screen area (230px spacing)
    D: 250,
    E: 480,
    F: 710,
    G: 940,
    H: 1170,
    I: 1400,
    J: 1630,
  },
  // Rows: y = 50 + (row - 1) * 95
  getRowY: (row: number) => 50 + (row - 1) * 95,
  rowCount: 10,
};

export function AnnotationOverlay({ className = '' }: AnnotationOverlayProps) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [showDebugGrid, setShowDebugGrid] = useState(false);

  // Listen for annotation events from Tauri
  useEffect(() => {
    console.log('[AnnotationOverlay] Component mounted, setting up listeners...');
    const unlisteners: UnlistenFn[] = [];

    invoke('clear_annotations').then(() => {
      console.log('[AnnotationOverlay] Cleared stale annotations on mount');
    }).catch(console.error);

    // Poll for annotations - SYNC state with backend (replace, don't merge)
    const pollInterval = setInterval(async () => {
      try {
        const backendAnnotations = await invoke<Annotation[]>('get_annotations');
        setAnnotations(prev => {
          // If backend has different annotations than our state, sync to backend
          const backendIds = new Set((backendAnnotations || []).map(a => a.id));
          const prevIds = new Set(prev.map(a => a.id));

          // Check if they're different
          const isDifferent = backendIds.size !== prevIds.size ||
            [...backendIds].some(id => !prevIds.has(id)) ||
            [...prevIds].some(id => !backendIds.has(id));

          if (isDifferent) {
            console.log('[AnnotationOverlay] Syncing state with backend:', backendAnnotations?.length || 0, 'annotations');
            return backendAnnotations || [];
          }
          return prev;
        });
      } catch (err) {
        // Silently ignore polling errors
      }
    }, 250);

    // Add annotation listener
    listen<Annotation>('annotation-add', (event) => {
      console.log('[AnnotationOverlay] EVENT RECEIVED - annotation-add:', event.payload);
      console.log('[AnnotationOverlay] Event payload type:', typeof event.payload);
      console.log('[AnnotationOverlay] Event payload keys:', Object.keys(event.payload || {}));
      setAnnotations(prev => {
        console.log('[AnnotationOverlay] Previous annotations:', prev.length);
        // Avoid duplicates by checking ID
        if (prev.some(a => a.id === event.payload.id)) {
          console.log('[AnnotationOverlay] Skipping duplicate annotation:', event.payload.id);
          return prev;
        }
        const newList = [...prev, event.payload];
        console.log('[AnnotationOverlay] New annotations:', newList.length);
        return newList;
      });
    }).then(async (unlisten) => {
      console.log('[AnnotationOverlay] annotation-add listener REGISTERED');
      unlisteners.push(unlisten);

      // CRITICAL: Poll for any annotations that were added before listener was ready
      try {
        console.log('[AnnotationOverlay] Polling for existing annotations...');
        const existing = await invoke<Annotation[]>('get_annotations');
        console.log('[AnnotationOverlay] Found existing annotations:', existing);
        if (existing && existing.length > 0) {
          setAnnotations(prev => {
            // Merge, avoiding duplicates
            const newAnnotations = existing.filter(e => !prev.some(p => p.id === e.id));
            console.log('[AnnotationOverlay] Adding', newAnnotations.length, 'existing annotations');
            return [...prev, ...newAnnotations];
          });
        }
      } catch (err) {
        console.error('[AnnotationOverlay] Failed to poll annotations:', err);
      }
    }).catch(err => {
      console.error('[AnnotationOverlay] FAILED to register annotation-add listener:', err);
    });

    // Remove annotation
    listen<string>('annotation-remove', (event) => {
      console.log('[AnnotationOverlay] Removing annotation:', event.payload);
      setAnnotations(prev => prev.filter(a => a.id !== event.payload));
    }).then(unlisten => {
      console.log('[AnnotationOverlay] annotation-remove listener REGISTERED');
      unlisteners.push(unlisten);
    });

    // Clear all annotations
    listen('annotation-clear', () => {
      console.log('[AnnotationOverlay] Clearing all annotations');
      setAnnotations([]);
    }).then(unlisten => {
      console.log('[AnnotationOverlay] annotation-clear listener REGISTERED');
      unlisteners.push(unlisten);
    });

    // Toggle debug grid
    listen('debug-grid-toggle', () => {
      console.log('[AnnotationOverlay] Toggling debug grid');
      setShowDebugGrid(prev => !prev);
    }).then(unlisten => {
      console.log('[AnnotationOverlay] debug-grid-toggle listener REGISTERED');
      unlisteners.push(unlisten);
    });

    return () => {
      console.log('[AnnotationOverlay] Cleaning up listeners and poll');
      clearInterval(pollInterval);
      unlisteners.forEach(fn => fn());
    };
  }, []);

  // Render a single annotation
  const renderAnnotation = useCallback((annotation: Annotation) => {
    const color = annotation.color || '#22d3ee'; // Cyan - IRIS's color
    const key = annotation.id;

    switch (annotation.annotation_type) {
      case 'circle':
        const circleRadius = annotation.radius || 50;
        return (
          <motion.div
            key={key}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            style={{
              position: 'absolute',
              left: annotation.x - circleRadius,
              top: annotation.y - circleRadius,
              width: circleRadius * 2,
              height: circleRadius * 2,
              border: `4px solid ${color}`,
              borderRadius: '50%',
              boxShadow: `0 0 20px ${color}40, inset 0 0 20px ${color}20`,
              pointerEvents: 'none',
            }}
          />
        );

      case 'arrow':
        const x1 = annotation.x;
        const y1 = annotation.y;
        const x2 = annotation.x2 || annotation.x + 100;
        const y2 = annotation.y2 || annotation.y + 100;

        return (
          <motion.svg
            key={key}
            initial={{ opacity: 0, pathLength: 0 }}
            animate={{ opacity: 1, pathLength: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
              overflow: 'visible',
            }}
          >
            <defs>
              <marker
                id={`arrowhead-${key}`}
                markerWidth="10"
                markerHeight="7"
                refX="9"
                refY="3.5"
                orient="auto"
              >
                <polygon points="0 0, 10 3.5, 0 7" fill={color} />
              </marker>
              <filter id={`glow-${key}`}>
                <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <motion.line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={color}
              strokeWidth="4"
              markerEnd={`url(#arrowhead-${key})`}
              filter={`url(#glow-${key})`}
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </motion.svg>
        );

      case 'highlight':
        const width = annotation.width || 200;
        const height = annotation.height || 100;
        return (
          <motion.div
            key={key}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.3 }}
            style={{
              position: 'absolute',
              left: annotation.x,
              top: annotation.y,
              width,
              height,
              backgroundColor: `${color}30`,
              border: `3px solid ${color}`,
              borderRadius: '8px',
              boxShadow: `0 0 30px ${color}40`,
              pointerEvents: 'none',
            }}
          />
        );

      case 'text':
        return (
          <motion.div
            key={key}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.3 }}
            style={{
              position: 'absolute',
              left: annotation.x,
              top: annotation.y,
              color: color,
              fontSize: '24px',
              fontWeight: 'bold',
              textShadow: '0 0 10px rgba(0,0,0,0.8), 0 0 20px rgba(0,0,0,0.5)',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            {annotation.text || ''}
          </motion.div>
        );

      case 'pointer':
        // Animated pointer/cursor indicator
        return (
          <motion.div
            key={key}
            initial={{ scale: 2, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            transition={{
              duration: 0.5,
              repeat: Infinity,
              repeatType: 'reverse',
            }}
            style={{
              position: 'absolute',
              left: annotation.x - 15,
              top: annotation.y - 15,
              width: 30,
              height: 30,
              borderRadius: '50%',
              backgroundColor: `${color}40`,
              border: `3px solid ${color}`,
              boxShadow: `0 0 20px ${color}60`,
              pointerEvents: 'none',
            }}
          />
        );

      default:
        return null;
    }
  }, []);

  // Render the debug grid overlay
  const renderDebugGrid = useCallback(() => {
    if (!showDebugGrid) return null;

    const columns = Object.entries(GRID_CONFIG.columns);
    const rows = Array.from({ length: GRID_CONFIG.rowCount }, (_, i) => i + 1);

    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          // Use a solid dark background so content is visible on Windows transparent webview
          backgroundColor: 'rgba(0, 20, 40, 0.85)',
        }}
      >
        {/* RED BORDER to show which screen we're on - thick and visible */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            border: '15px solid #ff0000',
            boxSizing: 'border-box',
            pointerEvents: 'none',
          }}
        />

        {/* Vertical lines for columns - thick and bright */}
        {columns.map(([letter, x]) => (
          <div
            key={`col-${letter}`}
            style={{
              position: 'absolute',
              left: x,
              top: 0,
              width: 3,
              height: '100%',
              backgroundColor: '#00ffff',
              pointerEvents: 'none',
            }}
          />
        ))}

        {/* Horizontal lines for rows - thick and bright */}
        {rows.map((row) => {
          const y = GRID_CONFIG.getRowY(row);
          return (
            <div
              key={`row-${row}`}
              style={{
                position: 'absolute',
                left: 0,
                top: y,
                width: '100%',
                height: 3,
                backgroundColor: '#00ffff',
                pointerEvents: 'none',
              }}
            />
          );
        })}

        {/* Grid cell labels at intersections */}
        {columns.map(([letter, x]) =>
          rows.map((row) => {
            const y = GRID_CONFIG.getRowY(row);
            return (
              <div
                key={`label-${letter}${row}`}
                style={{
                  position: 'absolute',
                  left: x + 4,
                  top: y + 4,
                  color: '#22d3ee',
                  fontSize: '12px',
                  fontWeight: 'bold',
                  fontFamily: 'monospace',
                  textShadow: '0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)',
                  backgroundColor: 'rgba(0,0,0,0.5)',
                  padding: '2px 4px',
                  borderRadius: '3px',
                }}
              >
                {letter}{row}
              </div>
            );
          })
        )}

        {/* Column headers at top */}
        {columns.map(([letter, x]) => (
          <div
            key={`header-${letter}`}
            style={{
              position: 'absolute',
              left: x - 10,
              top: 10,
              color: '#fff',
              fontSize: '16px',
              fontWeight: 'bold',
              fontFamily: 'monospace',
              backgroundColor: '#22d3ee',
              padding: '2px 8px',
              borderRadius: '4px',
            }}
          >
            {letter}
          </div>
        ))}

        {/* Row labels on left */}
        {rows.map((row) => {
          const y = GRID_CONFIG.getRowY(row);
          return (
            <div
              key={`rowlabel-${row}`}
              style={{
                position: 'absolute',
                left: 5,
                top: y - 10,
                color: '#fff',
                fontSize: '14px',
                fontWeight: 'bold',
                fontFamily: 'monospace',
                backgroundColor: '#22d3ee',
                padding: '2px 6px',
                borderRadius: '4px',
              }}
            >
              {row}
            </div>
          );
        })}

        {/* Instructions */}
        <div
          style={{
            position: 'absolute',
            bottom: 20,
            right: 20,
            color: '#fff',
            fontSize: '16px',
            fontFamily: 'monospace',
            backgroundColor: 'rgba(0,0,0,0.9)',
            padding: '12px 20px',
            borderRadius: '8px',
            border: '3px solid #ff0000',
          }}
        >
          DEBUG GRID - Press Ctrl+Shift+G to toggle
        </div>
      </div>
    );
  }, [showDebugGrid]);

  return (
    <div
      className={`fixed inset-0 pointer-events-none overflow-hidden ${className}`}
      style={{
        zIndex: 999999,
        // Fully transparent background - only annotations visible
      }}
    >
      {/* Debug grid overlay */}
      {renderDebugGrid()}

      <AnimatePresence>
        {annotations.map(renderAnnotation)}
      </AnimatePresence>
    </div>
  );
}

export default AnnotationOverlay;
