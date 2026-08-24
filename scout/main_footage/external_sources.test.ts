import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalAsset, PostRecord } from '../acquisition/types.ts';
import { decodeExternalSources, fingerprintCanonical } from './contracts.ts';
import {
  packageExternalFootage,
  type ExternalSourcesResult,
} from './external_sources.ts';

interface ReservationChildConfig {
  scoutRoot: string;
  contentSetPath: string;
  materializedPath: string;
  assetId: string;
  readyRoot: string;
  readyId: string;
  readyCount: number;
  resultPath: string;
  empty: boolean;
  waitForMarker?: string;
  doneMarker?: string;
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function waitUntil(predicate: () => boolean, message: string): void {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    Atomics.wait(waitBuffer, 0, 0, 10);
  }
}

async function runReservationChild(config: ReservationChildConfig): Promise<void> {
  const originalMkdirSync = fs.mkdirSync;
  let reachedReservation = false;
  Object.defineProperty(fs, 'mkdirSync', {
    configurable: true,
    value: (...args: unknown[]) => {
      const target = args[0];
      if (
        !reachedReservation &&
        typeof target === 'string' &&
        /[\\/]external-footage[\\/]v\d{3,}(?:[\\/]sources)?$/.test(path.resolve(target))
      ) {
        reachedReservation = true;
        fs.mkdirSync(config.readyRoot, { recursive: true });
        fs.writeFileSync(path.join(config.readyRoot, config.readyId), 'ready', {
          flag: 'wx',
        });
        waitUntil(
          () => fs.readdirSync(config.readyRoot).length >= config.readyCount,
          'reservation_barrier_timeout',
        );
      }
      return Reflect.apply(originalMkdirSync, fs, args);
    },
  });

  const result = await packageExternalFootage(
    { contentSetPath: config.contentSetPath },
    {
      scoutOutputRoot: config.scoutRoot,
      inspectPost: async (url): Promise<PostRecord> => ({
        canonical_url: url,
        platform: 'instagram',
        post_id: config.assetId,
        owner_handle: 'reporter',
        text: 'external footage',
        media: config.empty
          ? []
          : [
              {
                id: config.assetId,
                kind: 'video',
                index: 0,
                canonical_post_url: url,
                ephemeral_url: url,
              },
            ],
        outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 1 },
      }),
      materialize: async (): Promise<LocalAsset> => {
        if (config.waitForMarker) {
          waitUntil(() => fs.existsSync(config.waitForMarker!), 'cleanup_barrier_timeout');
        }
        return {
          path: config.materializedPath,
          kind: 'video',
          source: 'direct-http',
          bytes: fs.statSync(config.materializedPath).size,
        };
      },
      probe: async () => ({
        container: 'mp4',
        video_codec: 'h264',
        duration_sec: 4,
        width: 1280,
        height: 720,
        has_audio: true,
      }),
      now: () => Date.parse('2026-08-25T00:00:00.000Z'),
    },
  );
  fs.writeFileSync(config.resultPath, JSON.stringify(result), 'utf8');
  if (config.doneMarker) fs.writeFileSync(config.doneMarker, 'done', 'utf8');
}

const childConfig = process.env.THOTH_EXTERNAL_RESERVATION_CHILD;
if (childConfig) {
  await runReservationChild(JSON.parse(childConfig) as ReservationChildConfig);
  process.exit(0);
}

function writeChildFixture(
  scoutRoot: string,
  name: string,
  assetId: string,
): Pick<ReservationChildConfig, 'contentSetPath' | 'materializedPath'> {
  const contentSetPath = path.join(scoutRoot, `${name}-content-set.json`);
  const materializedPath = path.join(scoutRoot, 'acquisition-cache', `${name}.mp4`);
  fs.mkdirSync(path.dirname(materializedPath), { recursive: true });
  fs.writeFileSync(materializedPath, `${name}-video-bytes`, 'utf8');
  fs.writeFileSync(
    contentSetPath,
    JSON.stringify({
      main: { url: 'https://example.test/forced' },
      main_footage: {
        mode: 'forced_url_pool',
        package_manifest: 'main-footage/v001/package.json',
        coverage_target: 0.6,
      },
      footage: [
        {
          url: `https://cdn.example.test/${assetId}.mp4`,
          source_url: `https://example.test/${assetId}`,
          platform: 'instagram',
          is_video: true,
          query: name,
          description: `${name} external footage`,
        },
      ],
      comments: [],
    }),
    'utf8',
  );
  return { contentSetPath, materializedPath };
}

