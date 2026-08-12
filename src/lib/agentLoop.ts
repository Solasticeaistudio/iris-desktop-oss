import type { IrisModelProvider, ProviderMessage, ProviderResponse, ProviderToolCall } from './modelProvider';
import type { ToolExecutionResult } from './toolRegistry';

export const MAX_TOOL_ROUNDS = 8;
export const MAX_TOOL_CALLS_PER_ROUND = 4;
export const MAX_CONSECUTIVE_TOOL_FAILURES = 3;
export const MAX_AGENT_DURATION_MS = 120_000;

export interface AgentLoopOptions {
  provider: IrisModelProvider;
  messages: ProviderMessage[];
  tools: unknown[];
  executeTool: (call: ProviderToolCall) => Promise<ToolExecutionResult>;
  signal?: AbortSignal;
  maxToolRounds?: number;
  maxToolCallsPerRound?: number;
  maxConsecutiveFailures?: number;
  maxDurationMs?: number;
}

export interface AgentLoopResult {
  text: string;
  messages: ProviderMessage[];
  toolRounds: number;
  toolCallsExecuted: number;
  stoppedReason?: 'max_rounds' | 'max_calls' | 'tool_failures' | 'timeout' | 'cancelled';
}

function terminal(text: string, messages: ProviderMessage[], toolRounds: number, toolCallsExecuted: number, stoppedReason: AgentLoopResult['stoppedReason']): AgentLoopResult {
  return { text, messages, toolRounds, toolCallsExecuted, stoppedReason };
}

function toolResultMessage(call: ProviderToolCall, result: ToolExecutionResult): ProviderMessage {
  return {
    role: 'tool',
    name: call.name,
    toolCallId: call.id,
    content: JSON.stringify({ success: result.success, result: result.result ?? null, error: result.error ?? null }),
  };
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const messages = [...options.messages];
  const started = Date.now();
  const maxRounds = options.maxToolRounds ?? MAX_TOOL_ROUNDS;
  const maxCalls = options.maxToolCallsPerRound ?? MAX_TOOL_CALLS_PER_ROUND;
  const maxFailures = options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_TOOL_FAILURES;
  const maxDuration = options.maxDurationMs ?? MAX_AGENT_DURATION_MS;
  let toolRounds = 0;
  let toolCallsExecuted = 0;
  let consecutiveFailures = 0;

  while (true) {
    if (options.signal?.aborted) return terminal('IRIS stopped because the request was cancelled.', messages, toolRounds, toolCallsExecuted, 'cancelled');
    if (Date.now() - started >= maxDuration) return terminal('IRIS stopped after reaching the agent execution timeout.', messages, toolRounds, toolCallsExecuted, 'timeout');

    const response: ProviderResponse = await options.provider.chat(messages, options.tools);
    if (!Array.isArray(response.toolCalls)) throw new Error('Provider returned malformed tool calls.');
    if (response.toolCalls.length === 0) {
      const text = response.text || 'The model completed without a final text response.';
      messages.push({ role: 'assistant', content: text });
      return { text, messages, toolRounds, toolCallsExecuted };
    }
    if (response.toolCalls.length > maxCalls) return terminal(`IRIS stopped because the model requested more than ${maxCalls} tools in one round.`, messages, toolRounds, toolCallsExecuted, 'max_calls');
    if (toolRounds >= maxRounds) return terminal('IRIS stopped after reaching the maximum tool-execution depth.', messages, toolRounds, toolCallsExecuted, 'max_rounds');

    messages.push({ role: 'assistant', content: response.text || '', toolCalls: response.toolCalls });
    toolRounds += 1;
    for (const call of response.toolCalls) {
      if (!call.id || !call.name || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
        const malformed: ToolExecutionResult = { success: false, error: 'Malformed tool request rejected before execution.' };
        messages.push(toolResultMessage(call, malformed));
        consecutiveFailures += 1;
      } else {
        let result: ToolExecutionResult;
        try { result = await options.executeTool(call); }
        catch (error) { result = { success: false, error: error instanceof Error ? error.message : String(error) }; }
        messages.push(toolResultMessage(call, result));
        toolCallsExecuted += 1;
        consecutiveFailures = result.success ? 0 : consecutiveFailures + 1;
      }
      if (consecutiveFailures >= maxFailures) return terminal(`IRIS stopped after ${maxFailures} consecutive tool failures.`, messages, toolRounds, toolCallsExecuted, 'tool_failures');
      if (options.signal?.aborted) return terminal('IRIS stopped because the request was cancelled.', messages, toolRounds, toolCallsExecuted, 'cancelled');
    }
  }
}
