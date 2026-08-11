export interface AcquisitionConfig {
  captureDeadlineMs: number;
  transportAttempts: number;
  discoveryTtlMs: number;
  postTtlMs: number;
  negativeTtlMs: number;
  galleryDl: string;
  ytdlp: string;
}

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function readAcquisitionConfig(
  env: Record<string, string | undefined> = process.env,
): AcquisitionConfig {
  return {
    captureDeadlineMs: positiveInt(env.THOTH_ACQUISITION_CAPTURE_MS, 15_000),
    transportAttempts: 2,
    discoveryTtlMs: positiveInt(env.THOTH_ACQUISITION_DISCOVERY_TTL_MS, 1_800_000),
    postTtlMs: positiveInt(env.THOTH_ACQUISITION_POST_TTL_MS, 21_600_000),
    negativeTtlMs: positiveInt(env.THOTH_ACQUISITION_NEGATIVE_TTL_MS, 900_000),
    galleryDl: env.GALLERY_DL?.trim() || 'gallery-dl',
    ytdlp: env.YTDLP?.trim() || 'yt-dlp',
  };
}
