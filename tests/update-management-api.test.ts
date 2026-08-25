import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __requestLogTest } from "../src/server";
import { createUpdateStatusService } from "../src/update-status";
import type { FrogConfig } from "../src/types";
import type { UpdateStatusService } from "../src/update-status";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function config(): FrogConfig {
  return {
    port: 3764,
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "forward",
        defaultModel: "claude-sonnet-4-6",
      },
    },
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "frogp-update-api-"));
  tempDirs.push(directory);
  let registryRequests = 0;
  const updateStatusService = createUpdateStatusService({
    cachePath: join(directory, "cache", "update-status-v1.json"),
    identityHint: { kind: "bun", version: "1.2.3" },
    detectInstall: async () => ({ kind: "bun", version: "1.2.3" }),
    fetch: async () => {
      registryRequests += 1;
      return Response.json({ latest: "1.2.4" });
    },
    now: () => new Date("2026-08-25T00:00:00.000Z"),
  });
  return { updateStatusService, registryRequests: () => registryRequests };
}

async function request(
  cfg: FrogConfig,
  url: string,
  init: RequestInit,
  updateStatusService: UpdateStatusService,
  extra: Record<string, unknown> = {},
) {
  return __requestLogTest.handleManagementAPI(new Request(url, init), new URL(url), cfg, {
    updateStatusService,
    clientAddress: "127.0.0.1",
    ...extra,
  });
}

describe("update management API", () => {
  test("GET is snapshot-only and returns before OAuth credential recovery", async () => {
    const cfg = config();
    const update = fixture();
    let oauthRecoveryCalls = 0;
    const response = await request(cfg, "http://127.0.0.1:3764/api/update-status", { method: "GET" }, update.updateStatusService, {
      restoreOAuthProviderConfigs: () => {
        oauthRecoveryCalls += 1;
        return false;
      },
    });
    expect(response?.status).toBe(200);
    expect((await response?.json()).status).toBe("unavailable");
    expect(update.registryRequests()).toBe(0);
    expect(oauthRecoveryCalls).toBe(0);
  });

  test("explicit POST refresh uses the shared owner and remains allowed while disabled", async () => {
    const cfg = config();
    cfg.updateChecks = { enabled: false };
    const update = fixture();
    update.updateStatusService.setEnabled(false);
    const response = await request(
      cfg,
      "http://127.0.0.1:3764/api/update-status/refresh",
      { method: "POST", headers: { Origin: "http://127.0.0.1:3764" } },
      update.updateStatusService,
    );
    expect(response?.status).toBe(200);
    const payload = await response?.json();
    expect(payload.status).toBe("disabled");
    expect(payload.latestVersion).toBe("1.2.4");
    expect(update.registryRequests()).toBe(1);
  });

  test("PUT accepts exactly enabled, persists it, and rejects extra fields", async () => {
    const cfg = config();
    const update = fixture();
    let saved: FrogConfig | null = null;
    const response = await request(
      cfg,
      "http://127.0.0.1:3764/api/update-settings",
      {
        method: "PUT",
        headers: { Origin: "http://127.0.0.1:3764", "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
      update.updateStatusService,
      { saveConfig: (value: FrogConfig) => { saved = structuredClone(value); } },
    );
    expect(response?.status).toBe(200);
    expect((await response?.json()).status).toBe("disabled");
    expect(saved?.updateChecks).toEqual({ enabled: false });

    const invalid = await request(
      cfg,
      "http://127.0.0.1:3764/api/update-settings",
      {
        method: "PUT",
        headers: { Origin: "http://127.0.0.1:3764", "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, registry: "https://evil.invalid" }),
      },
      update.updateStatusService,
    );
    expect(invalid?.status).toBe(400);
  });

  test("failed settings persistence restores the in-memory config", async () => {
    const cfg = config();
    const update = fixture();
    const response = await request(
      cfg,
      "http://127.0.0.1:3764/api/update-settings",
      {
        method: "PUT",
        headers: { Origin: "http://127.0.0.1:3764", "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
      update.updateStatusService,
      { saveConfig: () => { throw new Error("disk full"); } },
    );
    expect(response?.status).toBe(500);
    expect(cfg.updateChecks).toBeUndefined();
    expect(update.updateStatusService.snapshot().enabled).toBe(true);
  });

  test("mutation guard blocks remote refresh before registry or config work", async () => {
    const cfg = config();
    const update = fixture();
    const url = "http://127.0.0.1:3764/api/update-status/refresh";
    const response = await __requestLogTest.handleManagementAPI(
      new Request(url, { method: "POST", headers: { Origin: "https://evil.invalid" } }),
      new URL(url),
      cfg,
      { updateStatusService: update.updateStatusService, clientAddress: "203.0.113.8" },
    );
    expect(response?.status).toBe(403);
    expect(update.registryRequests()).toBe(0);
  });
});
