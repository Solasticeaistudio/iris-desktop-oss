import { invoke } from '@tauri-apps/api/core';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ToolParameterType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface ToolParameter {
  name: string;
  type: ToolParameterType;
  description: string;
  required: boolean;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  parameters: ToolParameter[];
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  enabled: boolean;
  tags: string[];
  inputSchema?: JsonSchema;
  packageId?: string;
  capabilityId?: string;
}

export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean;
  nullable?: boolean;
  [key: string]: unknown;
}

export interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  execution_time_ms?: number;
}

export type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

interface AuditContext {
  userCommand: string;
  understoodIntent: string;
  conversationSnippet: Array<{ role: string; content: string; timestamp: string }>;
}

let currentAuditContext: AuditContext | null = null;

export function setAuditContext(userCommand: string, understoodIntent: string, conversationSnippet: AuditContext['conversationSnippet'] = []): void {
  currentAuditContext = { userCommand, understoodIntent, conversationSnippet };
}

export function clearAuditContext(): void {
  currentAuditContext = null;
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/-/g, '_');
}

function parameter(name: string, type: ToolParameterType, description: string, required = true): ToolParameter {
  return { name, type, description, required };
}

function redact(value: unknown, key = ''): unknown {
  if (/key|token|secret|password|authorization|credential/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…[truncated]`;
  return value;
}

function typeMatches(value: unknown, type: ToolParameterType): boolean {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateArguments(definition: ToolDefinition, params: Record<string, unknown>): string | null {
  if (definition.inputSchema) return validateJsonSchema(definition.inputSchema, params, '$');
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'Tool arguments must be a JSON object.';
  const known = new Set(definition.parameters.map((item) => item.name));
  const unknown = Object.keys(params).filter((key) => !known.has(key));
  if (unknown.length) return `Unknown argument(s): ${unknown.join(', ')}`;
  for (const item of definition.parameters) {
    if (item.required && !(item.name in params)) return `Missing required argument: ${item.name}`;
    if (item.name in params && !typeMatches(params[item.name], item.type)) {
      return `Invalid type for ${item.name}; expected ${item.type}.`;
    }
  }
  return null;
}

const SUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', 'type', 'description', 'properties', 'required', 'items', 'enum', 'minimum', 'maximum',
  'minLength', 'maxLength', 'pattern', 'additionalProperties', 'default', 'title', 'format', 'nullable',
]);

function validateJsonSchema(schema: JsonSchema, value: unknown, path: string, depth = 0): string | null {
  if (depth > 20) return 'Schema validation depth exceeded.';
  const unsupported = Object.keys(schema).filter((key) => !SUPPORTED_SCHEMA_KEYS.has(key));
  if (unsupported.length) return `Unsupported schema keyword(s): ${unsupported.join(', ')}`;
  if (value === null && schema.nullable) return null;
  const type = schema.type || 'object';
  const validType = type === 'object' ? Boolean(value && typeof value === 'object' && !Array.isArray(value))
    : type === 'array' ? Array.isArray(value)
      : type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
        : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : type === 'null' ? value === null
            : typeof value === type;
  if (!validType) return `${path}: expected ${type}.`;
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) return `${path}: value is not in enum.`;
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path}: below minimum.`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path}: above maximum.`;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path}: shorter than minLength.`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path}: longer than maxLength.`;
    if (schema.pattern) {
      try { if (!new RegExp(schema.pattern).test(value)) return `${path}: pattern mismatch.`; }
      catch { return `${path}: invalid schema pattern.`; }
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateJsonSchema(schema.items, value[index], `${path}[${index}]`, depth + 1);
      if (error) return error;
    }
  }
  if (type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const properties = schema.properties || {};
    for (const name of schema.required || []) if (!(name in object)) return `${path}: missing required property ${name}.`;
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(object).filter((name) => !(name in properties));
      if (unknown.length) return `${path}: unknown property ${unknown[0]}.`;
    }
    for (const [name, childSchema] of Object.entries(properties)) {
      if (!(name in object)) continue;
      const error = validateJsonSchema(childSchema, object[name], `${path}.${name}`, depth + 1);
      if (error) return error;
    }
  }
  return null;
}

async function saveAudit(tool: string, risk: RiskLevel, params: Record<string, unknown>, status: string, approvalRequired: boolean, approvalGranted: boolean | null, error?: string): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    await invoke('save_audit_log', {
      entry: {
        timestamp: new Date().toISOString(),
        tool,
        risk,
        arguments: redact(params),
        approvalRequired,
        approvalGranted,
        executionStatus: status,
        error: error || null,
        userCommand: currentAuditContext?.userCommand || '',
        understoodIntent: currentAuditContext?.understoodIntent || '',
        conversationSnippet: currentAuditContext?.conversationSnippet || [],
      },
    });
  } catch (auditError) {
    console.warn('[IRIS] Audit write failed:', auditError);
  }
}

interface NativeApprovalResponse {
  approved: boolean;
  approvalId?: string;
  expiresAt?: number;
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() || `iris-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function executeSensitiveTool(tool: string, params: Record<string, unknown>): Promise<unknown> {
  const request = { requestId: requestId(), tool: normalize(tool), arguments: params };
  const approval = await invoke<NativeApprovalResponse>('request_tool_approval', { request });
  if (!approval.approved || !approval.approvalId) throw new Error('Action denied or approval unavailable. Action cancelled.');
  return invoke('execute_sensitive_tool', { request, approvalId: approval.approvalId });
}

