import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OUTPUT_DIR } from '../lib/paths.ts';
import type { LocalAsset, MediaAsset, PostRecord } from '../acquisition/types.ts';
import type { MainFootageDescriptor, SourcePackageV1, SourceTechnicalMetadata } from './contracts.ts';
import { MAIN_FOOTAGE_SCHEMA_VERSION } from './contracts.ts';
import { atomicPublish, nextVersion, resolveContained } from './paths.ts';

export interface SourcePackageInput {
  post: PostRecord;
  contentSetPath: string;
  coverageTarget: number;
}

export interface SourcePackageDeps {
  materialize(asset: MediaAsset): Promise<LocalAsset>;
  probe(file: string): Promise<SourceTechnicalMetadata>;
  scoutOutputRoot?: string;
  now?: () => number;
}

export interface SourcePackageResult {
  descriptor: MainFootageDescriptor;
  package: SourcePackageV1;
  packagePath: string;
  packageJson: string;
  summary: { usable_video_count: number; ignored_photo_count: number; unavailable_video_count: number };
  excludedMediaIds: string[];
}

function forcedError(): Error {
  return Object.assign(new Error('forced_main_no_usable_video'), { code: 'forced_main_no_usable_video' });
}

function stableId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
}

function extension(local: LocalAsset): string {
  const result = path.extname(local.path).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(result) ? result : '.mp4';
}

function checksum(file: string): string {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function packageId(post: PostRecord): string {
  return createHash('sha256')
    .update(`${post.platform}:${post.post_id}:${post.canonical_url}`)
    .digest('hex')
    .slice(0, 16);
}

function reservePackageRoot(packagesRoot: string): string {
  fs.mkdirSync(packagesRoot, { recursive: true });
  let version = Number(nextVersion(packagesRoot).slice(1));
  for (;;) {
    const packageRoot = path.join(packagesRoot, `v${String(version).padStart(3, '0')}`);
    try {
      fs.mkdirSync(packageRoot);
      return packageRoot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      version += 1;
    }
  }
}

function relativeManifest(contentSetPath: string, packagePath: string): string {
  return path.relative(path.dirname(path.resolve(contentSetPath)), packagePath).split(path.sep).join('/');
}

function copyToTemp(original: string, temp: string): void {
  try {
    fs.linkSync(original, temp);
  } catch {
    fs.copyFileSync(original, temp, fs.constants.COPYFILE_EXCL);
  }
}

/**
 * Packages every usable video from one already-inspected forced post. The package is
 * write-once: original materializer output remains untouched and only fully probed
 * files become visible under sources/.
 */
export async function buildSourcePackage(
  input: SourcePackageInput,
  deps: SourcePackageDeps,
): Promise<SourcePackageResult> {
  const { post, contentSetPath, coverageTarget } = input;
  const outputRoot = path.resolve(deps.scoutOutputRoot || OUTPUT_DIR);
  const id = packageId(post);
  fs.mkdirSync(outputRoot, { recursive: true });
  const packagesRoot = resolveContained(outputRoot, 'main-footage');
  const packageRoot = reservePackageRoot(packagesRoot);
  const sourcesRoot = path.join(packageRoot, 'sources');
  const tempRoot = path.join(packageRoot, '.tmp');
  const packagePath = path.join(packageRoot, 'package.json');
  const ignored = post.media
    .filter((asset) => asset.kind === 'image')
    .map((asset) => ({ id: asset.id, media_index: asset.index, code: 'photo_slide_ignored' as const }));
  const unavailable: SourcePackageV1['unavailable'] = [];
  const sources: SourcePackageV1['sources'] = [];

  fs.mkdirSync(tempRoot, { recursive: true });
  const videos = post.media.filter((asset) => asset.kind === 'video');
  for (const asset of videos) {
    const sourceId = `source-${stableId(post.post_id)}-${asset.index}`;
    let temp = '';
    const startedAt = (deps.now ?? Date.now)();
    try {
      const local = await deps.materialize(asset);
      const ext = extension(local);
      const destination = path.join(sourcesRoot, `${sourceId}${ext}`);
      temp = path.join(tempRoot, `${sourceId}${ext}.tmp`);
      copyToTemp(local.path, temp);
      const technical = await deps.probe(temp);
      const bytes = fs.statSync(temp).size;
      const sourceChecksum = checksum(temp);
      atomicPublish(temp, destination);
      temp = '';
      sources.push({
        id: sourceId,
        media_index: asset.index,
        path: path.posix.join('sources', `${sourceId}${ext}`),
        checksum: sourceChecksum,
        bytes,
        technical,
        acquisition: {
          source: local.source,
          attempts: local.attempts ?? 1,
          elapsed_ms: local.elapsed_ms ?? (deps.now ?? Date.now)() - startedAt,
        },
      });
    } catch {
      if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
      unavailable.push({ id: asset.id, media_index: asset.index, code: 'source_video_skipped' });
    }
  }

  if (!sources.length) {
    try { fs.rmSync(packageRoot, { recursive: true, force: true }); } catch {}
    throw forcedError();
  }

  const packageData: SourcePackageV1 = {
    schema_version: MAIN_FOOTAGE_SCHEMA_VERSION,
    post: { id: post.post_id, canonical_url: post.canonical_url, platform: post.platform },
    analysis_identity: `forced-url-pool:${id}`,
    created_at: new Date((deps.now ?? Date.now)()).toISOString(),
    sources,
    ignored,
    unavailable,
    scene_indexes: [],
  };
  const packageJson = JSON.stringify(packageData, null, 2);
  const manifestTemp = path.join(tempRoot, 'package.json.tmp');
  try {
    fs.writeFileSync(manifestTemp, packageJson, 'utf8');
    atomicPublish(manifestTemp, packagePath);
  } catch (error) {
    try { fs.rmSync(packageRoot, { recursive: true, force: true }); } catch {}
    throw error;
  }

  return {
    descriptor: {
      mode: 'forced_url_pool',
      package_manifest: relativeManifest(contentSetPath, packagePath),
      coverage_target: coverageTarget,
    },
    package: packageData,
    packagePath,
    packageJson,
    summary: {
      usable_video_count: sources.length,
      ignored_photo_count: ignored.length,
      unavailable_video_count: unavailable.length,
    },
    excludedMediaIds: post.media.map((asset) => asset.id),
  };
}

export async function probeSourceVideo(file: string): Promise<SourceTechnicalMetadata> {
  const ffprobe = process.env.THOTH_FFPROBE || path.join(import.meta.dirname, '..', '..', 'ffprobe.exe');
  const stdout = execFileSync(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,width,height', '-of', 'json', file],
    { encoding: 'utf8', timeout: 30_000 },
  );
  const result = JSON.parse(stdout) as { format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> };
  const video = result.streams?.find((stream) => stream.codec_type === 'video');
  if (!video?.codec_name || !video.width || !video.height) throw new Error('ffprobe_missing_video_stream');
  const duration = Number(result.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('ffprobe_invalid_duration');
  return {
    container: result.format?.format_name || 'unknown',
    video_codec: video.codec_name,
    duration_sec: duration,
    width: video.width,
    height: video.height,
    has_audio: Boolean(result.streams?.some((stream) => stream.codec_type === 'audio')),
  };
}
