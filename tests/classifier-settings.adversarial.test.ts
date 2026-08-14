import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { AUTO_MODE_CLASSIFIER_ALIAS } from "../src/classifier-settings";
import { startServer } from "../src/server";
import type { FrogConfig } from "../src/types";

let testDir = "";
let previousFrogHome: string | undefined;

function adversarialConfig(): FrogConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "anthropic",
    providers: {
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com",
        authMode: "forward",
        defaultModel: "gpt-4o-mini",
        models: ["gpt-4o-mini", "gpt-5.4-mini"],
      },
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "forward",
        defaultModel: "claude-sonnet-5",
        models: ["claude-sonnet-5", "claude-opus-4-8"],
      },
    },
  };
}

async function put(serverUrl: URL, body: unknown): Promise<Response> {
  return fetch(new URL("/api/classifier-settings", serverUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  testDir = mkdtempSync(join(tmpdir(), "frog-auto-classifier-api-"));
  process.env.FROGPROGSY_HOME = testDir;
  saveConfig(adversarialConfig());
});

afterEach(() => {
  if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
  else process.env.FROGPROGSY_HOME = previousFrogHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("GET /api/classifier-settings", () => {
  test("returns every provider and one empty explicit target", async () => {
    const server = await startServer(0)
    try {
      const response = await fetch(new URL("/api/classifier-settings", server.url));
      expect(response.status).toBe(200);
      const body = await response.json() as {
        providers: { name: string; models: string[] }[];
        autoModeClassifier: { provider: string; model: string };
      };
      expect(body.providers.map(provider => provider.name).sort()).toEqual(["anthropic", "codex"]);
      expect(body.providers.every(provider => Array.isArray(provider.models))).toBe(true);
      expect(body.providers.every(provider => !("classifierModel" in provider))).toBe(true);
      expect(body.autoModeClassifier).toEqual({ provider: "", model: "" });
      expect(body).not.toHaveProperty("classifierFallback");
    } finally {
      await server.stop(true);
    }
  });
});

describe("PUT /api/classifier-settings", () => {
  test("persists one known provider/model pair", async () => {
    const server = await startServer(0)
    try {
      const response = await put(server.url, { autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" } });
      expect(response.status).toBe(200);
      const body = await response.json() as { autoModeClassifier: { provider: string; model: string } };
      expect(body.autoModeClassifier).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
      expect(loadConfig().autoModeClassifier).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
    } finally {
      await server.stop(true);
    }
  });

  test("rejects a model absent from a non-empty known catalog without persisting it", async () => {
    const server = await startServer(0)
    try {
      const response = await put(server.url, { autoModeClassifier: { provider: "codex", model: "invented-model" } });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(loadConfig().autoModeClassifier).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("rejects a missing provider", async () => {
    const server = await startServer(0)
    try {
      const response = await put(server.url, { autoModeClassifier: { provider: "ghost", model: "gpt-5.4-mini" } });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(loadConfig().autoModeClassifier).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("rejects incomplete and whitespace-only targets", async () => {
    const server = await startServer(0)
    try {
      for (const target of [
        { provider: "codex", model: "" },
        { provider: "", model: "gpt-5.4-mini" },
        { provider: "  ", model: "  " },
      ]) {
        const response = await put(server.url, { autoModeClassifier: target });
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
      expect(loadConfig().autoModeClassifier).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("rejects disabled raw, qualified, and reserved-alias targets", async () => {
    for (const disabled of ["gpt-5.4-mini", "codex/gpt-5.4-mini", AUTO_MODE_CLASSIFIER_ALIAS]) {
      const config = adversarialConfig();
      config.disabledModels = [disabled];
      saveConfig(config);
      const server = await startServer(0)
      try {
        const response = await put(server.url, { autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" } });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(loadConfig().autoModeClassifier).toBeUndefined();
      } finally {
        await server.stop(true);
      }
    }
  });

  test("clears the target only when no profile depends on it", async () => {
    const config = adversarialConfig();
    config.autoModeClassifier = { provider: "codex", model: "gpt-5.4-mini" };
    saveConfig(config);
    const server = await startServer(0)
    try {
      const response = await put(server.url, { autoModeClassifier: null });
      expect(response.status).toBe(200);
      expect(loadConfig().autoModeClassifier).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("rejects clearing while an opted-in Claude Code home depends on the target", async () => {
    const config = adversarialConfig();
    config.autoModeClassifier = { provider: "codex", model: "gpt-5.4-mini" };
    config.claudeProfiles = {
      schemaVersion: 1,
      profiles: [{ id: "cp_work", name: "Work", claudeHome: join(testDir, "claude-work"), routeAutoModeClassifier: true }],
    };
    saveConfig(config);
    const server = await startServer(0)
    try {
      const response = await put(server.url, { autoModeClassifier: null });
      expect(response.status).toBe(409);
      expect(loadConfig().autoModeClassifier).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
    } finally {
      await server.stop(true);
    }
  });

  test("rejects legacy payloads instead of silently accepting them", async () => {
    const server = await startServer(0)
    try {
      for (const body of [
        { classifierFallback: { provider: "codex", model: "gpt-5.4-mini" } },
        { providers: { codex: { classifierModel: "gpt-5.4-mini" } } },
      ]) {
        const response = await put(server.url, body);
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
      expect(loadConfig().autoModeClassifier).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("rejects malformed JSON", async () => {
    const server = await startServer(0)
    try {
      const response = await fetch(new URL("/api/classifier-settings", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      });
      expect(response.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });
});

describe("management mutations preserve the configured classifier target", () => {
  test("rejects disabling the configured target without persisting the new disabled list", async () => {
    const config = adversarialConfig();
    config.autoModeClassifier = { provider: "codex", model: "gpt-5.4-mini" };
    saveConfig(config);
    const server = await startServer(0)
    try {
      const response = await fetch(new URL("/api/disabled-models", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: ["codex/gpt-5.4-mini"] }),
      });
      expect(response.status).toBe(409);
      expect(loadConfig().disabledModels).toBeUndefined();
      expect(loadConfig().autoModeClassifier).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
    } finally {
      await server.stop(true);
    }
  });

  test("rejects deleting the configured classifier provider", async () => {
    const config = adversarialConfig();
    config.autoModeClassifier = { provider: "codex", model: "gpt-5.4-mini" };
    saveConfig(config);
    const server = await startServer(0)
    try {
      const response = await fetch(new URL("/api/providers?name=codex", server.url), { method: "DELETE" });
      expect(response.status).toBe(409);
      expect(loadConfig().providers.codex).toBeDefined();
    } finally {
      await server.stop(true);
    }
  });

  test("rejects overwriting the classifier provider when the target would disappear", async () => {
    const config = adversarialConfig();
    config.providers.review = {
      adapter: "openai-chat",
      baseUrl: "https://review.example.com",
      authMode: "forward",
      defaultModel: "review-v1",
      models: ["review-v1"],
      liveModels: false,
    };
    config.autoModeClassifier = { provider: "review", model: "review-v1" };
    saveConfig(config);
    const server = await startServer(0)
    try {
      const response = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "review",
          provider: {
            adapter: "openai-chat",
            baseUrl: "https://review.example.com",
            authMode: "forward",
            defaultModel: "other-v1",
            models: ["other-v1"],
            liveModels: false,
          },
        }),
      });
      expect(response.status).toBe(409);
      expect(loadConfig().providers.review?.models).toEqual(["review-v1"]);
    } finally {
      await server.stop(true);
    }
  });
});
