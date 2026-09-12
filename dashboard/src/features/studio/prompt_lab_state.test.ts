/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import type {
  ProjectPromptBinding,
  PromptStageDefinition,
  PromptTemplateRevision,
  ResolvedPromptDraft,
} from "@/api/control-plane";
import { createPromptLabState, promptLabReducer } from "./prompt_lab_state";

const stages = [
  { stage_id: "narrative_plan", label: "Narrative plan", status: "draft_only" },
  { stage_id: "visual_plan", label: "Visual plan", status: "draft_only" },
  { stage_id: "caption_copy", label: "Caption and copy", status: "draft_only" },
] satisfies PromptStageDefinition[];

const template = {
  project_id: "project_a",
  template_id: "ptpl_001",
  revision: 1,
  stage_id: "narrative_plan",
  language: "id-ID",
  body: "Write a hook",
} satisfies PromptTemplateRevision;

const binding = {
  project_id: "project_a",
  stage_id: "narrative_plan",
  template_id: "ptpl_001",
  template_revision: 1,
  project_override: "Use Indonesian",
  revision: 1,
} satisfies ProjectPromptBinding;

const resolved = {
  stage_id: "narrative_plan",
  sections: [{ kind: "template", label: "Template", text: "Write a hook" }],
  visible_text: "Template\nWrite a hook",
} satisfies ResolvedPromptDraft;

function readyState() {
  return createPromptLabState({
    stages,
    selectedStageId: "narrative_plan",
    templates: [template],
    binding,
    resolved,
  });
}

test("starts ready with the loaded registry, drafts, and base revisions", () => {
  const state = readyState();

  expect(state.stages).toEqual(stages);
  expect(state.selectedStageId).toBe("narrative_plan");
  expect(state.templateBodyDraft).toBe("Write a hook");
  expect(state.projectOverrideDraft).toBe("Use Indonesian");
  expect(state.languageDraft).toBe("id-ID");
  expect(state.templateBaseRevision).toBe(1);
  expect(state.bindingBaseRevision).toBe(1);
  expect(state.saveStatus).toBe("saved");
  expect(state.resolved).toEqual(resolved);
});

test("editing template and override drafts marks the state dirty", () => {
  const body = promptLabReducer(readyState(), {
    type: "edit_template_body",
    value: "Write a sharper hook",
  });
  expect(body.saveStatus).toBe("dirty");
  expect(body.templateBodyDraft).toBe("Write a sharper hook");

  const dirty = promptLabReducer(readyState(), {
    type: "edit_project_override",
    value: "Use conversational Indonesian",
  });
  expect(dirty.saveStatus).toBe("dirty");
  expect(dirty.projectOverrideDraft).toBe("Use conversational Indonesian");
});

test("selecting a template head loads its body and rebases the draft", () => {
  const newer = { ...template, revision: 3, body: "Newest hook" };
  const state = createPromptLabState({
    stages,
    selectedStageId: "narrative_plan",
    templates: [newer],
    binding: null,
    resolved: null,
  });

  const selected = promptLabReducer(state, { type: "select_template", templateId: newer.template_id });

  expect(selected.templateBodyDraft).toBe("Newest hook");
  expect(selected.languageDraft).toBe("id-ID");
  expect(selected.templateBaseRevision).toBe(3);
});

test("a successful template save rebases the base revision without touching drafts", () => {
  const dirty = promptLabReducer(readyState(), { type: "edit_template_body", value: "Sharper hook" });
  const started = promptLabReducer(dirty, { type: "save_started", kind: "template" });

  expect(started.saveStatus).toBe("saving");

  const saved = promptLabReducer(started, {
    type: "template_save_succeeded",
    saved: { ...template, revision: 2, body: "Sharper hook" },
  });

  expect(saved.saveStatus).toBe("saved");
  expect(saved.templateBaseRevision).toBe(2);
  expect(saved.templateBodyDraft).toBe("Sharper hook");
});

