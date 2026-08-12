import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { toolRegistry } from './toolRegistry';

export interface MacroStep { action: string; params?: Record<string, unknown>; delay_ms?: number }
export interface MacroDefinition { name: string; trigger: string; aliases?: string[]; description?: string; steps: MacroStep[] }
export interface MacroInfo { name: string; trigger: string; aliases: string[]; description?: string; step_count: number }
export interface MacroExecutionResult { success: boolean; stepsExecuted: number; errors: string[] }

export async function listMacros(): Promise<MacroInfo[]> {
  try { return await invoke<MacroInfo[]>('list_macros'); } catch { return []; }
}

export async function getMacro(nameOrTrigger: string): Promise<MacroDefinition | null> {
  try { return await invoke<MacroDefinition>('get_macro', { nameOrTrigger }); } catch { return null; }
}

export async function saveMacro(name: string, yamlContent: string): Promise<boolean> {
  try { await invoke('save_macro', { name, yamlContent }); return true; } catch { return false; }
}

export async function matchMacroTrigger(userInput: string): Promise<MacroDefinition | null> {
  const input = userInput.toLowerCase().trim();
  for (const macro of await listMacros()) {
    const candidates = [macro.trigger, ...macro.aliases].map((candidate) => candidate.toLowerCase());
    if (candidates.some((candidate) => input === candidate || input.includes(candidate))) return getMacro(macro.name);
  }
  return null;
}

async function executeStep(step: MacroStep): Promise<{ success: boolean; error?: string }> {
  const action = step.action.toLowerCase();
  const params = { ...(step.params || {}) };
  const aliases: Record<string, string> = { mute: 'adjust_volume', screenshot: 'take_screenshot', play_pause: 'media_control', next_track: 'media_control', skip: 'media_control' };
  const registryAction = aliases[action] || action;
  if (registryAction === 'adjust_volume' && action === 'mute') params.direction = 'mute';
  if (registryAction === 'media_control') params.action = action === 'next_track' || action === 'skip' ? 'next' : 'play_pause';
  if (registryAction === 'launch_app' || registryAction === 'open_app' || registryAction === 'close_app') params.appName = params.appName || params.app || params.name;
  const result = await toolRegistry.execute(registryAction, params);
  return result.success ? { success: true } : { success: false, error: result.error || 'Tool rejected.' };
}

export async function executeMacro(macro: MacroDefinition): Promise<MacroExecutionResult> {
  const result: MacroExecutionResult = { success: true, stepsExecuted: 0, errors: [] };
  emit('macro-start', { name: macro.name, stepCount: macro.steps.length });
  for (let index = 0; index < macro.steps.length; index += 1) {
    const step = macro.steps[index];
    emit('macro-progress', { name: macro.name, step: index + 1, total: macro.steps.length });
    if (step.delay_ms && step.delay_ms > 0) await new Promise((resolve) => setTimeout(resolve, step.delay_ms));
    const stepResult = await executeStep(step);
    if (stepResult.success) result.stepsExecuted += 1;
    else result.errors.push(`Step ${index + 1} (${step.action}): ${stepResult.error}`);
  }
  result.success = result.stepsExecuted === macro.steps.length;
  emit('macro-complete', { name: macro.name, success: result.success, errors: result.errors });
  return result;
}
