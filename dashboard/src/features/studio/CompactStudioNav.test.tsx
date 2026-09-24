/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompactStudioNav } from "./CompactStudioNav";

afterEach(cleanup);

const panes = [
  { id: "scenes", label: "Scenes" },
  { id: "preview", label: "Preview" },
  { id: "controls", label: "Controls" },
] as const;

test("labels every pane and marks only the selected one current", () => {
  render(<CompactStudioNav panes={panes} selected="controls" onSelect={() => {}} />);

  const nav = screen.getByRole("navigation", { name: "Studio panes" });
  const buttons = screen.getAllByRole("button");
  expect(buttons.map((button) => button.textContent)).toEqual(["Scenes", "Preview", "Controls"]);
  expect(nav.contains(buttons[0]!)).toBe(true);
  expect(screen.getByRole("button", { name: "Controls" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "Preview" }).hasAttribute("aria-current")).toBe(false);
  for (const button of buttons) {
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toContain("focus-visible:");
  }
});

test("selects a pane from the keyboard", async () => {
  const onSelect = mock();
  render(<CompactStudioNav panes={panes} selected="scenes" onSelect={onSelect} />);

  await userEvent.tab();
  expect(document.activeElement === screen.getByRole("button", { name: "Scenes" })).toBe(true);
  await userEvent.tab();
  await userEvent.keyboard("{Enter}");
  await userEvent.tab();
  await userEvent.keyboard(" ");

  expect(onSelect.mock.calls).toEqual([["preview"], ["controls"]]);
});
