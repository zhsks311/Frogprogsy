import {
  mkdir as mkdirFileSystem,
  open as openFileSystem,
  rename as renameFileSystem,
  unlink as unlinkFileSystem,
} from "node:fs/promises";
import { writeCacheAtomically } from "./atomic-cache-file";
import type { AtomicCacheFileHandle, AtomicCacheFileSystem } from "./atomic-cache-file";
import * as z from "zod/v4";
import { getUpdateStatusCachePath } from "./config";
import {
  detectInstallIdentity,
  installIdentityHint,
} from "./install-identity";
import type { InstallIdentity } from "./install-identity";
import { compareSemVer, parseCanonicalStableSemVer } from "./semver";
import type { UpdateFailure, UpdateStatus } from "./update-status-contract";
export type { UpdateFailure, UpdateStatus } from "./update-status-contract";

export const UPDATE_REGISTRY_URL = "https://registry.npmjs.org/-/package/frogprogsy/dist-tags";
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1_000;
export const UPDATE_FETCH_TIMEOUT_MS = 3_000;
export const UPDATE_MAX_RESPONSE_BYTES = 16 * 1024;
const UPDATE_MAX_CACHE_BYTES = 16 * 1024;


interface UpdateStatusFileHandle extends AtomicCacheFileHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
}

interface UpdateStatusFileSystem extends AtomicCacheFileSystem {
  open(path: string, flags: string, mode?: number): Promise<UpdateStatusFileHandle>;
}

export interface UpdateStatusServiceDeps {
  enabled?: boolean;
  identityHint?: InstallIdentity;
  detectInstall?: () => Promise<InstallIdentity>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  cachePath?: string;
  fileSystem?: Partial<UpdateStatusFileSystem>;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
}

const failureSchema = z.enum(["timeout", "network", "http", "oversized", "invalid-response", "cache-write"]);
const cacheSchema = z.strictObject({
  schemaVersion: z.literal(1),
  lastAttemptAt: z.iso.datetime({ offset: true }).nullable(),
  lastAttemptSucceeded: z.boolean(),
  checkedAt: z.iso.datetime({ offset: true }).nullable(),
  latestVersion: z.string().nullable(),
  failure: failureSchema.nullable(),
});
const distTagsSchema = z.object({ latest: z.string() });

const defaultFileSystem: UpdateStatusFileSystem = {
  mkdir: (path, options) => mkdirFileSystem(path, options),
  open: (path, flags, mode) => openFileSystem(path, flags, mode),
  rename: (oldPath, newPath) => renameFileSystem(oldPath, newPath),
  unlink: path => unlinkFileSystem(path),
};

interface UpdateMemoryState {
  identity: InstallIdentity;
  lastAttemptAtMs: number | null;
  lastAttemptSucceeded: boolean;
  checkedAtMs: number | null;
  latestVersion: string | null;
  failure: UpdateFailure | null;
}

type RegistryResult = { ok: true; latestVersion: string } | { ok: false; failure: Exclude<UpdateFailure, "cache-write"> };

