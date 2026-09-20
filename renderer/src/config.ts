/**
 * Everything this service is allowed to know about its environment.
 *
 * The renderer holds one credential and two locations: the private control
 * plane it reports to and the artifact root it renders inside. It is given no
 * database URL, creator key, provider secret, or Docker socket, so a misplaced
 * variable cannot widen what a render can reach.
 */

export class RendererConfigInvalid extends Error {
  constructor(setting: string) {
    super(`renderer setting invalid: ${setting}`);
    this.name = "RendererConfigInvalid";
  }
}

export type RendererConfig = {
  readonly port: number;
  readonly credential: string;
  readonly controlPlaneUrl: string;
  readonly artifactRoot: string;
  readonly rendererVersion: string;
  readonly deadlineSeconds: number;
};

export type Environment = Record<string, string | undefined>;

/** The pinned build this container is, recorded in every render's provenance. */
const DEFAULT_RENDERER_VERSION = "remotion-4.0.523";
/** Matches the control plane's own bound, so neither side outlives the other. */
const MIN_DEADLINE_SECONDS = 60;
const MAX_DEADLINE_SECONDS = 7200;
const MIN_CREDENTIAL_LENGTH = 16;

/**
 * The artifact root is a POSIX absolute path inside this Linux container, not a
 * path of whatever host happens to run the tests, so it is checked literally:
 * every segment must be real, with no traversal, no empty segment, and no
 * separator this service would have to interpret.
 */
function isContainerRoot(value: string): boolean {
  if (!value.startsWith("/") || value.includes("\\") || value.endsWith("/")) {
    return false;
  }
  return value
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RendererConfigInvalid(name);
  }
  return value.trim();
}

function integer(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RendererConfigInvalid(name);
  }
  return value;
}

function controlPlaneOrigin(environment: Environment): string {
  const raw = required(environment, "THOTH_RENDERER_CONTROL_PLANE_URL");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RendererConfigInvalid("THOTH_RENDERER_CONTROL_PLANE_URL");
  }
  // A credential belongs in the header, and a non-HTTP scheme would let a
  // misconfiguration turn a fetch into a local file read.
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new RendererConfigInvalid("THOTH_RENDERER_CONTROL_PLANE_URL");
  }
  return raw.replace(/\/+$/, "");
}

export function loadRendererConfig(environment: Environment): RendererConfig {
  const credential = required(environment, "THOTH_RENDERER_INTERNAL_CREDENTIAL");
  if (credential.length < MIN_CREDENTIAL_LENGTH) {
    throw new RendererConfigInvalid("THOTH_RENDERER_INTERNAL_CREDENTIAL");
  }
  const artifactRoot = required(environment, "THOTH_CONTROL_PLANE_ARTIFACT_ROOT");
  if (!isContainerRoot(artifactRoot)) {
    throw new RendererConfigInvalid("THOTH_CONTROL_PLANE_ARTIFACT_ROOT");
  }
  return Object.freeze({
    port: integer(environment, "THOTH_RENDERER_PORT", 8080, 1, 65535),
    credential,
    controlPlaneUrl: controlPlaneOrigin(environment),
    artifactRoot,
    rendererVersion: environment.THOTH_RENDERER_VERSION?.trim() || DEFAULT_RENDERER_VERSION,
    deadlineSeconds: integer(
      environment,
      "THOTH_RENDER_MAX_SECONDS",
      900,
      MIN_DEADLINE_SECONDS,
      MAX_DEADLINE_SECONDS,
    ),
  });
}
