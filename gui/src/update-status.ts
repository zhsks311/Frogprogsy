import type { TKey } from "./i18n";
import type { UpdateStatus } from "../../src/update-status-contract";

export const DISMISSED_UPDATE_VERSION_KEY = "frogp-update-dismissed-version";

const STATUS_LABEL_KEYS: Record<UpdateStatus["status"], TKey> = {
  disabled: "update.status.disabled",
  "up-to-date": "update.status.upToDate",
  available: "update.status.available",
  unavailable: "update.status.unavailable",
  source: "update.status.source",
  development: "update.status.development",
  unsupported: "update.status.unsupported",
};


export function canApplyUpdatePoll(capturedGeneration: number, currentGeneration: number): boolean {
  return capturedGeneration === currentGeneration && currentGeneration % 2 === 0;
}
export function updateStatusLabelKey(status: UpdateStatus["status"]): TKey {
  return STATUS_LABEL_KEYS[status];
}

export function shouldShowUpdateNotice(status: UpdateStatus | null, dismissedVersion: string | null): boolean {
  return status?.status === "available"
    && status.latestVersion !== null
    && status.latestVersion !== dismissedVersion;
}

export function readDismissedUpdateVersion(storage: Pick<Storage, "getItem">): string | null {
  try {
    return storage.getItem(DISMISSED_UPDATE_VERSION_KEY);
  } catch {
    return null;
  }
}

export function dismissUpdateVersion(storage: Pick<Storage, "setItem">, version: string): boolean {
  try {
    storage.setItem(DISMISSED_UPDATE_VERSION_KEY, version);
    return true;
  } catch {
    return false;
  }
}

export async function copyStableUpdateCommand(
  clipboard: Pick<Clipboard, "writeText"> | undefined,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText("frogp update");
    return true;
  } catch {
    return false;
  }
}