function timestampMs(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs ? parsed : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class UpdateStatusService {
  private enabled: boolean;
  private readonly detectInstall: () => Promise<InstallIdentity>;
  private readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly now: () => Date;
  private readonly cachePath: string;
  private readonly fileSystem: UpdateStatusFileSystem;
  private readonly timeoutSignal: (milliseconds: number) => AbortSignal;
  private state: UpdateMemoryState;
  private preparePromise: Promise<void> | null = null;
  private inFlight: Promise<UpdateStatus> | null = null;
  private forceRequested = false;
  private manualResultVisible = false;

  constructor(deps: UpdateStatusServiceDeps = {}) {
    const hint = deps.identityHint ?? installIdentityHint();
    this.enabled = deps.enabled ?? true;
    this.detectInstall = deps.detectInstall ?? detectInstallIdentity;
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.cachePath = deps.cachePath ?? getUpdateStatusCachePath();
    this.fileSystem = { ...defaultFileSystem, ...deps.fileSystem };
    this.timeoutSignal = deps.timeoutSignal ?? AbortSignal.timeout;
    this.state = {
      identity: hint,
      lastAttemptAtMs: null,
      lastAttemptSucceeded: false,
      checkedAtMs: null,
      latestVersion: null,
      failure: null,
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.manualResultVisible = false;
  }

  prepare(): Promise<void> {
    if (!this.preparePromise) {
      this.preparePromise = Promise.all([this.loadCache(), this.resolveIdentity()]).then(() => undefined);
    }
    return this.preparePromise;
  }

  snapshot(): UpdateStatus {
    const nowMs = this.now().getTime();
    const installed = parseCanonicalStableSemVer(this.state.identity.version);
    const latest = this.state.latestVersion === null ? null : parseCanonicalStableSemVer(this.state.latestVersion);
    const lastAttemptCurrent = this.state.lastAttemptAtMs !== null
      && this.state.lastAttemptAtMs <= nowMs
      && nowMs - this.state.lastAttemptAtMs < UPDATE_CHECK_TTL_MS;
    const stale = this.state.lastAttemptAtMs !== null
      && (!this.state.lastAttemptSucceeded || !lastAttemptCurrent);
    let status: UpdateStatus["status"];
    if (!this.enabled && !this.manualResultVisible) {
      status = "disabled";
    } else if (this.state.identity.kind === "source") {
      status = "source";
    } else if (this.state.identity.kind === "development") {
      status = "development";
    } else if (this.state.identity.kind === "unsupported") {
      status = "unsupported";
    } else if (!installed || !latest) {
      status = "unavailable";
    } else if (compareSemVer(latest, installed) > 0) {
      status = "available";
    } else if (this.state.lastAttemptSucceeded) {
      status = "up-to-date";
    } else {
      status = "unavailable";
    }
    const nextCheckAt = this.enabled
      && this.state.identity.kind === "bun"
      && installed !== null
      && this.state.lastAttemptAtMs !== null
      ? new Date(this.state.lastAttemptAtMs + UPDATE_CHECK_TTL_MS).toISOString()
      : null;
    return {
      enabled: this.enabled,
      installKind: this.state.identity.kind,
      installedVersion: this.state.identity.version,
      status,
      latestVersion: this.state.latestVersion,
      checkedAt: this.state.checkedAtMs === null ? null : new Date(this.state.checkedAtMs).toISOString(),
      lastAttemptAt: this.state.lastAttemptAtMs === null ? null : new Date(this.state.lastAttemptAtMs).toISOString(),
      stale,
      nextCheckAt,
      failure: this.state.failure,
    };
  }

  refresh(options: { force: boolean }): Promise<UpdateStatus> {
    if (options.force) this.forceRequested = true;
    if (this.inFlight) return this.inFlight;
    const run = this.performRefresh().finally(() => {
      if (this.inFlight === run) {
        this.inFlight = null;
        this.forceRequested = false;
      }
    });
    this.inFlight = run;
    return run;
  }

  private async resolveIdentity(): Promise<void> {
    try {
      this.state.identity = await this.detectInstall();
    } catch {
      this.state.identity = { ...this.state.identity, kind: "unsupported" };
    }
  }

  private async loadCache(): Promise<void> {
    let handle: UpdateStatusFileHandle | null = null;
    try {
      handle = await this.fileSystem.open(this.cachePath, "r");
      const buffer = Buffer.alloc(UPDATE_MAX_CACHE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > UPDATE_MAX_CACHE_BYTES) return;
      const parsedJson: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      const parsed = cacheSchema.safeParse(parsedJson);
      if (!parsed.success) return;
      const nowMs = this.now().getTime();
      const lastAttemptAtMs = timestampMs(parsed.data.lastAttemptAt, nowMs);
      const checkedAtMs = timestampMs(parsed.data.checkedAt, nowMs);
      const latestVersion = parsed.data.latestVersion;
      if (parsed.data.lastAttemptAt !== null && lastAttemptAtMs === null) return;
      if (parsed.data.checkedAt !== null && checkedAtMs === null) return;
      if (latestVersion !== null && parseCanonicalStableSemVer(latestVersion) === null) return;
      if ((checkedAtMs === null) !== (latestVersion === null)) return;
      if (lastAttemptAtMs === null
        && (checkedAtMs !== null || parsed.data.lastAttemptSucceeded || parsed.data.failure !== null)) return;
      if (checkedAtMs !== null && lastAttemptAtMs !== null) {
        if (parsed.data.lastAttemptSucceeded && checkedAtMs < lastAttemptAtMs) return;
        if (!parsed.data.lastAttemptSucceeded && checkedAtMs > lastAttemptAtMs) return;
      }
      if (parsed.data.lastAttemptSucceeded
        && (checkedAtMs === null || latestVersion === null || parsed.data.failure !== null)) return;
      this.state.lastAttemptAtMs = lastAttemptAtMs;
      this.state.lastAttemptSucceeded = parsed.data.lastAttemptSucceeded;
      this.state.checkedAtMs = checkedAtMs;
      this.state.latestVersion = latestVersion;
      this.state.failure = parsed.data.failure;
    } catch {
      // Missing, malformed, partial, and unreadable cache files are treated as no cache.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async performRefresh(): Promise<UpdateStatus> {
    await this.prepare();
    const force = this.forceRequested;
    const installed = parseCanonicalStableSemVer(this.state.identity.version);
    if ((!this.enabled && !force) || this.state.identity.kind !== "bun" || !installed) return this.snapshot();

    const nowMs = this.now().getTime();
    if (!force
      && this.state.lastAttemptAtMs !== null
      && this.state.lastAttemptAtMs <= nowMs
      && nowMs - this.state.lastAttemptAtMs < UPDATE_CHECK_TTL_MS) {
      return this.snapshot();
    }

    this.state.lastAttemptAtMs = nowMs;
    this.state.lastAttemptSucceeded = false;
    this.state.failure = null;
    await this.persistCache();

    const result = await this.fetchLatestStable();
    if (result.ok) {
      this.state.latestVersion = result.latestVersion;
      this.state.checkedAtMs = this.now().getTime();
      this.state.lastAttemptSucceeded = true;
      this.state.failure = null;
      if (force) this.manualResultVisible = true;
    } else {
      this.state.lastAttemptSucceeded = false;
      this.state.failure = result.failure;
    }
    if (!await this.persistCache()) this.state.failure = "cache-write";
    return this.snapshot();
  }

  private async fetchLatestStable(): Promise<RegistryResult> {
    const signal = this.timeoutSignal(UPDATE_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(UPDATE_REGISTRY_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        credentials: "omit",
        signal,
      });
    } catch {
      return { ok: false, failure: signal.aborted ? "timeout" : "network" };
    }
    if (!response.ok) return { ok: false, failure: "http" };
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const declaredBytes = Number(contentLength);
      if (!Number.isInteger(declaredBytes) || declaredBytes < 0) return { ok: false, failure: "invalid-response" };
      if (declaredBytes > UPDATE_MAX_RESPONSE_BYTES) return { ok: false, failure: "oversized" };
    }
    if (!response.body) return { ok: false, failure: "invalid-response" };

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > UPDATE_MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, failure: "oversized" };
        }
        chunks.push(chunk.value);
      }
    } catch {
      return { ok: false, failure: signal.aborted ? "timeout" : "network" };
    }

    const body = Buffer.concat(chunks, totalBytes).toString("utf8");
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { ok: false, failure: "invalid-response" };
    }
    if (!isPlainObject(json)) return { ok: false, failure: "invalid-response" };
    const parsed = distTagsSchema.safeParse(json);
    if (!parsed.success || parseCanonicalStableSemVer(parsed.data.latest) === null) {
      return { ok: false, failure: "invalid-response" };
    }
    return { ok: true, latestVersion: parsed.data.latest };
  }

  private async persistCache(): Promise<boolean> {
    return writeCacheAtomically(this.cachePath, JSON.stringify({
      schemaVersion: 1,
      lastAttemptAt: this.state.lastAttemptAtMs === null ? null : new Date(this.state.lastAttemptAtMs).toISOString(),
      lastAttemptSucceeded: this.state.lastAttemptSucceeded,
      checkedAt: this.state.checkedAtMs === null ? null : new Date(this.state.checkedAtMs).toISOString(),
      latestVersion: this.state.latestVersion,
      failure: this.state.failure,
    }) + "\n", this.fileSystem);
  }
}

export function createUpdateStatusService(deps: UpdateStatusServiceDeps = {}): UpdateStatusService {
  return new UpdateStatusService(deps);
}