interface NativeControlSession {
  controlSessionId: string;
  expiresAt: number;
  processId: number;
  windowHandle: number;
  executable: string;
  windowTitle: string;
}

let activeControlSession: NativeControlSession | null = null;

async function requestBoundControlSession(tool: string, purpose?: string, targetWindowTitle?: string): Promise<NativeControlSession> {
  activeControlSession = await invoke<NativeControlSession>('request_control_session', {
    purpose: purpose || `Execute the structured ${normalize(tool)} desktop-control tool`,
    targetWindowTitle: targetWindowTitle || null,
  });
  return activeControlSession;
}

export async function executeControlTool(tool: string, params: Record<string, unknown>, purpose?: string): Promise<unknown> {
  const normalizedTool = normalize(tool);
  if (normalizedTool === 'launch_app') {
    await cancelControlSession();
    return invoke('launch_allowlisted_app', { appName: params.appName });
  }
  const now = Math.floor(Date.now() / 1000);
  const requestedTitle = normalizedTool === 'focus_window' && typeof params.title === 'string' ? params.title : undefined;
  if (requestedTitle) {
    await cancelControlSession();
    await requestBoundControlSession(normalizedTool, purpose, requestedTitle);
  } else if (!activeControlSession || activeControlSession.expiresAt <= now) {
    await requestBoundControlSession(normalizedTool, purpose);
  }
  try {
    return await invoke('execute_control_tool', {
      controlSessionId: activeControlSession!.controlSessionId,
      tool: normalizedTool,
      arguments: params,
    });
  } catch (error) {
    if (/session|target_mismatch|new_control_authorization_required/i.test(String(error))) activeControlSession = null;
    throw error;
  }
}

async function executeBoundDrag(params: Record<string, unknown>): Promise<unknown> {
  const now = Math.floor(Date.now() / 1000);
  if (!activeControlSession || activeControlSession.expiresAt <= now) {
    await requestBoundControlSession('drag', 'Drag within the currently focused application window');
  }
  return executeSensitiveTool('drag', {
    ...params,
    controlSessionId: activeControlSession!.controlSessionId,
  });
}

export async function cancelControlSession(): Promise<void> {
  const current = activeControlSession;
  activeControlSession = null;
  if (current) await invoke('cancel_control_session', { controlSessionId: current.controlSessionId });
}

