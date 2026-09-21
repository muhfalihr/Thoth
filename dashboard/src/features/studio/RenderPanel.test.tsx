/// <reference types="bun-types" />

import { afterEach, describe, expect, jest, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { RenderCapability, RenderJob, RenderJobPage } from "@/api/control-plane";
import { RenderPanel, type RenderPanelClient, type RenderValidation } from "./RenderPanel";
import type { RenderEditorFacts } from "./render_job_state";

/** What the editor reports about itself; validity is its own summary. */
type EditorFacts = Omit<RenderEditorFacts, "documentValid">;

const AVAILABLE: RenderCapability = {
  available: true,
  preset_id: "standard_vertical_mp4_v1",
  renderer_version: "remotion-4.0.523",
};

const SAVED: EditorFacts = { saveStatus: "saved", online: true };
const VALID: RenderValidation = { textValid: true, blockingIssues: 0 };

function job(overrides: Partial<RenderJob> = {}): RenderJob {
  return {
    render_job_id: "rj_001",
    project_id: "project_001",
    document_id: "document_001",
    document_revision: 7,
    status: "preparing",
    template_id: "vertical_text_story",
    template_version: 1,
    preset_id: "standard_vertical_mp4_v1",
    renderer_version: "remotion-4.0.523",
    created_at: "2026-09-21T10:00:00Z",
    ...overrides,
  } as RenderJob;
}

const COMPLETED = job({
  render_job_id: "rj_done",
  status: "completed",
  created_at: "2026-09-21T09:00:00Z",
  finished_at: "2026-09-21T09:05:00Z",
  progress_percent: 100,
  output: {
    media_type: "video/mp4",
    size_bytes: 2048,
    checksum: `sha256:${"b".repeat(64)}`,
    width: 1080,
    height: 1920,
    fps: 30,
    duration_seconds: 10,
    has_audio: false,
  },
} as Partial<RenderJob>);

function page(jobs: RenderJob[]): RenderJobPage {
  return { jobs, next_cursor: null };
}

function calls(fn: unknown): unknown[][] {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls;
}

/**
 * A minimal stand-in for the control plane: what a mutation returns is what a
 * later list call reports, so the panel's refresh reads authoritative facts
 * instead of a fixture frozen before the mutation happened.
 */
function makeClient(
  seed: RenderJob[] = [],
  overrides: Partial<RenderPanelClient> = {},
): RenderPanelClient {
  const store = new Map(seed.map((entry) => [entry.render_job_id, entry]));
  const remember = (entry: RenderJob) => {
    store.set(entry.render_job_id, entry);
    return entry;
  };
  return {
    getRenderCapability: mock(async () => AVAILABLE),
    createRenderJob: mock(async () => remember(job())),
    listRenderJobs: mock(async () => page([...store.values()])),
    getRenderJob: mock(async (_projectId: string, id: string) => store.get(id) ?? job()),
    cancelRenderJob: mock(async (_projectId: string, id: string) =>
      remember({
        ...(store.get(id) ?? job()),
        status: "cancelled",
        finished_at: "2026-09-21T10:02:00Z",
      } as RenderJob),
    ),
    retryRenderJob: mock(async () =>
      remember(job({ render_job_id: "rj_retry", created_at: "2026-09-21T11:00:00Z" })),
    ),
    downloadRenderOutput: mock(async () => new Blob(["video"], { type: "video/mp4" })),
    cleanupRenderArtifacts: mock(async (_projectId: string, id: string) =>
      remember({
        ...(store.get(id) ?? COMPLETED),
        artifacts_cleaned_at: "2026-09-21T12:00:00Z",
      } as RenderJob),
    ),
    ...overrides,
  };
}

function panel(
  client: RenderPanelClient,
  facts: EditorFacts = SAVED,
  revision = 7,
  validation: RenderValidation = VALID,
) {
  return render(
    <RenderPanel
      client={client}
      projectId="project_001"
      documentId="document_001"
      documentRevision={revision}
      templateId="vertical_text_story"
      templateVersion={1}
      facts={facts}
      validation={validation}
    />,
  );
}

/** Flush the pending requests without relying on a timer, fake or real. */
async function settle() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

/** Load, open the confirmation, and confirm it, settling the create request. */
async function startRender() {
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Render video" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Start render" }));
  });
  await settle();
}

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe("loading the render surface", () => {
  test("loads capability and the newest-first first history page before offering a render", async () => {
    const client = makeClient([
      COMPLETED,
      job({ render_job_id: "rj_new", created_at: "2026-09-21T12:00:00Z" }),
    ]);
    panel(client);

    expect(await screen.findByRole("button", { name: "Render video" })).toBeDefined();
    expect(client.getRenderCapability).toHaveBeenCalledTimes(1);
    expect(client.listRenderJobs).toHaveBeenCalledTimes(1);

    const entries = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(entries[0]).toContain("2026-09-21T12:00:00Z");
    expect(entries[1]).toContain("2026-09-21T09:00:00Z");
  });

  test("an unavailable renderer is explained without naming the installation", async () => {
    const client = makeClient([], {
      getRenderCapability: mock(async () => ({
        ...AVAILABLE,
        available: false,
        reason: "renderer_not_configured" as const,
      })),
    });
    const { container } = panel(client);

    expect(await screen.findByText("Rendering is not set up on this installation.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Render video" })).toHaveProperty("disabled", true);
    expect(container.textContent).not.toContain("renderer_not_configured");
  });

  test("no private route, path, credential, or raw diagnostic reaches the DOM", async () => {
    const client = makeClient(
      [
        job({
          status: "failed",
          finished_at: "2026-09-21T10:04:00Z",
          failure_code: "render_storage_failed",
        } as Partial<RenderJob>),
      ],
      {
        getRenderCapability: mock(async () => {
          throw new Error(
            "connect ECONNREFUSED https://renderer.internal:9000 via C:/srv/proxy.pem",
          );
        }),
      },
    );
    const { container } = panel(client);

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByRole("alert").textContent).toBe("Something went wrong. Try again.");
    for (const forbidden of [
      "internal/render-jobs",
      "dispatch_id",
      "artifact_root",
      "output_relative_path",
      "renderer.internal",
      "C:/srv/",
      "ECONNREFUSED",
      "render_storage_failed",
    ]) {
      expect(container.textContent).not.toContain(forbidden);
    }
  });
});

