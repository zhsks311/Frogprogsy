import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import {
  AUTO_MODE_CLASSIFIER_ALIAS,
  classifierSettingsSnapshot,
  resolveAutoModeClassifierTarget,
} from "../src/classifier-settings";
import type { FrogConfig } from "../src/types";

let testDir = "";
let previousFrogHome: string | undefined;

function baseConfig(): FrogConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "codex",
    providers: {
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com",
        authMode: "forward",
        defaultModel: "gpt-5.4",
        models: ["gpt-5.4", "gpt-5.4-mini"],
        liveModels: false,
      },
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "forward",
        defaultModel: "claude-sonnet-4-6",
        models: ["claude-sonnet-4-6", "claude-haiku-4-5"],
        liveModels: false,
      },
    },
  } as FrogConfig;
}

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  testDir = mkdtempSync(join(tmpdir(), "frog-classifier-"));
  process.env.FROGPROGSY_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

async function put(serverUrl: URL, body: unknown): Promise<Response> {
  return fetch(new URL("/api/classifier-settings", serverUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Reserved alias constant ─────────────────────────────────────────────────

describe("AUTO_MODE_CLASSIFIER_ALIAS", () => {
  test("is the exact reserved gateway alias", () => {
    expect(AUTO_MODE_CLASSIFIER_ALIAS).toBe("claude-frogp-auto-classifier");
  });
});

// ── Unit: classifierSettingsSnapshot (new single-target shape) ───────────────

describe("classifierSettingsSnapshot", () => {
  test("new shape: providers {name, models} + empty target, no legacy keys", () => {
    const snap = classifierSettingsSnapshot(baseConfig());
    expect(snap.providers.map(p => p.name).sort()).toEqual(["anthropic", "codex"]);
    for (const p of snap.providers) {
      expect(typeof p.name).toBe("string");
      expect(Array.isArray(p.models)).toBe(true);
      expect(p).not.toHaveProperty("classifierModel");
    }
    expect(snap.autoModeClassifier).toEqual({ provider: "", model: "" });
    expect(snap).not.toHaveProperty("classifierFallback");
  });

  test("reflects a configured target and hides disabled models from the option list", () => {
    const config = baseConfig();
    config.autoModeClassifier = { provider: "codex", model: "gpt-5.4-mini" };
    config.disabledModels = ["codex/gpt-5.4"];
    const snap = classifierSettingsSnapshot(config);
    expect(snap.autoModeClassifier).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
    const codex = snap.providers.find(p => p.name === "codex")!;
    expect(codex.models).toContain("gpt-5.4-mini");
    expect(codex.models).not.toContain("gpt-5.4"); // disabled routed id hidden
  });
});

// ── Unit: resolveAutoModeClassifierTarget (deterministic reasons) ────────────

describe("resolveAutoModeClassifierTarget", () => {
  test("unset when no target is configured", () => {
    const r = resolveAutoModeClassifierTarget(baseConfig());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unset");
  });

  test("incomplete when either field is blank", () => {
    const config = baseConfig();
    config.autoModeClassifier = { provider: "codex", model: "" };
    const r = resolveAutoModeClassifierTarget(config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("incomplete");
  });

  test("provider_missing when the provider is not configured", () => {
    const config = baseConfig();
    config.autoModeClassifier = { provider: "ghost", model: "gpt-5.4-mini" };
    const r = resolveAutoModeClassifierTarget(config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("provider_missing");
  });

  test("disabled when the target model id is hidden via disabledModels", () => {
    const config = baseConfig();
    config.autoModeClassifier = { provider: "codex", model: "gpt-5.4-mini" };
    config.disabledModels = ["codex/gpt-5.4-mini"];
    const r = resolveAutoModeClassifierTarget(config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("disabled");
  });

  test("ok for a valid, enabled target", () => {
    const config = baseConfig();
    config.autoModeClassifier = { provider: "codex", model: "gpt-5.4-mini" };
    const r = resolveAutoModeClassifierTarget(config);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe("codex");
      expect(r.model).toBe("gpt-5.4-mini");
    }
  });
});

// ── API: GET /api/classifier-settings ────────────────────────────────────────

describe("GET /api/classifier-settings", () => {
  test("returns every provider and an empty explicit target", async () => {
    const server = await startServer(0)
    try {
      const res = await fetch(new URL("/api/classifier-settings", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as {
        providers: { name: string; models: string[] }[];
        autoModeClassifier: { provider: string; model: string };
      };
      expect(body.providers.map(p => p.name).sort()).toEqual(["anthropic", "codex"]);
      expect(body.providers.every(p => Array.isArray(p.models))).toBe(true);
      expect(body.autoModeClassifier).toEqual({ provider: "", model: "" });
      expect(body).not.toHaveProperty("classifierFallback");
    } finally {
      await server.stop(true);
    }
  });
});

// ── API: PUT /api/classifier-settings (single target) ────────────────────────

describe("PUT /api/classifier-settings", () => {
  test("saves one provider/model pair; GET and config reflect it", async () => {
    const server = await startServer(0)
    try {
      const res = await put(server.url, { autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" } });
      expect(res.status).toBe(200);
      const body = await res.json() as { autoModeClassifier: { provider: string; model: string } };
      expect(body.autoModeClassifier).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
      expect(loadConfig().autoModeClassifier).toEqual({ provider: "codex", model: "gpt-5.4-mini" });

      const get = await fetch(new URL("/api/classifier-settings", server.url));
      const getBody = await get.json() as { autoModeClassifier: { provider: string; model: string } };
      expect(getBody.autoModeClassifier).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
    } finally {
      await server.stop(true);
    }
  });

  test("clears the target with null when no Claude Code home depends on it", async () => {
    const config = baseConfig();
    config.autoModeClassifier = { provider: "codex", model: "gpt-5.4-mini" };
    saveConfig(config);
    const server = await startServer(0)
    try {
      const res = await put(server.url, { autoModeClassifier: null });
      expect(res.status).toBe(200);
      expect(loadConfig().autoModeClassifier).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("refuses to clear (409) while a home opts in via routeAutoModeClassifier", async () => {
    const config = baseConfig();
    config.autoModeClassifier = { provider: "codex", model: "gpt-5.4-mini" };
    config.claudeProfiles = {
      schemaVersion: 1,
      profiles: [{ id: "cp_work", name: "Work", claudeHome: join(testDir, ".claude-work"), routeAutoModeClassifier: true }],
    };
    saveConfig(config);
    const server = await startServer(0)
    try {
      const res = await put(server.url, { autoModeClassifier: null });
      expect(res.status).toBe(409);
      expect(loadConfig().autoModeClassifier).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
    } finally {
      await server.stop(true);
    }
  });

  test("rejects incomplete, unknown-provider, and unknown-model targets without persisting", async () => {
    const server = await startServer(0)
    try {
      expect((await put(server.url, { autoModeClassifier: { provider: "codex", model: "" } })).status).toBeGreaterThanOrEqual(400);
      expect((await put(server.url, { autoModeClassifier: { provider: "ghost", model: "gpt-5.4-mini" } })).status).toBeGreaterThanOrEqual(400);
      expect((await put(server.url, { autoModeClassifier: { provider: "codex", model: "not-a-real-model" } })).status).toBeGreaterThanOrEqual(400);
      expect(loadConfig().autoModeClassifier).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("rejects a disabled target (qualified id and reserved alias) without persisting", async () => {
    for (const disabled of ["codex/gpt-5.4-mini", AUTO_MODE_CLASSIFIER_ALIAS]) {
      const config = baseConfig();
      config.disabledModels = [disabled];
      saveConfig(config);
      const server = await startServer(0)
      try {
        const res = await put(server.url, { autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" } });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(loadConfig().autoModeClassifier).toBeUndefined();
      } finally {
        await server.stop(true);
      }
    }
  });

  test("rejects legacy payloads (classifierModel / classifierFallback) instead of silently accepting", async () => {
    const server = await startServer(0)
    try {
      for (const legacy of [
        { providers: { codex: { classifierModel: "gpt-5.4-mini" } } },
        { classifierFallback: { provider: "codex", model: "gpt-5.4-mini" } },
        { somethingElse: true },
      ]) {
        expect((await put(server.url, legacy)).status).toBe(400);
      }
      expect(loadConfig().autoModeClassifier).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("malformed JSON body returns 400", async () => {
    const server = await startServer(0)
    try {
      const res = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json {{",
      });
      expect(res.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });
});

// ── Regression: startup validates but never back-fills or strips the target ──

describe("startServer auto-mode classifier lifecycle (regression)", () => {
  test("does not back-fill provider classifierModel or drop the configured target on start", async () => {
    const config = baseConfig();
    config.autoModeClassifier = { provider: "codex", model: "gpt-5.4-mini" };
    saveConfig(config);
    const server = await startServer(0)
    try {
      // Old branch removed/rewrote the alias target at startup; the new startup only validates.
      expect(loadConfig().autoModeClassifier).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
      // And it never seeds a legacy per-provider classifierModel back onto providers.
      const persisted = loadConfig();
      expect("classifierModel" in (persisted.providers.codex as Record<string, unknown>)).toBe(false);
      expect("classifierModel" in (persisted.providers.anthropic as Record<string, unknown>)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("starting with an unset target leaves it unset (no silent creation)", async () => {
    const server = await startServer(0)
    try {
      expect(loadConfig().autoModeClassifier).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("fails before listening when a configured target is incomplete or disabled", async () => {
    for (const mutate of [
      (config: FrogConfig) => {
        config.autoModeClassifier = { provider: "codex", model: "" };
      },
      (config: FrogConfig) => {
        config.autoModeClassifier = { provider: "codex", model: "gpt-5.4-mini" };
        config.disabledModels = ["codex/gpt-5.4-mini"];
      },
    ]) {
      const config = baseConfig();
      mutate(config);
      saveConfig(config);
      await expect(startServer(0)).rejects.toThrow(/Invalid autoModeClassifier/);
    }
  });

  test("fails before listening when a static provider catalog does not contain the target", async () => {
    const config = baseConfig();
    config.autoModeClassifier = { provider: "codex", model: "invented-model" };
    saveConfig(config);
    await expect(startServer(0)).rejects.toThrow(/unknown_model/);
  });

  test("fails before listening when an opted-in home has no classifier target", async () => {
    const config = baseConfig();
    config.claudeProfiles = {
      schemaVersion: 1,
      profiles: [{
        id: "cp_work",
        name: "Work",
        claudeHome: join(testDir, ".claude-work"),
        routeAutoModeClassifier: true,
      }],
    };
    saveConfig(config);
    await expect(startServer(0)).rejects.toThrow(/Invalid autoModeClassifier/);
  });
});
