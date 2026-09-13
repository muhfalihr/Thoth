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
  expect(switched.saveStatus).toBe("loading");

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
  expect(online.saveStatus).toBe("ready");
  expect(online.isOffline).toBe(false);
});

test("went_online is a no-op while already online", () => {
  const state = readyState();

  expect(promptLabReducer(state, { type: "went_online" })).toBe(state);
});

test("reconnecting with unsaved drafts reports the dirty status and keeps them", () => {
  const dirty = promptLabReducer(readyState(), {
    type: "edit_project_override",
    value: "Keep it concise",
  });
  const offline = promptLabReducer(dirty, { type: "went_offline" });
  expect(offline.saveStatus).toBe("offline");

  const online = promptLabReducer(offline, { type: "went_online" });

  expect(online.isOffline).toBe(false);
  expect(online.saveStatus).toBe("dirty");
  expect(online.projectOverrideDraft).toBe("Keep it concise");
});

test("reloaded stage data refreshes lists without clobbering unsaved drafts", () => {
  const dirty = promptLabReducer(readyState(), {
    type: "edit_project_override",
    value: "Keep it concise",
  });

  const reloaded = promptLabReducer(dirty, {
    type: "stage_data_loaded",
    templates: [{ ...template, revision: 5, body: "Remote body" }],
    binding: { ...binding, revision: 4, project_override: "Remote override" },
  });

  expect(reloaded.templates[0].revision).toBe(5);
  expect(reloaded.binding?.revision).toBe(4);
  expect(reloaded.projectOverrideDraft).toBe("Keep it concise");
  expect(reloaded.templateBodyDraft).toBe("Remote body");
  expect(reloaded.saveStatus).toBe("dirty");
});

test("reloaded stage data preserves drafts restored from a previous stage visit", () => {
  const dirty = promptLabReducer(readyState(), {
    type: "edit_project_override",
    value: "Keep it concise",
  });
  const away = promptLabReducer(dirty, { type: "select_stage", stageId: "visual_plan" });
  const back = promptLabReducer(away, { type: "select_stage", stageId: "narrative_plan" });

  const reloaded = promptLabReducer(back, {
    type: "stage_data_loaded",
    templates: [template],
    binding: { ...binding, revision: 4, project_override: "Remote override" },
  });

  expect(reloaded.projectOverrideDraft).toBe("Keep it concise");
});

test("reloaded stage data refreshes a clean draft restored from a previous stage visit", () => {
  const away = promptLabReducer(readyState(), { type: "select_stage", stageId: "visual_plan" });
  const back = promptLabReducer(away, { type: "select_stage", stageId: "narrative_plan" });

  const reloaded = promptLabReducer(back, {
    type: "stage_data_loaded",
    templates: [{ ...template, revision: 2, body: "Remote body" }],
    binding: { ...binding, revision: 2, project_override: "Remote override" },
  });

  expect(reloaded.templateBodyDraft).toBe("Remote body");
  expect(reloaded.projectOverrideDraft).toBe("Remote override");
  expect(reloaded.saveStatus).toBe("ready");
});

test("an unvisited stage loads its server draft after leaving a dirty stage", () => {
  const dirty = promptLabReducer(readyState(), {
    type: "edit_project_override",
    value: "Keep narrative concise",
  });
  const switched = promptLabReducer(dirty, {
    type: "select_stage",
    stageId: "visual_plan",
  });
  const visualTemplate = {
    ...template,
    template_id: "ptpl_visual",
    stage_id: "visual_plan" as const,
    body: "Plan the visuals",
  };
  const loaded = promptLabReducer(switched, {
    type: "stage_data_loaded",
    templates: [visualTemplate],
    binding: null,
  });

  expect(loaded.templateBodyDraft).toBe("Plan the visuals");
  expect(loaded.saveStatus).toBe("ready");

  const restored = promptLabReducer(loaded, {
    type: "select_stage",
    stageId: "narrative_plan",
  });
  expect(restored.projectOverrideDraft).toBe("Keep narrative concise");
  expect(restored.saveStatus).toBe("dirty");
});