describe("the render gate", () => {
  const blocked: Array<[string, EditorFacts, string, RenderValidation]> = [
    ["a dirty draft", { ...SAVED, saveStatus: "dirty" }, "Save your changes before rendering.", VALID],
    [
      "a save in progress",
      { ...SAVED, saveStatus: "saving" },
      "Rendering starts once your changes finish saving.",
      VALID,
    ],
    [
      "a revision conflict",
      { ...SAVED, saveStatus: "conflict" },
      "A newer version exists. Resolve it before rendering.",
      VALID,
    ],
    [
      "invalid text",
      SAVED,
      "Fix the issues in your document before rendering.",
      { textValid: false, blockingIssues: 0 },
    ],
    [
      "being offline",
      { ...SAVED, online: false },
      "You are offline. Rendering resumes when the connection returns.",
      VALID,
    ],
  ];

  for (const [name, facts, copy, validation] of blocked) {
    test(`${name} disables Render and says why`, async () => {
      panel(makeClient(), facts, 7, validation);
      await settle();

      const button = screen.getByRole("button", { name: "Render video" });
      expect(button).toHaveProperty("disabled", true);
      const reason = button.getAttribute("aria-describedby");
      expect(reason).not.toBeNull();
      expect(window.document.getElementById(reason as string)?.textContent).toBe(copy);
    });
  }

  test("a busy renderer blocks the render and says another one is running", async () => {
    const client = makeClient([], {
      getRenderCapability: mock(async () => ({
        ...AVAILABLE,
        available: false,
        reason: "render_busy" as const,
        active_render_job_id: "rj_other",
      })),
    });
    panel(client);
    await settle();

    const button = screen.getByRole("button", { name: "Render video" });
    expect(button).toHaveProperty("disabled", true);
    expect(
      screen.getByText(
        "Another render is already running. You can start a new one when it finishes.",
      ),
    ).toBeDefined();
  });

  test("a mutation already in progress blocks a second render", async () => {
    const client = makeClient([], {
      createRenderJob: mock(() => new Promise<RenderJob>(() => {})),
    });
    panel(client);
    await startRender();

    const button = screen.getByRole("button", { name: "Render video" });
    expect(button).toHaveProperty("disabled", true);
    const reason = button.getAttribute("aria-describedby");
    expect(window.document.getElementById(reason as string)?.textContent).toBe(
      "A render request is already in progress.",
    );
  });

  test("the click guard reads the same gate the label shows", async () => {
    const client = makeClient();
    const { rerender } = panel(client);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Render video" }));
    expect(screen.getByRole("group", { name: "Render this version?" })).toBeDefined();

    // The draft goes dirty while the confirmation is open: confirming must not render it.
    rerender(
      <RenderPanel
        client={client}
        projectId="project_001"
        documentId="document_001"
        documentRevision={7}
        templateId="vertical_text_story"
        templateVersion={1}
        facts={{ ...SAVED, saveStatus: "dirty" }}
        validation={VALID}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start render" }));
    });

    expect(client.createRenderJob).toHaveBeenCalledTimes(0);
  });
});

