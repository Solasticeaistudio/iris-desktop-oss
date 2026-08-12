export type FoundryRisk = 'low' | 'medium' | 'high' | 'critical';

export interface Evidence {
  id: string; sourceMode: string; sourceType: string; sourceUrl: string;
  confidence: number; fingerprint: string; metadata: Record<string, unknown>;
}

export interface Capability {
  id: string; toolName: string; description: string; method: string; endpoint: string;
  inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
  authRequired: boolean; approvalRequired: boolean; riskLevel: FoundryRisk;
  confidence: number; sourceMode: string; evidenceIds: string[]; tags: string[];
  dataClassification: string; enabled: boolean; credentialHandle?: string;
  metadata: Record<string, unknown>;
}

export interface Route {
  capabilityId: string; method: string; pathTemplate: string;
  pathParameters: string[]; queryParameters: string[]; bodyFields: string[];
}

export interface Entity { id: string; name: string; schema: Record<string, unknown>; evidenceIds: string[] }
export interface RiskProfile { defaultRisk: string; disabledClasses: string[]; unknownBehavior: string; writeOwnershipRequired: boolean }
export interface NormalizedManifest { targetOrigin: string; capabilities: Capability[]; routes: Route[]; entities: Entity[]; riskProfile: RiskProfile; evidence: Evidence[] }

export interface CapabilityPackage {
  packageId: string; name: string; version: string; targetOrigin: string; createdAt: string;
  compilerVersion: string; capabilities: Capability[]; routes: Route[]; entities: Entity[];
  riskProfile: RiskProfile; evidence: Evidence[]; permissions: string[];
  networkScope: { origin: string; sameOriginRedirectsOnly: boolean; allowLocalNetwork: boolean; maxRedirects: number };
  credentialRequirements: string[]; dataFlowMetadata: Record<string, unknown>;
  driftFingerprint: string; contentHash: string;
  manifest: { formatVersion: string; contentHash: string; compilerVersion: string; declarativeOnly: boolean };
  tests: Array<Record<string, unknown>>;
}

export interface InstalledCapability {
  packageId: string; name: string; origin: string; version: string; contentHash: string;
  installedAt: string; enabled: boolean; driftStatus: string; toolCount: number;
  credentialHandles: string[]; tampered: boolean;
}

export interface DriftReport {
  packageId: string; status: 'stable' | 'drift_detected' | 'needs_attention'; severity: string;
  writeCapabilitiesSuspended: string[];
  changes: Array<{ capabilityId: string; field: string; oldValue: unknown; newValue: unknown; severity: string }>;
}

export interface DiscoveryResult {
  authorizedOrigin: string; package?: CapabilityPackage; detectedSurfaces: string[];
  rejectedSurfaces: string[]; requestsMade: number;
}
