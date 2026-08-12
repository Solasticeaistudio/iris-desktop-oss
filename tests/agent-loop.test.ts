import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgentLoop } from '../src/lib/agentLoop';
import { MockModelProvider, type IrisModelProvider, type ProviderMessage, type ProviderResponse } from '../src/lib/modelProvider';

function provider(responses: Array<ProviderResponse | Error>, seen: ProviderMessage[][] = []): IrisModelProvider {
  return {
    id: 'scripted', name: 'Scripted test provider', supportsVision: false, supportsTools: true, supportsStreaming: false,
    async chat(messages) {
      seen.push(structuredClone(messages));
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('Unexpected provider round');
      return next;
    },
  };
}

const initial: ProviderMessage[] = [{ role: 'user', content: 'test' }];
const call = (id: string, name = 'inspect') => ({ id, name, arguments: { path: 'fixture' } });

test('agent loop: single tool result returns to model before final answer', async () => {
  const seen: ProviderMessage[][] = [];
  const result = await runAgentLoop({ provider: provider([{ text: '', toolCalls: [call('one')] }, { text: 'done', toolCalls: [] }], seen), messages: initial, tools: [], executeTool: async () => ({ success: true, result: 'value' }) });
  assert.equal(result.text, 'done');
  assert.equal(seen[1].at(-1)?.role, 'tool');
  assert.equal(seen[1].at(-1)?.toolCallId, 'one');
});

test('agent loop: multiple sequential tool rounds preserve call IDs', async () => {
  const seen: ProviderMessage[][] = [];
  const executed: string[] = [];
  const result = await runAgentLoop({ provider: provider([{ text: '', toolCalls: [call('one')] }, { text: '', toolCalls: [call('two', 'read')] }, { text: 'final', toolCalls: [] }], seen), messages: initial, tools: [], executeTool: async (tool) => { executed.push(tool.name); return { success: true, result: tool.name }; } });
  assert.deepEqual(executed, ['inspect', 'read']);
  assert.equal(result.toolRounds, 2);
  assert.equal(seen[2].at(-1)?.toolCallId, 'two');
});

test('agent loop: denied tool is a structured failure the model can handle', async () => {
  const seen: ProviderMessage[][] = [];
  const result = await runAgentLoop({ provider: provider([{ text: '', toolCalls: [call('deny', 'delete_file')] }, { text: 'denied safely', toolCalls: [] }], seen), messages: initial, tools: [], executeTool: async () => ({ success: false, error: 'approval denied' }) });
  assert.equal(result.text, 'denied safely');
  assert.match(String(seen[1].at(-1)?.content), /approval denied/);
});

test('agent loop: executor exception becomes a failed tool result', async () => {
  const seen: ProviderMessage[][] = [];
  const result = await runAgentLoop({ provider: provider([{ text: '', toolCalls: [call('fail')] }, { text: 'recovered', toolCalls: [] }], seen), messages: initial, tools: [], executeTool: async () => { throw new Error('executor failed'); } });
  assert.equal(result.text, 'recovered');
  assert.match(String(seen[1].at(-1)?.content), /executor failed/);
});

test('agent loop: malformed tool request never reaches executor', async () => {
  let executed = false;
  const malformed = { id: '', name: '', arguments: null } as never;
  const result = await runAgentLoop({ provider: provider([{ text: '', toolCalls: [malformed] }, { text: 'handled', toolCalls: [] }]), messages: initial, tools: [], executeTool: async () => { executed = true; return { success: true }; } });
  assert.equal(executed, false);
  assert.equal(result.text, 'handled');
});

test('agent loop: max tool depth terminates deterministically', async () => {
  const endless = Array.from({ length: 4 }, (_, index) => ({ text: '', toolCalls: [call(String(index))] }));
  const result = await runAgentLoop({ provider: provider(endless), messages: initial, tools: [], executeTool: async () => ({ success: true }), maxToolRounds: 2 });
  assert.equal(result.stoppedReason, 'max_rounds');
  assert.match(result.text, /maximum tool-execution depth/);
});

test('agent loop: provider errors propagate as terminal provider failures', async () => {
  await assert.rejects(() => runAgentLoop({ provider: provider([new Error('provider offline')]), messages: initial, tools: [], executeTool: async () => ({ success: true }) }), /provider offline/);
});

test('agent loop: consecutive tool failures terminate without another provider call', async () => {
  const result = await runAgentLoop({ provider: provider([{ text: '', toolCalls: [call('a'), call('b'), call('c')] }]), messages: initial, tools: [], executeTool: async () => ({ success: false, error: 'nope' }) });
  assert.equal(result.stoppedReason, 'tool_failures');
  assert.equal(result.toolCallsExecuted, 3);
});

test('mock provider integration: two policy-evaluated tools feed results into a final answer', async () => {
  const executed: string[] = [];
  const result = await runAgentLoop({
    provider: new MockModelProvider(), messages: [{ role: 'user', content: 'mock sequence' }], tools: [],
    executeTool: async (tool) => { executed.push(tool.name); return { success: true, result: `${tool.name}-result` }; },
  });
  assert.deepEqual(executed, ['list_workspaces', 'get_time']);
  assert.equal(result.toolRounds, 2);
  assert.match(result.text, /2 tool results/);
});

test('agent loop: cancellation terminates before a provider call', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runAgentLoop({ provider: provider([]), messages: initial, tools: [], executeTool: async () => ({ success: true }), signal: controller.signal });
  assert.equal(result.stoppedReason, 'cancelled');
});

test('agent loop: legacy text action syntax remains inert presentation text', async () => {
  let executed = false;
  const legacyText = ['[', 'ACTIONS', ']\ndelete_file(path="fixture")\n[/', 'ACTIONS', ']'].join('');
  const result = await runAgentLoop({
    provider: provider([{ text: legacyText, toolCalls: [] }]),
    messages: initial,
    tools: [],
    executeTool: async () => { executed = true; return { success: true }; },
  });
  assert.equal(result.text, legacyText);
  assert.equal(executed, false);
  assert.equal(result.toolCallsExecuted, 0);
});
