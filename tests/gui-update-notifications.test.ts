import { describe, expect, test } from "bun:test";
import {
  DISMISSED_UPDATE_VERSION_KEY,
  canApplyUpdatePoll,
  dismissUpdateVersion,
  readDismissedUpdateVersion,
  shouldShowUpdateNotice,
  updateStatusLabelKey,
} from "../gui/src/update-status";
import { parseUpdateStatus } from "../src/update-status-contract";
import type { UpdateStatus } from "../src/update-status-contract";

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    enabled: true,
    installKind: "bun",
    installedVersion: "1.2.3",
    status: "available",
    latestVersion: "1.2.4",
    checkedAt: "2026-08-25T00:00:00.000Z",
    lastAttemptAt: "2026-08-25T00:00:00.000Z",
    stale: false,
    nextCheckAt: "2026-08-26T00:00:00.000Z",
    failure: null,
    ...overrides,
  };
}

class MemoryStorage {
  private values: Record<string, string> = {};

  getItem(key: string): string | null {
    return this.values[key] ?? null;
  }

  setItem(key: string, value: string): void {
    this.values[key] = value;
  }
}

describe("dashboard update presentation", () => {
  test("only an available, non-dismissed version shows the notification", () => {
    expect(shouldShowUpdateNotice(status(), null)).toBe(true);
    expect(shouldShowUpdateNotice(status({ stale: true, failure: "network" }), null)).toBe(true);
    expect(shouldShowUpdateNotice(status(), "1.2.4")).toBe(false);
    expect(shouldShowUpdateNotice(status({ latestVersion: "1.2.5" }), "1.2.4")).toBe(true);
    for (const state of ["up-to-date", "unavailable", "disabled", "source", "development", "unsupported"] as const) {
      expect(shouldShowUpdateNotice(status({ status: state }), null)).toBe(false);
      expect(updateStatusLabelKey(state)).toBe(`update.status.${state === "up-to-date" ? "upToDate" : state}`);
    }
  });

  test("dismissal persists only the advertised version", () => {
    const storage = new MemoryStorage();
    expect(readDismissedUpdateVersion(storage)).toBeNull();
    expect(dismissUpdateVersion(storage, "1.2.4")).toBe(true);
    expect(storage.getItem(DISMISSED_UPDATE_VERSION_KEY)).toBe("1.2.4");
    expect(readDismissedUpdateVersion(storage)).toBe("1.2.4");
  });

  test("wire parser rejects missing, extra, and wrong-typed update state", () => {
    expect(parseUpdateStatus(status())).toEqual(status());
    expect(parseUpdateStatus({ ...status(), registryUrl: "https://evil.invalid" })).toBeNull();
    const missing = status();
    Reflect.deleteProperty(missing, "failure");
    expect(parseUpdateStatus(missing)).toBeNull();
    expect(parseUpdateStatus({ ...status(), enabled: "yes" })).toBeNull();
    expect(parseUpdateStatus({ ...status(), installKind: "constructor" })).toBeNull();
    expect(parseUpdateStatus({ ...status(), status: "toString" })).toBeNull();
    expect(parseUpdateStatus({ ...status(), failure: "__proto__" })).toBeNull();
  });

  test("poll responses cannot overwrite an update action", () => {
    let generation = 0;
    const beforeAction = generation;
    generation += 1;
    const duringAction = generation;

    expect(canApplyUpdatePoll(beforeAction, generation)).toBe(false);
    expect(canApplyUpdatePoll(duringAction, generation)).toBe(false);

    generation += 1;
    expect(canApplyUpdatePoll(beforeAction, generation)).toBe(false);
    expect(canApplyUpdatePoll(duringAction, generation)).toBe(false);
    expect(canApplyUpdatePoll(generation, generation)).toBe(true);
  });
  test("Home owns manual dashboard refresh without a duplicate Details action", async () => {
    const homeSource = await Bun.file(new URL("../gui/src/pages/Home.tsx", import.meta.url)).text();
    const detailsSource = await Bun.file(new URL("../gui/src/pages/DeveloperDetails.tsx", import.meta.url)).text();
    expect(homeSource).toContain('/api/update-status/refresh');
    expect(homeSource).toContain("refreshUpdate");
    expect(detailsSource).not.toContain('/api/update-status/refresh');
    expect(detailsSource).not.toContain("refreshUpdateStatus");
  });

});
