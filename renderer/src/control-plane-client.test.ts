import { describe, expect, test } from "bun:test";

import { ControlPlaneClient, ControlPlaneUnavailable } from "./control-plane-client";

const CREDENTIAL = "internal-credential-value";

function client(handler: (request: Request) => Promise<Response> | Response): ControlPlaneClient {
  return new ControlPlaneClient({
    baseUrl: "http://api:8000",
    credential: CREDENTIAL,
    fetchImpl: async (request: Request) => handler(request),
  });
}

const EVENT = {
  render_job_id: "rj_001",
  dispatch_id: "dsp_001",
  sequence: 1,
  status: "preparing",
  occurred_at: "2026-09-20T10:00:00.000Z",
} as const;

describe("ControlPlaneClient", () => {
  test("reads one job's bundle from the private route with the internal credential", async () => {
    const seen: Request[] = [];
    const parsed = await client((request) => {
      seen.push(request);
      return new Response(JSON.stringify({ bundle_version: 1 }), {
        headers: { "Content-Type": "application/json" },
      });
    }).fetchBundle("rj_001");

    expect(parsed).toEqual({ bundle_version: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://api:8000/internal/render-jobs/rj_001/bundle");
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.headers.get("Authorization")).toBe(`Bearer ${CREDENTIAL}`);
    expect(seen[0]!.redirect).toBe("error");
  });

  test("posts one sequenced event as the Task 1 event JSON", async () => {
    const bodies: unknown[] = [];
    await client(async (request) => {
      bodies.push(await request.json());
      return new Response(JSON.stringify({ status: "preparing", last_event_sequence: 1 }), {
        headers: { "Content-Type": "application/json" },
      });
    }).publishEvent(EVENT);

    expect(bodies).toEqual([EVENT]);
  });

  test("refuses an identity that is not a single safe URL segment", async () => {
    const never = client(() => new Response("{}"));
    await expect(never.fetchBundle("../../etc/passwd")).rejects.toBeInstanceOf(
      ControlPlaneUnavailable,
    );
  });

  test("turns any transport or status failure into one fixed error", async () => {
    const failures: ControlPlaneClient[] = [
      client(() => new Response("boom", { status: 500 })),
      client(() => new Response("nope", { status: 404 })),
      client(() => new Response("go", { status: 302, headers: { Location: "http://evil" } })),
      client(() => {
        throw new Error("ECONNREFUSED 10.0.0.5:8000");
      }),
    ];
    for (const failing of failures) {
      await expect(failing.fetchBundle("rj_001")).rejects.toBeInstanceOf(ControlPlaneUnavailable);
    }
  });

  test("never carries the credential or a transport detail in its failure", async () => {
    const failing = client(() => {
      throw new Error(`ECONNREFUSED while sending Bearer ${CREDENTIAL}`);
    });
    try {
      await failing.publishEvent(EVENT);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ControlPlaneUnavailable);
      const text = `${String(error)}${(error as Error).stack ?? ""}`;
      expect(text).not.toContain(CREDENTIAL);
      expect(text).not.toContain("ECONNREFUSED");
    }
  });
});
