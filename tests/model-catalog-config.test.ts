import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEffectiveConfig,
  migratePersistedCatalogConfig,
  providerUserSeedFromRegistry,
  sanitizeCatalogProviderForPersistence,
  writeCatalogConfigBackupOnce,
} from "../src/model-catalog-config";
import { createRuntimeConfigState } from "../src/runtime-config-state";
import type { SelectedModelCatalog } from "../src/model-catalog-runtime";
import type { ModelCatalogDocumentV1 } from "../src/model-catalog-schema";
import type { FrogConfig } from "../src/types";

function bundledCatalog(): ModelCatalogDocumentV1 {
  return {
    schemaVersion: 1,
    catalogRevision: 1,
    catalogDigest: "a".repeat(64),
    sourceCommit: "b".repeat(40),
    generatedAt: "2026-08-12T00:00:00.000Z",
    minFrogprogsyVersion: "0.0.1",
    providers: [
      {
        id: "umans",
        defaultModel: "umans-coder",
        models: [
          {
            id: "umans-coder",
            contextWindow: 262_144,
            inputModalities: ["text", "image"],
            reasoningEfforts: ["low", "high"],
            noTemperature: true,
          },
          {
            id: "umans-glm-5.2",
            contextWindow: 200_000,
            inputModalities: ["text"],
            noReasoning: true,
          },
        ],
      },
      {
        id: "ollama",
        models: [],
      },
      {
        id: "moonshot",
        models: [],
      },
      {
        id: "neuralwatt",
        models: [],
      },
    ],
  };
}

function selectedCatalog(document = bundledCatalog()): SelectedModelCatalog {
  return {
    document,
    status: {
      source: "bundled",
      catalogRevision: document.catalogRevision,
      catalogDigest: document.catalogDigest,
      sourceCommit: document.sourceCommit,
      generatedAt: document.generatedAt,
      skippedRecords: 0,
      warnings: [],
    },
  };
}

function legacyConfig(): FrogConfig {
  return {
    port: 3764,
    defaultProvider: "umans",
    disabledModels: ["umans/user-disabled"],
    providers: {
      umans: {
        adapter: "anthropic",
        baseUrl: "https://api.code.umans.ai/",
        apiKey: "secret",
        apiKeys: ["second", "third"],
        headers: { "x-user-setting": "keep" },
        defaultModel: "user-added",
        models: ["umans-glm-5.1", "user-added"],
      },
    },
  };
}

