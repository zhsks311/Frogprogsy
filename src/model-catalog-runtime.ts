import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdir as mkdirFileSystem,
  open as openFileSystem,
  readFile as readFileSystem,
  rename as renameFileSystem,
  unlink as unlinkFileSystem,
} from "node:fs/promises";
import * as z from "zod/v4";
import { dirname } from "node:path";
import { getModelCatalogCachePath } from "./config";
import { catalogDataDigest } from "./model-catalog-generator";
import {
  modelCatalogProviderV1Schema,
  type CatalogSource,
  type ModelCatalogDocumentV1,
  type ModelCatalogModelV1,
  type ModelCatalogProviderV1,
} from "./model-catalog-schema";

export const MODEL_CATALOG_REMOTE_URL = "https://zhsks311.github.io/frog-progsy/catalog/v1/model-catalog.json";

const FETCH_TIMEOUT_MS = 2_000;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDERS = 256;
const MAX_MODELS = 20_000;
const JSON_CONTENT_TYPE = /^(?:application\/json|[^/\s]+\/[^;\s]+\+json)(?:\s*;|$)/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

const generatedAtSchema = z.iso.datetime({ offset: true });
export interface CatalogRuntimeStatus {
  source: CatalogSource;
  catalogRevision: number;
  catalogDigest: string;
  sourceCommit: string;
  generatedAt: string;
  refreshedAt?: string;
  skippedRecords: number;
  warnings: string[];
}

export interface SelectedModelCatalog {
  document: ModelCatalogDocumentV1;
  status: CatalogRuntimeStatus;
}

export type CatalogValidationResult = {
  ok: true;
  document: ModelCatalogDocumentV1;
  skippedRecords: number;
  warnings: string[];
} | {
  ok: false;
  warnings: string[];
};

export interface ModelCatalogFileHandle {
  writeFile(data: string, options?: { encoding?: BufferEncoding }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ModelCatalogFileSystem {
  readFile(path: string | URL, encoding: BufferEncoding): Promise<string>;
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  open(path: string, flags: string, mode?: number): Promise<ModelCatalogFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface ModelCatalogRuntimeDeps {
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  remoteUrl?: string | URL;
  fileSystem?: Partial<ModelCatalogFileSystem>;
  now?: () => Date;
  runtimeVersion?: string;
  bundled?: ModelCatalogDocumentV1;
  cachePath?: string;
}

interface ValidCandidate {
  raw: unknown;
  document: ModelCatalogDocumentV1;
  skippedRecords: number;
}

interface ParsedSemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: (number | string)[];
}

const defaultFileSystem: ModelCatalogFileSystem = {
  readFile: (path, encoding) => readFileSystem(path, encoding),
  mkdir: (path, options) => mkdirFileSystem(path, options),
  open: (path, flags, mode) => openFileSystem(path, flags, mode),
  rename: (oldPath, newPath) => renameFileSystem(oldPath, newPath),
  unlink: path => unlinkFileSystem(path),
};

const defaultBundledCatalog = JSON.parse(readFileSync(
  new URL("./generated/model-catalog-v1.json", import.meta.url),
  "utf8",
)) as ModelCatalogDocumentV1;

const defaultRuntimeVersion = (() => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json must contain a non-empty version");
  }
  return packageJson.version;
})();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSemVer(value: string): ParsedSemVer | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split(".").map(identifier => {
    if (/^(0|[1-9]\d*)$/.test(identifier)) return Number(identifier);
    return identifier;
  }) ?? [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      if (leftPart === rightPart) return 0;
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "string") return -1;
    if (typeof leftPart === "string" && typeof rightPart === "number") return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function isRuntimeCompatible(minimumVersion: unknown, runtimeVersion: string): boolean | null {
  if (typeof minimumVersion !== "string" || minimumVersion.length === 0) return null;
  const minimum = parseSemVer(minimumVersion);
  const runtime = parseSemVer(runtimeVersion);
  if (!minimum || !runtime) return null;
  return compareSemVer(runtime, minimum) >= 0;
}

function prefixOf(value: unknown): { id: string; minFrogprogsyVersion?: string } | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return null;
  if (value.minFrogprogsyVersion !== undefined
    && (typeof value.minFrogprogsyVersion !== "string" || value.minFrogprogsyVersion.length === 0)) {
    return null;
  }
  return value.minFrogprogsyVersion === undefined
    ? { id: value.id }
    : { id: value.id, minFrogprogsyVersion: value.minFrogprogsyVersion };
}

