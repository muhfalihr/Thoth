import { describe, expect, test } from "bun:test";

import { RendererConfigInvalid, loadArtifactRoot, loadRendererConfig } from "./config";

const COMPLETE = {
  THOTH_RENDERER_INTERNAL_CREDENTIAL: "internal-credential-value",
  THOTH_RENDERER_CONTROL_PLANE_URL: "http://api:8000",
  THOTH_CONTROL_PLANE_ARTIFACT_ROOT: "/srv/artifacts",
};

describe("loadRendererConfig", () => {
  test("reads the four settings the renderer is allowed to know", () => {
    const config = loadRendererConfig(COMPLETE);
    expect(config.controlPlaneUrl).toBe("http://api:8000");
    expect(config.artifactRoot).toBe("/srv/artifacts");
    expect(config.rendererVersion).toBe("remotion-4.0.523");
    expect(config.port).toBe(8080);
    expect(config.deadlineSeconds).toBe(900);
  });

  test("refuses to start without the internal credential", () => {
    const { THOTH_RENDERER_INTERNAL_CREDENTIAL: _omitted, ...rest } = COMPLETE;
    expect(() => loadRendererConfig(rest)).toThrow(RendererConfigInvalid);
  });

  test("refuses a credential too short to be a secret", () => {
    expect(() =>
      loadRendererConfig({ ...COMPLETE, THOTH_RENDERER_INTERNAL_CREDENTIAL: "short" }),
    ).toThrow(RendererConfigInvalid);
  });

  test("refuses a control-plane URL that is not a plain http origin", () => {
    for (const url of ["file:///etc/passwd", "http://user:pass@api:8000", "not-a-url", ""]) {
      expect(() =>
        loadRendererConfig({ ...COMPLETE, THOTH_RENDERER_CONTROL_PLANE_URL: url }),
      ).toThrow(RendererConfigInvalid);
    }
  });

  test("refuses an artifact root that is not an absolute directory path", () => {
    expect(() =>
      loadRendererConfig({ ...COMPLETE, THOTH_CONTROL_PLANE_ARTIFACT_ROOT: "relative/root" }),
    ).toThrow(RendererConfigInvalid);
  });

  test("keeps the deadline inside the bounds the control plane also enforces", () => {
    expect(
      loadRendererConfig({ ...COMPLETE, THOTH_RENDER_MAX_SECONDS: "1200" }).deadlineSeconds,
    ).toBe(1200);
    for (const seconds of ["10", "99999", "abc"]) {
      expect(() => loadRendererConfig({ ...COMPLETE, THOTH_RENDER_MAX_SECONDS: seconds })).toThrow(
        RendererConfigInvalid,
      );
    }
  });

  test("offers no way to point the renderer at another composition", () => {
    const config = loadRendererConfig({
      ...COMPLETE,
      THOTH_RENDERER_COMPOSITION_ENTRY: "/tmp/attacker/register.tsx",
    });
    expect(JSON.stringify(config)).not.toContain("attacker");
    expect(Object.keys(config)).not.toContain("compositionEntryPoint");
  });

  test("never reads a database, creator, provider, or registry credential", () => {
    const config = loadRendererConfig({
      ...COMPLETE,
      THOTH_EDITOR_DATABASE_URL: "postgresql://user:secret@db:5432/thoth",
      THOTH_CONTROL_PLANE_API_KEY: "creator-key",
      THOTH_PROMPT_PROVIDER_SECRETS: '{"novita":"provider-secret"}',
      DOCKER_HOST: "unix:///var/run/docker.sock",
    });
    const serialized = JSON.stringify(config);
    for (const secret of ["postgresql", "creator-key", "provider-secret", "docker.sock"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("loadArtifactRoot", () => {
  test("reads the one output root without demanding any capability", () => {
    // The template-release verifier renders offline and reports to nobody, so
    // it must not need the credential or control-plane URL a render job needs.
    expect(loadArtifactRoot({ THOTH_CONTROL_PLANE_ARTIFACT_ROOT: "/srv/artifacts" })).toBe(
      "/srv/artifacts",
    );
  });

  test("applies the same root rules the render service applies", () => {
    for (const value of [
      undefined,
      "",
      "relative/path",
      "/srv/artifacts/",
      "/srv/../escape",
      "/srv/./artifacts",
      "/srv//artifacts",
      "C:\srv\artifacts",
    ]) {
      expect(() => loadArtifactRoot({ THOTH_CONTROL_PLANE_ARTIFACT_ROOT: value })).toThrow(
        RendererConfigInvalid,
      );
    }
  });
});
