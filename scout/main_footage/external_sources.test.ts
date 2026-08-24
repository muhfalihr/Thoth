import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LocalAsset, PostRecord } from '../acquisition/types.ts';
import { decodeExternalSources, fingerprintCanonical } from './contracts.ts';
import { packageExternalFootage } from './external_sources.ts';

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
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('ok external_sources');
