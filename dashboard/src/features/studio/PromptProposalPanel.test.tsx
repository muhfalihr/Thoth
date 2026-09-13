/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
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
      project_id: "project_a",
      stage_id: "narrative_plan",
      provider_id: "novita",
      model_id: "deepseek/deepseek-v3.1",
      revision: 1,
      updated_at: "2026-09-13T08:00:00Z",
    })),
    getPromptLocks: mock(async () => []),
    savePromptLock: mock(async () => ({
      project_id: "project_a",
      stage_id: "narrative_plan",
      layer: "template",
      locked: true,
      revision: 1,
      updated_at: "2026-09-13T08:00:00Z",
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
  expect((api.savePromptLock as ReturnType<typeof mock>).mock.calls[0][3]).toEqual({ locked: true });
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

