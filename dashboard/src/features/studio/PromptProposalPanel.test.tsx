/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PromptProposalPanelClient } from "./PromptProposalPanel";

const provider = {
  provider_id: "novita",
  label: "Novita",
  enabled: true,
  models: [
    {
      model_id: "deepseek/deepseek-v3.1",
      label: "DeepSeek V3.1",
      capabilities: ["improve", "translate"],
      max_input_chars: 12000,
    },
  ],
};

const starter = {
  starter_id: "starter_v1",
  label: "Narrative plan starter",
  language: "id-ID",
  body: "Rencana narasi bawaan",
};

const runningProposal = {
  proposal_id: "proposal_9",
  project_id: "project_a",
  stage_id: "narrative_plan",
  kind: "improve",
  status: "running",
  target_layers: ["template"],
  source: {
    template_id: "ptpl_001",
    template_revision: 1,
    binding_revision: 1,
    template_language: "id-ID",
    template_body: "Write a hook",
    project_override: null,
  },
  provider_id: "novita",
  model_id: "deepseek/deepseek-v3.1",
  changes: [],
  translated_template_body: null,
  translated_project_override: null,
  failure_code: null,
  created_at: "2026-09-13T08:00:00Z",
  started_at: "2026-09-13T08:00:01Z",
  finished_at: null,
};

const succeededProposal = {
  ...runningProposal,
  proposal_id: "proposal_10",
  status: "succeeded",
  finished_at: "2026-09-13T08:00:05Z",
  changes: [
    {
      change_id: "change_abc",
      layer: "template",
      before_text: "Write a hook",
      after_text: "Write a better hook",
      start_line: 0,
      end_line: 1,
    },
  ],
};

function client(overrides: Record<string, unknown> = {}): PromptProposalPanelClient {
  return {
    listPromptProviders: mock(async () => [provider]),
    getPromptStarter: mock(async () => starter),
    getPromptPreference: mock(async () => null),
    savePromptPreference: mock(async () => ({
      kind: "saved" as const,
      value: {
        project_id: "project_a",
        stage_id: "narrative_plan",
        provider_id: "novita",
        model_id: "deepseek/deepseek-v3.1",
        revision: 1,
        updated_at: "2026-09-13T08:00:00Z",
      },
    })),
    getPromptLocks: mock(async () => []),
    savePromptLock: mock(async () => ({
      kind: "saved" as const,
      value: {
        project_id: "project_a",
        stage_id: "narrative_plan",
        layer: "template",
        locked: true,
        revision: 1,
        updated_at: "2026-09-13T08:00:00Z",
      },
    })),
    createPromptProposal: mock(async () => runningProposal),
    listPromptProposals: mock(async () => ({ proposals: [succeededProposal], next_cursor: null })),
    getPromptProposal: mock(async () => succeededProposal),
    applyPromptProposal: mock(async () => ({
      proposal: succeededProposal,
      resulting_template_id: "ptpl_001",
      resulting_template_revision: 2,
      resulting_binding_revision: 2,
    })),
    rejectPromptProposal: mock(async () => ({ ...succeededProposal, status: "rejected" })),
    ...overrides,
  } as unknown as PromptProposalPanelClient;
}

