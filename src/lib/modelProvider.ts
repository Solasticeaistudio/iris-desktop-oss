import { invoke } from '@tauri-apps/api/core';

export type ProviderRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ProviderMessage {
  role: ProviderRole;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  name?: string;
  toolCallId?: string;
  toolCalls?: ProviderToolCall[];
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ProviderResponse {
  text: string;
  toolCalls: ProviderToolCall[];
  raw?: unknown;
}

export interface IrisModelProvider {
  readonly id: string;
  readonly name: string;
  readonly supportsVision: boolean;
  readonly supportsTools: boolean;
  readonly supportsStreaming: boolean;
  chat(messages: ProviderMessage[], tools: unknown[]): Promise<ProviderResponse>;
}

export interface ProviderConfig {
  provider: string;
}

export interface NativeModelResponse {
  provider: string;
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string | Record<string, unknown> };
    }>;
  };
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string | Record<string, unknown> };
      }>;
    };
  }>;
  text?: string;
  tool_calls?: ProviderToolCall[];
  error?: string;
}

function parseArguments(value: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid provider tool arguments are deliberately converted to an empty object;
    // schema validation in the registry will reject the request before execution.
  }
  return {};
}

export function normalizeNativeModelResponse(response: NativeModelResponse): ProviderResponse {
  if (response.error) throw new Error(response.error);
  const message = response.message || response.choices?.[0]?.message;
  const rawCalls = response.tool_calls || message?.tool_calls || [];
  const toolCalls = rawCalls.map((call, index) => {
    const functionCall = 'function' in call ? call.function : undefined;
    return {
      id: call.id || `tool_call_${index + 1}`,
      name: functionCall?.name || ('name' in call ? String(call.name || '') : ''),
      arguments: parseArguments(functionCall?.arguments || ('arguments' in call ? call.arguments : undefined)),
    };
  }).filter((call) => call.name.length > 0);

  return {
    text: response.text || message?.content || '',
    toolCalls,
    raw: response,
  };
}

export class MockModelProvider implements IrisModelProvider {
  readonly id = 'mock';
  readonly name = 'Offline Mock Provider';
  readonly supportsVision = false;
  readonly supportsTools = true;
  readonly supportsStreaming = false;

  async chat(messages: ProviderMessage[]): Promise<ProviderResponse> {
    const sequenceRequest = messages.find((message) => message.role === 'user' && typeof message.content === 'string' && message.content.trim().toLowerCase() === 'mock sequence');
    if (sequenceRequest) {
      const results = messages.filter((message) => message.role === 'tool');
      if (results.length === 0) return { text: '', toolCalls: [{ id: 'mock_sequence_1', name: 'list_workspaces', arguments: {} }] };
      if (results.length === 1) return { text: '', toolCalls: [{ id: 'mock_sequence_2', name: 'get_time', arguments: {} }] };
      return { text: `Mock sequence complete with ${results.length} tool results.`, toolCalls: [] };
    }
    const lastMessage = messages.at(-1);
    if (lastMessage?.role === 'tool') {
      return { text: `Mock provider completed after receiving tool result: ${String(lastMessage.content).slice(0, 240)}`, toolCalls: [] };
    }
    const last = [...messages].reverse().find((message) => message.role === 'user');
    const multimodal = Array.isArray(last?.content) ? last.content : [];
    const content = typeof last?.content === 'string'
      ? last.content
      : multimodal.find((item) => item.type === 'text')?.text || 'your request';
    const hasScreenshot = multimodal.some((item) => item.type === 'image_url');
    const toolRequest = content.match(/^mock tool:\s*([a-z0-9_]+)(?:\s+(\{.*\}))?$/i);
    if (toolRequest) {
      let argumentsValue: Record<string, unknown> = {};
      if (toolRequest[2]) {
        try {
          const parsed: unknown = JSON.parse(toolRequest[2]);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            argumentsValue = parsed as Record<string, unknown>;
          }
        } catch {
          // The registry will fail closed if the deterministic request is malformed.
        }
      }
      return {
        text: `Mock provider requested tool ${toolRequest[1]}.`,
        toolCalls: [{ id: 'mock_tool_call_1', name: toolRequest[1], arguments: argumentsValue }],
      };
    }
    if (hasScreenshot) {
      return {
        text: `Mock provider response: I received a screenshot attachment with “${content.slice(0, 240)}”.`,
        toolCalls: [],
      };
    }
    return {
      text: `Mock provider response: I received “${content.slice(0, 240)}”. Configure an OpenAI-compatible provider for model reasoning.`,
      toolCalls: [],
    };
  }
}

export class OpenAICompatibleProvider implements IrisModelProvider {
  readonly id = 'openai-compatible';
  readonly name = 'OpenAI-compatible provider';
  readonly supportsVision = true;
  readonly supportsTools = true;
  readonly supportsStreaming = false;

  async chat(messages: ProviderMessage[], tools: unknown[]): Promise<ProviderResponse> {
    const transportMessages = messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
    }));
    const response = await invoke<NativeModelResponse>('model_chat', {
      request: {
        messages: transportMessages,
        tools,
      },
    });
    return normalizeNativeModelResponse(response);
  }
}

export function createModelProvider(config: ProviderConfig): IrisModelProvider {
  if (config.provider === 'mock') return new MockModelProvider();
  if (config.provider === 'openai-compatible') return new OpenAICompatibleProvider();
  throw new Error(`Unsupported model provider: ${config.provider}`);
}

export function getProviderConfig(): ProviderConfig {
  const configured = (import.meta.env.IRIS_MODEL_PROVIDER || import.meta.env.VITE_IRIS_MODEL_PROVIDER || 'mock').trim();
  return { provider: configured === 'mock' ? 'mock' : 'openai-compatible' };
}
