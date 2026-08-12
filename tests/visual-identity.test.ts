import assert from 'node:assert/strict';
import test from 'node:test';
import { IRIS_AUDIO_COLORS, IRIS_STATE_COLORS, IRIS_STATE_FORMATIONS, resolveIrisIdentityColor } from '../src/lib/irisVisualIdentity.ts';

test('the canonical sphere maps every runtime state to a procedural formation and color', () => {
  assert.deepEqual(Object.keys(IRIS_STATE_FORMATIONS).sort(), ['delivering', 'error', 'idle', 'listening', 'success', 'thinking']);
  assert.equal(IRIS_STATE_FORMATIONS.idle, 'sphere');
  assert.equal(IRIS_STATE_FORMATIONS.listening, 'ring');
  assert.equal(IRIS_STATE_FORMATIONS.thinking, 'sphere');
  assert.equal(IRIS_STATE_FORMATIONS.delivering, 'scatter');
  assert.notEqual(IRIS_STATE_COLORS.success, IRIS_STATE_COLORS.error);
});

test('user and IRIS audio drive distinct reactive colors with deterministic priority', () => {
  assert.equal(resolveIrisIdentityColor('idle', 0.5, 0, false), IRIS_AUDIO_COLORS.user);
  assert.equal(resolveIrisIdentityColor('delivering', 0.5, 0.5, false), IRIS_AUDIO_COLORS.iris);
  assert.equal(resolveIrisIdentityColor('thinking', 0.5, 0.5, true), IRIS_AUDIO_COLORS.power);
  assert.equal(resolveIrisIdentityColor('error', 0, 0, false), IRIS_STATE_COLORS.error);
});
