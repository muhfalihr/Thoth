/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";import type {
  ProjectPromptBinding,
  PromptStageDefinition,
  PromptTemplateRevision,
  ResolvedPromptDraft,
} from "@/api/control-plane";
import type { PromptLabClient } from "./PromptLab";

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

function client(overrides: Partial<PromptLabClient> = {}): PromptLabClient {
  return {
    listPromptStages: mock(async () => stages),
    listPromptTemplates: mock(async () => [template]),
    savePromptTemplate: mock(async () => ({ kind: "saved" as const, value: template })),
    getPromptBinding: mock(async () => binding),
    savePromptBinding: mock(async () => ({ kind: "saved" as const, value: binding })),
    getResolvedPrompt: mock(async () => resolved),
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

test("renders stage buttons, template list, and labelled editor controls", async () => {
  const { PromptLab } = await import("./PromptLab");
  render(<PromptLab client={client()} projectId="project_a" />);

  for (const stage of stages) {
    expect(await screen.findByRole("button", { name: stage.label })).toBeDefined();
  }
  expect(await screen.findByLabelText("Prompt templates")).toBeDefined();
  expect(screen.getByLabelText("Language")).toBeDefined();
  expect(screen.getByLabelText("Template body")).toBeDefined();
  expect(screen.getByLabelText("Project override")).toBeDefined();
  expect((screen.getByLabelText("Template body") as HTMLTextAreaElement).value).toBe("Write a hook");
  expect((screen.getByLabelText("Project override") as HTMLTextAreaElement).value).toBe("Use Indonesian");
  expect(screen.getByLabelText("Resolved prompt preview").textContent).toContain("Write a hook");
});

test("renders the resolved preview as escaped plain text", async () => {
  const { PromptLab } = await import("./PromptLab");
  const hostile = {
    ...resolved,
    visible_text: "Template\n<b>plain text</b>",
  } satisfies ResolvedPromptDraft;
  render(<PromptLab client={client({ getResolvedPrompt: mock(async () => hostile) })} projectId="project_a" />);

  const preview = await screen.findByLabelText("Resolved prompt preview");
  expect(preview.textContent).toContain("<b>plain text</b>");
  expect(document.querySelector("b")).toBeNull();
});

test("keeps Improve and Translate disabled with an explicit unavailable explanation", async () => {
  const { PromptLab } = await import("./PromptLab");
  const promptClient = client();
  render(<PromptLab client={promptClient} projectId="project_a" />);

  await screen.findByLabelText("Resolved prompt preview");
  const improve = screen.getByRole("button", { name: "Improve" }) as HTMLButtonElement;
  const translate = screen.getByRole("button", { name: "Translate" }) as HTMLButtonElement;
  expect(improve.disabled).toBe(true);
  expect(translate.disabled).toBe(true);
  expect(screen.getByText("Provider-backed proposals are not available yet.")).not.toBeNull();

  fireEvent.click(improve);
  fireEvent.click(translate);
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect((promptClient.savePromptTemplate as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((promptClient.savePromptBinding as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((promptClient.getResolvedPrompt as ReturnType<typeof mock>).mock.calls.length).toBe(1);
});

test("saves a template revision and reports Saving then Saved", async () => {
  const { PromptLab } = await import("./PromptLab");
  const user = userEvent.setup();
  const savedTemplate = { ...template, revision: 2, body: "Sharper hook" };
  let captured: unknown = null;
  const promptClient = client({
    savePromptTemplate: mock(async (_projectId, request) => {
      captured = request;
      return { kind: "saved" as const, value: savedTemplate };
    }),
  });
  render(<PromptLab client={promptClient} projectId="project_a" />);

  const body = await screen.findByDisplayValue("Write a hook");
  fireEvent.change(body, { target: { value: "Sharper hook" } });
  await user.click(screen.getByRole("button", { name: "Save template" }));

  expect(await screen.findByText("Saved")).toBeDefined();
  expect(screen.queryByText("Failed")).toBeNull();
  expect(captured).toEqual({
    stage_id: "narrative_plan",
    language: "id-ID",
    body: "Sharper hook",
    template_id: "ptpl_001",
    base_revision: 1,
  });
});

test("keeps draft text on failure and retries the same save", async () => {
  const { PromptLab } = await import("./PromptLab");
  const user = userEvent.setup();
  let calls = 0;
  const promptClient = client({
    savePromptTemplate: mock(async () => {
      calls += 1;
      if (calls === 1) throw new Error("database unavailable");
      return { kind: "saved" as const, value: { ...template, revision: 2 } };
    }),
  });
  render(<PromptLab client={promptClient} projectId="project_a" />);

  const body = await screen.findByLabelText("Template body");
  await user.type(body, "Sharper hook");
  await user.click(screen.getByRole("button", { name: "Save template" }));

  expect(await screen.findByText("Failed")).toBeDefined();
  expect((screen.getByLabelText("Template body") as HTMLTextAreaElement).value).toContain("Sharper hook");

  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Saved")).toBeDefined();
  expect(calls).toBe(2);
});

test("preserves the local draft on a template conflict and reloads latest on demand", async () => {
  const { PromptLab } = await import("./PromptLab");
  const user = userEvent.setup();
  const latest = { ...template, revision: 4, body: "Remote body" };
  const promptClient = client({
    savePromptTemplate: mock(async () => ({ kind: "conflict" as const, latest })),
  });
  render(<PromptLab client={promptClient} projectId="project_a" />);

  const body = await screen.findByLabelText("Template body");
  await user.type(body, "Local body");
  await user.click(screen.getByRole("button", { name: "Save template" }));

  expect(await screen.findByText("Conflict")).toBeDefined();
  expect((screen.getByLabelText("Template body") as HTMLTextAreaElement).value).toContain("Local body");

  await user.click(screen.getByRole("button", { name: "Reload Latest" }));
  expect((screen.getByLabelText("Template body") as HTMLTextAreaElement).value).toBe("Remote body");
  expect(await screen.findByText("Saved")).toBeDefined();
});

test("saves the project override through the binding endpoint", async () => {
  const { PromptLab } = await import("./PromptLab");
  const user = userEvent.setup();
  let captured: unknown = null;
  const promptClient = client({
    savePromptBinding: mock(async (_projectId, stageId, request) => {
      captured = { stageId, request };
      return {
        kind: "saved" as const,
        value: { ...binding, revision: 2, project_override: "Use conversational Indonesian" },
      };
    }),
  });
  render(<PromptLab client={promptClient} projectId="project_a" />);

  const override = await screen.findByLabelText("Project override");
  fireEvent.change(override, { target: { value: "Use conversational Indonesian" } });
  await user.click(screen.getByRole("button", { name: "Save binding" }));

  expect(await screen.findByText("Saved")).toBeDefined();
  expect(captured).toEqual({
    stageId: "narrative_plan",
    request: {
      template_id: "ptpl_001",
      template_revision: 1,
      project_override: "Use conversational Indonesian",
      base_revision: 1,
    },
  });
});

test("shows an explicit empty state with Create binding when no binding exists", async () => {
  const { PromptLab } = await import("./PromptLab");
  const user = userEvent.setup();
  const promptClient = client({
    getPromptBinding: mock(async () => null),
    getResolvedPrompt: mock(async () => {
      throw new Error("Control plane request failed (404)");
    }),
    savePromptBinding: mock(async () => ({ kind: "saved" as const, value: binding })),
  });
  render(<PromptLab client={promptClient} projectId="project_a" />);

  expect(await screen.findByText("No binding for this stage yet.")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Create binding" }));

  expect((promptClient.savePromptBinding as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  expect(await screen.findByText("Saved")).toBeDefined();
});

test("switching stages loads that stage's templates and binding", async () => {
  const { PromptLab } = await import("./PromptLab");
  const user = userEvent.setup();
  const promptClient = client({
    listPromptTemplates: mock(
      async (_projectId, stageId): Promise<PromptTemplateRevision[]> =>
        stageId === "caption_copy"
          ? [{ ...template, stage_id: "caption_copy", body: "Caption rules" }]
          : [template],
    ),
  });
  render(<PromptLab client={promptClient} projectId="project_a" />);

  await user.click(await screen.findByRole("button", { name: "Caption and copy" }));

  expect(await screen.findByLabelText("Template body")).toBeDefined();
  expect(
    (promptClient.listPromptTemplates as ReturnType<typeof mock>).mock.calls.some(
      (call) => call[1] === "caption_copy",
    ),
  ).toBe(true);
});

test("shows the safe offline state when the initial registry load fails", async () => {
  const { PromptLab } = await import("./PromptLab");
  const promptClient = client({
    listPromptStages: mock(async () => {
      throw new Error("registry unavailable");
    }),
  });
  render(<PromptLab client={promptClient} projectId="project_a" />);

  expect(
    await screen.findByText(
      "Offline. Your prompt drafts are still here and will save when the connection returns.",
    ),
  ).toBeDefined();
});

test("retry preserves a draft written before the initial registry recovered", async () => {
  const { PromptLab } = await import("./PromptLab");
  const user = userEvent.setup();
  let registryCalls = 0;
  const promptClient = client({
    listPromptStages: mock(async () => {
      registryCalls += 1;
      if (registryCalls === 1) throw new Error("registry unavailable");
      return stages;
    }),
  });

  render(<PromptLab client={promptClient} projectId="project_a" />);

  await screen.findByText(
    "Offline. Your prompt drafts are still here and will save when the connection returns.",
  );
  fireEvent.change(screen.getByLabelText("Template body"), {
    target: { value: "Draft written before registry recovery" },
  });
  await user.click(screen.getByRole("button", { name: "Retry" }));

  expect(await screen.findByDisplayValue("Draft written before registry recovery")).toBeDefined();
  expect(screen.getByText("Unsaved changes")).toBeDefined();
});

test("retries the load from the offline state and preserves unsaved drafts", async () => {
  const { PromptLab } = await import("./PromptLab");
  const user = userEvent.setup();
  const promptClient = client();
  render(<PromptLab client={promptClient} projectId="project_a" />);
  const override = (await screen.findByLabelText("Project override")) as HTMLTextAreaElement;
  fireEvent.change(override, { target: { value: "Keep it concise" } });

  promptClient.listPromptTemplates = mock(async () => {
    throw new Error("stage data unavailable");
  });
  act(() => {
    window.dispatchEvent(new Event("offline"));
  });
  expect(
    await screen.findByText(
      "Offline. Your prompt drafts are still here and will save when the connection returns.",
    ),
  ).toBeDefined();

  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  await screen.findByText(
    "Offline. Your prompt drafts are still here and will save when the connection returns.",
    {},
    { timeout: 1_000 },
  );

  promptClient.listPromptTemplates = mock(async () => [template]);
  await user.click(screen.getByRole("button", { name: "Retry" }));

  expect(
    ((await screen.findByLabelText("Project override")) as HTMLTextAreaElement).value,
  ).toBe("Keep it concise");
  expect(
    (promptClient.listPromptStages as ReturnType<typeof mock>).mock.calls.length,
  ).toBeGreaterThanOrEqual(2);
  expect(screen.getByText("Unsaved changes")).toBeDefined();
  expect(
    (screen.getByRole("button", { name: "Save binding" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

test("reloads the registry and stage data when the browser reports online", async () => {
  const { PromptLab } = await import("./PromptLab");
  const promptClient = client();
  render(<PromptLab client={promptClient} projectId="project_a" />);
  await screen.findByLabelText("Template body");
  const stagesBefore = (promptClient.listPromptStages as ReturnType<typeof mock>).mock.calls.length;
  const templatesBefore = (promptClient.listPromptTemplates as ReturnType<typeof mock>).mock.calls
    .length;

  act(() => {
    window.dispatchEvent(new Event("offline"));
  });
  await screen.findByText(
    "Offline. Your prompt drafts are still here and will save when the connection returns.",
  );

  act(() => {
    window.dispatchEvent(new Event("online"));
  });

  expect(await screen.findByText("Ready")).toBeDefined();
  expect((promptClient.listPromptStages as ReturnType<typeof mock>).mock.calls.length).toBe(
    stagesBefore + 1,
  );
  expect((promptClient.listPromptTemplates as ReturnType<typeof mock>).mock.calls.length).toBe(
    templatesBefore + 1,
  );
});

test("keeps recovery offline and saves disabled until reload succeeds", async () => {
  const { PromptLab } = await import("./PromptLab");
  const registryReload = deferred<PromptStageDefinition[]>();
  const promptClient = client();

  render(<PromptLab client={promptClient} projectId="project_a" />);

  await screen.findByDisplayValue("Write a hook");
  promptClient.listPromptStages = mock(() => registryReload.promise);

  act(() => {
    window.dispatchEvent(new Event("offline"));
  });
  act(() => {
    window.dispatchEvent(new Event("online"));
  });

  expect(screen.getByText("Reconnecting")).toBeDefined();
  expect(screen.queryByText("Saved")).toBeNull();
  expect((screen.getByRole("button", { name: "Save template" }) as HTMLButtonElement).disabled).toBe(
    true,
  );

  await act(async () => {
    registryReload.resolve(stages);
    await registryReload.promise;
  });

  expect(await screen.findByText("Ready")).toBeDefined();
  expect((screen.getByRole("button", { name: "Save template" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

test("recovery from an initial registry failure owns the selected-stage load", async () => {
  const { PromptLab } = await import("./PromptLab");
  const user = userEvent.setup();
  let registryCalls = 0;
  const listPromptTemplates = mock(async () => [template]);
  const getPromptBinding = mock(async () => binding);
  const promptClient = client({
    listPromptStages: mock(async () => {
      registryCalls += 1;
      if (registryCalls === 1) throw new Error("registry unavailable");
      return stages;
    }),
    listPromptTemplates,
    getPromptBinding,
  });

  render(<PromptLab client={promptClient} projectId="project_a" />);

  await screen.findByText(
    "Offline. Your prompt drafts are still here and will save when the connection returns.",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));

  expect(await screen.findByDisplayValue("Write a hook")).toBeDefined();
  expect(listPromptTemplates.mock.calls.length).toBe(1);
  expect(getPromptBinding.mock.calls.length).toBe(1);
});

test("recovery ignores an older selected-stage load that finishes later", async () => {
  const { PromptLab } = await import("./PromptLab");
  const staleTemplates = deferred<PromptTemplateRevision[]>();
  const freshTemplate = { ...template, revision: 2, body: "Fresh recovery body" };
  let templateCalls = 0;
  const listPromptTemplates = mock(() => {
    templateCalls += 1;
    return templateCalls === 1 ? staleTemplates.promise : Promise.resolve([freshTemplate]);
  });
  const promptClient = client({ listPromptTemplates });

  render(<PromptLab client={promptClient} projectId="project_a" />);

  await screen.findByRole("button", { name: "Narrative plan" });
  expect(listPromptTemplates.mock.calls.length).toBe(1);
  act(() => window.dispatchEvent(new Event("offline")));
  act(() => window.dispatchEvent(new Event("online")));

  expect(await screen.findByDisplayValue("Fresh recovery body")).toBeDefined();

  await act(async () => {
    staleTemplates.resolve([template]);
    await staleTemplates.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect((screen.getByLabelText("Template body") as HTMLTextAreaElement).value).toBe(
    "Fresh recovery body",
  );
  expect(listPromptTemplates.mock.calls.length).toBe(2);
});

test("recovery keeps a dirty binding template target separate from the refreshed editor", async () => {
  const { PromptLab } = await import("./PromptLab");
  const user = userEvent.setup();
  const alternate = {
    ...template,
    template_id: "ptpl_002",
    revision: 3,
    body: "Alternate template",
  };
  let templateResponse = [template, alternate];
  let captured: unknown = null;
  const promptClient = client({
    listPromptTemplates: mock(async () => templateResponse),
    savePromptBinding: mock(async (_projectId, _stageId, request) => {
      captured = request;
      return {
        kind: "saved" as const,
        value: {
          ...binding,
          template_id: alternate.template_id,
          template_revision: alternate.revision,
          revision: 2,
        },
      };
    }),
  });

  render(<PromptLab client={promptClient} projectId="project_a" />);

  await user.click(await screen.findByRole("button", { name: "ptpl_002 (revision 3)" }));
  templateResponse = [{ ...template, revision: 2, body: "Remote editor head" }];
  act(() => window.dispatchEvent(new Event("offline")));
  act(() => window.dispatchEvent(new Event("online")));

  expect(await screen.findByDisplayValue("Remote editor head")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Save binding" }));

  expect(captured).toMatchObject({
    template_id: "ptpl_002",
    template_revision: 3,
  });
});

test("editing during deferred recovery cannot switch the stage or lose the draft", async () => {
  const { PromptLab } = await import("./PromptLab");
  const registryReload = deferred<PromptStageDefinition[]>();
  const promptClient = client();

  render(<PromptLab client={promptClient} projectId="project_a" />);

  const body = (await screen.findByDisplayValue("Write a hook")) as HTMLTextAreaElement;
  promptClient.listPromptStages = mock(() => registryReload.promise);
  act(() => window.dispatchEvent(new Event("offline")));
  act(() => window.dispatchEvent(new Event("online")));
  fireEvent.change(body, { target: { value: "Local edit during recovery" } });

  expect(screen.getByText("Reconnecting")).toBeDefined();
  const visualStage = screen.getByRole("button", { name: "Visual plan" }) as HTMLButtonElement;
  expect(visualStage.disabled).toBe(true);
  fireEvent.click(visualStage);
  expect(screen.getByRole("button", { name: "Narrative plan" }).getAttribute("aria-pressed")).toBe(
    "true",
  );

  await act(async () => {
    registryReload.resolve(stages);
    await registryReload.promise;
  });

  expect((await screen.findByLabelText("Template body") as HTMLTextAreaElement).value).toBe(
    "Local edit during recovery",
  );
  expect(screen.getByText("Unsaved changes")).toBeDefined();
});

test("removes the offline listeners on unmount", async () => {
  const { PromptLab } = await import("./PromptLab");
  const promptClient = client();
  const { unmount } = render(<PromptLab client={promptClient} projectId="project_a" />);
  await screen.findByLabelText("Template body");
  const callsBefore = (promptClient.listPromptStages as ReturnType<typeof mock>).mock.calls.length;

  unmount();
  act(() => {
    window.dispatchEvent(new Event("offline"));
  });
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect((promptClient.listPromptStages as ReturnType<typeof mock>).mock.calls.length).toBe(
    callsBefore,
  );
});
