import type { CapabilityPackage } from './types';

export function candidateSummary(candidate: CapabilityPackage): string {
  const writes = candidate.capabilities.filter((item) => !['GET', 'HEAD', 'OPTIONS'].includes(item.method)).length;
  return `${candidate.capabilities.length} capabilities (${writes} state-changing), origin ${candidate.targetOrigin}, package hash ${candidate.contentHash}`;
}