test("registry fallback snapshots a removed dirty stage before selecting its replacement", () => {
  const dirty = promptLabReducer(readyState(), {
    type: "edit_template_body",
    value: "Local narrative draft",
  });

  const fallback = promptLabReducer(dirty, {
    type: "stages_loaded",
    stages: stages.filter((stage) => stage.stage_id !== "narrative_plan"),
  });

  expect(fallback.selectedStageId).toBe("visual_plan");
  expect(fallback.templateBodyDraft).toBe("");
  expect(fallback.templateDirty).toBe(false);
  expect(fallback.saveStatus).toBe("loading");
  expect(fallback.stageForms.narrative_plan.templateBodyDraft).toBe("Local narrative draft");
  expect(fallback.stageForms.narrative_plan.templateDirty).toBe(true);
});

test("registry fallback preserves a draft created before the first stage loaded", () => {
  const initial = createPromptLabState({ selectedStageId: "" });
  const offline = promptLabReducer(initial, { type: "went_offline" });
  const dirty = promptLabReducer(offline, {
    type: "edit_template_body",
    value: "Draft written before registry recovery",
  });
  const recovering = promptLabReducer(dirty, { type: "recovery_started" });

  const fallback = promptLabReducer(recovering, { type: "stages_loaded", stages });

  expect(fallback.selectedStageId).toBe("narrative_plan");
  expect(fallback.templateBodyDraft).toBe("Draft written before registry recovery");
  expect(fallback.templateDirty).toBe(true);
  expect(fallback.saveStatus).toBe("recovering");
});

test("stage reload refreshes a clean binding while preserving a dirty template", () => {
  const dirty = promptLabReducer(readyState(), {
    type: "edit_template_body",
    value: "Local template draft",
  });

  const reloaded = promptLabReducer(dirty, {
    type: "stage_data_loaded",
    templates: [{ ...template, revision: 2, body: "Remote template" }],
    binding: { ...binding, revision: 2, project_override: "Remote override" },
  });

  expect(reloaded.templateBodyDraft).toBe("Local template draft");
  expect(reloaded.templateBaseRevision).toBe(1);
  expect(reloaded.projectOverrideDraft).toBe("Remote override");
  expect(reloaded.bindingBaseRevision).toBe(2);
  expect(reloaded.saveStatus).toBe("dirty");
});

test("stage reload refreshes a clean template while preserving a dirty binding", () => {
  const dirty = promptLabReducer(readyState(), {
    type: "edit_project_override",
    value: "Local binding draft",
  });

  const reloaded = promptLabReducer(dirty, {
    type: "stage_data_loaded",
    templates: [{ ...template, revision: 2, body: "Remote template" }],
    binding: { ...binding, revision: 2, project_override: "Remote override" },
  });

  expect(reloaded.templateBodyDraft).toBe("Remote template");
  expect(reloaded.templateBaseRevision).toBe(2);
  expect(reloaded.projectOverrideDraft).toBe("Local binding draft");
  expect(reloaded.bindingBaseRevision).toBe(1);
  expect(reloaded.saveStatus).toBe("dirty");
});

test("stage reload preserves the dirty binding template target separately from the editor", () => {
  const alternate = {
    ...template,
    template_id: "ptpl_002",
    revision: 3,
    body: "Alternate template",
  };
  const state = createPromptLabState({
    stages,
    selectedStageId: "narrative_plan",
    templates: [template, alternate],
    binding,
    resolved,
  });
  const selected = promptLabReducer(state, {
    type: "select_template",
    templateId: alternate.template_id,
  });

  const reloaded = promptLabReducer(selected, {
    type: "stage_data_loaded",
    templates: [{ ...template, revision: 2, body: "Remote editor head" }],
    binding,
  });

  expect(reloaded.templateIdDraft).toBe("ptpl_001");
  expect(reloaded.templateBaseRevision).toBe(2);
  expect(reloaded.bindingTemplateIdDraft).toBe("ptpl_002");
  expect(reloaded.bindingTemplateRevisionDraft).toBe(3);
  expect(reloaded.bindingDirty).toBe(true);
});

