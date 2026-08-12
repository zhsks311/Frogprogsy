import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SelectedModelCatalog } from "./model-catalog-runtime";
import type { ModelCatalogDocumentV1, ModelCatalogProviderV1 } from "./model-catalog-schema";
import { providerConfigSeed } from "./providers/derive";
import {
  PROVIDER_REGISTRY,
  providerUserSeedFromRegistry as registryUserSeed,
  type ProviderRegistryEntry,
} from "./providers/registry";
import type { FrogConfig, FrogProviderConfig } from "./types";

export interface CatalogConfigMigrationResult {
  config: FrogConfig;
  changed: boolean;
  warnings: string[];
}

export interface CatalogConfigMigrationDeps {
  writeBackup(bytes: string): void;
}

export function writeCatalogConfigBackupOnce(configPath: string, bytes: string): void {
  const backupPath = join(dirname(configPath), "config.pre-model-catalog-v1.json");
  try {
    writeFileSync(backupPath, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(backupPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
}

const MANAGED_METADATA_FIELDS = [
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
] as const satisfies readonly (keyof FrogProviderConfig)[];

const RECORD_METADATA_FIELDS = new Set<keyof FrogProviderConfig>([
  "modelContextWindows",
  "modelCapabilities",
  "modelReasoningEfforts",
  "reasoningEffortMap",
  "modelReasoningEffortMap",
]);

const LEGACY_RETIRED_MODELS_BY_PROVIDER: Record<string, readonly string[]> = {
  umans: ["umans-kimi-k2.6", "umans-glm-5.1", "umans-qwen3.6-35b-a3b"],
  neuralwatt: [
    "moonshotai/Kimi-K2.5",
    "kimi-k2.5-fast",
    "kimi-k2.6",
    "kimi-k2.6-fast",
    "qwen3.5-397b",
    "qwen3.5-397b-fast",
  ],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
};

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function providerAuthMode(provider: FrogProviderConfig): string {
  return provider.authMode ?? "key";
}

function registryAuthMode(entry: ProviderRegistryEntry): string {
  return entry.authKind === "local" ? "key" : entry.authKind;
}

function hasRegistryIdentity(provider: FrogProviderConfig, entry: ProviderRegistryEntry): boolean {
  return provider.adapter === entry.adapter
    && normalizedBaseUrl(provider.baseUrl) === normalizedBaseUrl(entry.baseUrl)
    && providerAuthMode(provider) === registryAuthMode(entry);
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function catalogProviderConfig(provider: ModelCatalogProviderV1): Partial<FrogProviderConfig> {
  const models = provider.models.map(model => model.id);
  const modelContextWindows: Record<string, number> = {};
  const modelCapabilities: NonNullable<FrogProviderConfig["modelCapabilities"]> = {};
  const modelReasoningEfforts: Record<string, string[]> = {};
  const modelReasoningEffortMap: Record<string, Record<string, string>> = {};
  const noReasoningModels: string[] = [];
  const noTemperatureModels: string[] = [];
  const noTopPModels: string[] = [];
  const noPenaltyModels: string[] = [];
  const autoToolChoiceOnlyModels: string[] = [];
  const preserveReasoningContentModels: string[] = [];

  for (const model of provider.models) {
    if (model.contextWindow !== undefined) modelContextWindows[model.id] = model.contextWindow;
    if (model.inputModalities !== undefined) modelCapabilities[model.id] = { input: [...model.inputModalities] };
    if (model.reasoningEfforts !== undefined) modelReasoningEfforts[model.id] = [...model.reasoningEfforts];
    if (model.reasoningEffortMap !== undefined) modelReasoningEffortMap[model.id] = { ...model.reasoningEffortMap };
    if (model.noReasoning) noReasoningModels.push(model.id);
    if (model.noTemperature) noTemperatureModels.push(model.id);
    if (model.noTopP) noTopPModels.push(model.id);
    if (model.noPenalty) noPenaltyModels.push(model.id);
    if (model.autoToolChoiceOnly) autoToolChoiceOnlyModels.push(model.id);
    if (model.preserveReasoningContent) preserveReasoningContentModels.push(model.id);
  }

  return {
    models,
    ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
    ...(Object.keys(modelContextWindows).length > 0 ? { modelContextWindows } : {}),
    ...(Object.keys(modelCapabilities).length > 0 ? { modelCapabilities } : {}),
    ...(Object.keys(modelReasoningEfforts).length > 0 ? { modelReasoningEfforts } : {}),
    ...(Object.keys(modelReasoningEffortMap).length > 0 ? { modelReasoningEffortMap } : {}),
    ...(noReasoningModels.length > 0 ? { noReasoningModels } : {}),
    ...(noTemperatureModels.length > 0 ? { noTemperatureModels } : {}),
    ...(noTopPModels.length > 0 ? { noTopPModels } : {}),
    ...(noPenaltyModels.length > 0 ? { noPenaltyModels } : {}),
    ...(autoToolChoiceOnlyModels.length > 0 ? { autoToolChoiceOnlyModels } : {}),
    ...(preserveReasoningContentModels.length > 0 ? { preserveReasoningContentModels } : {}),
    ...(provider.escapeBuiltinToolNames !== undefined
      ? { escapeBuiltinToolNames: provider.escapeBuiltinToolNames }
      : {}),
  };
}

function stripLegacyManagedMetadata(
  provider: FrogProviderConfig,
  catalogProvider: ModelCatalogProviderV1,
  registryEntry: ProviderRegistryEntry,
): void {
  const catalogMetadata = catalogProviderConfig(catalogProvider);
  const legacyRegistryMetadata = providerConfigSeed(registryEntry);
  for (const field of MANAGED_METADATA_FIELDS) {
    if (provider[field] === undefined) continue;
    if (equalJson(provider[field], catalogMetadata[field]) || equalJson(provider[field], legacyRegistryMetadata[field])) {
      delete provider[field];
    }
  }
}

export function migratePersistedCatalogConfig(
  config: FrogConfig,
  bundled: ModelCatalogDocumentV1,
  deps: CatalogConfigMigrationDeps,
): CatalogConfigMigrationResult {
  if (config.modelCatalogConfigVersion === 1) {
    return { config, changed: false, warnings: [] };
  }

  try {
    deps.writeBackup(`${JSON.stringify(config, null, 2)}\n`);
  } catch (error) {
    return {
      config,
      changed: false,
      warnings: [`Model catalog config backup failed; migration was not applied: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const migrated = structuredClone(config);
  const warnings: string[] = [];
  const bundledById = new Map(bundled.providers.map(provider => [provider.id, provider]));

  for (const [providerName, provider] of Object.entries(migrated.providers)) {
    const exactEntries = PROVIDER_REGISTRY.filter(entry => entry.id === providerName && hasRegistryIdentity(provider, entry));
    const identityMatches = PROVIDER_REGISTRY.filter(entry => hasRegistryIdentity(provider, entry));
    if (exactEntries.length !== 1) {
      if (identityMatches.length > 1) {
        warnings.push(`Provider "${providerName}" matches multiple registry identities and remains custom.`);
      } else if (identityMatches.length === 1 || PROVIDER_REGISTRY.some(entry => entry.id === providerName)) {
        warnings.push(`Provider "${providerName}" does not have an exact registry identity and remains custom.`);
      }
      continue;
    }

    const registryEntry = exactEntries[0];
    const catalogProvider = bundledById.get(registryEntry.id);
    if (!catalogProvider) {
      warnings.push(`Provider "${providerName}" is absent from the bundled catalog and remains custom.`);
      continue;
    }

    provider.catalogProviderId = registryEntry.id;
    if (provider.liveModels === false) continue;

    const managedModels = new Set([
      ...catalogProvider.models.map(model => model.id),
      ...(catalogProvider.retiredModels ?? []),
      ...(LEGACY_RETIRED_MODELS_BY_PROVIDER[registryEntry.id] ?? []),
    ]);
    const legacyModels = Array.isArray(provider.models) ? provider.models : [];
    provider.userModels = uniqueStrings([
      ...(provider.userModels ?? []),
      ...legacyModels.filter(model => !managedModels.has(model)),
    ]);
    if (provider.userModels.length === 0) delete provider.userModels;
    delete provider.models;
    stripLegacyManagedMetadata(provider, catalogProvider, registryEntry);
  }

  migrated.modelCatalogConfigVersion = 1;
  return { config: migrated, changed: true, warnings };
}

function mergeManagedProvider(
  persisted: FrogProviderConfig,
  catalogProvider: ModelCatalogProviderV1,
): FrogProviderConfig {
  const managed = catalogProviderConfig(catalogProvider);
  const effective = { ...managed, ...persisted } as FrogProviderConfig;
  effective.models = uniqueStrings([
    ...(managed.models ?? []),
    ...(persisted.userModels ?? []),
  ]);

  for (const field of RECORD_METADATA_FIELDS) {
    const managedValue = managed[field];
    const persistedValue = persisted[field];
    if (!managedValue || typeof managedValue !== "object" || Array.isArray(managedValue)) continue;
    if (!persistedValue || typeof persistedValue !== "object" || Array.isArray(persistedValue)) continue;
    effective[field] = { ...managedValue, ...persistedValue } as never;
  }
  return effective;
}

export function buildEffectiveConfig(persisted: FrogConfig, selected: SelectedModelCatalog): FrogConfig {
  const effective = structuredClone(persisted);
  const catalogById = new Map(selected.document.providers.map(provider => [provider.id, provider]));
  effective.providers = Object.fromEntries(Object.entries(effective.providers).map(([name, provider]) => {
    if (!provider.catalogProviderId || provider.liveModels === false) return [name, provider];
    const catalogProvider = catalogById.get(provider.catalogProviderId);
    return [name, catalogProvider ? mergeManagedProvider(provider, catalogProvider) : provider];
  }));
  return effective;
}

export function providerUserSeedFromRegistry(catalogProviderId: string): FrogProviderConfig {
  return registryUserSeed(catalogProviderId);
}
