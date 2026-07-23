import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_OCR_MODEL,
  OCR_ANALYZER_VERSION,
  OCR_SCHEMA_VERSION,
  type OcrAnalysis,
} from '../lib/ocr_contract.ts';
import { analyzeSubtitlesDetailed } from '../lib/subtitle_vision.ts';

export type LocalOcrDeps = {
  analyze: (videoPath: string) => Promise<OcrAnalysis>;
  isFile: (videoPath: string) => boolean;
  now: () => Date;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
};

const defaultDeps: LocalOcrDeps = {
  analyze: (videoPath) => analyzeSubtitlesDetailed(videoPath),
  isFile: (videoPath) => {
    try {
      return fs.statSync(videoPath).isFile();
    } catch {
      return false;
    }
  },
  now: () => new Date(),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

function failedAnalysis(deps: LocalOcrDeps, errorCode: string, errorMessage: string): OcrAnalysis {
  return {
    schema_version: OCR_SCHEMA_VERSION,
    ocr_status: 'failed',
    provider: 'novita',
    model: DEFAULT_OCR_MODEL,
    analyzer_version: OCR_ANALYZER_VERSION,
    requested_frames: 0,
    valid_frames: 0,
    analyzed_at: deps.now().toISOString(),
    error_code: errorCode,
    error_message: errorMessage,
  };
}

function writeResult(deps: LocalOcrDeps, result: OcrAnalysis): number {
  deps.writeStdout(`${JSON.stringify(result)}\n`);
  if (result.ocr_status === 'analyzed') return 0;
  deps.writeStderr(`OCR analysis failed: ${result.error_message || 'Unknown failure'}.\n`);
  return 1;
}

export async function runLocalOcr(
  args: string[],
  overrides: Partial<LocalOcrDeps> = {},
): Promise<number> {
  const deps = { ...defaultDeps, ...overrides };
  const videoPath = args[0];
  if (!videoPath) {
    return writeResult(deps, failedAnalysis(deps, 'missing_video_path', 'Video path is required'));
  }
  if (!path.isAbsolute(videoPath)) {
    return writeResult(
      deps,
      failedAnalysis(deps, 'video_path_not_absolute', 'Video path must be absolute'),
    );
  }
  if (!deps.isFile(videoPath)) {
    return writeResult(
      deps,
      failedAnalysis(deps, 'video_file_not_found', 'Video path must identify an existing file'),
    );
  }
  try {
    return writeResult(deps, await deps.analyze(videoPath));
  } catch {
    return writeResult(
      deps,
      failedAnalysis(deps, 'analysis_exception', 'OCR analysis could not be completed'),
    );
  }
}

if (import.meta.main) {
  process.exitCode = await runLocalOcr(process.argv.slice(2));
}
