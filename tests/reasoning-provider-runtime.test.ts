import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeNativeModelResponse } from '../src/lib/modelProvider';

test('OpenAI-compatible choices response yields text and structured tool calls', () => {
  const response = normalizeNativeModelResponse({
    provider: 'gemini',
    choices: [{
      message: {
        content: 'I can reason now.',
        tool_calls: [{
          id: 'call_1',
          function: {
            name: 'get_time',
            arguments: '{"timezone":"America/Chicago"}',
          },
        }],
      },
    }],
  });

  assert.equal(response.text, 'I can reason now.');
  assert.deepEqual(response.toolCalls, [{
    id: 'call_1',
    name: 'get_time',
    arguments: { timezone: 'America/Chicago' },
  }]);
});

test('malformed provider tool arguments remain fail-closed for schema validation', () => {
  const response = normalizeNativeModelResponse({
    provider: 'openai',
    choices: [{
      message: {
        tool_calls: [{
          id: 'call_2',
          function: { name: 'get_time', arguments: '{not-json}' },
        }],
      },
    }],
  });

  assert.deepEqual(response.toolCalls[0]?.arguments, {});
});