describe("confirming a render", () => {
  test("Create requires a confirmation showing immutable facts and no draft text", async () => {
    const client = makeClient();
    const { container } = panel(client);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Render video" }));

    const confirmation = screen.getByRole("group", { name: "Render this version?" });
    expect(confirmation.getAttribute("aria-modal")).toBeNull();
    expect(confirmation.textContent).toContain("project_001");
    expect(confirmation.textContent).toContain("document_001");
    expect(confirmation.textContent).toContain("7");
    expect(confirmation.textContent).toContain("vertical_text_story");
    expect(confirmation.textContent).toContain("standard_vertical_mp4_v1");
    expect(client.createRenderJob).toHaveBeenCalledTimes(0);
    expect(container.textContent).not.toContain("Original heading");
  });

  test("the request carries exactly the confirmed facts", async () => {
    const client = makeClient();
    panel(client);
    await startRender();

    expect(client.createRenderJob).toHaveBeenCalledWith("project_001", expect.any(String), {
      document_id: "document_001",
      document_revision: 7,
    });
  });

  test("a double click cannot start two render attempts", async () => {
    const client = makeClient([], {
      createRenderJob: mock(() => new Promise<RenderJob>(() => {})),
    });
    panel(client);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Render video" }));

    const confirm = screen.getByRole("button", { name: "Start render" });
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });

    expect(client.createRenderJob).toHaveBeenCalledTimes(1);
  });

  test("a saved revision change closes the confirmation instead of rendering a stale one", async () => {
    const client = makeClient();
    const { rerender } = panel(client);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Render video" }));

    rerender(
      <RenderPanel
        client={client}
        projectId="project_001"
        documentId="document_001"
        documentRevision={8}
        templateId="vertical_text_story"
        templateVersion={1}
        facts={SAVED}
        validation={VALID}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Render this version?" })).toBeNull(),
    );
    expect(client.createRenderJob).toHaveBeenCalledTimes(0);
  });
});

describe("idempotency keys", () => {
  test("every create attempt carries one fresh key the UI generated", async () => {
    const client = makeClient();
    panel(client);
    await startRender();
    await startRender();

    const keys = calls(client.createRenderJob).map((call) => call[1] as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe("");
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("an ambiguous attempt replays under its original key after reconnecting", async () => {
    const rejects: Array<(reason: Error) => void> = [];
    const client = makeClient([], {
      createRenderJob: mock(
        () =>
          new Promise<RenderJob>((_resolve, reject) => {
            rejects.push(reject);
          }),
      ),
    });
    panel(client);
    await startRender();
    const firstKey = calls(client.createRenderJob)[0][1] as string;

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
      rejects[0](new Error("network"));
    });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();

    expect(calls(client.createRenderJob)).toHaveLength(2);
    expect(calls(client.createRenderJob)[1][1]).toBe(firstKey);
  });

  test("an explicit retry receives a new key and a new job identity", async () => {
    const failed = job({
      render_job_id: "rj_failed",
      status: "failed",
      finished_at: "2026-09-21T10:04:00Z",
      failure_code: "render_engine_failed",
    } as Partial<RenderJob>);
    const client = makeClient([failed]);
    panel(client);
    await settle();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Render started 2026-09-21T10:00:00Z/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry render" }));
    });
    await settle();

    expect(client.retryRenderJob).toHaveBeenCalledWith(
      "project_001",
      "rj_failed",
      expect.any(String),
    );
    expect(calls(client.retryRenderJob)[0][2]).not.toBe("");
    expect(screen.getByLabelText("Current render").textContent).toContain("Preparing");
  });
});