function definition(name: string, description: string, riskLevel: RiskLevel, parameters: ToolParameter[], requiresApproval = riskLevel === 'high' || riskLevel === 'critical'): ToolDefinition {
  return { id: name, name, description, category: 'desktop', parameters, riskLevel, requiresApproval, enabled: true, tags: ['local', riskLevel] };
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(name: string, handler: ToolHandler, toolDefinition: ToolDefinition): void {
    const normalizedName = normalize(name);
    if (toolDefinition.name !== normalizedName || !toolDefinition.riskLevel) throw new Error(`Tool ${name} must declare risk metadata.`);
    if (toolDefinition.category === 'capability-foundry' && !/^foundry_[a-z0-9_]{1,56}$/.test(normalizedName)) {
      throw new Error(`Invalid Foundry tool namespace: ${normalizedName}`);
    }
    if (toolDefinition.category !== 'capability-foundry' && normalizedName.startsWith('foundry_')) {
      throw new Error(`Reserved Foundry tool namespace: ${normalizedName}`);
    }
    if (this.tools.has(normalizedName)) throw new Error(`Tool name collision: ${normalizedName}`);
    this.tools.set(normalizedName, { definition: toolDefinition, handler });
  }

  unregister(name: string): boolean { return this.tools.delete(normalize(name)); }
  has(name: string): boolean { return this.tools.has(normalize(name)); }
  get(name: string): RegisteredTool | undefined { return this.tools.get(normalize(name)); }
  async loadFromBackend(): Promise<number> {
    const definitions = await invoke<Array<{
      packageId: string; capabilityId: string; name: string; description: string; category: string;
      inputSchema: JsonSchema; riskLevel: RiskLevel; requiresApproval: boolean; enabled: boolean; tags: string[];
    }>>('foundry_list_tools');
    const names = new Set<string>();
    for (const item of definitions) {
      const name = normalize(item.name);
      if (this.tools.has(name) || names.has(name)) throw new Error(`Tool name collision: ${name}`);
      names.add(name);
    }
    for (const item of definitions) {
      const definition: ToolDefinition = {
        id: item.capabilityId,
        name: normalize(item.name),
        description: item.description,
        category: item.category,
        parameters: [],
        inputSchema: item.inputSchema,
        riskLevel: item.riskLevel,
        requiresApproval: item.requiresApproval,
        enabled: item.enabled,
        tags: item.tags,
        packageId: item.packageId,
        capabilityId: item.capabilityId,
      };
      this.register(definition.name, async (params) => {
        let approvalId: string | undefined;
        if (definition.requiresApproval) {
          const approval = await invoke<NativeApprovalResponse>('foundry_request_approval', {
            request: {
              requestId: requestId(),
              packageId: definition.packageId,
              capabilityId: definition.capabilityId,
              arguments: params,
            },
          });
          if (!approval.approved || !approval.approvalId) throw new Error('APPROVAL_REQUIRED');
          approvalId = approval.approvalId;
        }
        return invoke('foundry_execute', {
          request: {
            packageId: definition.packageId,
            capabilityId: definition.capabilityId,
            arguments: params,
            approvalId,
          },
        });
      }, definition);
    }
    return definitions.length;
  }
  async refresh(): Promise<number> {
    for (const [name, tool] of this.tools) if (tool.definition.category === 'capability-foundry') this.tools.delete(name);
    return this.loadFromBackend();
  }

  list(): ToolDefinition[] { return [...this.tools.values()].map((tool) => tool.definition); }

  modelTools(): unknown[] {
    return this.list().map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: `${tool.description} Risk: ${tool.riskLevel}.${tool.requiresApproval ? ' Requires explicit local approval.' : ''}`,
        parameters: tool.inputSchema || {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(tool.parameters.map((item) => [item.name, {
            type: item.type === 'array' ? 'array' : item.type,
            description: item.description,
          }])),
          required: tool.parameters.filter((item) => item.required).map((item) => item.name),
        },
      },
    }));
  }

  positionalArguments(name: string, values: string[]): Record<string, unknown> {
    const tool = this.get(name);
    if (!tool) return {};
    const result: Record<string, unknown> = {};
    tool.definition.parameters.forEach((item, index) => {
      const value = values[index];
      if (value === undefined) return;
      if (item.type === 'number') result[item.name] = Number(value);
      else if (item.type === 'boolean') result[item.name] = value === 'true';
      else if (item.type === 'array' || item.type === 'object') {
        try { result[item.name] = JSON.parse(value); } catch { result[item.name] = value; }
      } else result[item.name] = value;
    });
    return result;
  }

  async execute(name: string, params: Record<string, unknown> = {}, options: { onWarning?: (warning: string) => void } = {}): Promise<ToolExecutionResult> {
    const normalizedName = normalize(name);
    const tool = this.tools.get(normalizedName);
    if (!tool) return { success: false, error: `Unknown tool '${name}'. Execution denied. IRIS may offer Capability Foundry inspection, but discovery requires an explicitly user-authorized target in the local UI.` };
    if (!tool.definition.enabled) return { success: false, error: `Tool '${name}' is disabled.` };

    const validationError = validateArguments(tool.definition, params);
    if (validationError) {
      await saveAudit(normalizedName, tool.definition.riskLevel, params, 'invalid_arguments', false, null, validationError);
      return { success: false, error: validationError };
    }

    let approved: boolean | null = null;
    if (tool.definition.requiresApproval) {
      const warning = `Approval required: ${tool.definition.name} (${tool.definition.riskLevel.toUpperCase()})\n${JSON.stringify(redact(params), null, 2)}`;
      options.onWarning?.(warning);
      // The trusted native dialog creates a short-lived approval token bound to
      // this exact tool and normalized argument object. The renderer cannot mint it.
      approved = true;
    }

    const start = performance.now();
    try {
      const result = tool.definition.category === 'capability-foundry'
        ? await tool.handler(params)
        : tool.definition.requiresApproval
        ? normalizedName === 'drag'
          ? await executeBoundDrag(params)
          : await executeSensitiveTool(normalizedName, params)
        : await tool.handler(params);
      await saveAudit(normalizedName, tool.definition.riskLevel, params, 'executed', tool.definition.requiresApproval, approved);
      return { success: true, result, execution_time_ms: performance.now() - start };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const denied = tool.definition.requiresApproval && /denied|approval unavailable|expired|already consumed|not bound/i.test(message);
      await saveAudit(normalizedName, tool.definition.riskLevel, params, denied ? 'denied' : 'failed', tool.definition.requiresApproval, denied ? false : approved, message);
      return { success: false, error: message, execution_time_ms: performance.now() - start };
    }
  }

  initializeBuiltins(): void {
    const add = (name: string, description: string, risk: RiskLevel, parameters: ToolParameter[], handler: ToolHandler, approval = risk === 'high' || risk === 'critical') => {
      this.register(name, handler, definition(name, description, risk, parameters, approval));
    };
    const appParam = [parameter('appName', 'string', 'Name of an allowlisted desktop application.')];
    add('launch_app', 'Launch a non-terminal allowlisted application. Input control requires a separate target-bound authorization after its window exists.', 'medium', appParam, async (p) => executeControlTool('launch_app', { appName: p.appName }));
    add('open_app', 'Open a non-terminal allowlisted application. Input control requires a separate target-bound authorization after its window exists.', 'medium', appParam, async (p) => executeControlTool('launch_app', { appName: p.appName }));
    add('close_app', 'Close a desktop application by name.', 'high', appParam, async () => undefined);
    add('open_url', 'Open a URL in the default browser; network navigation requires approval.', 'high', [parameter('url', 'string', 'Absolute http or https URL.')], async () => undefined);
    add('open_folder', 'Open an existing local folder in the system file browser.', 'low', [parameter('path', 'string', 'Absolute existing folder path.')], async (p) => invoke('open_folder', { path: p.path }));
    add('web_search', 'Open a web search in the default browser.', 'high', [parameter('query', 'string', 'Search terms.')], async () => undefined);
    add('type_text', 'Type text during an authorized, time-bounded computer-control session.', 'medium', [parameter('text', 'string', 'Text to type.')], async (p) => executeControlTool('type_text', { text: p.text }));
    add('set_volume', 'Set system volume.', 'low', [parameter('level', 'number', 'Volume from 0 to 100.')], async (p) => invoke('set_volume', { level: p.level }));
    add('adjust_volume', 'Adjust system volume.', 'low', [parameter('direction', 'string', 'up, down, or mute.')], async (p) => invoke('adjust_volume', { direction: p.direction }));
    add('media_control', 'Control media playback.', 'medium', [parameter('action', 'string', 'play, pause, next, previous, or stop.')], async (p) => invoke('media_control', { action: p.action }));
    add('set_brightness', 'Set display brightness.', 'medium', [parameter('level', 'number', 'Brightness from 0 to 100.')], async (p) => invoke('set_brightness', { level: p.level }));
    add('adjust_brightness', 'Adjust display brightness.', 'medium', [parameter('direction', 'string', 'up or down.')], async (p) => invoke('adjust_brightness', { direction: p.direction }));
    add('toggle_wifi', 'Enable or disable Wi-Fi.', 'high', [parameter('enable', 'boolean', 'Whether Wi-Fi should be enabled.')], async () => undefined);
    add('take_screenshot', 'Capture the screen to a local file.', 'low', [], async () => invoke('save_screenshot', { path: null }));
    add('read_clipboard', 'Read the current clipboard text after a bound privacy approval.', 'high', [], async () => executeSensitiveTool('read_clipboard', {}));
    add('copy_to_clipboard', 'Replace the clipboard text.', 'medium', [parameter('text', 'string', 'Text to copy.')], async (p) => invoke('set_clipboard_text', { text: p.text }));
    add('read_file', 'Read a UTF-8 file after native path validation and a bound privacy approval.', 'high', [parameter('path', 'string', 'File path to read.')], async (p) => executeSensitiveTool('read_file', { path: p.path }));
    add('press_key_combo', 'Press a keyboard shortcut during an authorized control session.', 'medium', [parameter('keys', 'array', 'Keys such as ["CTRL", "C"].')], async (p) => executeControlTool('press_key_combo', { keys: p.keys }));
    add('show_notification', 'Show a local desktop notification.', 'low', [parameter('title', 'string', 'Notification title.'), parameter('body', 'string', 'Notification body.')], async (p) => invoke('show_notification', { title: p.title, body: p.body }));
    add('move_mouse', 'Move the pointer during an authorized control session.', 'medium', [parameter('x', 'number', 'Screen x coordinate.'), parameter('y', 'number', 'Screen y coordinate.')], async (p) => executeControlTool('move_mouse', { x: p.x, y: p.y }));
    add('click', 'Click during an authorized control session.', 'medium', [parameter('x', 'number', 'Screen x coordinate.'), parameter('y', 'number', 'Screen y coordinate.')], async (p) => executeControlTool('click', { x: p.x, y: p.y }));
    add('double_click', 'Double-click during an authorized control session.', 'medium', [parameter('x', 'number', 'Screen x coordinate.'), parameter('y', 'number', 'Screen y coordinate.')], async (p) => executeControlTool('double_click', { x: p.x, y: p.y }));
    add('right_click', 'Right-click during an authorized control session.', 'medium', [parameter('x', 'number', 'Screen x coordinate.'), parameter('y', 'number', 'Screen y coordinate.')], async (p) => executeControlTool('right_click', { x: p.x, y: p.y }));
    add('drag', 'Drag the mouse between two screen coordinates.', 'high', [parameter('x1', 'number', 'Start x.'), parameter('y1', 'number', 'Start y.'), parameter('x2', 'number', 'End x.'), parameter('y2', 'number', 'End y.')], async () => undefined);
    add('scroll', 'Scroll during an authorized control session.', 'medium', [parameter('direction', 'string', 'up, down, left, or right.'), parameter('amount', 'number', 'Scroll amount.')], async (p) => executeControlTool('scroll', { direction: p.direction, amount: p.amount }));
    add('focus_window', 'Focus a window during an authorized control session.', 'medium', [parameter('title', 'string', 'Window title.')], async (p) => executeControlTool('focus_window', { title: p.title }));
    add('save_workspace', 'Save a local workspace snapshot.', 'medium', [parameter('name', 'string', 'Workspace name.')], async (p) => invoke('save_workspace', { name: p.name }));
    add('load_workspace', 'Restore applications and windows from a local snapshot after approval.', 'high', [parameter('name', 'string', 'Workspace name.')], async (p) => executeSensitiveTool('load_workspace', { name: p.name }));
    add('list_workspaces', 'List local workspace snapshots.', 'low', [], async () => invoke('list_workspaces'));
    add('add_annotation', 'Draw a local screen annotation.', 'medium', [parameter('annotation', 'object', 'Annotation object.')], async (p) => invoke('add_annotation', { annotation: p.annotation }));
    add('clear_annotations', 'Clear local screen annotations.', 'medium', [], async () => invoke('clear_annotations'));
    add('delete_file', 'Delete one file after explicit approval.', 'high', [parameter('path', 'string', 'Exact file path; wildcards are not allowed.')], async () => undefined);
    add('delete_folder', 'Delete one folder recursively after explicit approval.', 'critical', [parameter('path', 'string', 'Exact folder path; wildcards are not allowed.')], async () => undefined);
    add('clear_folder', 'Delete the contents of one folder after explicit approval.', 'critical', [parameter('path', 'string', 'Exact folder path; wildcards are not allowed.')], async () => undefined);
  }
}

export const toolRegistry = new ToolRegistry();
toolRegistry.initializeBuiltins();