test("editing while recovery is active keeps the recovering status", () => {
  const offline = promptLabReducer(readyState(), { type: "went_offline" });
  const recovering = promptLabReducer(offline, { type: "recovery_started" });
  const edited = promptLabReducer(recovering, {
    type: "edit_template_body",
    value: "Local edit during recovery",
  });

  expect(edited.saveStatus).toBe("recovering");
  expect(edited.isOffline).toBe(true);
  expect(edited.templateDirty).toBe(true);
});

test("saving a template does not make an unsaved binding draft reseedable", () => {
  const templateEdited = promptLabReducer(readyState(), {
    type: "edit_template_body",
    value: "Sharper hook",
  });
  const bothEdited = promptLabReducer(templateEdited, {
    type: "edit_project_override",
    value: "Keep local override",
  });
  const saved = promptLabReducer(bothEdited, {
    type: "template_save_succeeded",
    saved: { ...template, revision: 2, body: "Sharper hook" },
  });
  const reloaded = promptLabReducer(saved, {
    type: "stage_data_loaded",
    templates: [{ ...template, revision: 2, body: "Sharper hook" }],
    binding: { ...binding, revision: 2, project_override: "Remote override" },
  });

  expect(saved.saveStatus).toBe("dirty");
  expect(reloaded.projectOverrideDraft).toBe("Keep local override");
  expect(reloaded.saveStatus).toBe("dirty");
});

test("saving a binding does not make an unsaved template draft reseedable", () => {
  const templateEdited = promptLabReducer(readyState(), {
    type: "edit_template_body",
    value: "Keep local template",
  });
  const bothEdited = promptLabReducer(templateEdited, {
    type: "edit_project_override",
    value: "Saved override",
  });
  const saved = promptLabReducer(bothEdited, {
    type: "binding_save_succeeded",
    saved: { ...binding, revision: 2, project_override: "Saved override" },
  });
  const reloaded = promptLabReducer(saved, {
    type: "stage_data_loaded",
    templates: [{ ...template, revision: 2, body: "Remote template" }],
    binding: { ...binding, revision: 2, project_override: "Saved override" },
  });

  expect(saved.saveStatus).toBe("dirty");
  expect(reloaded.templateBodyDraft).toBe("Keep local template");
  expect(reloaded.saveStatus).toBe("dirty");
});

test("recovery remains offline until the reload succeeds", () => {
  const offline = promptLabReducer(readyState(), { type: "went_offline" });
  const recovering = promptLabReducer(offline, { type: "recovery_started" });

  expect(recovering.isOffline).toBe(true);
  expect(recovering.saveStatus).toBe("recovering");

  const online = promptLabReducer(recovering, { type: "went_online" });
  expect(online.isOffline).toBe(false);
  expect(online.saveStatus).toBe("ready");
});

test("a successful save lets a later reload reseed drafts cleanly", () => {
  const edited = promptLabReducer(readyState(), { type: "edit_template_body", value: "Saved body" });
  const started = promptLabReducer(edited, { type: "save_started", kind: "template" });
  const saved = promptLabReducer(started, {
    type: "template_save_succeeded",
    saved: { ...template, revision: 2, body: "Saved body" },
  });

  const reloaded = promptLabReducer(saved, {
    type: "stage_data_loaded",
    templates: [{ ...template, revision: 2, body: "Saved body" }],
    binding,
  });

  expect(reloaded.templateBodyDraft).toBe("Saved body");
  expect(reloaded.templateBaseRevision).toBe(2);
  expect(reloaded.saveStatus).toBe("ready");
});

test("new_template clears the draft for a fresh creation", () => {
  const fresh = promptLabReducer(readyState(), { type: "new_template" });

  expect(fresh.templateIdDraft).toBeNull();
  expect(fresh.templateBaseRevision).toBeNull();
  expect(fresh.templateBodyDraft).toBe("");
  expect(fresh.saveStatus).toBe("dirty");
});