describe("bounded polling", () => {
  test("only one status request is in flight and the next waits for it to settle", async () => {
    jest.useFakeTimers();
    const resolvers: Array<(value: RenderJob) => void> = [];
    const client = makeClient([], {
      getRenderJob: mock(
        () =>
          new Promise<RenderJob>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    });
    panel(client);
    await startRender();

    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(client.getRenderJob).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers[0](job({ status: "rendering", progress_percent: 40 } as Partial<RenderJob>));
    });
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(client.getRenderJob).toHaveBeenCalledTimes(2);
  });

  test("a terminal job stops the poll", async () => {
    jest.useFakeTimers();
    const client = makeClient([], {
      getRenderJob: mock(async () =>
        job({ status: "cancelled", finished_at: "2026-09-21T10:02:00Z" } as Partial<RenderJob>),
      ),
    });
    panel(client);
    await startRender();

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(client.getRenderJob).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(client.getRenderJob).toHaveBeenCalledTimes(1);
  });

  test("offline pauses the poll and reconnecting reloads authoritative state", async () => {
    jest.useFakeTimers();
    const client = makeClient();
    panel(client);
    await startRender();

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(client.getRenderJob).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(client.getRenderJob).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();

    expect(client.getRenderCapability).toHaveBeenCalledTimes(3);
    expect(client.listRenderJobs).toHaveBeenCalledTimes(3);
  });

  test("timers and connectivity listeners are released on unmount", async () => {
    jest.useFakeTimers();
    const client = makeClient();
    const { unmount } = panel(client);
    await startRender();

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(client.getRenderJob).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(client.getRenderJob).toHaveBeenCalledTimes(1);

    // A listener left behind would keep answering the window after unmount.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(client.getRenderCapability).toHaveBeenCalledTimes(2);
  });
});

describe("async race protection", () => {
  test("a response from a superseded document cannot change what is shown", async () => {
    const resolvers: Array<(value: RenderJobPage) => void> = [];
    const client = makeClient([], {
      listRenderJobs: mock(
        () =>
          new Promise<RenderJobPage>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    });
    const { rerender } = panel(client);

    rerender(
      <RenderPanel
        client={client}
        projectId="project_001"
        documentId="document_002"
        documentRevision={1}
        templateId="vertical_text_story"
        templateVersion={1}
        facts={SAVED}
        validation={VALID}
      />,
    );
    await act(async () => {
      resolvers[0](page([COMPLETED]));
    });

    expect(screen.queryByText(/2026-09-21T09:00:00Z/)).toBeNull();
  });

  test("a stale mutation completion cannot select a job from the previous document", async () => {
    const resolvers: Array<(value: RenderJob) => void> = [];
    const client = makeClient([], {
      createRenderJob: mock(
        () =>
          new Promise<RenderJob>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    });
    const { rerender } = panel(client);
    await startRender();

    rerender(
      <RenderPanel
        client={client}
        projectId="project_001"
        documentId="document_002"
        documentRevision={1}
        templateId="vertical_text_story"
        templateVersion={1}
        facts={SAVED}
        validation={VALID}
      />,
    );
    await act(async () => {
      resolvers[0](job({ render_job_id: "rj_stale" }));
    });

    expect(screen.queryByLabelText("Current render")).toBeNull();
  });
});

describe("acting on a render", () => {
  test("Cancel is offered only while the job can still be cancelled and refreshes afterwards", async () => {
    const client = makeClient();
    panel(client);
    await startRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel render" }));
    });
    await settle();

    expect(client.cancelRenderJob).toHaveBeenCalledWith("project_001", "rj_001");
    expect(screen.queryByRole("button", { name: "Cancel render" })).toBeNull();
    expect(client.listRenderJobs).toHaveBeenCalledTimes(3);
    expect(client.getRenderCapability).toHaveBeenCalledTimes(3);
  });

  test("Download saves the authenticated blob under a name the UI owns and revokes the URL", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const names: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = ((blob: Blob) => {
      const url = `blob:render-${created.length}`;
      created.push(url);
      expect(blob.type).toBe("video/mp4");
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;
    HTMLAnchorElement.prototype.click = function recordClick(this: HTMLAnchorElement) {
      names.push(this.download);
    };

    try {
      const client = makeClient([COMPLETED]);
      panel(client);
      await settle();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: /Render started 2026-09-21T09:00:00Z/ }),
        );
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Download video" }));
      });
      await settle();

      expect(client.downloadRenderOutput).toHaveBeenCalledWith("project_001", "rj_done");
      expect(names).toEqual(["render-rj_done.mp4"]);
      expect(created).toHaveLength(1);
      expect(revoked).toEqual(created);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });

  test("Cleanup requires a destructive confirmation and refreshes authoritative state", async () => {
    const client = makeClient([COMPLETED]);
    panel(client);
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Render started 2026-09-21T09:00:00Z/ }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete render files" }));
    expect(screen.getByRole("group", { name: "Delete render files" }).textContent).toContain(
      "cannot be undone",
    );
    expect(client.cleanupRenderArtifacts).toHaveBeenCalledTimes(0);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete files" }));
    });
    await settle();

    expect(client.cleanupRenderArtifacts).toHaveBeenCalledWith("project_001", "rj_done");
    expect(client.listRenderJobs).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Download video" })).toBeNull();
  });

  test("an action button cannot be pressed twice into two requests", async () => {
    const client = makeClient([], {
      cancelRenderJob: mock(() => new Promise<RenderJob>(() => {})),
    });
    panel(client);
    await startRender();

    const cancel = screen.getByRole("button", { name: "Cancel render" });
    await act(async () => {
      fireEvent.click(cancel);
      fireEvent.click(cancel);
    });

    expect(client.cancelRenderJob).toHaveBeenCalledTimes(1);
  });
});