function validateEnvelope(raw: unknown, runtimeVersion: string, now: Date): raw is Record<string, unknown> & {
  schemaVersion: 1;
  catalogRevision: number;
  catalogDigest: string;
  sourceCommit: string;
  generatedAt: string;
  minFrogprogsyVersion: string;
  providers: unknown[];
} {
  if (!isRecord(raw)) return false;
  const allowedKeys = new Set([
    "schemaVersion",
    "catalogRevision",
    "catalogDigest",
    "sourceCommit",
    "generatedAt",
    "minFrogprogsyVersion",
    "providers",
  ]);
  if (Object.keys(raw).some(key => !allowedKeys.has(key))) return false;
  if (raw.schemaVersion !== 1
    || typeof raw.catalogRevision !== "number"
    || !Number.isInteger(raw.catalogRevision)
    || raw.catalogRevision <= 0
    || typeof raw.catalogDigest !== "string"
    || !SHA256_PATTERN.test(raw.catalogDigest)
    || typeof raw.sourceCommit !== "string"
    || !COMMIT_PATTERN.test(raw.sourceCommit)
    || typeof raw.generatedAt !== "string"
    || !generatedAtSchema.safeParse(raw.generatedAt).success
    || !Array.isArray(raw.providers)) {
    return false;
  }
  const compatible = isRuntimeCompatible(raw.minFrogprogsyVersion, runtimeVersion);
  if (compatible !== true) return false;
  const generatedAt = Date.parse(raw.generatedAt);
  if (!Number.isFinite(generatedAt) || generatedAt > now.getTime()) return false;
  return true;
}

function countWithinLimits(raw: unknown): boolean {
  if (!isRecord(raw) || !Array.isArray(raw.providers) || raw.providers.length > MAX_PROVIDERS) return false;
  let modelCount = 0;
  for (const provider of raw.providers) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    modelCount += provider.models.length;
    if (modelCount > MAX_MODELS) return false;
  }
  return true;
}

function overlayProvider(
  rawProvider: Record<string, unknown>,
  bundledProvider: ModelCatalogProviderV1,
  runtimeVersion: string,
): { provider: ModelCatalogProviderV1; skippedRecords: number; warning?: string } {
  if (!Array.isArray(rawProvider.models)) {
    return { provider: bundledProvider, skippedRecords: 1, warning: `Provider ${bundledProvider.id} was skipped after validation.` };
  }
  let skippedRecords = 0;

  let invalidPrefix = false;
  const compatibleModels: unknown[] = [];
  const seenModelIds = new Set<string>();
  for (const rawModel of rawProvider.models) {
    const prefix = prefixOf(rawModel);
    if (!prefix) {
      invalidPrefix = true;
      break;
    }
    if (prefix.minFrogprogsyVersion !== undefined) {
      const compatible = isRuntimeCompatible(prefix.minFrogprogsyVersion, runtimeVersion);
      if (compatible === null) {
        invalidPrefix = true;
        break;
      }
      if (!compatible) {
        skippedRecords++;
        continue;
      }
    }
    if (seenModelIds.has(prefix.id)) {
      invalidPrefix = true;
      break;
    }
    seenModelIds.add(prefix.id);
    compatibleModels.push(rawModel);
  }

  if (invalidPrefix) {
    return {
      provider: bundledProvider,
      skippedRecords: skippedRecords + 1,
      warning: `Provider ${bundledProvider.id} was skipped after validation.`,
    };
  }

  const modelsById = new Map<string, ModelCatalogModelV1>(
    bundledProvider.models.map(model => [model.id, structuredClone(model)]),
  );
  for (const rawModel of compatibleModels) {
    const prefix = prefixOf(rawModel)!;
    modelsById.set(prefix.id, rawModel as ModelCatalogModelV1);
  }
  if (Array.isArray(rawProvider.retiredModels)) {
    for (const retiredModel of rawProvider.retiredModels) {
      if (typeof retiredModel === "string") modelsById.delete(retiredModel);
    }
  }

  const candidate = {
    ...structuredClone(bundledProvider),
    ...rawProvider,
    models: [...modelsById.values()],
  };
  const validation = modelCatalogProviderV1Schema.safeParse(candidate);
  if (!validation.success) {
    return {
      provider: bundledProvider,
      skippedRecords: skippedRecords + 1,
      warning: `Provider ${bundledProvider.id} was skipped after validation.`,
    };
  }
  return { provider: validation.data, skippedRecords };
}

