import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { MockModelProvider } from '../src/lib/modelProvider';
import {
  isDeterministicMockToolCommand,
  isNonSpeechTranscript,
  parseScreenCaptureRequest,
  parseSpeakRequest,
} from '../src/lib/interactionRouting';

test('deterministic mock tool calls bypass local intent parsing even with ISO dates', () => {
  assert.equal(isDeterministicMockToolCommand('mock tool: foundry_localhost_getshipments {}'), true);
  assert.equal(isDeterministicMockToolCommand('mock tool: foundry_localhost_rescheduledelivery {"id":"shipment-1","date":"2030-01-01"}'), true);
  assert.equal(isDeterministicMockToolCommand('calculate 2030-01-01'), false);
});

test('screen capture intent selects the primary or requested one-based monitor', () => {
  assert.deepEqual(parseScreenCaptureRequest('take a screenshot.'), { displayIndex: 0 });
  assert.deepEqual(parseScreenCaptureRequest('capture screenshot of monitor 2'), { displayIndex: 1 });
  assert.deepEqual(parseScreenCaptureRequest('capture display 3'), { displayIndex: 2 });
  assert.equal(parseScreenCaptureRequest('what is on my screen?'), null);
});

test('explicit repeat requests become deterministic local speech without capturing generic prompts', () => {
  assert.equal(parseSpeakRequest('say tic-tac-toe'), 'tic-tac-toe');
  assert.equal(parseSpeakRequest('Um, say tic-tac-toe'), 'tic-tac-toe');
  assert.equal(parseSpeakRequest('Could you repeat after me: hello, world?'), 'hello, world?');
  assert.equal(parseSpeakRequest('can you say something?'), null);
  assert.equal(parseSpeakRequest('what did she say?'), null);
});

test('cloud STT audio-event labels are not treated as user requests', () => {
  assert.equal(isNonSpeechTranscript('[outro jingle]'), true);
  assert.equal(isNonSpeechTranscript('[music] [applause]'), true);
  assert.equal(isNonSpeechTranscript('I heard an outro jingle'), false);
  assert.equal(isNonSpeechTranscript('what time is it?'), false);
});

test('mock provider confirms that a screenshot attachment reached the provider boundary', async () => {
  const provider = new MockModelProvider();
  const response = await provider.chat([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this screenshot' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,dGVzdA==' } },
      ],
    },
  ]);
  assert.match(response.text, /received a screenshot attachment/i);
});

test('active floating chat exposes capture and Foundry count is committed after refresh', async () => {
  const root = new URL('../', import.meta.url);
  const [floating, iris, panel] = await Promise.all([
    readFile(new URL('src/components/FloatingMessageStack.tsx', root), 'utf8'),
    readFile(new URL('src/components/IrisWindow.tsx', root), 'utf8'),
    readFile(new URL('src/components/ToolBuilderPanel.tsx', root), 'utf8'),
  ]);
  assert.match(floating, /onCaptureScreen/);
  assert.match(iris, /capture_screen_by_index/);
  assert.match(panel, /setDynamicToolCount/);
});
