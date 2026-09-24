/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StudioJobNav } from "./StudioJobNav";
import type { StudioJob } from "./studio_viewport";

afterEach(cleanup);

test("names the four jobs and marks only the selected one current", () => {
  const onSelect = mock((_job: StudioJob) => {});
  render(<StudioJobNav selected="edit" onSelect={onSelect} />);

  const nav = screen.getByRole("navigation", { name: "Studio jobs" });
  const buttons = within(nav).getAllByRole("button");
  expect(buttons.map((button) => button.textContent)).toEqual(["Edit", "Prompt", "Review", "Render"]);
  expect(buttons.filter((button) => button.getAttribute("aria-current") === "page").map((button) => button.textContent)).toEqual(["Edit"]);
  for (const button of buttons) {
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toContain("focus-visible:");
  }

  fireEvent.click(within(nav).getByRole("button", { name: "Render" }));
  expect(onSelect).toHaveBeenCalledWith("render");
});

test("selects a job from the keyboard", async () => {
  const onSelect = mock((_job: StudioJob) => {});
  render(<StudioJobNav selected="edit" onSelect={onSelect} />);

  await userEvent.tab();
  expect(document.activeElement === screen.getByRole("button", { name: "Edit" })).toBe(true);
  await userEvent.tab();
  await userEvent.keyboard("{Enter}");
  await userEvent.tab();
  await userEvent.keyboard(" ");

  expect(onSelect.mock.calls).toEqual([["prompt"], ["review"]]);
});
