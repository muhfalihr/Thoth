// Shared C2 control-plane test fixtures/builder, extracted out of GuidedStudio.test.tsx and
// GuidedStudio.final-fix.test.tsx to stop the two files drifting out of sync with each other.
import { mock } from "bun:test";
import type {
  ProjectPromptBinding,
  PromptStageDefinition,
  PromptTemplateRevision,
  ResolvedPromptDraft,
} from "@/api/control-plane";

export const promptStage = {
  stage_id: "narrative_plan",
  label: "Narrative plan",
  status: "draft_only",
} satisfies PromptStageDefinition;

export const promptTemplate = {
  project_id: "project_001",
  template_id: "ptpl_001",
  revision: 1,
  stage_id: "narrative_plan",
  language: "id-ID",
  body: "Write a hook",
} satisfies PromptTemplateRevision;

export const promptBinding = {
  project_id: "project_001",
  stage_id: "narrative_plan",
  template_id: "ptpl_001",
  template_revision: 1,
  project_override: "Use Indonesian",
  revision: 1,
} satisfies ProjectPromptBinding;

export const promptResolved = {
  stage_id: "narrative_plan",
  sections: [{ kind: "template", label: "Template", text: "Write a hook" }],
  visible_text: "Template\nWrite a hook",
} satisfies ResolvedPromptDraft;

export const C2_PROVIDER = {
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

export const C2_FULL_PROPOSAL = {
  proposal_id: "proposal_1",
  project_id: "project_001",
  stage_id: "narrative_plan" as const,
  kind: "improve" as const,
  status: "queued" as const,
  target_layers: ["template"] as Array<"template" | "project_override">,
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
  started_at: null,
  finished_at: null,
};

// C2 (control-plane) mock methods only - callers add their own getEditDocument/patchEditDocument.
export function createC2ClientFixtureBase() {
  return {
    listPromptProviders: mock(async () => [C2_PROVIDER]),
    getPromptStarter: mock(async () => ({
      starter_id: "starter_v1",
      label: "Narrative plan starter",
      language: "id-ID",
      body: "Rencana narasi bawaan",
    })),
    getPromptPreference: mock(async () => null),
    savePromptPreference: mock(async () => ({
      kind: "saved" as const,
      value: {
        project_id: "project_001",
        stage_id: "narrative_plan" as const,
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
        project_id: "project_001",
        stage_id: "narrative_plan" as const,
        layer: "template" as const,
        locked: true,
        revision: 1,
        updated_at: "2026-09-13T08:00:00Z",
      },
    })),
    createPromptProposal: mock(async () => C2_FULL_PROPOSAL),
    listPromptProposals: mock(async () => ({ proposals: [], next_cursor: null })),
    getPromptProposal: mock(async () => C2_FULL_PROPOSAL),
    applyPromptProposal: mock(async () => ({
      proposal: C2_FULL_PROPOSAL,
      resulting_template_id: "ptpl_001",
      resulting_template_revision: 2,
      resulting_binding_revision: 2,
    })),
    rejectPromptProposal: mock(async () => ({ ...C2_FULL_PROPOSAL, status: "rejected" as const })),
    listPromptStages: mock(async () => [promptStage]),
    listPromptTemplates: mock(async () => [promptTemplate]),
    savePromptTemplate: mock(async () => ({ kind: "saved" as const, value: promptTemplate })),
    getPromptBinding: mock(async () => promptBinding),
    savePromptBinding: mock(async () => ({ kind: "saved" as const, value: promptBinding })),
    getResolvedPrompt: mock(async () => promptResolved),
  };
}
