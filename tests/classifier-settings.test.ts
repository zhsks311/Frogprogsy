import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { __requestLogTest, startServer } from "../src/server";
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
    claudeProfiles: {
      schemaVersion: 1,
      defaultProfileId: "cp_default",
      profiles: [{ id: "cp_default", name: "Default", claudeHome: join(testDir, "claude-default") }],
    },
  } as FrogConfig;
}

beforeEach(() => {
  previousFrogHome = process.env.FROGPROGSY_HOME;
  testDir = mkdtempSync(join(tmpdir(), "frog-classifier-"));
  mkdirSync(join(testDir, "claude-default"));
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
    expect(snap.autoModeClassifierEnabled).toBe(false);
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
  test("enables the global route only when a valid provider/model pair is saved with it", async () => {
    const server = await startServer(0)
    try {
      const res = await put(server.url, {
        autoModeClassifierEnabled: true,
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      });
      expect(res.status).toBe(200);
      expect(loadConfig()).toMatchObject({
        autoModeClassifierEnabled: true,
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      });
    } finally {
      await server.stop(true);
    }
  });
  test("materializes and updates the default managed home on first enable", async () => {
    const claudeHome = join(testDir, "claude-materialized");
    mkdirSync(claudeHome);
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    const config = baseConfig();
    delete config.claudeProfiles;
    saveConfig(config);
    const server = await startServer(0);
    try {
      const response = await put(server.url, {
        autoModeClassifierEnabled: true,
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      });
      expect(response.status).toBe(200);
      const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
      expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(AUTO_MODE_CLASSIFIER_ALIAS);
      const materializedProfile = loadConfig().claudeProfiles?.profiles.find(profile => profile.id === "cp_default");
      expect(materializedProfile).toBeDefined();
      const materializedSettings = JSON.parse(readFileSync(join(materializedProfile!.claudeHome, "settings.json"), "utf8"));
      expect(materializedSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(AUTO_MODE_CLASSIFIER_ALIAS);
    } finally {
      await server.stop(true);
      if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
  });
  test("disables the global route without discarding the saved target", async () => {
    const config = baseConfig();
    config.autoModeClassifierEnabled = true;
    config.autoModeClassifier = { provider: "codex", model: "gpt-5.4-mini" };
    saveConfig(config);
    const server = await startServer(0)
    try {
      const res = await put(server.url, {
        autoModeClassifierEnabled: false,
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      });
      expect(res.status).toBe(200);
      expect(loadConfig()).toMatchObject({
        autoModeClassifierEnabled: false,
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      });
    } finally {
      await server.stop(true);
    }
  });
  test("disabling leaves a managed home that is already direct unchanged", async () => {
    const directHome = join(testDir, "claude-direct-disabled");
    mkdirSync(directHome);
    const originalSettings = { env: { USER_SETTING: "keep" } };
    writeFileSync(join(directHome, "settings.json"), JSON.stringify(originalSettings));
    const config = baseConfig();
    config.autoModeClassifierEnabled = true;
    config.autoModeClassifier = { provider: "codex", model: "gpt-5.4-mini" };
    config.claudeProfiles = {
      schemaVersion: 1,
      defaultProfileId: "cp_direct",
      profiles: [{ id: "cp_direct", name: "Direct", claudeHome: directHome }],
    };
    saveConfig(config);
    const server = await startServer(0);
    try {
      const response = await put(server.url, {
        autoModeClassifierEnabled: false,
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(readFileSync(join(directHome, "settings.json"), "utf8"))).toEqual(originalSettings);
    } finally {
      await server.stop(true);
    }
  });
  test("global switch applies and removes the reserved alias for every managed home and enrolled project", async () => {
    const claudeHome = join(testDir, "claude-work");
    const idleHome = join(testDir, "claude-idle");
    const projectRoot = join(testDir, "project");
    mkdirSync(claudeHome);
    mkdirSync(idleHome);
    mkdirSync(projectRoot);
    const config = baseConfig();
    config.claudeProfiles = {
      schemaVersion: 1,
      profiles: [
        { id: "cp_work", name: "Work", claudeHome, injected: true },
        { id: "cp_idle", name: "Idle", claudeHome: idleHome },
      ],
    };
    config.claudeProjects = {
      schemaVersion: 1,
      projects: [{ id: "cproj_all", name: "All", projectPath: projectRoot, enrolled: true }],
    };
    saveConfig(config);
    const server = await startServer(0)
    try {
      const res = await put(server.url, {
        autoModeClassifierEnabled: true,
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      });
      expect(res.status).toBe(200);
      const homeSettings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
      const idleSettings = JSON.parse(readFileSync(join(idleHome, "settings.json"), "utf8"));
      const projectSettings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf8"));
      expect(homeSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(AUTO_MODE_CLASSIFIER_ALIAS);
      expect(idleSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(AUTO_MODE_CLASSIFIER_ALIAS);
      expect(projectSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(AUTO_MODE_CLASSIFIER_ALIAS);
      const disabled = await put(server.url, {
        autoModeClassifierEnabled: false,
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      });
      expect(disabled.status).toBe(200);
      const disabledHome = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
      const disabledIdle = JSON.parse(readFileSync(join(idleHome, "settings.json"), "utf8"));
      const disabledProject = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf8"));
      expect(disabledHome.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(disabledIdle.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(disabledProject.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(loadConfig().autoModeClassifierEnabled).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
  test("disabling removes the reserved alias even when the gateway base URL is stale", async () => {
    const claudeHome = join(testDir, "claude-stale-port");
    const projectRoot = join(testDir, "project-stale-port");
    mkdirSync(claudeHome);
    mkdirSync(projectRoot);
    const config = baseConfig();
    config.claudeProfiles = {
      schemaVersion: 1,
      profiles: [{ id: "cp_stale", name: "Stale", claudeHome }],
    };
    config.claudeProjects = {
      schemaVersion: 1,
      projects: [{ id: "cproj_stale", name: "Stale", projectPath: projectRoot, enrolled: true }],
    };
    saveConfig(config);
    const server = await startServer(0);
    try {
      const enabled = await put(server.url, {
        autoModeClassifierEnabled: true,
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      });
      expect(enabled.status).toBe(200);
      const homeSettingsPath = join(claudeHome, "settings.json");
      const projectSettingsPath = join(projectRoot, ".claude", "settings.local.json");
      const homeSettings = JSON.parse(readFileSync(homeSettingsPath, "utf8"));
      const projectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf8"));
      homeSettings.env.ANTHROPIC_BASE_URL = "http://localhost:65535";
      projectSettings.env.ANTHROPIC_BASE_URL = "http://localhost:65535";
      writeFileSync(homeSettingsPath, JSON.stringify(homeSettings));
      writeFileSync(projectSettingsPath, JSON.stringify(projectSettings));

      const disabled = await put(server.url, {
        autoModeClassifierEnabled: false,
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      });
      expect(disabled.status).toBe(200);
      const disabledHome = JSON.parse(readFileSync(homeSettingsPath, "utf8"));
      const disabledProject = JSON.parse(readFileSync(projectSettingsPath, "utf8"));
      expect(disabledHome.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(disabledProject.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(loadConfig().autoModeClassifierEnabled).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("rolls applied and previously direct homes back when one enrolled project cannot be updated", async () => {
    const claudeHome = join(testDir, "claude-rollback");
    const directHome = join(testDir, "claude-direct-rollback");
    mkdirSync(claudeHome);
    mkdirSync(directHome);
    const originalDirectSettings = { env: { USER_SETTING: "keep" } };
    writeFileSync(join(directHome, "settings.json"), JSON.stringify(originalDirectSettings));
    const config = baseConfig();
    config.claudeProfiles = {
      schemaVersion: 1,
      profiles: [
        { id: "cp_work", name: "Work", claudeHome, injected: true },
        { id: "cp_direct", name: "Direct", claudeHome: directHome },
      ],
    };
    config.claudeProjects = {
      schemaVersion: 1,
      projects: [{
        id: "cproj_missing",
        name: "Missing",
        projectPath: join(testDir, "missing-project"),
        enrolled: true,
      }],
    };
    saveConfig(config);
    const server = await startServer(0)
    try {
      const response = await put(server.url, {
        autoModeClassifierEnabled: true,
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      });
      expect(response.status).toBe(409);
      expect(loadConfig().autoModeClassifierEnabled).not.toBe(true);
      const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
      const directSettings = JSON.parse(readFileSync(join(directHome, "settings.json"), "utf8"));
      expect(settings.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
      expect(directSettings).toEqual(originalDirectSettings);
    } finally {
      await server.stop(true);
    }
  });
  test("rolls back earlier homes when a later managed home cannot be inspected", async () => {
    const appliedHome = join(testDir, "claude-applied-before-missing");
    const missingHome = join(testDir, "claude-missing");
    mkdirSync(appliedHome);
    const config = baseConfig();
    config.claudeProfiles = {
      schemaVersion: 1,
      profiles: [
        { id: "cp_applied", name: "Applied", claudeHome: appliedHome },
        { id: "cp_missing", name: "Missing", claudeHome: missingHome },
      ],
    };
    saveConfig(config);
    const server = await startServer(0);
    try {
      const response = await put(server.url, {
        autoModeClassifierEnabled: true,
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      });
      expect(response.status).toBe(409);
      expect(loadConfig().autoModeClassifierEnabled).not.toBe(true);
      const settings = JSON.parse(readFileSync(join(appliedHome, "settings.json"), "utf8"));
      expect(settings.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("refuses disabling while an enrolled project cannot be restored", async () => {
    const projectRoot = join(testDir, "project-temporarily-missing");
    const detachedProjectRoot = join(testDir, "project-detached");
    mkdirSync(projectRoot);
    const config = baseConfig();
    config.claudeProjects = {
      schemaVersion: 1,
      projects: [{ id: "cproj_detached", name: "Detached", projectPath: projectRoot, enrolled: true }],
    };
    saveConfig(config);
    const server = await startServer(0);
    try {
      const enabled = await put(server.url, {
        autoModeClassifierEnabled: true,
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      });
      expect(enabled.status).toBe(200);
      renameSync(projectRoot, detachedProjectRoot);
      const disabled = await put(server.url, {
        autoModeClassifierEnabled: false,
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      });
      renameSync(detachedProjectRoot, projectRoot);
      expect(disabled.status).toBe(409);
      expect(loadConfig().autoModeClassifierEnabled).toBe(true);
      const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf8"));
      expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(AUTO_MODE_CLASSIFIER_ALIAS);
    } finally {
      await server.stop(true);
    }
  });


  test("rolls Claude homes and in-memory classifier state back when config persistence fails", async () => {
    const claudeHome = join(testDir, "claude-persist-rollback");
    mkdirSync(claudeHome);
    const originalSettings = { env: { USER_SETTING: "keep" } };
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify(originalSettings));
    const config = baseConfig();
    config.claudeProfiles = {
      schemaVersion: 1,
      profiles: [{ id: "cp_work", name: "Work", claudeHome }],
    };

    const response = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/classifier-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoModeClassifierEnabled: true,
          autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
        }),
      }),
      new URL("http://localhost/api/classifier-settings"),
      config,
      { saveConfig: () => { throw new Error("disk full"); } },
    );

    expect(response?.status).toBe(500);
    expect(config.autoModeClassifierEnabled).not.toBe(true);
    expect(config.autoModeClassifier).toBeUndefined();
    expect(JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"))).toEqual(originalSettings);
  });

  test("keeps a disabled saved target when clearing it cannot be persisted", async () => {
    const config = baseConfig();
    config.autoModeClassifierEnabled = false;
    config.autoModeClassifier = { provider: "codex", model: "gpt-5.4-mini" };

    const response = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/classifier-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoModeClassifierEnabled: false,
          autoModeClassifier: null,
        }),
      }),
      new URL("http://localhost/api/classifier-settings"),
      config,
      { saveConfig: () => { throw new Error("disk full"); } },
    );

    expect(response?.status).toBe(500);
    expect(config.autoModeClassifierEnabled).toBe(false);
    expect(config.autoModeClassifier).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
  });




  test("rejects payloads that omit either the global switch or target", async () => {
    const server = await startServer(0)
    try {
      expect((await put(server.url, {
        autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      })).status).toBe(400);
      expect((await put(server.url, {
        autoModeClassifierEnabled: true,
      })).status).toBe(400);
      expect(loadConfig().autoModeClassifier).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("rejects incomplete, unknown-provider, and unknown-model targets without persisting", async () => {
    const server = await startServer(0)
    try {
      expect((await put(server.url, { autoModeClassifierEnabled: true, autoModeClassifier: { provider: "codex", model: "" } })).status).toBeGreaterThanOrEqual(400);
      expect((await put(server.url, { autoModeClassifierEnabled: true, autoModeClassifier: { provider: "ghost", model: "gpt-5.4-mini" } })).status).toBeGreaterThanOrEqual(400);
      expect((await put(server.url, { autoModeClassifierEnabled: true, autoModeClassifier: { provider: "codex", model: "not-a-real-model" } })).status).toBeGreaterThanOrEqual(400);
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
        const res = await put(server.url, { autoModeClassifierEnabled: true, autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" } });
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
      config.autoModeClassifierEnabled = true;
      saveConfig(config);
      await expect(startServer(0)).rejects.toThrow(/Invalid autoModeClassifier/);
    }
  });

  test("fails before listening when a static provider catalog does not contain the target", async () => {
    const config = baseConfig();
    config.autoModeClassifier = { provider: "codex", model: "invented-model" };
    config.autoModeClassifierEnabled = true;
    saveConfig(config);
    await expect(startServer(0)).rejects.toThrow(/unknown_model/);
  });

  test("fails before listening when the global route is enabled without a classifier target", async () => {
    const config = baseConfig();
    config.autoModeClassifierEnabled = true;
    saveConfig(config);
    await expect(startServer(0)).rejects.toThrow(/Invalid autoModeClassifier/);
  });
  test("removes retired per-profile route flags without enabling the global switch", async () => {
    const config = baseConfig();
    config.claudeProfiles = {
      schemaVersion: 1,
      profiles: [{ id: "cp_work", name: "Work", claudeHome: join(testDir, "claude-work") }],
    };
    const legacyProfile = config.claudeProfiles.profiles[0] as unknown as Record<string, unknown>;
    legacyProfile.routeAutoModeClassifier = true;
    saveConfig(config);

    const server = await startServer(0)
    try {
      const persisted = loadConfig();
      expect(persisted.autoModeClassifierEnabled).not.toBe(true);
      expect(persisted.claudeProfiles?.profiles[0]).not.toHaveProperty("routeAutoModeClassifier");
    } finally {
      await server.stop(true);
    }
  });

});
