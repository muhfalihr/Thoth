import type {
  ProjectPromptBinding,
  PromptStageDefinition,
  PromptTemplateRevision,
  ResolvedPromptDraft,
} from "@/api/control-plane";

export type PromptLabSaveKind = "template" | "binding";

export type PromptLabStatus =
  | "loading"
  | "ready"
  | "dirty"
  | "saving"
  | "saved"
  | "failed"
  | "conflict"
  | "offline";

type StageFormSnapshot = {
  templateIdDraft: string | null;
  templateBaseRevision: number | null;
  templateBodyDraft: string;
  languageDraft: string;
  bindingBaseRevision: number | null;
  projectOverrideDraft: string;
};

export type PromptLabState = StageFormSnapshot & {
  stages: PromptStageDefinition[];
  selectedStageId: string;
  templates: PromptTemplateRevision[];
  binding: ProjectPromptBinding | null;
  resolved: ResolvedPromptDraft | null;
  stageForms: Record<string, StageFormSnapshot>;
  saveStatus: PromptLabStatus;
  isOffline: boolean;
  lastFailedSave: PromptLabSaveKind | null;
  latestTemplate: PromptTemplateRevision | null;
  latestBinding: ProjectPromptBinding | null;
};

export type PromptLabAction =
  | { type: "stages_loaded"; stages: PromptStageDefinition[] }
  | {
      type: "stage_data_loaded";
      templates: PromptTemplateRevision[];
      binding: ProjectPromptBinding | null;
    }
  | { type: "resolved_loaded"; resolved: ResolvedPromptDraft | null }
  | { type: "select_stage"; stageId: string }
  | { type: "select_template"; templateId: string }
  | { type: "new_template" }
  | { type: "edit_template_body"; value: string }
  | { type: "edit_language"; value: string }
  | { type: "edit_project_override"; value: string }
  | { type: "save_started"; kind: PromptLabSaveKind }
  | { type: "template_save_succeeded"; saved: PromptTemplateRevision }
  | { type: "template_save_conflicted"; latest: PromptTemplateRevision }
  | { type: "template_save_failed" }
  | { type: "binding_save_succeeded"; saved: ProjectPromptBinding }
  | { type: "binding_save_conflicted"; latest: ProjectPromptBinding }
  | { type: "binding_save_failed" }
  | { type: "retry_save" }
  | { type: "reload_latest" }
  | { type: "went_offline" }
  | { type: "went_online" };

const DEFAULT_LANGUAGE = "id-ID";

function snapshot(state: PromptLabState): StageFormSnapshot {
  return {
    templateIdDraft: state.templateIdDraft,
    templateBaseRevision: state.templateBaseRevision,
    templateBodyDraft: state.templateBodyDraft,
    languageDraft: state.languageDraft,
    bindingBaseRevision: state.bindingBaseRevision,
    projectOverrideDraft: state.projectOverrideDraft,
  };
}

function restore(snapshotValue: StageFormSnapshot | undefined): StageFormSnapshot {
  return (
    snapshotValue ?? {
      templateIdDraft: null,
      templateBaseRevision: null,
      templateBodyDraft: "",
      languageDraft: DEFAULT_LANGUAGE,
      bindingBaseRevision: null,
      projectOverrideDraft: "",
    }
  );
}

function statusAfterLocalChange(state: PromptLabState): PromptLabStatus {
  if (state.isOffline) return "offline";
  return state.saveStatus === "saving" ? "saving" : "dirty";
}

function statusAfterSettle(state: PromptLabState): PromptLabStatus {
  return state.isOffline ? "offline" : "saved";
}

export function createPromptLabState(input: {
  stages?: PromptStageDefinition[];
  selectedStageId: string;
  templates?: PromptTemplateRevision[];
  binding?: ProjectPromptBinding | null;
  resolved?: ResolvedPromptDraft | null;
}): PromptLabState {
  const templates = input.templates ?? [];
  const head = templates[0];
  return {
    stages: input.stages ?? [],
    selectedStageId: input.selectedStageId,
    templates,
    binding: input.binding ?? null,
    resolved: input.resolved ?? null,
    stageForms: {},
    templateIdDraft: head?.template_id ?? null,
    templateBaseRevision: head?.revision ?? null,
    templateBodyDraft: head?.body ?? "",
    languageDraft: head?.language ?? DEFAULT_LANGUAGE,
    bindingBaseRevision: input.binding?.revision ?? null,
    projectOverrideDraft: input.binding?.project_override ?? "",
    saveStatus:
      input.resolved !== undefined ? "saved" : input.binding !== undefined ? "ready" : "loading",
    isOffline: false,
    lastFailedSave: null,
    latestTemplate: null,
    latestBinding: null,
  };
}

