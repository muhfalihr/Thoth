import { expect, test } from "bun:test";
import config from "./vite.config";

test("proxies the control plane separately from the legacy server", () => {
  expect(config.server?.proxy).toMatchObject({
    "/api/v1": "http://127.0.0.1:8000",
    "/api": "http://127.0.0.1:9090",
  });
});
