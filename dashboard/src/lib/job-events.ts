import type { SseEvent } from "../api";

export type TerminalJobEvent = "done" | "error" | "cancelled";

export function terminalEventKind(type: SseEvent["type"]): TerminalJobEvent | null {
  return type === "done" || type === "error" || type === "cancelled" ? type : null;
}

export function terminalEventIsFailure(type: TerminalJobEvent): boolean {
  return type === "error";
}