export function validateCatalogCandidate(
  raw: unknown,
  bundled: ModelCatalogDocumentV1,
  runtimeVersion: string,
  now: Date = new Date(),
): CatalogValidationResult {
  if (!validateEnvelope(raw, runtimeVersion, now) || !countWithinLimits(raw)) {
    return { ok: false, warnings: ["Catalog envelope validation failed."] };
  }
  if (catalogDataDigest({ providers: raw.providers as ModelCatalogProviderV1[] }) !== raw.catalogDigest) {
    return { ok: false, warnings: ["Catalog digest validation failed."] };
  }

  const bundledById = new Map(bundled.providers.map(provider => [provider.id, provider]));
  const overlays = new Map<string, ModelCatalogProviderV1>();
  const seenProviderIds = new Set<string>();
  const warnings: string[] = [];
  let skippedRecords = 0;

  for (const rawProvider of raw.providers) {
    const prefix = prefixOf(rawProvider);
    if (!prefix) {
      return { ok: false, warnings: ["Catalog provider prefix validation failed."] };
    }
    if (prefix.minFrogprogsyVersion !== undefined) {
      const compatible = isRuntimeCompatible(prefix.minFrogprogsyVersion, runtimeVersion);
      if (compatible === null) {
        return { ok: false, warnings: ["Catalog provider version validation failed."] };
      }
      if (!compatible) {
        skippedRecords++;
        warnings.push(`Provider ${prefix.id} requires a newer Frogprogsy version.`);
        continue;
      }
    }
    const bundledProvider = bundledById.get(prefix.id);
    if (!bundledProvider) {
      skippedRecords++;
      warnings.push(`Unknown provider ${prefix.id} was skipped.`);
      continue;
    }
    if (seenProviderIds.has(prefix.id)) {
      return { ok: false, warnings: ["Catalog provider prefix validation failed."] };
    }
    seenProviderIds.add(prefix.id);
    const overlaid = overlayProvider(rawProvider as Record<string, unknown>, bundledProvider, runtimeVersion);
    overlays.set(prefix.id, overlaid.provider);
    skippedRecords += overlaid.skippedRecords;
    if (overlaid.warning) warnings.push(overlaid.warning);
  }

  const providers = bundled.providers.map(provider => overlays.get(provider.id) ?? structuredClone(provider));
  return {
    ok: true,
    document: {
      schemaVersion: 1,
      catalogRevision: raw.catalogRevision,
      catalogDigest: raw.catalogDigest,
      sourceCommit: raw.sourceCommit,
      generatedAt: raw.generatedAt,
      minFrogprogsyVersion: raw.minFrogprogsyVersion,
      providers,
    },
    skippedRecords,
    warnings,
  };
}

async function readBodyWithLimit(response: Response): Promise<string | null> {
  try {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          byteLength += chunk.value.byteLength;
          if (byteLength > MAX_CATALOG_BYTES) {
            await reader.cancel();
            return null;
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, byteLength));
  } catch {
    return null;
  }
}

async function fetchRemoteCatalog(
  fetchImpl: NonNullable<ModelCatalogRuntimeDeps["fetch"]>,
  remoteUrl: string | URL,
): Promise<{ raw: unknown; text: string } | null> {
  let response: Response;
  try {
    response = await fetchImpl(remoteUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (!JSON_CONTENT_TYPE.test(contentType)) return null;
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isInteger(length) || length < 0 || length > MAX_CATALOG_BYTES) return null;
  }
  const text = await readBodyWithLimit(response);
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as unknown;
    if (!countWithinLimits(raw)) return null;
    return { raw, text };
  } catch {
    return null;
  }
}

async function readCachedCandidate(
  path: string,
  fileSystem: ModelCatalogFileSystem,
  bundled: ModelCatalogDocumentV1,
  runtimeVersion: string,
  now: Date,
): Promise<ValidCandidate | null> {
  try {
    const text = await fileSystem.readFile(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) return null;
    const raw = JSON.parse(text) as unknown;
    const validated = validateCatalogCandidate(raw, bundled, runtimeVersion, now);
    return validated.ok
      ? { raw, document: validated.document, skippedRecords: validated.skippedRecords }
      : null;
  } catch {
    return null;
  }
}

