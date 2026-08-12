/**
 * GridCalibrator - Fullscreen Grid Calibration Tool
 *
 * Allows visual calibration of IRIS's annotation grid system.
 * Shows the grid overlay with adjustable column/row positions.
 */

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface GridConfig {
  columns: { [key: string]: number };
  rowStart: number;
  rowSpacing: number;
  rowCount: number;
}

const DEFAULT_CONFIG: GridConfig = {
  columns: {
    A: 35,
    B: 110,
    C: 185,
    D: 250,
    E: 480,
    F: 710,
    G: 940,
    H: 1170,
    I: 1400,
    J: 1630,
  },
  rowStart: 50,
  rowSpacing: 95,
  rowCount: 10,
};

export function GridCalibrator() {
  const [config, setConfig] = useState<GridConfig>(DEFAULT_CONFIG);
  const [showControls, setShowControls] = useState(true);
  const [uniformMode, setUniformMode] = useState(false);
  const [uniformWidth, setUniformWidth] = useState(150);
  const [startX, setStartX] = useState(35);
  const [screenSize, setScreenSize] = useState({ width: 1920, height: 1080 });

  // Get screen size and load saved config on mount
  useEffect(() => {
    const width = window.screen.width;
    const height = window.screen.height;
    setScreenSize({ width, height });

    // Try to load saved config for this resolution
    const resolutionKey = `${width}x${height}`;
    try {
      const allConfigs = localStorage.getItem('iris-grid-configs');
      if (allConfigs) {
        const configs = JSON.parse(allConfigs);
        if (configs[resolutionKey]) {
          const saved = configs[resolutionKey];
          console.log(`[GridCalibrator] Loaded saved config for ${resolutionKey}:`, saved);
          setConfig(saved);

          // Detect if it was uniform mode by checking if columns are evenly spaced
          const colValues = Object.values(saved.columns) as number[];
          if (colValues.length >= 2) {
            const spacing = colValues[1] - colValues[0];
            const isUniform = colValues.every((v, i) => i === 0 || Math.abs(v - colValues[i-1] - spacing) < 2);
            if (isUniform) {
              setUniformMode(true);
              setUniformWidth(spacing);
              setStartX(colValues[0]);
            }
          }
          return;
        }
      }
    } catch (e) {
      console.warn('[GridCalibrator] Failed to load saved config:', e);
    }

    // No saved config - show EXACTLY what IRIS uses (DEFAULT_CONFIG)
    // This way the calibrator displays IRIS's current perception
    console.log(`[GridCalibrator] No saved config for ${resolutionKey}, showing IRIS default config`);
    // Keep uniformMode=false and config=DEFAULT_CONFIG (already set as initial state)
    // User can switch to uniform mode if they want to adjust
  }, []);

  // Calculate uniform grid
  const getUniformColumns = useCallback(() => {
    const cols: { [key: string]: number } = {};
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    let x = startX;
    let i = 0;
    while (x < screenSize.width && i < 26) {
      cols[letters[i]] = x;
      x += uniformWidth;
      i++;
    }
    return cols;
  }, [uniformWidth, startX, screenSize.width]);

  // Get current columns based on mode
  const currentColumns = uniformMode ? getUniformColumns() : config.columns;
  const columnEntries = Object.entries(currentColumns);

  // Calculate rows
  const rows = Array.from({ length: config.rowCount }, (_, i) => ({
    num: i + 1,
    y: config.rowStart + i * config.rowSpacing,
  }));

  // Close window
  const handleClose = async () => {
    try {
      await invoke('hide_grid_calibrator');
    } catch (e) {
      console.error('Failed to close grid calibrator:', e);
    }
  };

  // Export config
  const handleExport = () => {
    const exportConfig = {
      columns: currentColumns,
      rowStart: config.rowStart,
      rowSpacing: config.rowSpacing,
      rowCount: config.rowCount,
      uniformMode,
      uniformWidth: uniformMode ? uniformWidth : null,
      startX: uniformMode ? startX : null,
      screenSize,
      exportedAt: new Date().toISOString(),
    };

    const json = JSON.stringify(exportConfig, null, 2);
    navigator.clipboard.writeText(json);
    alert('Grid config copied to clipboard!');
  };

  // Apply to IRIS - save config keyed by screen resolution
  const handleApply = () => {
    const resolutionKey = `${screenSize.width}x${screenSize.height}`;
    const gridConfig = {
      columns: currentColumns,
      rowStart: config.rowStart,
      rowSpacing: config.rowSpacing,
      rowCount: config.rowCount,
    };

    // Load existing configs (for other resolutions)
    let allConfigs: { [key: string]: typeof gridConfig } = {};
    try {
      const saved = localStorage.getItem('iris-grid-configs');
      if (saved) allConfigs = JSON.parse(saved);
    } catch (e) { /* ignore */ }

    // Add/update this resolution's config
    allConfigs[resolutionKey] = gridConfig;

    localStorage.setItem('iris-grid-configs', JSON.stringify(allConfigs));
    alert(`Grid config saved for ${resolutionKey}!\n\nIRIS will use this config when annotating on this display.`);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'transparent',
        fontFamily: 'monospace',
        overflow: 'hidden',
      }}
    >
      {/* Screen edge indicator - 1px so it doesn't affect calibration */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          border: '1px solid #ff0000',
          boxSizing: 'border-box',
          pointerEvents: 'none',
        }}
      />

      {/* Column lines */}
      {columnEntries.map(([letter, x]) => (
        <div key={`col-${letter}`}>
          {/* Vertical line */}
          <div
            style={{
              position: 'absolute',
              left: x,
              top: 0,
              width: 2,
              height: '100%',
              backgroundColor: '#00ffff',
              pointerEvents: 'none',
            }}
          />
          {/* Column header */}
          <div
            style={{
              position: 'absolute',
              left: x - 12,
              top: 12,
              backgroundColor: '#00ffff',
              color: '#000',
              padding: '4px 10px',
              fontWeight: 'bold',
              fontSize: '14px',
              borderRadius: '4px',
              pointerEvents: 'none',
            }}
          >
            {letter}
          </div>
        </div>
      ))}

      {/* Row lines */}
      {rows.map(({ num, y }) => (
        <div key={`row-${num}`}>
          {/* Horizontal line */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: y,
              width: '100%',
              height: 2,
              backgroundColor: '#00ffff',
              pointerEvents: 'none',
            }}
          />
          {/* Row label */}
          <div
            style={{
              position: 'absolute',
              left: 12,
              top: y - 12,
              backgroundColor: '#00ffff',
              color: '#000',
              padding: '4px 10px',
              fontWeight: 'bold',
              fontSize: '14px',
              borderRadius: '4px',
              pointerEvents: 'none',
            }}
          >
            {num}
          </div>
        </div>
      ))}

      {/* Cell labels at intersections */}
      {columnEntries.map(([letter, x]) =>
        rows.map(({ num, y }) => (
          <div
            key={`cell-${letter}${num}`}
            style={{
              position: 'absolute',
              left: x + 8,
              top: y + 8,
              backgroundColor: 'rgba(0,0,0,0.7)',
              color: '#00ffff',
              padding: '3px 8px',
              fontSize: '12px',
              fontWeight: 'bold',
              borderRadius: '4px',
              border: '1px solid #00ffff',
              pointerEvents: 'none',
            }}
          >
            {letter}{num}
          </div>
        ))
      )}

      {/* Control Panel */}
      {showControls && (
        <div
          style={{
            position: 'absolute',
            bottom: 20,
            right: 20,
            backgroundColor: 'rgba(0,0,0,0.95)',
            color: '#fff',
            padding: '20px',
            borderRadius: '12px',
            border: '2px solid #00ffff',
            width: '350px',
            maxHeight: '80vh',
            overflowY: 'auto',
          }}
        >
          <h2 style={{ margin: '0 0 15px 0', color: '#00ffff', fontSize: '18px' }}>
            Grid Calibrator
          </h2>

          {/* Mode Toggle */}
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={uniformMode}
                onChange={(e) => setUniformMode(e.target.checked)}
                style={{ width: '18px', height: '18px' }}
              />
              <span>Uniform Grid Mode</span>
            </label>
          </div>

          {uniformMode ? (
            <>
              {/* Uniform mode controls */}
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', color: '#aaa' }}>
                  Cell Width: {uniformWidth}px
                </label>
                <input
                  type="range"
                  min="50"
                  max="300"
                  value={uniformWidth}
                  onChange={(e) => setUniformWidth(parseInt(e.target.value))}
                  style={{ width: '100%' }}
                />
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', color: '#aaa' }}>
                  Start X: {startX}px
                </label>
                <input
                  type="range"
                  min="0"
                  max="200"
                  value={startX}
                  onChange={(e) => setStartX(parseInt(e.target.value))}
                  style={{ width: '100%' }}
                />
              </div>
            </>
          ) : (
            <>
              {/* Manual column positions */}
              <div style={{ marginBottom: '15px', fontSize: '12px', color: '#aaa' }}>
                Manual mode - edit tauri config directly
              </div>
            </>
          )}

          {/* Row controls */}
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', color: '#aaa' }}>
              Row Start Y: {config.rowStart}px
            </label>
            <input
              type="range"
              min="0"
              max="200"
              value={config.rowStart}
              onChange={(e) => setConfig({ ...config, rowStart: parseInt(e.target.value) })}
              style={{ width: '100%' }}
            />
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', color: '#aaa' }}>
              Row Spacing: {config.rowSpacing}px
            </label>
            <input
              type="range"
              min="50"
              max="200"
              value={config.rowSpacing}
              onChange={(e) => setConfig({ ...config, rowSpacing: parseInt(e.target.value) })}
              style={{ width: '100%' }}
            />
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', color: '#aaa' }}>
              Row Count: {config.rowCount}
            </label>
            <input
              type="range"
              min="5"
              max="20"
              value={config.rowCount}
              onChange={(e) => setConfig({ ...config, rowCount: parseInt(e.target.value) })}
              style={{ width: '100%' }}
            />
          </div>

          {/* Info */}
          <div style={{ marginBottom: '15px', padding: '10px', backgroundColor: 'rgba(0,255,255,0.1)', borderRadius: '6px', fontSize: '11px' }}>
            <div>Screen: {screenSize.width} x {screenSize.height}</div>
            <div>Columns: {columnEntries.length}</div>
            <div>Rows: {config.rowCount}</div>
          </div>

          {/* Buttons */}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button
              onClick={handleExport}
              style={{
                flex: 1,
                padding: '10px',
                backgroundColor: '#00ffff',
                color: '#000',
                border: 'none',
                borderRadius: '6px',
                fontWeight: 'bold',
                cursor: 'pointer',
              }}
            >
              Copy Config
            </button>
            <button
              onClick={handleApply}
              style={{
                flex: 1,
                padding: '10px',
                backgroundColor: '#22c55e',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                fontWeight: 'bold',
                cursor: 'pointer',
              }}
            >
              Apply
            </button>
            <button
              onClick={handleClose}
              style={{
                flex: 1,
                padding: '10px',
                backgroundColor: '#ff4444',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                fontWeight: 'bold',
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Toggle controls button */}
      <button
        onClick={() => setShowControls(!showControls)}
        style={{
          position: 'absolute',
          top: 20,
          right: 20,
          padding: '10px 20px',
          backgroundColor: showControls ? '#666' : '#00ffff',
          color: showControls ? '#fff' : '#000',
          border: 'none',
          borderRadius: '6px',
          fontWeight: 'bold',
          cursor: 'pointer',
          fontFamily: 'monospace',
        }}
      >
        {showControls ? 'Hide Controls' : 'Show Controls'}
      </button>

      {/* Title */}
      <div
        style={{
          position: 'absolute',
          top: 20,
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: 'rgba(0,0,0,0.9)',
          color: '#00ffff',
          padding: '10px 30px',
          borderRadius: '8px',
          border: '2px solid #00ffff',
          fontSize: '18px',
          fontWeight: 'bold',
        }}
      >
        IRIS Grid Calibrator
      </div>
    </div>
  );
}

export default GridCalibrator;
