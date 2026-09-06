import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('acquisition runner executes assert tests that mention bun:test dynamically', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-runner-regression-'));
  roots.push(root);
  const ordered = [
    'url',
    'cache',
    'browser_coordinator',
    'network_capture',
    'policy',
    'materialize',
    'service',
    'adapters/instagram',
    'adapters/twitter',
    'adapters/tiktok',
    'adapters/youtube',
    'adapters/facebook',
    'adapters/threads',
    'adapters/reddit',
    'boundary',
  ];
  for (const name of ordered) {
    const target = path.join(root, 'acquisition', `${name}.test.ts`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'export {};\n');
  }
  fs.copyFileSync(
    new URL('../acquisition/run_all_tests.ts', import.meta.url),
    path.join(root, 'acquisition/run_all_tests.ts'),
  );
  fs.writeFileSync(
    path.join(root, 'acquisition/adapters/instagram_cache_scope.test.ts'),
    "const moduleName = 'bun:test';\nthrow new Error('cache_scope_sentinel');\n",
  );
  const child = Bun.spawn([process.execPath, 'acquisition/run_all_tests.ts'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = await new Response(child.stderr).text();
  await new Response(child.stdout).text();
  expect(await child.exited).not.toBe(0);
  expect(stderr).toContain('cache_scope_sentinel');
});
