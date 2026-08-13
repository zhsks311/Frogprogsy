import { closeSync, chmodSync, linkSync, openSync, readFileSync, fsyncSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { supportsWireModelIds } from "./adapters/base";
import type { SelectedModelCatalog } from "./model-catalog-runtime";
import type { ModelCatalogDocumentV1, ModelCatalogProviderV1 } from "./model-catalog-schema";
import { intersectReasoningEfforts, mergeReasoningEffortMap } from "./reasoning-effort";
import { providerConfigSeed } from "./providers/derive";
import {
  PROVIDER_REGISTRY,
  providerUserSeedFromRegistry as registryUserSeed,
  type ProviderRegistryEntry,
} from "./providers/registry";
import type { FrogConfig, FrogModelCapabilities, FrogProviderConfig } from "./types";

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
  const tempPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(tempPath, 0o600);
    const descriptor = openSync(tempPath, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(tempPath, backupPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (readFileSync(backupPath, "utf8") !== bytes) {
      throw new Error(`Existing model catalog config backup at ${backupPath} does not match config.json bytes.`);
    }
    if (process.platform !== "win32" && (statSync(backupPath).mode & 0o777) !== 0o600) {
      throw new Error(`Existing model catalog config backup at ${backupPath} must have mode 0600.`);
    }
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // The backup result is authoritative; temporary-file cleanup is best-effort.
    }
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
const MANAGED_METADATA_FIELD_SET = new Set<keyof FrogProviderConfig>(MANAGED_METADATA_FIELDS);

const USER_OWNED_PROVIDER_FIELDS = [
  "adapter",
  "baseUrl",
  "apiKey",
  "apiKeys",
  "defaultModel",
  "userModels",
  "liveModels",
  "contextWindow",
  "modelContextWindows",
  "modelCapabilities",
  "headers",
  "authMode",
  "claudeGrantId",
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

function setOwnRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function ownRecordValue<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function catalogProviderConfig(provider: ModelCatalogProviderV1): Partial<FrogProviderConfig> {
  const models = provider.models.map(model => model.id);
  const modelContextWindows: Record<string, number> = {};
  const modelCapabilities: NonNullable<FrogProviderConfig["modelCapabilities"]> = {};
  const modelReasoningEfforts: Record<string, string[]> = {};
  const modelWireIds: Record<string, string> = {};
  const modelReasoningEffortMap: Record<string, Record<string, string>> = {};
  const noReasoningModels: string[] = [];
  const noTemperatureModels: string[] = [];
  const noTopPModels: string[] = [];
  const noPenaltyModels: string[] = [];
  const autoToolChoiceOnlyModels: string[] = [];
  const preserveReasoningContentModels: string[] = [];

  for (const model of provider.models) {
    if (model.contextWindow !== undefined) setOwnRecordValue(modelContextWindows, model.id, model.contextWindow);
    if (model.inputModalities !== undefined) setOwnRecordValue(modelCapabilities, model.id, { input: [...model.inputModalities] });
    if (model.reasoningEfforts !== undefined) setOwnRecordValue(modelReasoningEfforts, model.id, [...model.reasoningEfforts]);
    if (model.reasoningEffortMap !== undefined) setOwnRecordValue(modelReasoningEffortMap, model.id, { ...model.reasoningEffortMap });
    if (model.wireModelId !== undefined) setOwnRecordValue(modelWireIds, model.id, model.wireModelId);
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
    ...(Object.keys(modelWireIds).length > 0 ? { modelWireIds } : {}),
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
      ...(registryEntry.models ?? []),
      ...(registryEntry.retiredModels ?? []),
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

function minimumPositive(left: number | undefined, right: number | undefined): number | undefined {
  const values = [left, right].filter((value): value is number => typeof value === "number" && value > 0);
  return values.length > 0 ? Math.min(...values) : undefined;
}

function intersectValues<T>(managed: readonly T[] | undefined, userOverride: readonly T[] | undefined): T[] | undefined {
  if (managed === undefined) return userOverride === undefined ? undefined : [...userOverride];
  if (userOverride === undefined) return [...managed];
  return managed.filter(value => userOverride.includes(value));
}

function mergePositiveRecords(
  managed: Record<string, number> | undefined,
  userOverride: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!managed && !userOverride) return undefined;
  const merged: Record<string, number> = {};
  for (const key of new Set([...Object.keys(managed ?? {}), ...Object.keys(userOverride ?? {})])) {
    const value = minimumPositive(ownRecordValue(managed, key), ownRecordValue(userOverride, key));
    if (value !== undefined) setOwnRecordValue(merged, key, value);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeModelCapabilities(
  managed: Record<string, FrogModelCapabilities> | undefined,
  userOverride: Record<string, FrogModelCapabilities> | undefined,
): Record<string, FrogModelCapabilities> | undefined {
  if (!managed && !userOverride) return undefined;
  const merged: Record<string, FrogModelCapabilities> = {};
  for (const key of new Set([...Object.keys(managed ?? {}), ...Object.keys(userOverride ?? {})])) {
    const managedCapabilities = ownRecordValue(managed, key);
    const userCapabilities = ownRecordValue(userOverride, key);
    const input = intersectValues(managedCapabilities?.input, userCapabilities?.input);
    setOwnRecordValue(merged, key, {
      ...managedCapabilities,
      ...userCapabilities,
      ...(input !== undefined ? { input } : {}),
    });
  }
  return merged;
}

function mergeReasoningEffortRecords(
  managed: Record<string, string[]> | undefined,
  userOverride: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!managed && !userOverride) return undefined;
  const merged: Record<string, string[]> = {};
  for (const key of new Set([...Object.keys(managed ?? {}), ...Object.keys(userOverride ?? {})])) {
    const efforts = intersectReasoningEfforts(ownRecordValue(managed, key), ownRecordValue(userOverride, key));
    if (efforts !== undefined) setOwnRecordValue(merged, key, efforts);
  }
  return merged;
}

function mergeReasoningEffortMapRecords(
  managed: Record<string, Record<string, string>> | undefined,
  userOverride: Record<string, Record<string, string>> | undefined,
  modelEfforts: Record<string, string[]> | undefined,
  providerEfforts: readonly string[] | undefined,
): Record<string, Record<string, string>> | undefined {
  if (!managed && !userOverride) return undefined;
  const merged: Record<string, Record<string, string>> = {};
  for (const key of new Set([...Object.keys(managed ?? {}), ...Object.keys(userOverride ?? {})])) {
    const effortMap = mergeReasoningEffortMap(
      undefined,
      ownRecordValue(managed, key),
      ownRecordValue(userOverride, key),
      ownRecordValue(modelEfforts, key) ?? providerEfforts,
    );
    if (effortMap !== undefined) setOwnRecordValue(merged, key, effortMap);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function unionRestrictions(
  managed: readonly string[] | undefined,
  userOverride: readonly string[] | undefined,
): string[] | undefined {
  if (!managed && !userOverride) return undefined;
  return uniqueStrings([...(managed ?? []), ...(userOverride ?? [])]);
}

function mergeManagedProvider(
  persisted: FrogProviderConfig,
  catalogProvider: ModelCatalogProviderV1,
): FrogProviderConfig {
  const managed = catalogProviderConfig(catalogProvider);
  const effective = { ...managed, ...persisted } as FrogProviderConfig;
  const managedModelIds = new Set(managed.models ?? []);
  const retiredModelIds = new Set(catalogProvider.retiredModels ?? []);
  const persistedUserModels = uniqueStrings(persisted.userModels ?? []);
  effective.models = uniqueStrings([
    ...(managed.models ?? []),
    ...persistedUserModels,
  ]);
  const effectiveUserModels = persistedUserModels.filter(model => !managedModelIds.has(model));
  if (effectiveUserModels.length > 0) effective.userModels = effectiveUserModels;
  else delete effective.userModels;

  if (persisted.defaultModel !== undefined && retiredModelIds.has(persisted.defaultModel)) {
    if (managed.defaultModel !== undefined) effective.defaultModel = managed.defaultModel;
    else delete effective.defaultModel;
  }

  if (supportsWireModelIds(persisted.adapter) && managed.modelWireIds !== undefined) {
    effective.modelWireIds = managed.modelWireIds;
  } else {
    delete effective.modelWireIds;
  }

  const contextWindow = minimumPositive(managed.contextWindow, persisted.contextWindow);
  if (contextWindow !== undefined) effective.contextWindow = contextWindow;
  else delete effective.contextWindow;

  const modelContextWindows = mergePositiveRecords(managed.modelContextWindows, persisted.modelContextWindows);
  if (modelContextWindows !== undefined) effective.modelContextWindows = modelContextWindows;
  else delete effective.modelContextWindows;

  const modelCapabilities = mergeModelCapabilities(managed.modelCapabilities, persisted.modelCapabilities);
  if (modelCapabilities !== undefined) effective.modelCapabilities = modelCapabilities;
  else delete effective.modelCapabilities;

  const reasoningEfforts = intersectReasoningEfforts(managed.reasoningEfforts, persisted.reasoningEfforts);
  if (reasoningEfforts !== undefined) effective.reasoningEfforts = reasoningEfforts;
  else delete effective.reasoningEfforts;

  const modelReasoningEfforts = mergeReasoningEffortRecords(
    managed.modelReasoningEfforts,
    persisted.modelReasoningEfforts,
  );
  if (modelReasoningEfforts !== undefined) effective.modelReasoningEfforts = modelReasoningEfforts;
  else delete effective.modelReasoningEfforts;

  const reasoningEffortMap = mergeReasoningEffortMap(
    undefined,
    managed.reasoningEffortMap,
    persisted.reasoningEffortMap,
    reasoningEfforts,
  );
  if (reasoningEffortMap !== undefined) effective.reasoningEffortMap = reasoningEffortMap;
  else delete effective.reasoningEffortMap;

  const modelReasoningEffortMap = mergeReasoningEffortMapRecords(
    managed.modelReasoningEffortMap,
    persisted.modelReasoningEffortMap,
    modelReasoningEfforts,
    reasoningEfforts,
  );
  if (modelReasoningEffortMap !== undefined) effective.modelReasoningEffortMap = modelReasoningEffortMap;
  else delete effective.modelReasoningEffortMap;

  for (const field of [
    "noReasoningModels",
    "noTemperatureModels",
    "noTopPModels",
    "noPenaltyModels",
    "autoToolChoiceOnlyModels",
    "preserveReasoningContentModels",
  ] as const) {
    const restrictions = unionRestrictions(managed[field], persisted[field]);
    if (restrictions !== undefined) effective[field] = restrictions;
    else delete effective[field];
  }

  if (managed.escapeBuiltinToolNames !== undefined || persisted.escapeBuiltinToolNames !== undefined) {
    effective.escapeBuiltinToolNames = managed.escapeBuiltinToolNames === true
      || persisted.escapeBuiltinToolNames === true;
  } else {
    delete effective.escapeBuiltinToolNames;
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

export function sanitizeCatalogProviderForPersistence(
  catalogProviderId: string,
  submitted: FrogProviderConfig,
  current?: FrogProviderConfig,
  effectiveCurrent?: FrogProviderConfig,
): FrogProviderConfig {
  const seed = registryUserSeed(catalogProviderId);
  const sameCatalogCurrent = current?.catalogProviderId === catalogProviderId ? current : undefined;
  const sameCatalogEffective = effectiveCurrent?.catalogProviderId === catalogProviderId ? effectiveCurrent : undefined;
  const combined = sameCatalogCurrent ? { ...sameCatalogCurrent, ...submitted } : submitted;
  if (combined.liveModels === false) {
    return structuredClone({
      ...combined,
      catalogProviderId,
    });
  }

  const sanitized = { ...seed };
  for (const field of USER_OWNED_PROVIDER_FIELDS) {
    const submittedValue = submitted[field];
    const isUnchangedManagedSnapshot = MANAGED_METADATA_FIELD_SET.has(field)
      && submittedValue !== undefined
      && sameCatalogEffective !== undefined
      && equalJson(submittedValue, sameCatalogEffective[field]);
    const value = isUnchangedManagedSnapshot
      ? sameCatalogCurrent?.[field]
      : submittedValue !== undefined
        ? submittedValue
        : sameCatalogCurrent?.[field];
    if (value !== undefined) sanitized[field] = structuredClone(value) as never;
  }
  return sanitized;
}

export function providerUserSeedFromRegistry(catalogProviderId: string): FrogProviderConfig {
  return registryUserSeed(catalogProviderId);
}
