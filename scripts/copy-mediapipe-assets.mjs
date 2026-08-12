import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const source = join(packageRoot, 'wasm');
const destination = join(root, 'public', 'mediapipe', 'wasm');
const expectedFiles = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_module_internal.js',
  'vision_wasm_module_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

const appPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const installedPackage = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const configuredVersion = appPackage.dependencies['@mediapipe/tasks-vision'];
if (configuredVersion !== installedPackage.version) {
  throw new Error(`MediaPipe version mismatch: package.json=${configuredVersion}, installed=${installedPackage.version}`);
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const file of expectedFiles) {
  await cp(join(source, file), join(destination, file));
}
await writeFile(join(destination, 'version.json'), `${JSON.stringify({
  package: '@mediapipe/tasks-vision',
  version: installedPackage.version,
  files: expectedFiles,
}, null, 2)}\n`);
console.log(`Prepared MediaPipe ${installedPackage.version} WASM assets in public/mediapipe/wasm`);
