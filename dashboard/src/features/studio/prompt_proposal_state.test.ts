/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import type { PromptProposalResource } from "@/api/control-plane";
import {
  canApplyProposal,
  canGenerateProposal,
  createPromptProposalState,
  promptProposalReducer,
  type PromptProposalState,
} from "./prompt_proposal_state";

const provider = {
  provider_id: "novita",
  label: "Novita",
  enabled: true,
  models: [
    {
      model_id: "deepseek/deepseek-v3.1",
      label: "DeepSeek V3.1",
      capabilities: ["improve", "translate"] as Array<"improve" | "translate">,
      max_input_chars: 12000,
    },
  ],
};

const proposal = {
  proposal_id: "proposal_1",
  project_id: "project_a",
  stage_id: "narrative_plan",
  kind: "improve",
  status: "succeeded",
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
  translated_template_body: null,
  translated_project_override: null,
  failure_code: null,
  created_at: "2026-09-13T08:00:00Z",
  started_at: "2026-09-13T08:00:01Z",
  finished_at: "2026-09-13T08:00:05Z",
} as unknown as PromptProposalResource;

function readyState(): PromptProposalState {
  return createPromptProposalState({
    stageId: "narrative_plan",
    providers: [provider],
    savedTemplateId: "ptpl_001",
    savedTemplateRevision: 1,
    savedBindingRevision: 1,
    savedOverrideText: "Use Indonesian",
  });
}

test("stage changes discard view state but not server-owned resources", () => {
  const withSelection = promptProposalReducer(readyState(), {
    type: "proposal_loaded",
    proposal,
  });
  const next = promptProposalReducer(withSelection, { type: "stage_selected", stageId: "visual_plan" });

  expect(next.stageId).toBe("visual_plan");
  expect(next.selectedChangeIds).toEqual([]);
  expect(next.activeProposal).toBeNull();
  expect(next.providers).toEqual([provider]);
});

test("offline and dirty authoring state fail closed", () => {
  expect(canGenerateProposal(readyState(), { online: false, formDirty: false }).allowed).toBe(false);
  expect(canGenerateProposal(readyState(), { online: true, formDirty: true }).allowed).toBe(false);
});

test("generation requires saved revisions and unlocks when clean", () => {
  const noSaved = createPromptProposalState({
    stageId: "narrative_plan",
    providers: [provider],
    savedTemplateId: null,
    savedTemplateRevision: null,
    savedBindingRevision: null,
    savedOverrideText: "",
  });
  expect(canGenerateProposal(noSaved, { online: true, formDirty: false }).allowed).toBe(false);
  expect(
    canGenerateProposal(noSaved, { online: true, formDirty: false }, "improve", "template").reason,
  ).toBe("missing_saved_source");

  const allowed = canGenerateProposal(readyState(), { online: true, formDirty: false });
  expect(allowed.allowed).toBe(true);
});

test("locked target layer blocks generation", () => {
  const locked = promptProposalReducer(readyState(), {
    type: "locks_loaded",
    locks: [
      { project_id: "project_a", stage_id: "narrative_plan", layer: "template", locked: true, revision: 1, updated_at: "2026-09-13T08:00:00Z" },
      { project_id: "project_a", stage_id: "narrative_plan", layer: "project_override", locked: false, revision: 1, updated_at: "2026-09-13T08:00:00Z" },
    ],
  });
  expect(
    canGenerateProposal(locked, { online: true, formDirty: false }, "improve", "template").allowed,
  ).toBe(false);
  expect(
    canGenerateProposal(locked, { online: true, formDirty: false }, "improve", "project_override").allowed,
  ).toBe(true);
});

test("queued proposal blocks a second generation", () => {
  const queued = promptProposalReducer(readyState(), {
    type: "proposal_loaded",
    proposal: { ...proposal, status: "queued" } as PromptProposalResource,
  });
  expect(canGenerateProposal(queued, { online: true, formDirty: false }).allowed).toBe(false);
});

test("improve hunks are toggled individually and never preselected", () => {
  const ready = promptProposalReducer(readyState(), { type: "proposal_loaded", proposal });
  expect(ready.selectedChangeIds).toEqual([]);

  const toggled = promptProposalReducer(ready, { type: "toggle_change", changeId: "change_abc" });
  expect(toggled.selectedChangeIds).toEqual(["change_abc"]);
  expect(canApplyProposal(toggled, { online: true, templateRevision: 1, bindingRevision: 1 }).allowed).toBe(true);
});

test("translate proposals apply whole and never expose hunks", () => {
  const translate = promptProposalReducer(readyState(), {
    type: "proposal_loaded",
    proposal: {
      ...proposal,
      kind: "translate",
      target_layers: ["template", "project_override"],
      target_language: "en-US",
      translated_template_body: "Translated",
    } as PromptProposalResource,
  });
  expect(canApplyProposal(translate, { online: true, templateRevision: 1, bindingRevision: 1 }).allowed).toBe(true);
});