async function runChildren(configs: ReservationChildConfig[]): Promise<void> {
  const modulePath = fileURLToPath(import.meta.url);
  const children = configs.map((config) =>
    spawn(process.execPath, [modulePath], {
      env: {
        ...process.env,
        THOTH_EXTERNAL_RESERVATION_CHILD: JSON.stringify(config),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => (stdout += String(chunk)));
          child.stderr.on('data', (chunk) => (stderr += String(chunk)));
          child.on('error', reject);
          child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`reservation child exited ${code}\n${stdout}\n${stderr}`));
          });
        }),
    ),
  );
}

async function assertCrossProcessReservation(root: string): Promise<void> {
  const scoutRoot = path.join(root, 'reservation-scout-output');
  const readyRoot = path.join(root, 'reservation-ready');
  const configs = ['alpha', 'bravo'].map((name, index): ReservationChildConfig => {
    const fixture = writeChildFixture(scoutRoot, name, `asset-${name}`);
    return {
      scoutRoot,
      ...fixture,
      assetId: `asset-${name}`,
      readyRoot,
      readyId: String(index),
      readyCount: 2,
      resultPath: path.join(root, `${name}-reservation-result.json`),
      empty: false,
    };
  });

  await runChildren(configs);
  const results = configs.map(
    (config) => JSON.parse(fs.readFileSync(config.resultPath, 'utf8')) as ExternalSourcesResult,
  );
  assert.deepEqual(
    results.map((result) => path.basename(path.dirname(result.manifestPath))).sort(),
    ['v001', 'v002'],
  );
  assert.equal(new Set(results.map((result) => result.manifestPath)).size, 2);
  for (const result of results) assert.ok(fs.existsSync(result.manifestPath));
}

