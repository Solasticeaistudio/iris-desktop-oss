import React, { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import * as THREE from 'three';
import type { IrisState } from '../hooks/useIrisState';
import { IRIS_AUDIO_COLORS, IRIS_STATE_COLORS, IRIS_STATE_FORMATIONS, resolveIrisIdentityColor } from '../lib/irisVisualIdentity';

export interface IrisParticlesRef {
  morphToShape: (shape: keyof typeof FORMATIONS) => void;
  setColor: (color: string) => void;
}

interface IrisParticlesProps {
  state: IrisState;
  className?: string;
  particleCount?: number;
  audioLevel?: number;      // User's mic level (0-1)
  irisAudioLevel?: number;  // IRIS TTS level (0-1)
  isExec?: boolean;         // God Mode active?
}

// Particle formations - larger radius for better visibility
const FORMATIONS = {
  sphere: (i: number, total: number, radius = 12) => {
    const phi = Math.acos(-1 + (2 * i) / total);
    const theta = Math.sqrt(total * Math.PI) * phi;
    return {
      x: radius * Math.cos(theta) * Math.sin(phi),
      y: radius * Math.sin(theta) * Math.sin(phi),
      z: radius * Math.cos(phi),
    };
  },
  ring: (i: number, total: number, radius = 14) => {
    const angle = (i / total) * Math.PI * 2;
    const wobble = Math.sin(i * 0.3) * 2;
    return {
      x: Math.cos(angle) * (radius + wobble),
      y: (Math.random() - 0.5) * 4,
      z: Math.sin(angle) * (radius + wobble),
    };
  },
  converge: () => ({
    x: (Math.random() - 0.5) * 2,
    y: (Math.random() - 0.5) * 2,
    z: (Math.random() - 0.5) * 2
  }),
  scatter: (_i: number, _total: number, range = 30) => ({
    x: (Math.random() - 0.5) * range,
    y: (Math.random() - 0.5) * range,
    z: (Math.random() - 0.5) * range,
  }),
};

// State to formation mapping
// Audio reactive colors
const COLOR_USER_SPEAKING = new THREE.Color(IRIS_AUDIO_COLORS.user);
const COLOR_IRIS_SPEAKING = new THREE.Color(IRIS_AUDIO_COLORS.iris);

export const IrisParticles = forwardRef(function IrisParticles(
  props: IrisParticlesProps,
  ref: React.ForwardedRef<IrisParticlesRef>
) {
  const {
    state,
    className,
    particleCount = 1200,
    audioLevel = 0,
    irisAudioLevel = 0,
    isExec = false,
  } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const particlesRef = useRef<THREE.Points | null>(null);
  const animationRef = useRef<number>(0);
  const targetPositionsRef = useRef<Float32Array | null>(null);
  const targetColorRef = useRef<THREE.Color>(new THREE.Color(IRIS_STATE_COLORS.idle));
  const audioLevelRef = useRef(0);
  const irisAudioLevelRef = useRef(0);
  const stateRef = useRef<IrisState>(state);

  // Update state ref
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Update audio level refs
  useEffect(() => {
    audioLevelRef.current = audioLevel;
  }, [audioLevel]);

  useEffect(() => {
    irisAudioLevelRef.current = irisAudioLevel;
  }, [irisAudioLevel]);

  const PARTICLE_COUNT = particleCount;
  const customColorRef = useRef<THREE.Color | null>(null);

  // Expose methods via ref
  useImperativeHandle(ref, () => ({

    // Morph to a built-in shape
    morphToShape(shape: keyof typeof FORMATIONS) {
      if (!targetPositionsRef.current) return;

      const formationFn = FORMATIONS[shape];
      if (!formationFn) {
        console.warn(`[IrisParticles] Unknown shape: ${shape}`);
        return;
      }

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const pos = formationFn(i, PARTICLE_COUNT);
        targetPositionsRef.current[i * 3] = pos.x;
        targetPositionsRef.current[i * 3 + 1] = pos.y;
        targetPositionsRef.current[i * 3 + 2] = pos.z;
      }
      console.log(`[IrisParticles] Morphed to shape: ${shape}`);
    },

    // Set custom particle color
    setColor(color: string) {
      try {
        customColorRef.current = new THREE.Color(color);
        targetColorRef.current = customColorRef.current;
      } catch (e) {
        console.warn('[IrisParticles] Invalid color:', color);
      }
    }
  }), [PARTICLE_COUNT]);

  // Initialize Three.js scene
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Camera - closer for better visibility
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.z = 35;
    cameraRef.current = camera;

    // Renderer
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Create particles
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    const sizes = new Float32Array(PARTICLE_COUNT);

    // Initialize positions in sphere formation
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const pos = FORMATIONS.sphere(i, PARTICLE_COUNT);
      positions[i * 3] = pos.x;
      positions[i * 3 + 1] = pos.y;
      positions[i * 3 + 2] = pos.z;

      // Initial color (cyan)
      colors[i * 3] = 0;
      colors[i * 3 + 1] = 0.95;
      colors[i * 3 + 2] = 1;

      sizes[i] = 0.08 + Math.random() * 0.06;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    targetPositionsRef.current = new Float32Array(positions);

    // Custom shader material for particles
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        pointSize: { value: 3.5 }, // Increased size
      },
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        uniform float time;
        uniform float pointSize;

        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * pointSize * (300.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;

        void main() {
          float dist = length(gl_PointCoord - vec2(0.5));
          if (dist > 0.5) discard;

          float alpha = 1.0 - smoothstep(0.2, 0.5, dist);
          // Boosted brightness for video visibility (Reduced from 3.0 to avoid white blowout)
          vec3 brightColor = vColor * 1.5 + 0.1; 
          gl_FragColor = vec4(brightColor, alpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const particles = new THREE.Points(geometry, material);
    particlesRef.current = particles;
    scene.add(particles);

    // Animation loop with audio reactivity
    const animate = () => {
      animationRef.current = requestAnimationFrame(animate);

      const time = performance.now() * 0.001;
      (material.uniforms.time as { value: number }).value = time;

      // Get audio levels from refs
      const userAudio = audioLevelRef.current;
      const irisAudio = irisAudioLevelRef.current;

      // Morph positions
      const posAttr = geometry.attributes.position as THREE.BufferAttribute;
      const colorAttr = geometry.attributes.color as THREE.BufferAttribute;
      const targetPositions = targetPositionsRef.current!;
      const targetColor = targetColorRef.current.clone();

      // Audio-reactive color blending
      if (userAudio > 0.05) {
        targetColor.lerp(COLOR_USER_SPEAKING, userAudio * 1.8);
      }
      if (irisAudio > 0.05) {
        targetColor.lerp(COLOR_IRIS_SPEAKING, irisAudio * 2.0);
      }

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const idx = i * 3;

        // Lerp positions
        posAttr.array[idx] += (targetPositions[idx] - posAttr.array[idx]) * 0.02;
        posAttr.array[idx + 1] += (targetPositions[idx + 1] - posAttr.array[idx + 1]) * 0.02;
        posAttr.array[idx + 2] += (targetPositions[idx + 2] - posAttr.array[idx + 2]) * 0.02;

        // Organic movement
        posAttr.array[idx + 1] += Math.sin(time * 2 + i * 0.1) * 0.01;

        // Audio-reactive movement - particles pulse gently with sound (No chaotic jitter)
        if (userAudio > 0.01) {
          // Gentle expansion/breath
          const pulseStrength = userAudio * 0.15; // Subtle expansion
          const dist = Math.sqrt(
            posAttr.array[idx] ** 2 +
            posAttr.array[idx + 1] ** 2 +
            posAttr.array[idx + 2] ** 2
          );
          if (dist > 0.01) {
            // Push outward slightly based on audio
            posAttr.array[idx] += (posAttr.array[idx] / dist) * pulseStrength;
            posAttr.array[idx + 1] += (posAttr.array[idx + 1] / dist) * pulseStrength;
            posAttr.array[idx + 2] += (posAttr.array[idx + 2] / dist) * pulseStrength;
          }

          // Very slight jitter for energy (reduced from 0.3)
          posAttr.array[idx] += (Math.random() - 0.5) * userAudio * 0.05;
          posAttr.array[idx + 1] += (Math.random() - 0.5) * userAudio * 0.05;
          posAttr.array[idx + 2] += (Math.random() - 0.5) * userAudio * 0.05;
        }
        if (irisAudio > 0.1) {
          // Iris speaking - particles pulse outward
          const pulseStrength = irisAudio * 0.2;
          const dist = Math.sqrt(
            posAttr.array[idx] ** 2 +
            posAttr.array[idx + 1] ** 2 +
            posAttr.array[idx + 2] ** 2
          );
          if (dist > 0) {
            posAttr.array[idx] += (posAttr.array[idx] / dist) * pulseStrength;
            posAttr.array[idx + 1] += (posAttr.array[idx + 1] / dist) * pulseStrength;
            posAttr.array[idx + 2] += (posAttr.array[idx + 2] / dist) * pulseStrength;
          }
        }

        // Lerp colors
        if (stateRef.current === 'thinking') {
          // RAINBOW RIPPLE EFFECT
          // Calculate phase based on position and time
          const rippleSpeed = 3.0;
          const rippleFreq = 0.2;
          const dist = Math.sqrt(posAttr.array[idx] ** 2 + posAttr.array[idx + 1] ** 2 + posAttr.array[idx + 2] ** 2);

          // Phase shift based on distance from center (spherical ripple)
          const phase = dist * rippleFreq - time * rippleSpeed;

          // Rainbow colors using sine waves offset by 2*PI/3
          // Full Range 0.0 to 1.0 for maximum saturation
          const r = Math.sin(phase) * 0.5 + 0.5;
          const g = Math.sin(phase + 2.094) * 0.5 + 0.5;
          const b = Math.sin(phase + 4.188) * 0.5 + 0.5;

          colorAttr.array[idx] += (r - colorAttr.array[idx]) * 0.1;
          colorAttr.array[idx + 1] += (g - colorAttr.array[idx + 1]) * 0.1;
          colorAttr.array[idx + 2] += (b - colorAttr.array[idx + 2]) * 0.1;
        } else {
          // Standard Single Color Lerp
          colorAttr.array[idx] += (targetColor.r - colorAttr.array[idx]) * 0.08;
          colorAttr.array[idx + 1] += (targetColor.g - colorAttr.array[idx + 1]) * 0.08;
          colorAttr.array[idx + 2] += (targetColor.b - colorAttr.array[idx + 2]) * 0.08;
        }
      }
      posAttr.needsUpdate = true;
      colorAttr.needsUpdate = true;

      // Slow rotation (faster when audio active)
      const rotationSpeed = 0.002 + (userAudio * 0.01) + (irisAudio * 0.008);
      particles.rotation.y += rotationSpeed;
      particles.rotation.x = Math.sin(time * 0.5) * 0.1;

      renderer.render(scene, camera);
    };

    animate();

    // Handle resize
    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationRef.current);
      renderer.dispose();
      geometry.dispose();
      material.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  // Update formation and color when state changes
  useEffect(() => {
    if (!targetPositionsRef.current) return;

    const formation = IRIS_STATE_FORMATIONS[state];
    const formationFn = FORMATIONS[formation];

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const pos = formationFn(i, PARTICLE_COUNT);
      targetPositionsRef.current[i * 3] = pos.x;
      targetPositionsRef.current[i * 3 + 1] = pos.y;
      targetPositionsRef.current[i * 3 + 2] = pos.z;
    }

    // Update target color logic
    targetColorRef.current = new THREE.Color(resolveIrisIdentityColor(state, audioLevel, irisAudioLevel, isExec));
  }, [state, audioLevel, irisAudioLevel, isExec]);

  return <div ref={containerRef} className={className} />;
});
