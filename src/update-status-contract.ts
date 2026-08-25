export type InstallKind = "bun" | "source" | "development" | "unsupported";

export type UpdateFailure =
  | "timeout"
  | "network"
  | "http"
  | "oversized"
  | "invalid-response"
  | "cache-write";

export type UpdateState =
  | "disabled"
  | "up-to-date"
  | "available"
  | "unavailable"
  | "source"
  | "development"
  | "unsupported";

export interface UpdateStatus {
  enabled: boolean;
  installKind: InstallKind;
  installedVersion: string;
  status: UpdateState;
  latestVersion: string | null;
  checkedAt: string | null;
  lastAttemptAt: string | null;
  stale: boolean;
  nextCheckAt: string | null;
  failure: UpdateFailure | null;
}

const INSTALL_KINDS: Record<InstallKind, true> = {
  bun: true,
  source: true,
  development: true,
  unsupported: true,
};
const UPDATE_STATES: Record<UpdateState, true> = {
  disabled: true,
  "up-to-date": true,
  available: true,
  unavailable: true,
  source: true,
  development: true,
  unsupported: true,
};
const UPDATE_FAILURES: Record<UpdateFailure, true> = {
  timeout: true,
  network: true,
  http: true,
  oversized: true,
  "invalid-response": true,
  "cache-write": true,
};
const UPDATE_STATUS_KEYS: Record<keyof UpdateStatus, true> = {
  enabled: true,
  installKind: true,
  installedVersion: true,
  status: true,
  latestVersion: true,
  checkedAt: true,
  lastAttemptAt: true,
  stale: true,
  nextCheckAt: true,
  failure: true,
};

function isInstallKind(value: unknown): value is InstallKind {
  return typeof value === "string" && Object.hasOwn(INSTALL_KINDS, value);
}

function isUpdateState(value: unknown): value is UpdateState {
  return typeof value === "string" && Object.hasOwn(UPDATE_STATES, value);
}

function isUpdateFailure(value: unknown): value is UpdateFailure {
  return typeof value === "string" && Object.hasOwn(UPDATE_FAILURES, value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Strict wire parser shared by local CLI and dashboard consumers. */
export function parseUpdateStatus(value: unknown): UpdateStatus | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 10 || !keys.every(key => Object.hasOwn(UPDATE_STATUS_KEYS, key))) return null;
  if (!(("enabled" in value) && typeof value.enabled === "boolean")
    || !(("installKind" in value) && isInstallKind(value.installKind))
    || !(("installedVersion" in value) && typeof value.installedVersion === "string")
    || !(("status" in value) && isUpdateState(value.status))
    || !(("latestVersion" in value) && nullableString(value.latestVersion))
    || !(("checkedAt" in value) && nullableString(value.checkedAt))
    || !(("lastAttemptAt" in value) && nullableString(value.lastAttemptAt))
    || !(("stale" in value) && typeof value.stale === "boolean")
    || !(("nextCheckAt" in value) && nullableString(value.nextCheckAt))
    || !(("failure" in value) && (value.failure === null || isUpdateFailure(value.failure)))) {
    return null;
  }
  return {
    enabled: value.enabled,
    installKind: value.installKind,
    installedVersion: value.installedVersion,
    status: value.status,
    latestVersion: value.latestVersion,
    checkedAt: value.checkedAt,
    lastAttemptAt: value.lastAttemptAt,
    stale: value.stale,
    nextCheckAt: value.nextCheckAt,
    failure: value.failure,
  };
}
