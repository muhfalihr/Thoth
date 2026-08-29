import type { components } from "./generated/control-plane";

export type WorkflowRequest = components["schemas"]["WorkflowRequest"];
export type WorkflowSummary = components["schemas"]["WorkflowSummary"];
export type StylePreset = components["schemas"]["StylePreset"];
export type ApprovalSubmission = components["schemas"]["ApprovalSubmission"];
export type RetryRequest = components["schemas"]["RetryRequest"];

export type ControlPlaneClient = {
  listStylePresets: () => Promise<StylePreset[]>;
  createWorkflow: (request: WorkflowRequest) => Promise<WorkflowSummary>;
  getWorkflow: (workflowId: string) => Promise<WorkflowSummary>;
  streamWorkflow: (
    workflowId: string,
    onSnapshot: (snapshot: WorkflowSummary) => void,
    lastEventId?: string,
  ) => () => void;
  approveWorkflow: (workflowId: string, approval: ApprovalSubmission) => Promise<WorkflowSummary>;
  cancelWorkflow: (workflowId: string) => Promise<WorkflowSummary>;
  retryWorkflow: (workflowId: string, retry?: RetryRequest) => Promise<WorkflowSummary>;
};

type ClientOptions = { baseUrl?: string; apiKey?: string };

const defaultBaseUrl = (import.meta.env.VITE_CONTROL_PLANE_URL ?? "").replace(/\/$/, "");
const defaultApiKey = import.meta.env.VITE_CONTROL_PLANE_API_KEY ?? "";

function eventBlocks(chunk: string): Array<{ id?: string; data: string }> {
  return chunk.split("\n\n").flatMap((block) => {
    const fields = block.split("\n");
    const id = fields.find((line) => line.startsWith("id:"))?.slice(3).trim();
    const data = fields
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return data ? [{ id, data }] : [];
  });
}

export function createControlPlaneClient(options: ClientOptions = {}): ControlPlaneClient {
  const baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/$/, "");
  const apiKey = options.apiKey ?? defaultApiKey;
  const headers = (extra: HeadersInit = {}) => ({ Authorization: `Bearer ${apiKey}`, ...extra });

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: headers(init.headers),
    });
    if (!response.ok) throw new Error(`Control plane request failed (${response.status})`);
    return response.json() as Promise<T>;
  }

  const client: ControlPlaneClient = {
    listStylePresets: () => request<StylePreset[]>("/api/v1/style-presets"),
    createWorkflow: (workflow) =>
      request<WorkflowSummary>("/api/v1/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(workflow),
      }),
    getWorkflow: (workflowId) => request<WorkflowSummary>(`/api/v1/workflows/${workflowId}`),
    approveWorkflow: (workflowId, approval) =>
      request<WorkflowSummary>(`/api/v1/workflows/${workflowId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(approval),
      }),
    cancelWorkflow: (workflowId) =>
      request<WorkflowSummary>(`/api/v1/workflows/${workflowId}/cancel`, { method: "POST" }),
    retryWorkflow: (workflowId, retry = {}) =>
      request<WorkflowSummary>(`/api/v1/workflows/${workflowId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(retry),
      }),
    streamWorkflow(workflowId, onSnapshot, lastEventId) {
      let active = true;
      let cursor = lastEventId;
      let controller: AbortController | undefined;
      let snapshotRefresh = Promise.resolve();

      const refreshSnapshot = () => {
        snapshotRefresh = snapshotRefresh.then(async () => {
          if (!active) return;
          try {
            onSnapshot(await client.getWorkflow(workflowId));
          } catch {
            // A later stream retry or user action will obtain the next snapshot.
          }
        });
        return snapshotRefresh;
      };
      void refreshSnapshot();

      void (async () => {
        while (active) {
          controller = new AbortController();
          try {
            const response = await fetch(`${baseUrl}/api/v1/workflows/${workflowId}/events`, {
              headers: headers(cursor ? { "Last-Event-ID": cursor } : {}),
              signal: controller.signal,
            });
            if (!response.ok || response.body === null) throw new Error("workflow stream unavailable");
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let pending = "";
            while (active) {
              const { done, value } = await reader.read();
              pending = (pending + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
              let boundary = pending.indexOf("\n\n");
              while (boundary >= 0) {
                for (const event of eventBlocks(pending.slice(0, boundary))) {
                  if (event.id) cursor = event.id;
                  await refreshSnapshot();
                }
                pending = pending.slice(boundary + 2);
                boundary = pending.indexOf("\n\n");
              }
              if (done) break;
            }
          } catch {
            // The immediately refreshed snapshot is authoritative after every reconnect.
          }
          await refreshSnapshot();
          if (active) await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      })();
      return () => {
        active = false;
        controller?.abort();
      };
    },
  };
  return client;
}

export const controlPlaneClient = createControlPlaneClient();