describe("what the panel shows", () => {
  test("progress appears only when the job reports one", async () => {
    jest.useFakeTimers();
    const client = makeClient([], {
      getRenderJob: mock(async () => job({ status: "rendering" })),
    });
    panel(client);
    await startRender();

    expect(screen.getByLabelText("Current render").textContent).toContain("Preparing");
    expect(screen.queryByText(/%/)).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(screen.getByLabelText("Current render").textContent).toContain("Rendering");
    expect(screen.queryByText(/%/)).toBeNull();
  });

  test("a reported percentage is shown as the job reports it", async () => {
    jest.useFakeTimers();
    const client = makeClient([], {
      getRenderJob: mock(async () =>
        job({ status: "rendering", progress_percent: 42 } as Partial<RenderJob>),
      ),
    });
    panel(client);
    await startRender();

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(screen.getByLabelText("Current render").textContent).toContain("42%");
  });

  test("a failure shows fixed safe copy and an unknown one stays generic", async () => {
    const failed = job({
      status: "failed",
      finished_at: "2026-09-21T10:04:00Z",
      failure_code: "render_asset_unavailable",
    } as Partial<RenderJob>);
    const unknown = job({
      render_job_id: "rj_odd",
      created_at: "2026-09-21T08:00:00Z",
      status: "failed",
      finished_at: "2026-09-21T08:04:00Z",
      failure_code: "something_new_from_the_future",
    } as unknown as Partial<RenderJob>);
    const client = makeClient([failed, unknown]);
    const { container } = panel(client);
    await settle();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Render started 2026-09-21T10:00:00Z/ }));
    });
    expect(screen.getByLabelText("Current render").textContent).toContain(
      "A file this render needs was not available.",
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Render started 2026-09-21T08:00:00Z/ }));
    });
    expect(screen.getByLabelText("Current render").textContent).toContain(
      "The render did not finish.",
    );
    expect(container.textContent).not.toContain("something_new_from_the_future");
  });
});

