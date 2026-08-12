import type { IrisState } from '../hooks/useIrisState';

export type ProceduralFormation = 'sphere' | 'ring' | 'converge' | 'scatter';

export const IRIS_STATE_FORMATIONS: Record<IrisState, ProceduralFormation> = {
  idle: 'sphere',
  listening: 'ring',
  thinking: 'sphere',
  delivering: 'scatter',
  success: 'sphere',
  error: 'sphere',
};

export const IRIS_STATE_COLORS: Record<IrisState, number> = {
  idle: 0x00f3ff,
  listening: 0x00f3ff,
  thinking: 0xa855f7,
  delivering: 0xffcc00,
  success: 0x22c55e,
  error: 0xef4444,
};

export const IRIS_AUDIO_COLORS = {
  user: 0xa855f7,
  iris: 0xf59e0b,
  power: 0xff3300,
} as const;

export function resolveIrisIdentityColor(state: IrisState, userAudio: number, irisAudio: number, powerMode: boolean): number {
  if (powerMode) return IRIS_AUDIO_COLORS.power;
  if (irisAudio > 0.1) return IRIS_AUDIO_COLORS.iris;
  if (userAudio > 0.1) return IRIS_AUDIO_COLORS.user;
  return IRIS_STATE_COLORS[state];
}