test("stale source disables apply with a visible reason", () => {
  const ready = promptProposalReducer(readyState(), { type: "proposal_loaded", proposal });
  expect(
    canApplyProposal(ready, { online: true, templateRevision: 7, bindingRevision: 1 }).allowed,
  ).toBe(false);
  expect(
    canApplyProposal(ready, { online: true, templateRevision: 7, bindingRevision: 1 }).reason,
  ).toBe("source_changed");
});

test("offline blocks apply", () => {
  const ready = promptProposalReducer(readyState(), { type: "proposal_loaded", proposal });
  expect(canApplyProposal(ready, { online: false, templateRevision: 1, bindingRevision: 1 }).allowed).toBe(false);
});

test("terminal polling stops and failure keeps a safe code", () => {
  const queued = promptProposalReducer(readyState(), {
    type: "proposal_loaded",
    proposal: { ...proposal, status: "failed", failure_code: "provider_timeout" } as PromptProposalResource,
  });
  expect(queued.activeProposal?.status).toBe("failed");
  expect(queued.activeProposal?.failure_code).toBe("provider_timeout");
});

test("reject and supersede transitions update the active proposal", () => {
  const ready = promptProposalReducer(readyState(), { type: "proposal_loaded", proposal });
  const rejected = promptProposalReducer(ready, { type: "proposal_status_changed", status: "rejected" });
  expect(rejected.activeProposal?.status).toBe("rejected");
});


test("generate gate is operation- and target-aware", () => {
  const lockedTemplate = promptProposalReducer(readyState(), {
    type: "locks_loaded",
    locks: [
      { project_id: "project_a", stage_id: "narrative_plan", layer: "template", locked: true, revision: 1, updated_at: "2026-09-13T08:00:00Z" },
      { project_id: "project_a", stage_id: "narrative_plan", layer: "project_override", locked: false, revision: 1, updated_at: "2026-09-13T08:00:00Z" },
    ],
  });
  expect(
    canGenerateProposal(lockedTemplate, { online: true, formDirty: false }, "improve", "template").allowed,
  ).toBe(false);
  expect(
    canGenerateProposal(lockedTemplate, { online: true, formDirty: false }, "improve", "project_override").allowed,
  ).toBe(true);
});

test("capability gate is per-operation", () => {
  const improveOnly = promptProposalReducer(readyState(), {
    type: "providers_loaded",
    providers: [
      {
        provider_id: "novita",
        label: "Novita",
        enabled: true,
        models: [
          {
            model_id: "improve/model",
            label: "Improve only",
            capabilities: ["improve"] as Array<"improve" | "translate">,
            max_input_chars: 12000,
          },
        ],
      },
    ],
  });
  promptProposalReducer(improveOnly, {
    type: "select_provider",
    providerId: "novita",
    modelId: "improve/model",
  });
  const state = { ...improveOnly, selectedProviderId: "novita", selectedModelId: "improve/model" };
  expect(canGenerateProposal(state, { online: true, formDirty: false }, "improve", "template").allowed).toBe(true);
  expect(canGenerateProposal(state, { online: true, formDirty: false }, "translate", "template").allowed).toBe(false);
});

test("saved tuple syncs through the explicit action", () => {
  const synced = promptProposalReducer(readyState(), {
    type: "saved_revisions_changed",
    templateId: "ptpl_real",
    templateRevision: 5,
    bindingRevision: 3,
    overrideText: "Override",
  });
  expect(synced.savedTemplateId).toBe("ptpl_real");
  expect(synced.savedTemplateRevision).toBe(5);
  expect(synced.savedBindingRevision).toBe(3);
});

test("preference conflict keeps the latest returned resource", () => {
  const latest = {
    project_id: "project_a",
    stage_id: "narrative_plan",
    provider_id: "novita",
    model_id: "deepseek/deepseek-v3.1",
    revision: 9,
    updated_at: "2026-09-13T08:00:00Z",
  };
  const conflicted = promptProposalReducer(readyState(), {
    type: "preference_conflict",
    latest,
  });
  expect(conflicted.preference?.revision).toBe(9);
  expect(conflicted.lastError).toBe("preference_conflict");
});

test("lock_saved upserts the returned lock", () => {
  const saved = promptProposalReducer(readyState(), {
    type: "lock_saved",
    lock: { project_id: "project_a", stage_id: "narrative_plan", layer: "template", locked: true, revision: 4, updated_at: "2026-09-13T08:00:00Z" },
  });
  expect(saved.locks.find((lock) => lock.layer === "template")?.locked).toBe(true);
  expect(saved.locks.find((lock) => lock.layer === "template")?.revision).toBe(4);
});
