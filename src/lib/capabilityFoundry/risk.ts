import type { FoundryRisk } from './types';

export const riskLabel: Record<FoundryRisk, string> = {
  low: 'Public read', medium: 'Review advised', high: 'Explicit approval', critical: 'Disabled by default',
};

export function riskColor(risk: FoundryRisk): string {
  return risk === 'critical' ? 'text-red-300' : risk === 'high' ? 'text-orange-300' : risk === 'medium' ? 'text-amber-200' : 'text-emerald-300';
}