describe("persisted model catalog config migration", () => {
  test("backs up the legacy config before exact-identity migration and preserves user-owned values", () => {
    const legacy = legacyConfig();
    let backup = "";
    let inputAtBackup = "";

    const migrated = migratePersistedCatalogConfig(legacy, bundledCatalog(), {
      writeBackup: bytes => {
        backup = bytes;
        inputAtBackup = JSON.stringify(legacy);
      },
    });

    expect(migrated.changed).toBe(true);
    expect(migrated.warnings).toEqual([]);
    expect(migrated.config.modelCatalogConfigVersion).toBe(1);
    expect(migrated.config.providers.umans).toEqual({
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai/",
      apiKey: "secret",
      apiKeys: ["second", "third"],
      headers: { "x-user-setting": "keep" },
      defaultModel: "user-added",
      catalogProviderId: "umans",
      userModels: ["user-added"],
    });
    expect(migrated.config.disabledModels).toEqual(["umans/user-disabled"]);
    expect(legacy.modelCatalogConfigVersion).toBeUndefined();
    expect(legacy.providers.umans.models).toEqual(["umans-glm-5.1", "user-added"]);
    expect(inputAtBackup).toBe(JSON.stringify(legacy));
    expect(backup).toContain("\"apiKey\": \"secret\"");
    expect(backup).toBe(`${JSON.stringify(legacy, null, 2)}\n`);
  });

  test("drops stale generated metadata for an exact managed provider during migration", () => {
    const legacy = legacyConfig();
    Object.assign(legacy.providers.umans, {
      contextWindow: 1,
      modelContextWindows: { "umans-glm-5.1": 1, "user-added": 2 },
      modelCapabilities: { "umans-glm-5.1": { input: ["text"] } },
      reasoningEfforts: ["low"],
      modelReasoningEfforts: { "umans-glm-5.1": ["low"] },
      reasoningEffortMap: { low: "low" },
      modelReasoningEffortMap: { "umans-glm-5.1": { low: "low" } },
      noReasoningModels: ["umans-glm-5.1"],
      noTemperatureModels: ["umans-glm-5.1"],
      noTopPModels: ["umans-glm-5.1"],
      noPenaltyModels: ["umans-glm-5.1"],
      autoToolChoiceOnlyModels: ["umans-glm-5.1"],
      preserveReasoningContentModels: ["umans-glm-5.1"],
      escapeBuiltinToolNames: true,
    });

    const migrated = migratePersistedCatalogConfig(legacy, bundledCatalog(), { writeBackup: () => {} });
    const provider = migrated.config.providers.umans;

    for (const field of [
      "contextWindow",
      "modelContextWindows",
      "modelCapabilities",
      "reasoningEfforts",
      "modelReasoningEfforts",
      "reasoningEffortMap",
      "modelReasoningEffortMap",
      "noReasoningModels",
      "noTemperatureModels",
      "noTopPModels",
      "noPenaltyModels",
      "autoToolChoiceOnlyModels",
      "preserveReasoningContentModels",
      "escapeBuiltinToolNames",
    ] as const) {
      expect(provider[field]).toBeUndefined();
    }
  });

  test("keeps renamed providers custom instead of guessing by adapter and URL", () => {
    const legacy = legacyConfig();
    legacy.defaultProvider = "my-umans";
    legacy.providers["my-umans"] = legacy.providers.umans;
    delete legacy.providers.umans;

    const migrated = migratePersistedCatalogConfig(legacy, bundledCatalog(), { writeBackup: () => {} });

    expect(migrated.config.providers["my-umans"]).toEqual(legacy.providers["my-umans"]);
    expect(migrated.config.providers["my-umans"].catalogProviderId).toBeUndefined();
    expect(migrated.warnings.join("\n")).toContain("my-umans");
    expect(migrated.config.modelCatalogConfigVersion).toBe(1);
  });

  test("treats a missing auth mode as canonical key identity for local registry seeds", () => {
    const legacy: FrogConfig = {
      port: 3764,
      defaultProvider: "ollama",
      providers: {
        ollama: {
          adapter: "openai-chat",
          baseUrl: "http://localhost:11434/v1/",
          models: ["local-user-model"],
        },
      },
    };

    const migrated = migratePersistedCatalogConfig(legacy, bundledCatalog(), { writeBackup: () => {} });

    expect(migrated.config.providers.ollama.catalogProviderId).toBe("ollama");
    expect(migrated.config.providers.ollama.authMode).toBeUndefined();
    expect(migrated.config.providers.ollama.userModels).toEqual(["local-user-model"]);
  });

  test("preserves a fixed allowlist and all provider credentials and settings byte-for-byte", () => {
    const legacy = legacyConfig();
    legacy.providers.umans.liveModels = false;
    legacy.providers.umans.authMode = "key";
    legacy.providers.umans.modelContextWindows = { "umans-glm-5.1": 123_456 };
    const beforeProviderBytes = JSON.stringify(legacy.providers.umans);

    const migrated = migratePersistedCatalogConfig(legacy, bundledCatalog(), { writeBackup: () => {} });

    const provider = migrated.config.providers.umans;
    expect(provider.catalogProviderId).toBe("umans");
    expect(provider.liveModels).toBe(false);
    expect(provider.models).toEqual(["umans-glm-5.1", "user-added"]);
    const { catalogProviderId: _managedIdentity, ...persistedFields } = provider;
    expect(JSON.stringify(persistedFields)).toBe(beforeProviderBytes);
  });

  test("does not reclassify current or retired registry models as user additions", () => {
    const legacy: FrogConfig = {
      port: 3764,
      defaultProvider: "moonshot",
      providers: {
        moonshot: {
          adapter: "openai-chat",
          baseUrl: "https://api.moonshot.ai/v1",
          models: ["kimi-k2-0905-preview", "moonshot-private"],
        },
        neuralwatt: {
          adapter: "openai-chat",
          baseUrl: "https://api.neuralwatt.com/v1",
          models: ["kimi-k2.5-fast", "glm-5.2-fast", "qwen3.5-397b-fast", "neural-private"],
        },
      },
    };

    const migrated = migratePersistedCatalogConfig(legacy, bundledCatalog(), { writeBackup: () => {} });

    expect(migrated.config.providers.moonshot.userModels).toEqual(["moonshot-private"]);
    expect(migrated.config.providers.neuralwatt.userModels).toEqual(["neural-private"]);
  });

  test("leaves the input and version marker untouched when backup fails", () => {
    const legacy = legacyConfig();
    const before = JSON.stringify(legacy);

    const migrated = migratePersistedCatalogConfig(legacy, bundledCatalog(), {
      writeBackup: () => { throw new Error("disk full"); },
    });

    expect(migrated.changed).toBe(false);
    expect(migrated.config).toBe(legacy);
    expect(JSON.stringify(legacy)).toBe(before);
    expect(migrated.config.modelCatalogConfigVersion).toBeUndefined();
    expect(migrated.warnings.join("\n")).toContain("disk full");
  });

  test("backup 뒤 save가 실패하면 원본 persisted semantics를 메모리에 유지한다", async () => {
    const legacy = legacyConfig();
    const original = structuredClone(legacy);
    let backupWritten = false;
    const warnings: string[] = [];

    const state = await createRuntimeConfigState({
      loadConfig: () => legacy,
      saveConfig: () => { throw new Error("save failed"); },
      getConfigPath: () => "/tmp/frogp-config.json",
      configExists: () => true,
      readConfig: () => `${JSON.stringify(original, null, 2)}\n`,
      bundledCatalog: bundledCatalog(),
      writeBackup: () => { backupWritten = true; },
      refreshCatalog: async () => selectedCatalog(),
      warn: warning => warnings.push(warning),
    });

    expect(backupWritten).toBeTrue();
    expect(state.persisted).toEqual(original);
    expect(state.persisted.modelCatalogConfigVersion).toBeUndefined();
    expect(state.effective.providers.umans.models).toEqual(original.providers.umans.models);
    expect(warnings.join("\n")).toContain("save failed");
  });

  test("does not back up or mutate an already migrated config", () => {
    const config = { ...legacyConfig(), modelCatalogConfigVersion: 1 as const };
    let backups = 0;

    const migrated = migratePersistedCatalogConfig(config, bundledCatalog(), {
      writeBackup: () => { backups += 1; },
    });

    expect(migrated).toEqual({ config, changed: false, warnings: [] });
    expect(migrated.config).toBe(config);
    expect(backups).toBe(0);
  });

  test("writes the pre-migration backup once with owner-only permissions", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-catalog-migration-"));
    try {
      const configPath = join(home, "config.json");
      writeCatalogConfigBackupOnce(configPath, "{\"apiKey\":\"original\"}\n");
      writeCatalogConfigBackupOnce(configPath, "{\"apiKey\":\"original\"}\n");

      const backupPath = join(home, "config.pre-model-catalog-v1.json");
      expect(readFileSync(backupPath, "utf8")).toBe("{\"apiKey\":\"original\"}\n");
      if (process.platform !== "win32") expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects an incomplete pre-existing backup on the next startup without mutating config", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-catalog-partial-backup-"));
    try {
      const configPath = join(home, "config.json");
      const backupPath = join(home, "config.pre-model-catalog-v1.json");
      const legacy = legacyConfig();
      writeFileSync(backupPath, "{\"partial\":", { mode: 0o600 });

      const migrated = migratePersistedCatalogConfig(legacy, bundledCatalog(), {
        writeBackup: bytes => writeCatalogConfigBackupOnce(configPath, bytes),
      });

      expect(migrated.changed).toBe(false);
      expect(migrated.config).toBe(legacy);
      expect(migrated.config.modelCatalogConfigVersion).toBeUndefined();
      expect(migrated.warnings.join("\n")).toContain("does not match");
      expect(readFileSync(backupPath, "utf8")).toBe("{\"partial\":");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("rejects an existing matching backup unless its mode is 0600", () => {
    const home = mkdtempSync(join(tmpdir(), "frogp-catalog-backup-mode-"));
    try {
      const configPath = join(home, "config.json");
      const backupPath = join(home, "config.pre-model-catalog-v1.json");
      const bytes = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
      writeFileSync(backupPath, bytes, { mode: 0o600 });
      chmodSync(backupPath, 0o644);

      expect(() => writeCatalogConfigBackupOnce(configPath, bytes)).toThrow("mode");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("effective model catalog config", () => {
  test("combines managed and user models while allowing persisted metadata to narrow limits only", () => {
    const persisted: FrogConfig = {
      port: 3764,
      defaultProvider: "umans",
      modelCatalogConfigVersion: 1,
      providers: {
        umans: {
          adapter: "anthropic",
          baseUrl: "https://api.code.umans.ai",
          catalogProviderId: "umans",
          apiKey: "secret",
          defaultModel: "user-added",
          userModels: ["user-added", "umans-coder"],
          modelContextWindows: { "umans-coder": 111_111 },
          noTemperatureModels: [],
        },
      },
    };

    const effective = buildEffectiveConfig(persisted, selectedCatalog());

    expect(effective.providers.umans.models).toEqual(["umans-coder", "umans-glm-5.2", "user-added"]);
    expect(effective.providers.umans.userModels).toEqual(["user-added"]);
    expect(effective.providers.umans.modelContextWindows).toEqual({
      "umans-coder": 111_111,
      "umans-glm-5.2": 200_000,
    });
    expect(effective.providers.umans.modelCapabilities).toEqual({
      "umans-coder": { input: ["text", "image"] },
      "umans-glm-5.2": { input: ["text"] },
    });
    expect(effective.providers.umans.modelReasoningEfforts).toEqual({ "umans-coder": ["low", "high"] });
    expect(effective.providers.umans.noReasoningModels).toEqual(["umans-glm-5.2"]);
    expect(effective.providers.umans.noTemperatureModels).toEqual(["umans-coder"]);
    expect(effective.providers.umans.apiKey).toBe("secret");
    expect(effective.providers.umans.defaultModel).toBe("user-added");
    expect(persisted.providers.umans.models).toBeUndefined();
    expect(persisted.providers.umans.userModels).toEqual(["user-added", "umans-coder"]);
    expect(persisted.providers.umans.noTemperatureModels).toEqual([]);
  });

  test("preserves a full persisted user-model snapshot and accepts an explicit replacement", () => {
    const persisted: FrogConfig = {
      port: 3764,
      defaultProvider: "umans",
      modelCatalogConfigVersion: 1,
      providers: {
        umans: {
          adapter: "anthropic",
          baseUrl: "https://api.code.umans.ai",
          catalogProviderId: "umans",
          userModels: ["user-added", "umans-coder"],
        },
      },
    };
    const effective = buildEffectiveConfig(persisted, selectedCatalog());
    const apiSnapshot = {
      ...effective.providers.umans,
      userModels: [...persisted.providers.umans.userModels!],
    };

    const sanitizedSnapshot = sanitizeCatalogProviderForPersistence(
      "umans",
      apiSnapshot,
      persisted.providers.umans,
      effective.providers.umans,
    );
    const sanitizedExplicitEdit = sanitizeCatalogProviderForPersistence(
      "umans",
      { ...effective.providers.umans, userModels: ["user-added"] },
      persisted.providers.umans,
      effective.providers.umans,
    );

    expect(sanitizedSnapshot.userModels).toEqual(["user-added", "umans-coder"]);
    expect(sanitizedExplicitEdit.userModels).toEqual(["user-added"]);
  });

  test("stores special model IDs as own metadata keys without changing record prototypes", () => {
    const document = bundledCatalog();
    document.providers.find(provider => provider.id === "umans")!.models.push({
      id: "__proto__",
      contextWindow: 123_456,
      inputModalities: ["text"],
      reasoningEfforts: ["low"],
    });
    const persisted: FrogConfig = {
      port: 3764,
      defaultProvider: "umans",
      modelCatalogConfigVersion: 1,
      providers: {
        umans: {
          adapter: "anthropic",
          baseUrl: "https://api.code.umans.ai",
          catalogProviderId: "umans",
          modelReasoningEfforts: { unrelated: ["high"] },
        },
      },
    };

    const provider = buildEffectiveConfig(persisted, selectedCatalog(document)).providers.umans;

    expect(Object.getPrototypeOf(provider.modelCapabilities)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(provider.modelCapabilities, "__proto__")).toBe(true);
    expect(provider.modelCapabilities?.["__proto__"]).toEqual({ input: ["text"] });
    expect(Object.prototype.hasOwnProperty.call(provider.modelContextWindows, "__proto__")).toBe(true);
    expect(provider.modelContextWindows?.["__proto__"]).toBe(123_456);
    expect(Object.prototype.hasOwnProperty.call(provider.modelReasoningEfforts, "__proto__")).toBe(true);
    expect(provider.modelReasoningEfforts?.["__proto__"]).toEqual(["low"]);
  });

  test("retired managed default를 명시적 정책 없이 교체하지 않고 사용자 default 경계를 보존한다", () => {
    const document = bundledCatalog();
    const managed = document.providers.find(provider => provider.id === "umans")!;
    managed.retiredModels = ["umans-glm-5.1"];
    const persisted = legacyConfig();
    persisted.modelCatalogConfigVersion = 1;
    persisted.providers.umans = {
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      catalogProviderId: "umans",
      defaultModel: "umans-glm-5.1",
      userModels: ["user-added", "umans-glm-5.1"],
    };
    persisted.providers.custom = {
      adapter: "anthropic",
      baseUrl: "https://custom.invalid",
      defaultModel: "umans-glm-5.1",
      models: ["umans-glm-5.1"],
    };

    const effective = buildEffectiveConfig(persisted, selectedCatalog(document));

    expect(effective.providers.umans.defaultModel).toBe("umans-glm-5.1");
    expect(effective.providers.umans.models).toContain("umans-glm-5.1");
    expect(effective.providers.umans.userModels).toEqual(["user-added", "umans-glm-5.1"]);
    expect(effective.providers.custom.defaultModel).toBe("umans-glm-5.1");

    persisted.providers.umans.defaultModel = "user-added";
    expect(buildEffectiveConfig(persisted, selectedCatalog(document)).providers.umans.defaultModel)
      .toBe("user-added");
  });

  test("wire model mapping은 이를 지원하는 managed adapter에만 전달한다", () => {
    const document = bundledCatalog();
    document.providers.push({
      id: "wire-provider",
      defaultModel: "claude-opus-4-6[1m]",
      models: [{
        id: "claude-opus-4-6[1m]",
        wireModelId: "claude-opus-4-6",
      }],
    });
    const persisted: FrogConfig = {
      port: 3764,
      defaultProvider: "supported",
      modelCatalogConfigVersion: 1,
      providers: {
        supported: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          catalogProviderId: "wire-provider",
        },
        unsupported: {
          adapter: "openai-chat",
          baseUrl: "https://example.invalid/v1",
          catalogProviderId: "wire-provider",
        },
      },
    };

    const effective = buildEffectiveConfig(persisted, selectedCatalog(document));

    expect(effective.providers.supported.modelWireIds).toEqual({
      "claude-opus-4-6[1m]": "claude-opus-4-6",
    });
    expect(effective.providers.unsupported.modelWireIds).toBeUndefined();
  });

  test("leaves custom and fixed-allowlist providers unchanged in the effective clone", () => {
    const persisted: FrogConfig = {
      port: 3764,
      defaultProvider: "custom",
      modelCatalogConfigVersion: 1,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://custom.invalid", models: ["mine"] },
        fixed: {
          adapter: "anthropic",
          baseUrl: "https://api.code.umans.ai",
          catalogProviderId: "umans",
          liveModels: false,
          models: ["fixed-only"],
          apiKey: "fixed-secret",
        },
      },
    };

    const effective = buildEffectiveConfig(persisted, selectedCatalog());

    expect(effective.providers).toEqual(persisted.providers);
    expect(effective.providers.custom).not.toBe(persisted.providers.custom);
    expect(effective.providers.fixed).not.toBe(persisted.providers.fixed);
  });
});

describe("registry user seed", () => {
  test("contains only user-owned identity, auth mode, and selected default fields", () => {
    expect(providerUserSeedFromRegistry("umans")).toEqual({
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      authMode: "key",
      catalogProviderId: "umans",
      defaultModel: "umans-coder",
    });
  });
});