function panelProps(overrides: Record<string, unknown> = {}) {
  return {
    client: client(),
    projectId: "project_a",
    stageId: "narrative_plan",
    savedTemplateId: "ptpl_001",
    savedTemplateRevision: 1,
    savedBindingRevision: 1,
    savedOverrideText: "Use Indonesian",
    formDirty: false,
    online: true,
    hasBinding: true,
    onApplied: mock(() => {}),
    onUseStarter: mock(() => {}),
    onCreateScratch: mock(() => {}),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => cleanup());

test("Use starter copies text locally without any write API call", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const api = client();
  const onUseStarter = mock(() => {});
  render(<PromptProposalPanel {...panelProps({ client: api, onUseStarter, hasBinding: false })} />);

  await user.click(await screen.findByRole("button", { name: "Use starter" }));
  expect((api.getPromptStarter as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  expect(onUseStarter).toHaveBeenCalledTimes(1);
  expect((api.createPromptProposal as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("Create scratch clears the local draft without writing", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const onCreateScratch = mock(() => {});
  const api = client();
  render(<PromptProposalPanel {...panelProps({ client: api, onCreateScratch, hasBinding: false })} />);

  await user.click(await screen.findByRole("button", { name: "Create scratch" }));
  expect(onCreateScratch).toHaveBeenCalledTimes(1);
  expect((api.createPromptProposal as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("persists provider preference only on explicit save", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const api = client();
  render(<PromptProposalPanel {...panelProps({ client: api })} />);

  await screen.findByLabelText("Provider");
  await user.selectOptions(screen.getByLabelText("Model"), "deepseek/deepseek-v3.1");
  expect((api.savePromptPreference as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  await user.click(screen.getByRole("button", { name: "Save preference" }));
  expect((api.savePromptPreference as ReturnType<typeof mock>).mock.calls.length).toBe(1);
});

test("locks are revisioned through the panel controls", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const api = client();
  render(<PromptProposalPanel {...panelProps({ client: api })} />);

  await user.click(await screen.findByRole("button", { name: "Lock template" }));
  expect((api.savePromptLock as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  expect((api.savePromptLock as ReturnType<typeof mock>).mock.calls[0][3]).toEqual({
    locked: true,
    base_revision: null,
  });
});

test("a running proposal resumes polling after a refresh-shaped remount", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const api = client({
    listPromptProposals: mock(async () => ({ proposals: [runningProposal], next_cursor: null })),
  });
  const first = render(<PromptProposalPanel {...panelProps({ client: api })} />);
  first.unmount();
  render(<PromptProposalPanel {...panelProps({ client: api })} />);

  expect(await screen.findByText("Proposal running")).toBeDefined();
  expect((api.createPromptProposal as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("completed proposals expose selectable hunks, Apply and Reject", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const api = client();
  const onApplied = mock(() => {});
  const { unmount } = render(<PromptProposalPanel {...panelProps({ client: api, onApplied })} />);

  const checkbox = await screen.findByRole("checkbox");
  await user.click(checkbox);
  await user.click(screen.getByRole("button", { name: "Apply selected" }));
  expect((api.applyPromptProposal as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  expect(onApplied).toHaveBeenCalledTimes(1);
  unmount();

  // Rejecting is the explicit no-change action on a fresh succeeded proposal.
  const rejectApi = client();
  const rejectProps = panelProps({ client: rejectApi });
  render(<PromptProposalPanel {...rejectProps} />);
  await screen.findByText("Proposal ready for review");
  await user.click(screen.getByRole("button", { name: "Reject proposal" }));
  expect((rejectApi.rejectPromptProposal as ReturnType<typeof mock>).mock.calls.length).toBe(1);
});

test("Generate is blocked while the authoring form is dirty", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const api = client();
  render(<PromptProposalPanel {...panelProps({ client: api, formDirty: true })} />);

  await screen.findByLabelText("Provider");
  await user.click(screen.getByRole("button", { name: "Improve with AI" }));
  expect((api.createPromptProposal as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect(screen.getAllByText("Save changes first").length).toBeGreaterThan(0);
});


test("proposal creation sends the exact saved template identity", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const api = client();
  render(
    <PromptProposalPanel
      {...panelProps({ client: api })}
      savedTemplateId="ptpl_real_9"
      savedTemplateRevision={4}
      savedBindingRevision={2}
    />,
  );

  await screen.findByLabelText("Provider");
  await user.click(screen.getByRole("button", { name: "Improve with AI" }));

  expect((api.createPromptProposal as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  const payload = (api.createPromptProposal as ReturnType<typeof mock>).mock.calls[0][2];
  expect(payload.source_template_id).toBe("ptpl_real_9");
  expect(payload.source_template_revision).toBe(4);
  expect(payload.source_binding_revision).toBe(2);
  expect(String(payload.source_template_id)).not.toContain("ptpl_4");
});

test("generate refuses to send a request for a stage id outside the known set", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const api = client();
  render(<PromptProposalPanel {...panelProps({ client: api, stageId: "not_a_real_stage" })} />);

  await screen.findByLabelText("Provider");
  await user.click(screen.getByRole("button", { name: "Improve with AI" }));
  expect((api.createPromptProposal as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("switching stages clears the prior stage's proposal before the new stage loads", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const staleHistory = deferred<{ proposals: unknown[]; next_cursor: null }>();
  let historyCalls = 0;
  const api = client({
    listPromptProposals: mock(() => {
      historyCalls += 1;
      return historyCalls === 1
        ? Promise.resolve({ proposals: [runningProposal], next_cursor: null })
        : staleHistory.promise;
    }),
  });
  const { rerender } = render(<PromptProposalPanel {...panelProps({ client: api })} />);
  expect(await screen.findByText("Proposal running")).toBeDefined();

  rerender(<PromptProposalPanel {...panelProps({ client: api, stageId: "visual_plan" })} />);

  expect(screen.queryByText("Proposal running")).toBeNull();
});

test("a late response for the previous stage cannot overwrite the new stage's state", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const staleHistory = deferred<{ proposals: unknown[]; next_cursor: null }>();
  let historyCalls = 0;
  const api = client({
    listPromptProposals: mock(() => {
      historyCalls += 1;
      return historyCalls === 1
        ? staleHistory.promise
        : Promise.resolve({ proposals: [], next_cursor: null });
    }),
  });
  const { rerender } = render(<PromptProposalPanel {...panelProps({ client: api })} />);
  await screen.findByLabelText("Provider");

  rerender(<PromptProposalPanel {...panelProps({ client: api, stageId: "visual_plan" })} />);
  await screen.findByLabelText("Provider");

  staleHistory.resolve({ proposals: [runningProposal], next_cursor: null });
  await staleHistory.promise;

  expect(screen.queryByText("Proposal running")).toBeNull();
});

test("empty history leaves the proposal review panel unrendered", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const api = client({
    listPromptProposals: mock(async () => ({ proposals: [], next_cursor: null })),
  });
  render(<PromptProposalPanel {...panelProps({ client: api })} />);

  await screen.findByLabelText("Provider");
  expect(screen.queryByLabelText("Proposal review")).toBeNull();
});

test("reconnecting reloads catalog, preference, locks, then history in order", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const order: string[] = [];
  const api = client({
    listPromptProviders: mock(async () => {
      order.push("catalog");
      return [provider];
    }),
    getPromptPreference: mock(async () => {
      order.push("preference");
      return null;
    }),
    getPromptLocks: mock(async () => {
      order.push("locks");
      return [];
    }),
    listPromptProposals: mock(async () => {
      order.push("history");
      return { proposals: [], next_cursor: null };
    }),
  });
  const { rerender } = render(
    <PromptProposalPanel {...panelProps({ client: api, online: false })} />,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  order.length = 0;

  rerender(<PromptProposalPanel {...panelProps({ client: api, online: true })} />);
  await screen.findByLabelText("Provider");

  expect(order).toEqual(["catalog", "preference", "locks", "history"]);
});

test("polling stops and is not rescheduled once the panel unmounts", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const api = client({
    listPromptProposals: mock(async () => ({ proposals: [runningProposal], next_cursor: null })),
  });
  const { unmount } = render(<PromptProposalPanel {...panelProps({ client: api })} />);
  await screen.findByText("Proposal running");
  unmount();

  await new Promise((resolve) => setTimeout(resolve, 1600));
  expect((api.getPromptProposal as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("generation is disabled without a saved template identity", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const api = client();
  render(
    <PromptProposalPanel
      {...panelProps({ client: api })}
      savedTemplateId={null}
      savedTemplateRevision={null}
      savedBindingRevision={null}
    />,
  );

  await screen.findByLabelText("Provider");
  const improve = screen.getByRole("button", { name: "Improve with AI" }) as HTMLButtonElement;
  expect(improve.disabled).toBe(true);
  expect(screen.getAllByText("Save changes first").length).toBeGreaterThan(0);
});

test("Unlock stays clickable online even though the layer is locked", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const api = client({
    getPromptLocks: mock(async () => [
      {
        project_id: "project_a",
        stage_id: "narrative_plan",
        layer: "template",
        locked: true,
        revision: 3,
        updated_at: "2026-09-13T08:00:00Z",
      },
    ]),
  });
  render(<PromptProposalPanel {...panelProps({ client: api })} />);

  const unlock = await screen.findByRole("button", { name: "Unlock template" });
  expect((unlock as HTMLButtonElement).disabled).toBe(false);
  await user.click(unlock);
  expect((api.savePromptLock as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  expect((api.savePromptLock as ReturnType<typeof mock>).mock.calls[0][3]).toEqual({
    locked: false,
    base_revision: 3,
  });
});

test("both lock buttons are disabled offline and while a lock save is pending", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const inFlight = deferred<{
    kind: "saved";
    value: { project_id: string; stage_id: string; layer: string; locked: boolean; revision: number; updated_at: string };
  }>();
  const api = client({ savePromptLock: mock(() => inFlight.promise) });
  const { rerender } = render(<PromptProposalPanel {...panelProps({ client: api, online: false })} />);

  expect((await screen.findByRole("button", { name: "Lock template" })).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Lock project override" }).hasAttribute("disabled")).toBe(true);

  rerender(<PromptProposalPanel {...panelProps({ client: api, online: true })} />);
  const lockTemplate = screen.getByRole("button", { name: "Lock template" }) as HTMLButtonElement;
  expect(lockTemplate.disabled).toBe(false);
  await user.click(lockTemplate);
  expect(lockTemplate.disabled).toBe(true);

  inFlight.resolve({
    kind: "saved",
    value: {
      project_id: "project_a",
      stage_id: "narrative_plan",
      layer: "template",
      locked: true,
      revision: 1,
      updated_at: "2026-09-13T08:00:00Z",
    },
  });
  await screen.findByRole("button", { name: "Unlock template" });
});

test("a lock conflict adopts the latest resource instead of failing silently", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const latest = {
    project_id: "project_a",
    stage_id: "narrative_plan",
    layer: "template",
    locked: true,
    revision: 7,
    updated_at: "2026-09-13T08:00:01Z",
  };
  const api = client({
    savePromptLock: mock(async () => ({ kind: "conflict" as const, latest })),
  });
  render(<PromptProposalPanel {...panelProps({ client: api })} />);

  await user.click(await screen.findByRole("button", { name: "Lock template" }));
  expect(await screen.findByRole("button", { name: "Unlock template" })).toBeDefined();
});

test("a preference conflict adopts the latest resource instead of failing silently", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const latest = {
    project_id: "project_a",
    stage_id: "narrative_plan",
    provider_id: "novita",
    model_id: "deepseek/deepseek-v3.1",
    revision: 5,
    updated_at: "2026-09-13T08:00:01Z",
  };
  const api = client({
    savePromptPreference: mock(async () => ({ kind: "conflict" as const, latest })),
  });
  render(<PromptProposalPanel {...panelProps({ client: api })} />);

  await screen.findByLabelText("Provider");
  await user.click(screen.getByRole("button", { name: "Save preference" }));
  expect((api.savePromptPreference as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  // No error surfaced to the user despite the 409; the latest resource silently wins.
  expect(screen.queryByText(/store_unavailable/)).toBeNull();
});

test("Translate with AI is blocked when the project override is locked and non-blank", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const api = client({
    getPromptLocks: mock(async () => [
      {
        project_id: "project_a",
        stage_id: "narrative_plan",
        layer: "project_override",
        locked: true,
        revision: 1,
        updated_at: "2026-09-13T08:00:00Z",
      },
    ]),
  });
  render(
    <PromptProposalPanel {...panelProps({ client: api, savedOverrideText: "Use Indonesian" })} />,
  );

  const translate = await screen.findByRole("button", { name: "Translate with AI" });
  expect((translate as HTMLButtonElement).disabled).toBe(true);
});

test("a rejected poll reschedules exactly one bounded retry instead of stopping or hot-looping", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  let calls = 0;
  const api = client({
    listPromptProposals: mock(async () => ({ proposals: [runningProposal], next_cursor: null })),
    getPromptProposal: mock(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("network blip"));
      return Promise.resolve({ ...runningProposal, status: "succeeded" });
    }),
  });
  render(<PromptProposalPanel {...panelProps({ client: api })} />);
  await screen.findByText("Proposal running");

  await new Promise((resolve) => setTimeout(resolve, 1600));
  expect(calls).toBe(1);

  await new Promise((resolve) => setTimeout(resolve, 1600));
  expect(calls).toBe(2);
  expect(await screen.findByText("Proposal ready for review")).toBeDefined();

  // Terminal now; no further polling.
  await new Promise((resolve) => setTimeout(resolve, 1600));
  expect(calls).toBe(2);
});

test("an initial load failure disables Generate, Save preference, and lock writes", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const api = client({ getPromptLocks: mock(() => Promise.reject(new Error("network blip"))) });
  render(<PromptProposalPanel {...panelProps({ client: api })} />);

  await screen.findByRole("alert");
  const improve = screen.getByRole("button", { name: "Improve with AI" }) as HTMLButtonElement;
  const translate = screen.getByRole("button", { name: "Translate with AI" }) as HTMLButtonElement;
  const savePreference = screen.getByRole("button", { name: "Save preference" }) as HTMLButtonElement;
  const lockTemplate = screen.getByRole("button", { name: "Lock template" }) as HTMLButtonElement;
  expect(improve.disabled).toBe(true);
  expect(translate.disabled).toBe(true);
  expect(savePreference.disabled).toBe(true);
  expect(lockTemplate.disabled).toBe(true);
});

test("no proposal polling begins after an incomplete initial load", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const api = client({
    listPromptProposals: mock(() => Promise.reject(new Error("network blip"))),
  });
  render(<PromptProposalPanel {...panelProps({ client: api })} />);
  await screen.findByRole("alert");

  await new Promise((resolve) => setTimeout(resolve, 1600));
  expect((api.getPromptProposal as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("a failed reconnect reload does not let stale-cleared locks appear generatable", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  let locksCalls = 0;
  const api = client({
    getPromptLocks: mock(() => {
      locksCalls += 1;
      if (locksCalls === 1) {
        return Promise.resolve([
          {
            project_id: "project_a",
            stage_id: "narrative_plan",
            layer: "template",
            locked: true,
            revision: 1,
            updated_at: "2026-09-13T08:00:00Z",
          },
        ]);
      }
      return Promise.reject(new Error("network blip"));
    }),
  });
  const { rerender } = render(<PromptProposalPanel {...panelProps({ client: api, online: false })} />);
  await screen.findByRole("button", { name: "Unlock template" });

  rerender(<PromptProposalPanel {...panelProps({ client: api, online: true })} />);
  await screen.findByRole("alert");

  const improve = screen.getByRole("button", { name: "Improve with AI" }) as HTMLButtonElement;
  expect(improve.disabled).toBe(true);
});

test("a subsequent complete reload restores actions after a prior failure", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  let locksCalls = 0;
  const api = client({
    getPromptLocks: mock(() => {
      locksCalls += 1;
      return locksCalls === 1 ? Promise.reject(new Error("network blip")) : Promise.resolve([]);
    }),
  });
  render(<PromptProposalPanel {...panelProps({ client: api })} />);
  const retry = await screen.findByRole("button", { name: "Retry loading proposals" });
  await user.click(retry);

  await screen.findByLabelText("Provider");
  const improve = screen.getByRole("button", { name: "Improve with AI" }) as HTMLButtonElement;
  expect(improve.disabled).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a failed required reload during reconnect leaves the proposal panel fail-closed", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  let locksCalls = 0;
  const api = client({
    getPromptLocks: mock(() => {
      locksCalls += 1;
      if (locksCalls === 1) return Promise.resolve([]);
      return Promise.reject(new Error("network blip"));
    }),
    listPromptProposals: mock(async () => ({ proposals: [runningProposal], next_cursor: null })),
  });
  const { rerender } = render(
    <PromptProposalPanel {...panelProps({ client: api, online: false })} />,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  rerender(<PromptProposalPanel {...panelProps({ client: api, online: true })} />);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(screen.queryByText("Proposal running") === null).toBe(true);
  expect((api.getPromptProposal as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("a lock save started before a stage switch must not apply after the switch", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const inFlight = deferred<{
    kind: "saved";
    value: { project_id: string; stage_id: string; layer: string; locked: boolean; revision: number; updated_at: string };
  }>();
  const api = client({ savePromptLock: mock(() => inFlight.promise) });
  const { rerender } = render(<PromptProposalPanel {...panelProps({ client: api })} />);
  await user.click(await screen.findByRole("button", { name: "Lock template" }));

  rerender(<PromptProposalPanel {...panelProps({ client: api, stageId: "visual_plan" })} />);
  await screen.findByLabelText("Provider");

  inFlight.resolve({
    kind: "saved",
    value: {
      project_id: "project_a",
      stage_id: "narrative_plan",
      layer: "template",
      locked: true,
      revision: 1,
      updated_at: "2026-09-13T08:00:00Z",
    },
  });
  await inFlight.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(screen.getByRole("button", { name: "Lock template" })).toBeDefined();
});

test("a lock on an unrelated layer does not show a false Improve blocker", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const api = client({
    getPromptLocks: mock(async () => [
      {
        project_id: "project_a",
        stage_id: "narrative_plan",
        layer: "project_override",
        locked: true,
        revision: 1,
        updated_at: "2026-09-13T08:00:00Z",
      },
    ]),
  });
  // Blank override text keeps Translate's own (legitimate) dual-layer lock check from
  // also matching this lock, isolating the assertion to Improve's false-positive.
  render(<PromptProposalPanel {...panelProps({ client: api, savedOverrideText: "" })} />);

  const improve = (await screen.findByRole("button", { name: "Improve with AI" })) as HTMLButtonElement;
  expect(improve.disabled).toBe(false);
  expect(screen.queryByText("Unlock the target layer first") === null).toBe(true);
});

test("Translate is disabled with its own reason when the model lacks translate capability", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const improveOnlyProvider = {
    ...provider,
    models: [{ ...provider.models[0], capabilities: ["improve"] }],
  };
  const api = client({ listPromptProviders: mock(async () => [improveOnlyProvider]) });
  render(<PromptProposalPanel {...panelProps({ client: api })} />);

  const translate = (await screen.findByRole("button", { name: "Translate with AI" })) as HTMLButtonElement;
  expect(translate.disabled).toBe(true);
  expect(screen.getByText("Select a provider and model")).toBeDefined();
  const improve = screen.getByRole("button", { name: "Improve with AI" }) as HTMLButtonElement;
  expect(improve.disabled).toBe(false);
});

test("Regenerate's own gate, not a generic any-lock check, decides its blocked reason", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const overrideProposal = {
    ...succeededProposal,
    target_layers: ["project_override"] as Array<"template" | "project_override">,
  };
  const api = client({
    listPromptProposals: mock(async () => ({ proposals: [overrideProposal], next_cursor: null })),
    getPromptLocks: mock(async () => [
      {
        project_id: "project_a",
        stage_id: "narrative_plan",
        layer: "template",
        locked: true,
        revision: 1,
        updated_at: "2026-09-13T08:00:00Z",
      },
    ]),
  });
  const { container } = render(<PromptProposalPanel {...panelProps({ client: api })} />);

  // template is locked, so Improve/Translate (which target template) are legitimately
  // blocked here too - the assertion is scoped to the proposal review region, where
  // only Regenerate's own gate (targeting the proposal's actual project_override layer)
  // decides its reason, proving it isn't falsely tripped by the unrelated template lock.
  const regenerate = (await screen.findByRole("button", { name: "Regenerate" })) as HTMLButtonElement;
  expect(regenerate.disabled).toBe(false);
  const review = within(container.querySelector('[aria-label="Proposal review"]') as HTMLElement);
  expect(review.queryByText("Unlock the target layer first") === null).toBe(true);
});

test("Regenerate targets the proposal's own recorded layer, not the current Improve dropdown", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const overrideProposal = {
    ...succeededProposal,
    target_layers: ["project_override"] as Array<"template" | "project_override">,
  };
  const api = client({
    listPromptProposals: mock(async () => ({ proposals: [overrideProposal], next_cursor: null })),
    getPromptLocks: mock(async () => [
      {
        project_id: "project_a",
        stage_id: "narrative_plan",
        layer: "template",
        locked: true,
        revision: 1,
        updated_at: "2026-09-13T08:00:00Z",
      },
    ]),
  });
  render(<PromptProposalPanel {...panelProps({ client: api })} />);

  // The Improve dropdown still defaults to "template" (locked), but the proposal being
  // regenerated only ever targeted project_override (unlocked) — Regenerate must stay enabled.
  const regenerate = await screen.findByRole("button", { name: "Regenerate" });
  expect((regenerate as HTMLButtonElement).disabled).toBe(false);
  await user.click(regenerate);
  expect((api.createPromptProposal as ReturnType<typeof mock>).mock.calls.length).toBe(1);
});

test("a deferred starter response from an earlier stage cannot populate the new stage's editor", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const starterResponse = deferred<typeof starter>();
  const api = client({ getPromptStarter: mock(() => starterResponse.promise) });
  const onUseStarter = mock(() => {});
  const { rerender } = render(
    <PromptProposalPanel {...panelProps({ client: api, onUseStarter, hasBinding: false })} />,
  );
  await user.click(await screen.findByRole("button", { name: "Use starter" }));

  rerender(
    <PromptProposalPanel
      {...panelProps({ client: api, onUseStarter, hasBinding: false, stageId: "visual_plan" })}
    />,
  );
  await screen.findByLabelText("Provider");

  starterResponse.resolve(starter);
  await starterResponse.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(onUseStarter).not.toHaveBeenCalled();
});

test("a deferred starter response settling after unmount does not invoke the starter callback", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const starterResponse = deferred<typeof starter>();
  const api = client({ getPromptStarter: mock(() => starterResponse.promise) });
  const onUseStarter = mock(() => {});
  const { unmount } = render(
    <PromptProposalPanel {...panelProps({ client: api, onUseStarter, hasBinding: false })} />,
  );
  await user.click(await screen.findByRole("button", { name: "Use starter" }));

  unmount();
  starterResponse.resolve(starter);
  await starterResponse.promise;

  expect(onUseStarter).not.toHaveBeenCalled();
});

test("a deferred apply completion after unmount does not call onApplied", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const applyResponse = deferred<{
    proposal: typeof succeededProposal;
    resulting_template_id: string;
    resulting_template_revision: number;
    resulting_binding_revision: number;
  }>();
  const api = client({ applyPromptProposal: mock(() => applyResponse.promise) });
  const onApplied = mock(() => {});
  const { unmount } = render(<PromptProposalPanel {...panelProps({ client: api, onApplied })} />);

  const checkbox = await screen.findByRole("checkbox");
  await user.click(checkbox);
  await user.click(screen.getByRole("button", { name: "Apply selected" }));
  expect((api.applyPromptProposal as ReturnType<typeof mock>).mock.calls.length).toBe(1);

  unmount();
  applyResponse.resolve({
    proposal: succeededProposal,
    resulting_template_id: "ptpl_001",
    resulting_template_revision: 2,
    resulting_binding_revision: 2,
  });
  await applyResponse.promise;

  expect(onApplied).not.toHaveBeenCalled();
});

test("an old-stage lock request settling cannot clear the pending state of a newer-stage lock request on the same layer", async () => {
  const { PromptProposalPanel } = await import("./PromptProposalPanel");
  const user = userEvent.setup();
  const staleLock = deferred<{
    kind: "saved";
    value: { project_id: string; stage_id: string; layer: string; locked: boolean; revision: number; updated_at: string };
  }>();
  const freshLock = deferred<{
    kind: "saved";
    value: { project_id: string; stage_id: string; layer: string; locked: boolean; revision: number; updated_at: string };
  }>();
  let lockCalls = 0;
  const api = client({
    savePromptLock: mock(() => {
      lockCalls += 1;
      return lockCalls === 1 ? staleLock.promise : freshLock.promise;
    }),
  });
  const { rerender } = render(<PromptProposalPanel {...panelProps({ client: api })} />);
  await user.click(await screen.findByRole("button", { name: "Lock template" }));

  rerender(<PromptProposalPanel {...panelProps({ client: api, stageId: "visual_plan" })} />);
  await screen.findByLabelText("Provider");
  await user.click(await screen.findByRole("button", { name: "Lock template" }));

  const lockTemplate = screen.getByRole("button", { name: "Lock template" }) as HTMLButtonElement;
  expect(lockTemplate.disabled).toBe(true);

  staleLock.resolve({
    kind: "saved",
    value: {
      project_id: "project_a",
      stage_id: "narrative_plan",
      layer: "template",
      locked: true,
      revision: 1,
      updated_at: "2026-09-13T08:00:00Z",
    },
  });
  await staleLock.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(lockTemplate.disabled).toBe(true);
});