describe("replacing the render context", () => {
  test("an attempt started on one document cannot reach another", async () => {
    const rejects: Array<(reason: Error) => void> = [];
    const client = makeClient([], {
      createRenderJob: mock(
        () =>
          new Promise<RenderJob>((_resolve, reject) => {
            rejects.push(reject);
          }),
      ),
    });
    const { rerender } = panel(client);
    await startRender();
    expect(calls(client.createRenderJob)).toHaveLength(1);

    rerender(
      <RenderPanel
        client={client}
        projectId="project_002"
        documentId="document_002"
        documentRevision={1}
        templateId="vertical_text_story"
        templateVersion={1}
        facts={SAVED}
        validation={VALID}
      />,
    );
    await settle();

    // The replacement owes the old attempt nothing: it can render immediately.
    expect(screen.getByRole("button", { name: "Render video" })).toHaveProperty("disabled", false);

    await act(async () => {
      rejects[0](new Error("network"));
    });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();

    // Nothing the replaced document owned was replayed through the new project.
    expect(calls(client.createRenderJob)).toHaveLength(1);
    expect(calls(client.createRenderJob)[0][0]).toBe("project_001");
    // Every read after the switch belongs to the project now on screen.
    expect(calls(client.listRenderJobs).slice(1).map((call) => call[0])).not.toContain(
      "project_001",
    );
  });

  test("a new template version replaces the surface it confirmed", async () => {
    const client = makeClient();
    const { rerender } = panel(client);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Render video" }));
    expect(screen.getByRole("group", { name: "Render this version?" })).toBeDefined();

    rerender(
      <RenderPanel
        client={client}
        projectId="project_001"
        documentId="document_001"
        documentRevision={7}
        templateId="vertical_text_story"
        templateVersion={2 as RenderJob["template_version"]}
        facts={SAVED}
        validation={VALID}
      />,
    );
    await settle();

    expect(screen.queryByRole("group", { name: "Render this version?" })).toBeNull();
    expect(client.listRenderJobs).toHaveBeenCalledTimes(2);
    expect(client.createRenderJob).toHaveBeenCalledTimes(0);
  });
});

describe("recovering after a reconnect", () => {
  test("reconnecting mid-request owes one replay under the original key", async () => {
    const rejects: Array<(reason: Error) => void> = [];
    const client = makeClient([], {
      createRenderJob: mock(
        () =>
          new Promise<RenderJob>((_resolve, reject) => {
            rejects.push(reject);
          }),
      ),
    });
    panel(client);
    await startRender();
    const firstKey = calls(client.createRenderJob)[0][1] as string;

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    // The line returns while the ambiguous request is still outstanding.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(calls(client.createRenderJob)).toHaveLength(1);

    await act(async () => {
      rejects[0](new Error("network"));
    });
    await settle();

    expect(calls(client.createRenderJob)).toHaveLength(2);
    expect(calls(client.createRenderJob)[1][1]).toBe(firstKey);

    // Exactly one recovery, not a loop.
    await settle();
    await settle();
    expect(calls(client.createRenderJob)).toHaveLength(2);
  });
});

describe("settling a mutation", () => {
  test("a failed create re-reads authoritative state and still says why", async () => {
    const client = makeClient([], {
      createRenderJob: mock(async () => {
        throw { code: "render_busy" };
      }),
    });
    panel(client);
    await startRender();

    expect(screen.getByRole("alert").textContent).toBe(
      "A render is already running. Try again when it finishes.",
    );
    expect(client.listRenderJobs).toHaveBeenCalledTimes(2);
    expect(client.getRenderCapability).toHaveBeenCalledTimes(2);
  });

  test("a failed cleanup re-reads authoritative state", async () => {
    const client = makeClient([COMPLETED], {
      cleanupRenderArtifacts: mock(async () => {
        throw { code: "render_job_not_cleanable" };
      }),
    });
    panel(client);
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Render started 2026-09-21T09:00:00Z/ }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete render files" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete files" }));
    });
    await settle();

    expect(screen.getByRole("alert").textContent).toBe("Those render files cannot be deleted.");
    expect(client.listRenderJobs).toHaveBeenCalledTimes(2);
  });

  test("an outcome that settles offline defers its refresh to the reconnect", async () => {
    const resolvers: Array<(value: RenderJob) => void> = [];
    const client = makeClient([], {
      createRenderJob: mock(
        () =>
          new Promise<RenderJob>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    });
    panel(client);
    await startRender();
    expect(client.listRenderJobs).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    await act(async () => {
      resolvers[0](job());
    });
    await settle();

    // Nothing is re-read while the line is down.
    expect(client.listRenderJobs).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();

    expect(client.listRenderJobs).toHaveBeenCalledTimes(2);
    expect(calls(client.createRenderJob)).toHaveLength(1);
  });
});

