/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { terminalEventIsFailure, terminalEventKind } from "./job-events";

test("cancelled is terminal and is not a failure", () => {
  const terminal = terminalEventKind("cancelled");

  expect(terminal).toBe("cancelled");
  expect(terminalEventIsFailure(terminal!)).toBe(false);
});

test("error is terminal and is a failure", () => {
  const terminal = terminalEventKind("error");

  expect(terminal).toBe("error");
  expect(terminalEventIsFailure(terminal!)).toBe(true);
});

test("progress and log are not terminal", () => {
  expect(terminalEventKind("progress")).toBeNull();
  expect(terminalEventKind("log")).toBeNull();
});
