/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { WorkflowWizard } from "./WorkflowWizard";

afterEach(cleanup);

test("starts a workflow from source and style without Scout executor controls", async () => {
  const user = userEvent.setup();
  const fakeClient = {
    listStylePresets: mock(async () => [
      { preset_id: "news-vertical", label: "News vertical", description: "Fast-paced" },
    ]),
    createWorkflow: mock(async () => ({ workflow_id: "wf_001", status: "queued" })),
  };
  render(<WorkflowWizard client={fakeClient} onStarted={() => {}} />);

  await user.type(screen.getByLabelText("Source URL"), "https://example.test/post/1");
  await user.selectOptions(await screen.findByLabelText("Style"), "news-vertical");
  await user.click(screen.getByRole("button", { name: "Start workflow" }));

  expect(fakeClient.createWorkflow).toHaveBeenCalledWith(expect.objectContaining({
    source: { url: "https://example.test/post/1", intent: "produce_video" },
  }));
  expect(screen.queryByLabelText(/max clips|cap|raw log/i)).toBeNull();
});
