import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgentLoop } from '../src/lib/agentLoop';
import type { IrisModelProvider, ProviderResponse } from '../src/lib/modelProvider';
import { ToolRegistry, type ToolDefinition } from '../src/lib/toolRegistry';
import { unsupportedSchemaKeywords } from '../src/lib/capabilityFoundry/schemas';

const definition: ToolDefinition = {
  id: 'cap_fixture', name: 'foundry_test_shipping_get_shipments', description: 'Fixture read capability',
  category: 'capability-foundry', parameters: [], riskLevel: 'low', requiresApproval: false,
  enabled: true, tags: ['openapi'], packageId: 'pkg_fixture', capabilityId: 'cap_fixture',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['state'],
    properties: { state: { type: 'string', enum: ['open', 'closed'], minLength: 4 } },
  },
};

test('Foundry registry preserves full JSON Schema and rejects collisions', () => {
  const registry = new ToolRegistry();
  registry.register(definition.name, async () => ({ shipments: [] }), definition);
  const providerSchema = (registry.modelTools()[0] as { function: { parameters: unknown } }).function.parameters;
  assert.deepEqual(providerSchema, definition.inputSchema);
  assert.throws(() => registry.register(definition.name, async () => ({}), definition), /collision/i);
  assert.throws(() => registry.register('read_file', async () => ({}), { ...definition, name: 'read_file' }), /namespace/i);
  assert.throws(() => registry.register('foundry_fake_builtin', async () => ({}), { ...definition, name: 'foundry_fake_builtin', category: 'desktop' }), /reserved/i);
  assert.deepEqual(unsupportedSchemaKeywords(definition.inputSchema), []);
  assert.deepEqual(unsupportedSchemaKeywords({ oneOf: [] }), ['oneOf']);
});

test('Foundry registry validates enum, required, type, and unknown fields before execution', async () => {
  let executions = 0; const registry = new ToolRegistry();
  registry.register(definition.name, async () => { executions += 1; return { shipments: [] }; }, definition);
  assert.equal((await registry.execute(definition.name, { state: 'open' })).success, true);
  assert.match((await registry.execute(definition.name, { state: 'other' })).error || '', /enum/);
  assert.match((await registry.execute(definition.name, {})).error || '', /required/);
  assert.match((await registry.execute(definition.name, { state: 'open', escape: 'https://attacker.example' })).error || '', /unknown/);
  assert.equal(executions, 1);
});

test('mock provider capability call traverses agent loop and registry to final response', async () => {
  const registry = new ToolRegistry(); let nativeHostCalls = 0;
  registry.register(definition.name, async (params) => { nativeHostCalls += 1; return { origin: 'shipping.test', state: params.state, sanitized: true }; }, definition);
  const responses: ProviderResponse[] = [
    { text: '', toolCalls: [{ id: 'foundry-call-1', name: definition.name, arguments: { state: 'open' } }] },
    { text: 'Shipment capability completed.', toolCalls: [] },
  ];
  const provider: IrisModelProvider = { id:'fixture',name:'Fixture',supportsVision:false,supportsTools:true,supportsStreaming:false,async chat(){return responses.shift()!;} };
  const result = await runAgentLoop({ provider, messages:[{role:'user',content:'Get shipments'}], tools:registry.modelTools(), executeTool:(call)=>registry.execute(call.name,call.arguments) });
  assert.equal(result.text, 'Shipment capability completed.'); assert.equal(nativeHostCalls, 1); assert.equal(result.toolCallsExecuted, 1);
});
