/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompactStudioNav } from "./CompactStudioNav";

afterEach(cleanup);

const panes = [
  { id: "preview", label: "Preview" },
  { id: "edit", label: "Edit" },
  { id: "renders", label: "Renders" },
] as const;

test("labels every pane and marks only the selected one current", () => {
  render(<CompactStudioNav panes={panes} selected="edit" onSelect={() => {}} />);

  const nav = screen.getByRole("navigation", { name: "Studio panes" });
  const buttons = screen.getAllByRole("button");
  expect(buttons.map((button) => button.textContent)).toEqual(["Preview", "Edit", "Renders"]);
  expect(nav.contains(buttons[0]!)).toBe(true);
  expect(screen.getByRole("button", { name: "Edit" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "Preview" }).hasAttribute("aria-current")).toBe(false);
  for (const button of buttons) {
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toContain("focus-visible:");
  }
});

test("selects a pane from the keyboard", async () => {
  const onSelect = mock();
  render(<CompactStudioNav panes={panes} selected="preview" onSelect={onSelect} />);

  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Preview" }));
  await userEvent.tab();
  await userEvent.keyboard("{Enter}");
  await userEvent.tab();
  await userEvent.keyboard(" ");

  expect(onSelect.mock.calls).toEqual([["edit"], ["renders"]]);
});
