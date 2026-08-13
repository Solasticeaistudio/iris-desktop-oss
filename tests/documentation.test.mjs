import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredGuides = [
  'docs/README.md',
  'docs/GETTING_STARTED.md',
  'docs/CAPABILITIES.md',
  'docs/CONFIGURATION.md',
  'docs/TROUBLESHOOTING.md',
];

test('new-user documentation set is present and linked from README', async () => {
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  for (const guide of requiredGuides) {
    assert.equal(existsSync(path.join(root, guide)), true, `${guide} is missing`);
    assert.match(readme, new RegExp(guide.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('relative Markdown links in user documentation resolve locally', async () => {
  for (const relativeFile of ['README.md', ...requiredGuides]) {
    const absoluteFile = path.join(root, relativeFile);
    const markdown = await readFile(absoluteFile, 'utf8');
    const links = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
    for (const link of links) {
      if (/^(?:https?:|mailto:|#)/.test(link)) continue;
      const withoutAnchor = decodeURIComponent(link.split('#')[0]);
      assert.equal(
        existsSync(path.resolve(path.dirname(absoluteFile), withoutAnchor)),
        true,
        `${relativeFile} contains a broken link: ${link}`,
      );
    }
  }
});

test('getting-started commands use reproducible install and correct Tauri launch modes', async () => {
  const guide = await readFile(path.join(root, 'docs/GETTING_STARTED.md'), 'utf8');
  assert.match(guide, /npm ci/);
  assert.match(guide, /npm run tauri:dev/);
  assert.match(guide, /npm run tauri:build/);
  assert.match(guide, /localhost refused to connect/);
  assert.doesNotMatch(guide, /npm install/);
});