async function assertOwnedCleanup(root: string): Promise<void> {
  const scoutRoot = path.join(root, 'cleanup-scout-output');
  const readyRoot = path.join(root, 'cleanup-ready');
  const cleanupDone = path.join(root, 'empty-cleanup-done');
  const emptyFixture = writeChildFixture(scoutRoot, 'empty', 'asset-empty');
  const publisherFixture = writeChildFixture(scoutRoot, 'publisher', 'asset-publisher');
  const configs: ReservationChildConfig[] = [
    {
      scoutRoot,
      ...emptyFixture,
      assetId: 'asset-empty',
      readyRoot,
      readyId: 'empty',
      readyCount: 2,
      resultPath: path.join(root, 'empty-cleanup-result.json'),
      empty: true,
      doneMarker: cleanupDone,
    },
    {
      scoutRoot,
      ...publisherFixture,
      assetId: 'asset-publisher',
      readyRoot,
      readyId: 'publisher',
      readyCount: 2,
      resultPath: path.join(root, 'publisher-cleanup-result.json'),
      empty: false,
      waitForMarker: cleanupDone,
    },
  ];

  await runChildren(configs);
  assert.equal(JSON.parse(fs.readFileSync(configs[0]!.resultPath, 'utf8')), null);
  const published = JSON.parse(
    fs.readFileSync(configs[1]!.resultPath, 'utf8'),
  ) as ExternalSourcesResult;
  assert.ok(published, 'empty-process cleanup must not delete a foreign reservation');
  assert.ok(fs.existsSync(published.manifestPath));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-external-sources-'));
try {
  const scoutRoot = path.join(root, 'scout-output');
  const contentSetPath = path.join(scoutRoot, 'content-set.json');
  const materialized = path.join(scoutRoot, 'acquisition-cache', 'external.mp4');
  fs.mkdirSync(path.dirname(materialized), { recursive: true });
  fs.writeFileSync(materialized, 'external-video-bytes');
  fs.writeFileSync(
    contentSetPath,
    JSON.stringify({
      main: { url: 'https://example.test/forced' },
      main_footage: {
        mode: 'forced_url_pool',
        package_manifest: 'main-footage/v001/package.json',
        coverage_target: 0.6,
      },
      footage: [
        {
          url: 'https://cdn.example.test/external.mp4',
          source_url: 'https://example.test/external-post',
          platform: 'instagram',
          is_video: true,
          query: 'harbour rescue',
          description: 'Rescue crews arrive beside the harbour crane.',
          trim_start: 0.25,
        },
        {
          url: 'https://example.test/forced',
          platform: 'instagram',
          is_video: true,
          query: 'must stay excluded',
        },
        { url: 'https://example.test/photo', platform: 'instagram', is_video: false },
      ],
      comments: [],
    }),
  );

  const posts = new Map<string, PostRecord>([
    [
      'https://example.test/external-post',
      {
        canonical_url: 'https://example.test/external-post',
        platform: 'instagram',
        post_id: 'external-post',
        owner_handle: 'reporter',
        text: 'Rescue crews arrive beside the harbour crane.',
        media: [
          {
            id: 'external-post:0',
            kind: 'video',
            index: 0,
            canonical_post_url: 'https://example.test/external-post',
            ephemeral_url: 'https://cdn.example.test/external.mp4',
          },
        ],
        outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 1 },
      },
    ],
    [
      'https://example.test/forced',
      {
        canonical_url: 'https://example.test/forced',
        platform: 'instagram',
        post_id: 'forced',
        owner_handle: 'owner',
        text: 'forced post',
        media: [
          {
            id: 'forced:0',
            kind: 'video',
            index: 0,
            canonical_post_url: 'https://example.test/forced',
          },
        ],
        outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 1 },
      },
    ],
  ]);
  const materializedIds: string[] = [];
  const result = await packageExternalFootage(
    { contentSetPath, excludedMediaIds: ['forced:0'] },
    {
      scoutOutputRoot: scoutRoot,
      inspectPost: async (url) => posts.get(url)!,
      materialize: async (asset): Promise<LocalAsset> => {
        materializedIds.push(asset.id);
        return {
          path: materialized,
          kind: 'video',
          source: 'direct-http',
          bytes: fs.statSync(materialized).size,
        };
      },
      probe: async () => ({
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        video_codec: 'h264',
        duration_sec: 4,
        width: 1280,
        height: 720,
        has_audio: true,
      }),
      now: () => Date.parse('2026-08-25T00:00:00.000Z'),
    },
  );

  assert.ok(result, 'one eligible local enrichment video must publish a manifest');
  assert.deepEqual(materializedIds, ['external-post:0']);
  const manifest = decodeExternalSources(
    JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')),
  );
  assert.equal(manifest.sources.length, 1);
  assert.equal(manifest.sources[0]?.query, 'harbour rescue');
  assert.equal(manifest.sources[0]?.trim_start_sec, 0.25);
  assert.ok(manifest.sources[0]?.path.startsWith('sources/'));
  assert.ok(!JSON.stringify(manifest).includes('https://'));
  assert.equal(manifest.fingerprint, fingerprintCanonical(manifest));
  assert.equal(
    JSON.parse(fs.readFileSync(contentSetPath, 'utf8')).main_footage.external_sources_manifest,
    result.descriptorPath,
  );

  const retained = path.join(path.dirname(result.manifestPath), manifest.sources[0]!.path);
  fs.unlinkSync(materialized);
  assert.equal(fs.readFileSync(retained, 'utf8'), 'external-video-bytes');

  await assertCrossProcessReservation(root);
  await assertOwnedCleanup(root);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('ok external_sources');