test("a failed save preserves draft text and reports the failure", () => {
  const dirty = promptLabReducer(readyState(), {
    type: "edit_project_override",
    value: "Use conversational Indonesian",
  });
  const started = promptLabReducer(dirty, { type: "save_started", kind: "binding" });
  const failed = promptLabReducer(started, { type: "binding_save_failed" });

  expect(failed.projectOverrideDraft).toBe("Use conversational Indonesian");
  expect(failed.saveStatus).toBe("failed");
  expect(failed.lastFailedSave).toBe("binding");

  expect(promptLabReducer(failed, { type: "retry_save" }).saveStatus).toBe("dirty");
});

test("a template conflict preserves the draft until reload_latest adopts the latest", () => {
  const latest = { ...template, revision: 4, body: "Remote body" };
  const dirty = promptLabReducer(readyState(), { type: "edit_template_body", value: "Local body" });
  const conflicted = promptLabReducer(dirty, {
    type: "template_save_conflicted",
    latest,
  });

  expect(conflicted.saveStatus).toBe("conflict");
  expect(conflicted.templateBodyDraft).toBe("Local body");

  const reloaded = promptLabReducer(conflicted, { type: "reload_latest" });

  expect(reloaded.templateBodyDraft).toBe("Remote body");
  expect(reloaded.templateBaseRevision).toBe(4);
  expect(reloaded.saveStatus).toBe("saved");
});

test("a binding conflict preserves the override draft until reload_latest", () => {
  const latest = { ...binding, revision: 5, project_override: "Remote override" };
  const dirty = promptLabReducer(readyState(), {
    type: "edit_project_override",
    value: "Local override",
  });
  const conflicted = promptLabReducer(dirty, { type: "binding_save_conflicted", latest });

  expect(conflicted.saveStatus).toBe("conflict");
  expect(conflicted.projectOverrideDraft).toBe("Local override");

  const reloaded = promptLabReducer(conflicted, { type: "reload_latest" });

  expect(reloaded.projectOverrideDraft).toBe("Remote override");
  expect(reloaded.bindingBaseRevision).toBe(5);
  expect(reloaded.saveStatus).toBe("saved");
});

test("a successful binding save rebases the binding revision", () => {
  const dirty = promptLabReducer(readyState(), {
    type: "edit_project_override",
    value: "Use conversational Indonesian",
  });
  const started = promptLabReducer(dirty, { type: "save_started", kind: "binding" });
  const saved = promptLabReducer(started, {
    type: "binding_save_succeeded",
    saved: { ...binding, revision: 2, project_override: "Use conversational Indonesian" },
  });

  expect(saved.saveStatus).toBe("saved");
  expect(saved.bindingBaseRevision).toBe(2);
  expect(saved.binding?.revision).toBe(2);
});

test("stage switches preserve per-stage form state", () => {
  const dirty = promptLabReducer(readyState(), {
    type: "edit_project_override",
    value: "Keep it concise",
  });
  const switched = promptLabReducer(dirty, { type: "select_stage", stageId: "visual_plan" });

  expect(switched.selectedStageId).toBe("visual_plan");
  expect(switched.projectOverrideDraft).toBe("");
  expect(switched.saveStatus).toBe("ready");

  const back = promptLabReducer(switched, { type: "select_stage", stageId: "narrative_plan" });

  expect(back.selectedStageId).toBe("narrative_plan");
  expect(back.projectOverrideDraft).toBe("Keep it concise");
  expect(back.templateBodyDraft).toBe("Write a hook");
});

test("offline state is explicit and reconnect returns to the dirty status", () => {
  const offline = promptLabReducer(readyState(), { type: "went_offline" });
  expect(offline.saveStatus).toBe("offline");
  expect(offline.isOffline).toBe(true);

  const online = promptLabReducer(offline, { type: "went_online" });
  expect(online.saveStatus).toBe("saved");
  expect(online.isOffline).toBe(false);
});

test("new_template clears the draft for a fresh creation", () => {
  const fresh = promptLabReducer(readyState(), { type: "new_template" });

  expect(fresh.templateIdDraft).toBeNull();
  expect(fresh.templateBaseRevision).toBeNull();
  expect(fresh.templateBodyDraft).toBe("");
  expect(fresh.saveStatus).toBe("dirty");
});
