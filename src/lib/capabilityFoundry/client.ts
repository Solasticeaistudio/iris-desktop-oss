import { invoke } from '@tauri-apps/api/core';
import type { CapabilityPackage, DiscoveryResult, DriftReport, InstalledCapability } from './types';

export const foundryClient = {
  discover: (targetUrl: string, allowLocalNetwork = false) => invoke<DiscoveryResult>('foundry_discover', { targetUrl, allowLocalNetwork }),
  cancel: () => invoke<void>('foundry_cancel_discovery'),
  importOpenApi: (document: unknown, sourceUrl: string, allowLocalNetwork = false) => invoke<CapabilityPackage>('foundry_import_openapi', { document, sourceUrl, allowLocalNetwork }),
  importGraphQl: (document: unknown, endpointUrl: string, allowLocalNetwork = false) => invoke<CapabilityPackage>('foundry_import_graphql', { document, endpointUrl, allowLocalNetwork }),
  importHar: (document: unknown, targetUrl: string, allowLocalNetwork = false) => invoke<CapabilityPackage>('foundry_import_har', { document, targetUrl, allowLocalNetwork }),
  importHtml: (html: string, pageUrl: string, allowLocalNetwork = false) => invoke<CapabilityPackage>('foundry_import_html', { html, pageUrl, allowLocalNetwork }),
  getCandidate: (packageId: string) => invoke<CapabilityPackage>('foundry_get_candidate', { packageId }),
  reject: (packageId: string) => invoke<void>('foundry_reject_candidate', { packageId }),
  install: (packageId: string, selectedCapabilityIds: string[]) => invoke<InstalledCapability>('foundry_install_candidate', { packageId, selectedCapabilityIds }),
  list: () => invoke<InstalledCapability[]>('foundry_list_packages'),
  setEnabled: (packageId: string, enabled: boolean) => invoke<void>('foundry_set_package_enabled', { packageId, enabled }),
  uninstall: (packageId: string) => invoke<void>('foundry_uninstall_package', { packageId }),
  drift: (packageId: string, currentCandidateId: string) => invoke<DriftReport>('foundry_check_drift', { packageId, currentCandidateId }),
  history: () => invoke<unknown[]>('foundry_history'),
  mcpInfo: (packageId: string) => invoke<Record<string, unknown>>('foundry_mcp_info', { packageId }),
};
