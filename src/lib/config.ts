// IRIS Agent Configuration
// This file is used as a template - values will be overwritten by Agent Factory scaffold

export const AGENT_CONFIG = {
    name: 'IRIS',
    packageName: 'iris-desktop',

    // Theme/Branding
    theme: {
        primaryColor: '#4f46e5',  // Indigo
        primaryRGB: '79, 70, 229'
    },

    // Canonical procedural particle-sphere viewport
    sphere: {
        containerWidth: 500,
        containerHeight: 500,
        cameraZ: 35,
        cameraFOV: 50,
        scale: 1
    },

    // Layout settings
    layout: {
        chat: {
            x: -200,
            y: 0,
            width: 350,
            paddingRight: 350
        },
        settings: {
            top: 14,
            left: 10
        }
    },

    // Voice settings
    voice: {
        provider: 'system' as 'system' | 'elevenlabs' | 'openai',
        voice: '',
        voiceId: '',
        speed: 1
    }
} as const;

export type AgentConfig = typeof AGENT_CONFIG;
