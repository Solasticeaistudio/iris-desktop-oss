import { invoke } from '@tauri-apps/api/core';

export type ReasoningProvider = 'mock' | 'gemini' | 'openai' | 'custom';

export interface ReasoningSettings {
  provider: ReasoningProvider;
  model: string;
  customBaseUrl: string;
}

export interface ReasoningStatus {
  settings: ReasoningSettings;
  endpoint?: string;
  credential: {
    configured: boolean;
    source: 'none' | 'environment' | 'os_keyring';
  };
  configurationSource: 'default' | 'environment' | 'app_config';
  secureStorageAvailable: boolean;
}

export const DEFAULT_REASONING_STATUS: ReasoningStatus = {
  settings: {
    provider: 'mock',
    model: 'gemini-3.6-flash',
    customBaseUrl: '',
  },
  credential: { configured: false, source: 'none' },
  configurationSource: 'default',
  secureStorageAvailable: false,
};

export const getReasoningStatus = () => invoke<ReasoningStatus>('reasoning_get_status');

export const saveReasoningSettings = (settings: ReasoningSettings) =>
  invoke<ReasoningStatus>('reasoning_save_settings', { settings });

export const setReasoningCredential = (credential: string) =>
  invoke<ReasoningStatus>('reasoning_set_credential', { credential });

export const clearReasoningCredential = () =>
  invoke<ReasoningStatus>('reasoning_clear_credential');

export const testReasoningConnection = () =>
  invoke<string>('reasoning_test_connection');
