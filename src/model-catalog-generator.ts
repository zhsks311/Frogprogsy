import { createHash } from "node:crypto";
import {
  listJawcodeModelMetadata,
  type JawcodeModelMetadata,
} from "./generated/jawcode-model-metadata";
import { MODEL_CATALOG_REVISION } from "./model-catalog-revision";
import {
  modelCatalogDocumentV1Schema,
  type ModelCatalogDocumentV1,
  type ModelCatalogModelV1,
  type ModelCatalogProviderV1,
} from "./model-catalog-schema";
import {
  PROVIDER_REGISTRY,
  type ProviderRegistryEntry,
} from "./providers/registry";

const MIN_FROGPROGSY_VERSION = "0.0.2-preview.2";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) {
      sorted[key] = canonicalize(record[key]);
    }
  }
  return sorted;
}

export function catalogDataDigest(
  input: Pick<ModelCatalogDocumentV1, "providers">,
): string {
  const canonicalJson = JSON.stringify(canonicalize(input.providers));
  return createHash("sha256").update(canonicalJson).digest("hex");
}

function addModelIds(ids: Set<string>, values: readonly string[] | undefined): void {
  for (const value of values ?? []) {
    ids.add(value);
  }
}

function modelIdsForProvider(
  provider: ProviderRegistryEntry,
  jawcodeModels: readonly JawcodeModelMetadata[],
): string[] {
  const ids = new Set<string>(provider.models ?? []);
  if (provider.defaultModel !== undefined) {
    ids.add(provider.defaultModel);
  }
  if (provider.id === "openrouter") {
    addModelIds(ids, jawcodeModels.map(model => model.id));
  }
  for (const unmanagedModel of provider.unmanagedModels ?? []) {
    ids.delete(unmanagedModel);
  }
  return [...ids].sort();
}

function includes(values: readonly string[] | undefined, modelId: string): boolean {
  return values?.includes(modelId) ?? false;
}

function sortedRecord(input: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of Object.keys(input).sort()) {
    output[key] = input[key];
  }
  return output;
}

function modelFromSources(
  provider: ProviderRegistryEntry,
  modelId: string,
  jawcodeModel: JawcodeModelMetadata | undefined,
): ModelCatalogModelV1 {
  const model: ModelCatalogModelV1 = { id: modelId };
  const minFrogprogsyVersion = provider.modelMinFrogprogsyVersions?.[modelId];
  const contextWindow = provider.modelContextWindows?.[modelId]
    ?? provider.contextWindow
    ?? jawcodeModel?.contextWindow;
  const inputModalities = provider.modelCapabilities?.[modelId]?.input
    ?? jawcodeModel?.input;
  const reasoningEfforts = provider.modelReasoningEfforts?.[modelId]
    ?? provider.reasoningEfforts;
  const reasoningEffortMap = provider.modelReasoningEffortMap?.[modelId]
    ?? provider.reasoningEffortMap;

  if (minFrogprogsyVersion !== undefined) {
    model.minFrogprogsyVersion = minFrogprogsyVersion;
  }
  if (contextWindow !== undefined) {
    model.contextWindow = contextWindow;
  }
  if (inputModalities !== undefined) {
    model.inputModalities = [...inputModalities];
  }
  if (reasoningEfforts !== undefined) {
    model.reasoningEfforts = [...reasoningEfforts] as ModelCatalogModelV1["reasoningEfforts"];
  }
  if (reasoningEffortMap !== undefined) {
    model.reasoningEffortMap = sortedRecord(reasoningEffortMap);
  }
  if (jawcodeModel?.wireModelId !== undefined) {
    model.wireModelId = jawcodeModel.wireModelId;
  }
  if (includes(provider.noReasoningModels, modelId) || jawcodeModel?.reasoning === false) {
    model.noReasoning = true;
  }
  if (includes(provider.noTemperatureModels, modelId)) {
    model.noTemperature = true;
  }
  if (includes(provider.noTopPModels, modelId)) {
    model.noTopP = true;
  }
  if (includes(provider.noPenaltyModels, modelId)) {
    model.noPenalty = true;
  }
  if (includes(provider.autoToolChoiceOnlyModels, modelId)) {
    model.autoToolChoiceOnly = true;
  }
  if (includes(provider.preserveReasoningContentModels, modelId)) {
    model.preserveReasoningContent = true;
  }

  return model;
}

function providerFromRegistry(provider: ProviderRegistryEntry): ModelCatalogProviderV1 {
  const jawcodeModels = provider.jawcodeBundle === undefined
    ? []
    : listJawcodeModelMetadata(provider.jawcodeBundle);
  const verifiedJawcodeModelIds = provider.id === "openrouter"
    ? undefined
    : new Set(provider.verifiedJawcodeModels ?? []);
  const managedJawcodeModels = verifiedJawcodeModelIds === undefined
    ? jawcodeModels
    : jawcodeModels.filter(model => verifiedJawcodeModelIds.has(model.id));
  const jawcodeById = new Map(managedJawcodeModels.map(model => [model.id, model]));
  const models = modelIdsForProvider(provider, managedJawcodeModels)
    .map(modelId => modelFromSources(provider, modelId, jawcodeById.get(modelId)));

  const catalogProvider: ModelCatalogProviderV1 = {
    id: provider.id,
    models,
  };
  if (provider.minFrogprogsyVersion !== undefined) {
    catalogProvider.minFrogprogsyVersion = provider.minFrogprogsyVersion;
  }
  if (provider.retiredModels !== undefined) {
    catalogProvider.retiredModels = [...provider.retiredModels].sort();
  }
  if (provider.unmanagedModels !== undefined) {
    catalogProvider.unmanagedModels = [...provider.unmanagedModels].sort();
  }
  if (provider.defaultModel !== undefined) {
    catalogProvider.defaultModel = provider.defaultModel;
  }
  if (provider.escapeBuiltinToolNames !== undefined) {
    catalogProvider.escapeBuiltinToolNames = provider.escapeBuiltinToolNames;
  }
  return catalogProvider;
}

export function generateModelCatalog(
  input: {
    sourceCommit: string;
    generatedAt: string;
    catalogRevision?: number;
  },
  registry: readonly ProviderRegistryEntry[] = PROVIDER_REGISTRY,
): ModelCatalogDocumentV1 {
  const providers = registry
    .map(providerFromRegistry)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const document: ModelCatalogDocumentV1 = {
    schemaVersion: 1,
    catalogRevision: input.catalogRevision ?? MODEL_CATALOG_REVISION,
    catalogDigest: catalogDataDigest({ providers }),
    sourceCommit: input.sourceCommit,
    generatedAt: input.generatedAt,
    minFrogprogsyVersion: MIN_FROGPROGSY_VERSION,
    providers,
  };
  return modelCatalogDocumentV1Schema.parse(document);
}