async function writeCacheAtomically(
  path: string,
  content: string,
  fileSystem: ModelCatalogFileSystem,
): Promise<boolean> {
  const directory = dirname(path);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: ModelCatalogFileHandle | null = null;
  try {
    await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await fileSystem.open(tempPath, "wx", 0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(tempPath, path);
    return true;
  } catch {
    if (handle) {
      try { await handle.close(); } catch { /* best effort cleanup */ }
    }
    try { await fileSystem.unlink(tempPath); } catch { /* best effort cleanup */ }
    return false;
  }
}

function statusFor(
  source: CatalogSource,
  candidate: ValidCandidate,
  warnings: string[],
  refreshedAt?: string,
): CatalogRuntimeStatus {
  const status: CatalogRuntimeStatus = {
    source,
    catalogRevision: candidate.document.catalogRevision,
    catalogDigest: candidate.document.catalogDigest,
    sourceCommit: candidate.document.sourceCommit,
    generatedAt: candidate.document.generatedAt,
    skippedRecords: candidate.skippedRecords,
    warnings,
  };
  if (refreshedAt !== undefined) status.refreshedAt = refreshedAt;
  return status;
}

export async function refreshModelCatalog(
  deps: ModelCatalogRuntimeDeps = {},
): Promise<SelectedModelCatalog> {
  const bundled = deps.bundled ?? defaultBundledCatalog;
  const runtimeVersion = deps.runtimeVersion ?? defaultRuntimeVersion;
  const now = deps.now?.() ?? new Date();
  const cachePath = deps.cachePath ?? getModelCatalogCachePath();
  const fileSystem: ModelCatalogFileSystem = { ...defaultFileSystem, ...deps.fileSystem };
  const warnings: string[] = [];
  const bundledCandidate: ValidCandidate = { raw: bundled, document: bundled, skippedRecords: 0 };
  let selected = bundledCandidate;
  let source: CatalogSource = "bundled";

  const cache = await readCachedCandidate(cachePath, fileSystem, bundled, runtimeVersion, now);
  if (cache) {
    if (cache.document.catalogRevision > selected.document.catalogRevision) {
      selected = cache;
      source = "cached";
    } else if (cache.document.catalogRevision === selected.document.catalogRevision
      && cache.document.catalogDigest !== selected.document.catalogDigest) {
      warnings.push("Cached catalog conflicts with the trusted bundled catalog and was ignored.");
    }
  }

  const remote = await fetchRemoteCatalog(deps.fetch ?? globalThis.fetch, deps.remoteUrl ?? MODEL_CATALOG_REMOTE_URL);
  if (!remote) {
    warnings.push("Remote model catalog refresh failed; the existing catalog remains active.");
    return { document: selected.document, status: statusFor(source, selected, warnings) };
  }
  const validatedRemote = validateCatalogCandidate(remote.raw, bundled, runtimeVersion, now);
  if (!validatedRemote.ok) {
    warnings.push("Remote model catalog validation failed; the existing catalog remains active.");
    return { document: selected.document, status: statusFor(source, selected, warnings) };
  }
  const remoteCandidate: ValidCandidate = {
    raw: remote.raw,
    document: validatedRemote.document,
    skippedRecords: validatedRemote.skippedRecords,
  };

  if (remoteCandidate.document.catalogRevision < selected.document.catalogRevision) {
    warnings.push("Remote model catalog revision is older than the active catalog and was ignored.");
    return { document: selected.document, status: statusFor(source, selected, warnings) };
  }
  if (remoteCandidate.document.catalogRevision === selected.document.catalogRevision) {
    if (remoteCandidate.document.catalogDigest !== selected.document.catalogDigest) {
      warnings.push("Remote model catalog conflicts with the active catalog and was ignored.");
      return { document: selected.document, status: statusFor(source, selected, warnings) };
    }
    const written = await writeCacheAtomically(cachePath, remote.text, fileSystem);
    if (!written) {
      warnings.push("Remote model catalog cache update failed; the existing catalog remains active.");
      return { document: selected.document, status: statusFor(source, selected, warnings) };
    }
    return {
      document: selected.document,
      status: statusFor(source, selected, warnings, now.toISOString()),
    };
  }

  const written = await writeCacheAtomically(cachePath, remote.text, fileSystem);
  if (!written) {
    warnings.push("Remote model catalog cache update failed; the existing catalog remains active.");
    return { document: selected.document, status: statusFor(source, selected, warnings) };
  }
  warnings.push(...validatedRemote.warnings);
  return {
    document: remoteCandidate.document,
    status: statusFor("remote", remoteCandidate, warnings, now.toISOString()),
  };
}
