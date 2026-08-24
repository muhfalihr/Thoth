// Test-only Scout planner entry point. Production always invokes scout/cli.ts;
// this composition exists solely for the Rust acceptance test, where only the two
// model-facing providers are substituted. File-based embeddings and media ports are real.
import path from 'node:path';
import { fileEmbeddingLoader, type CandidateDeps } from '../candidates.ts';
import { ffmpegCut, type PlanMainFootageProviders, runPlanMainFootageCli } from '../plan_job.ts';
import { probeSourceVideo } from '../source_package.ts';

function requiredArgument(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value) throw new Error('invalid_arguments');
  return value;
}

export function offlineAcceptanceProviders(args: readonly string[]): PlanMainFootageProviders {
  const jobRoot = requiredArgument(args, '--job-root');
  const packagePath = requiredArgument(args, '--package');
  const packageRoot = path.dirname(path.resolve(jobRoot, packagePath));
  const candidateDeps: CandidateDeps = {
    embedText: async () => null,
    loadEmbedding: fileEmbeddingLoader(packageRoot),
    rankShortlist: async () => [],
  };
  return { candidateDeps, ffmpeg: ffmpegCut, ffprobe: probeSourceVideo };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  await runPlanMainFootageCli(args, offlineAcceptanceProviders(args));
}
