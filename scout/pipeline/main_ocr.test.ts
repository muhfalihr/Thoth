// scout/pipeline/main_ocr.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMainOcr } from './main_ocr.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-main-ocr-'));
try {
  const packageRoot = path.join(root, 'main-footage', 'v001');
  fs.mkdirSync(path.join(packageRoot, 'sources'), { recursive: true });
  const sourceFile = path.join(packageRoot, 'sources', 'source-a.mp4');
  fs.writeFileSync(sourceFile, Buffer.from('video'));
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ sources: [{ id: 'source-a', path: 'sources/source-a.mp4' }] }),
    'utf8',
  );

  const file = path.join(root, 'set.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      main: { url: 'https://www.tiktok.com/@who/video/1', is_video: true },
      main_footage: {
        mode: 'forced_url_pool',
        package_manifest: 'main-footage/v001/package.json',
        coverage_target: 0.75,
      },
      footage: [],
      comments: [],
    }),
    'utf8',
  );

  const analyzed: string[] = [];
  await runMainOcr(
    { file },
    {
      scoutOutputRoot: root,
      analyze: async (record) => {
        // The whole point of pointing OCR at the packaged copy: the analyzer reads a local file,
        // so a run succeeds even when the platform extractor that produced it is down.
        analyzed.push(String(record.source_local));
        Object.assign(record, { ocr_status: 'analyzed', trim_start: 1.5 });
      },
    },
  );

  assert.deepEqual(analyzed, [sourceFile]);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.main.ocr_status, 'analyzed');
  assert.equal(written.main.trim_start, 1.5);
  assert.equal(written.main.source_local, sourceFile);
  console.log('ok main_ocr');

  // A manifest whose source path escapes the package must not be analyzed from wherever it points.
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ sources: [{ id: 'source-a', path: '../../../etc/passwd' }] }),
    'utf8',
  );
  await assert.rejects(
    () => runMainOcr({ file: file }, { scoutOutputRoot: root, analyze: async () => {} }),
    /path_outside_root/,
  );
  console.log('ok main_ocr_contained');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