export function promptLabReducer(state: PromptLabState, action: PromptLabAction): PromptLabState {
  switch (action.type) {
    case "stages_loaded":
      return { ...state, stages: action.stages };
    case "stage_data_loaded": {
      const pristine = state.stageForms[state.selectedStageId] === undefined;
      if (pristine) {
        const next = createPromptLabState({
          stages: state.stages,
          selectedStageId: state.selectedStageId,
          templates: action.templates,
          binding: action.binding,
          resolved: state.resolved,
        });
        return {
          ...next,
          isOffline: state.isOffline,
          saveStatus: state.isOffline ? "offline" : "ready",
        };
      }
      return {
        ...state,
        templates: action.templates,
        binding: action.binding,
        saveStatus: state.isOffline
          ? "offline"
          : state.saveStatus === "loading"
            ? "ready"
            : state.saveStatus,
      };
    }
    case "resolved_loaded":
      return { ...state, resolved: action.resolved };
    case "select_stage": {
      if (action.stageId === state.selectedStageId) return state;
      if (!state.stages.some((stage) => stage.stage_id === action.stageId)) return state;
      const restored = restore(state.stageForms[action.stageId]);
      return {
        ...state,
        ...restored,
        selectedStageId: action.stageId,
        stageForms: {
          ...state.stageForms,
          [state.selectedStageId]: snapshot(state),
        },
        templates: [],
        binding: null,
        resolved: null,
        saveStatus: "ready",
        lastFailedSave: null,
        latestTemplate: null,
        latestBinding: null,
      };
    }
    case "select_template": {
      const selected = state.templates.find((template) => template.template_id === action.templateId);
      if (!selected) return state;
      return {
        ...state,
        templateIdDraft: selected.template_id,
        templateBaseRevision: selected.revision,
        templateBodyDraft: selected.body,
        languageDraft: selected.language,
        saveStatus: statusAfterLocalChange(state),
      };
    }
    case "new_template":
      return {
        ...state,
        templateIdDraft: null,
        templateBaseRevision: null,
        templateBodyDraft: "",
        saveStatus: statusAfterLocalChange(state),
      };
    case "edit_template_body": {
      if (state.templateBodyDraft === action.value) return state;
      return { ...state, templateBodyDraft: action.value, saveStatus: statusAfterLocalChange(state) };
    }
    case "edit_language":
      if (state.languageDraft === action.value) return state;
      return { ...state, languageDraft: action.value, saveStatus: statusAfterLocalChange(state) };
    case "edit_project_override": {
      if (state.projectOverrideDraft === action.value) return state;
      return {
        ...state,
        projectOverrideDraft: action.value,
        saveStatus: statusAfterLocalChange(state),
      };
    }
    case "save_started":
      return { ...state, saveStatus: "saving", lastFailedSave: null };
    case "template_save_succeeded":
      return {
        ...state,
        templateIdDraft: action.saved.template_id,
        templateBaseRevision: action.saved.revision,
        latestTemplate: null,
        lastFailedSave: null,
        saveStatus: statusAfterSettle(state),
      };
    case "template_save_conflicted":
      return {
        ...state,
        saveStatus: "conflict",
        latestTemplate: action.latest,
      };
    case "template_save_failed":
      return { ...state, saveStatus: "failed", lastFailedSave: "template" };
    case "binding_save_succeeded":
      return {
        ...state,
        binding: action.saved,
        bindingBaseRevision: action.saved.revision,
        latestBinding: null,
        lastFailedSave: null,
        saveStatus: statusAfterSettle(state),
      };
    case "binding_save_conflicted":
      return {
        ...state,
        saveStatus: "conflict",
        latestBinding: action.latest,
      };
    case "binding_save_failed":
      return { ...state, saveStatus: "failed", lastFailedSave: "binding" };
    case "retry_save":
      return state.lastFailedSave && !state.isOffline
        ? { ...state, saveStatus: "dirty" }
        : state;
    case "reload_latest": {
      if (state.latestTemplate) {
        const latest = state.latestTemplate;
        return {
          ...state,
          templateIdDraft: latest.template_id,
          templateBaseRevision: latest.revision,
          templateBodyDraft: latest.body,
          languageDraft: latest.language,
          latestTemplate: null,
          saveStatus: statusAfterSettle(state),
        };
      }
      if (state.latestBinding) {
        const latest = state.latestBinding;
        return {
          ...state,
          binding: latest,
          bindingBaseRevision: latest.revision,
          projectOverrideDraft: latest.project_override ?? "",
          latestBinding: null,
          saveStatus: statusAfterSettle(state),
        };
      }
      return state;
    }
    case "went_offline":
      return {
        ...state,
        isOffline: true,
        saveStatus: state.saveStatus === "saving" ? "saving" : "offline",
      };
    case "went_online":
      return {
        ...state,
        isOffline: false,
        saveStatus: state.saveStatus === "offline" || state.saveStatus === "saved" ? "saved" : state.saveStatus,
      };
    default:
      return state;
  }
}