describe("acting while offline", () => {
  test("Cancel is unavailable offline and refuses a forced activation", async () => {
    const client = makeClient();
    panel(client);
    await startRender();

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    const cancel = screen.getByRole("button", { name: "Cancel render" });
    expect(cancel).toHaveProperty("disabled", true);

    // Forced past the disabled attribute, the handler still refuses.
    cancel.removeAttribute("disabled");
    await act(async () => {
      fireEvent.click(cancel);
    });
    expect(client.cancelRenderJob).toHaveBeenCalledTimes(0);
  });

  test("Download and Cleanup are unavailable offline and call nothing", async () => {
    const client = makeClient([COMPLETED]);
    panel(client);
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Render started 2026-09-21T09:00:00Z/ }));
    });
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });

    const download = screen.getByRole("button", { name: "Download video" });
    const cleanup = screen.getByRole("button", { name: "Delete render files" });
    expect(download).toHaveProperty("disabled", true);
    expect(cleanup).toHaveProperty("disabled", true);

    download.removeAttribute("disabled");
    cleanup.removeAttribute("disabled");
    await act(async () => {
      fireEvent.click(download);
      fireEvent.click(cleanup);
    });
    const confirmed = screen.queryByRole("button", { name: "Delete files" });
    if (confirmed) {
      await act(async () => {
        fireEvent.click(confirmed);
      });
    }

    expect(client.downloadRenderOutput).toHaveBeenCalledTimes(0);
    expect(client.cleanupRenderArtifacts).toHaveBeenCalledTimes(0);
  });
});

describe("document validation", () => {
  test("a blocking timeline issue stops a render whose text is valid", async () => {
    const client = makeClient();
    panel(client, SAVED, 7, { textValid: true, blockingIssues: 2 });
    await settle();

    const button = screen.getByRole("button", { name: "Render video" });
    expect(button).toHaveProperty("disabled", true);
    const reason = button.getAttribute("aria-describedby");
    expect(window.document.getElementById(reason as string)?.textContent).toBe(
      "Fix 2 timeline issues before rendering.",
    );
    fireEvent.click(button);
    expect(client.createRenderJob).toHaveBeenCalledTimes(0);
  });

  test("one issue is named in the singular", async () => {
    panel(makeClient(), SAVED, 7, { textValid: true, blockingIssues: 1 });
    await settle();

    const reason = screen
      .getByRole("button", { name: "Render video" })
      .getAttribute("aria-describedby");
    expect(window.document.getElementById(reason as string)?.textContent).toBe(
      "Fix 1 timeline issue before rendering.",
    );
  });

  test("valid text with no blocking issue still renders", async () => {
    const client = makeClient();
    panel(client, SAVED, 7, { textValid: true, blockingIssues: 0 });
    await startRender();

    expect(client.createRenderJob).toHaveBeenCalledTimes(1);
  });
});

describe("recovering an active render", () => {
  test("the active render capability names is selected and polled again", async () => {
    jest.useFakeTimers();
    const active = job({
      render_job_id: "rj_active",
      status: "rendering",
      created_at: "2026-09-21T11:00:00Z",
      progress_percent: 20,
    } as Partial<RenderJob>);
    const client = makeClient([COMPLETED, active], {
      getRenderCapability: mock(async () => ({
        ...AVAILABLE,
        available: false,
        reason: "render_busy" as const,
        active_render_job_id: "rj_active",
      })),
    });
    panel(client);
    await settle();

    expect(screen.getByLabelText("Current render").textContent).toContain("Rendering");

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(client.getRenderJob).toHaveBeenCalledWith("project_001", "rj_active");
  });

  test("a history with nothing active starts no poll", async () => {
    jest.useFakeTimers();
    const client = makeClient([COMPLETED]);
    panel(client);
    await settle();

    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(client.getRenderJob).toHaveBeenCalledTimes(0);
  });
});

describe("confirmation semantics", () => {
  test("the create confirmation is labelled and operable without claiming modality", async () => {
    const { container } = panel(makeClient());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Render video" }));

    const confirmation = screen.getByRole("group", { name: "Render this version?" });
    expect(container.querySelector("[aria-modal]")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    const start = screen.getByRole("button", { name: "Start render" });
    expect(confirmation.contains(start)).toBe(true);
    start.focus();
    expect(window.document.activeElement).toBe(start);
  });

  test("the destructive cleanup confirmation uses the same honest semantics", async () => {
    const { container } = panel(makeClient([COMPLETED]));
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Render started 2026-09-21T09:00:00Z/ }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete render files" }));

    const confirmation = screen.getByRole("group", { name: "Delete render files" });
    expect(container.querySelector("[aria-modal]")).toBeNull();
    expect(confirmation.textContent).toContain("cannot be undone");

    const destroy = screen.getByRole("button", { name: "Delete files" });
    expect(confirmation.contains(destroy)).toBe(true);
    destroy.focus();
    expect(window.document.activeElement).toBe(destroy);
  });
});
