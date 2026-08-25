import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPDATE_CHECK_TTL_MS,
  UPDATE_MAX_RESPONSE_BYTES,
  UPDATE_REGISTRY_URL,
  createUpdateStatusService,
} from "../src/update-status";
import type { InstallIdentity } from "../src/install-identity";
import type { UpdateStatusServiceDeps } from "../src/update-status";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempCachePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "frogp-update-status-"));
  tempDirs.push(directory);
  return join(directory, "cache", "update-status-v1.json");
}

function identity(kind: InstallIdentity["kind"] = "bun", version = "1.2.3"): InstallIdentity {
  return { kind, version };
}

function service(
  cachePath: string,
  install: InstallIdentity,
  fetchImpl: NonNullable<UpdateStatusServiceDeps["fetch"]>,
  now = new Date("2026-08-25T00:00:00.000Z"),
  extra: Partial<UpdateStatusServiceDeps> = {},
) {
  return createUpdateStatusService({
    cachePath,
    identityHint: install,
    detectInstall: async () => install,
    fetch: fetchImpl,
    now: () => now,
    ...extra,
  });
}

describe("stable update status service", () => {
  test("persists one ordinary attempt for 24 hours and explicit refresh bypasses the throttle", async () => {
    const cachePath = tempCachePath();
    let requests = 0;
    const fetchImpl: NonNullable<UpdateStatusServiceDeps["fetch"]> = async (input, init) => {
      requests += 1;
      expect(String(input)).toBe(UPDATE_REGISTRY_URL);
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers)).toEqual(new Headers({ Accept: "application/json" }));
      return Response.json({ latest: "1.2.4", preview: "9.0.0-preview.1" });
    };

    const first = service(cachePath, identity(), fetchImpl);
    expect((await first.refresh({ force: false })).status).toBe("available");
    expect(requests).toBe(1);

    const restarted = service(cachePath, identity(), fetchImpl);
    const cached = await restarted.refresh({ force: false });
    expect(cached.status).toBe("available");
    expect(cached.stale).toBe(false);
    expect(requests).toBe(1);

    expect((await restarted.refresh({ force: true })).status).toBe("available");
    expect(requests).toBe(2);
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({
      schemaVersion: 1,
      lastAttemptAt: "2026-08-25T00:00:00.000Z",
      lastAttemptSucceeded: true,
      checkedAt: "2026-08-25T00:00:00.000Z",
      latestVersion: "1.2.4",
      failure: null,
    });
  });

  test("reloads a successful cache whose completion follows its attempt timestamp", async () => {
    const cachePath = tempCachePath();
    let clock = Date.parse("2026-08-25T00:00:00.000Z");
    let requests = 0;
    const fetchImpl = async () => {
      requests += 1;
      clock += 1_000;
      return Response.json({ latest: "1.2.4" });
    };
    const first = createUpdateStatusService({
      cachePath,
      identityHint: identity(),
      detectInstall: async () => identity(),
      fetch: fetchImpl,
      now: () => new Date(clock),
    });
    expect((await first.refresh({ force: false })).status).toBe("available");

    clock += 60_000;
    const restarted = createUpdateStatusService({
      cachePath,
      identityHint: identity(),
      detectInstall: async () => identity(),
      fetch: fetchImpl,
      now: () => new Date(clock),
    });
    expect((await restarted.refresh({ force: false })).status).toBe("available");
    expect(requests).toBe(1);
  });

  test("deduplicates concurrent refreshes in one process", async () => {
    const cachePath = tempCachePath();
    const gate = Promise.withResolvers<Response>();
    const requested = Promise.withResolvers<void>();
    let requests = 0;
    const update = service(cachePath, identity(), async () => {
      requests += 1;
      requested.resolve();
      return gate.promise;
    });

    const first = update.refresh({ force: true });
    const second = update.refresh({ force: true });
    await requested.promise;
    expect(requests).toBe(1);
    gate.resolve(Response.json({ latest: "1.2.4" }));
    expect(await first).toEqual(await second);
  });

  test("queues one forced refresh behind an ordinary in-flight check", async () => {
    const ordinaryGate = Promise.withResolvers<Response>();
    const ordinaryRequested = Promise.withResolvers<void>();
    const forcedRequested = Promise.withResolvers<void>();
    let requests = 0;
    const update = service(tempCachePath(), identity(), async () => {
      requests += 1;
      if (requests === 1) {
        ordinaryRequested.resolve();
        return ordinaryGate.promise;
      }
      forcedRequested.resolve();
      return Response.json({ latest: "1.2.5" });
    });

    const ordinary = update.refresh({ force: false });
    await ordinaryRequested.promise;
    const forced = update.refresh({ force: true });
    ordinaryGate.resolve(Response.json({ latest: "1.2.4" }));
    await forcedRequested.promise;
    expect((await ordinary).latestVersion).toBe("1.2.4");
    expect((await forced).latestVersion).toBe("1.2.5");
    expect(requests).toBe(2);
  });

  test("never contacts the registry for ineligible installs or preview versions", async () => {
    let requests = 0;
    const fetchImpl = async () => {
      requests += 1;
      return Response.json({ latest: "9.9.9" });
    };
    const cases: Array<[InstallIdentity, string]> = [
      [identity("source"), "source"],
      [identity("development"), "development"],
      [identity("unsupported"), "unsupported"],
      [identity("bun", "1.2.4-preview.1"), "unavailable"],
    ];
    for (const [install, expected] of cases) {
      const update = service(tempCachePath(), install, fetchImpl);
      expect((await update.refresh({ force: true })).status).toBe(expected);
    }
    expect(requests).toBe(0);
  });

  test("equal, older, malformed, missing, and prerelease latest values never advertise an update", async () => {
    const fixtures: Array<[unknown, string, string | null]> = [
      [{ latest: "1.2.3" }, "up-to-date", null],
      [{ latest: "1.2.2" }, "up-to-date", null],
      [{ latest: "1.2.4-preview.1" }, "unavailable", "invalid-response"],
      [{ latest: "not-semver" }, "unavailable", "invalid-response"],
      [{ preview: "1.2.4-preview.1" }, "unavailable", "invalid-response"],
    ];
    for (const [body, expectedStatus, expectedFailure] of fixtures) {
      const update = service(tempCachePath(), identity(), async () => Response.json(body));
      const snapshot = await update.refresh({ force: true });
      expect(snapshot.status).toBe(expectedStatus);
      expect(snapshot.failure).toBe(expectedFailure);
    }
  });

  test("maps bounded transport failures without throwing or exposing raw bodies", async () => {
    const oversized = "x".repeat(UPDATE_MAX_RESPONSE_BYTES + 1);
    const cases: Array<[string, NonNullable<UpdateStatusServiceDeps["fetch"]>, Partial<UpdateStatusServiceDeps>]> = [
      ["network", async () => { throw new Error("secret raw body"); }, {}],
      ["timeout", async () => { throw new Error("deadline"); }, { timeoutSignal: () => AbortSignal.abort() }],
      ["http", async () => new Response("secret", { status: 503 }), {}],
      ["oversized", async () => new Response(oversized), {}],
      ["invalid-response", async () => new Response("not json"), {}],
    ];
    for (const [failure, fetchImpl, extra] of cases) {
      const update = service(tempCachePath(), identity(), fetchImpl, new Date("2026-08-25T00:00:00.000Z"), extra);
      const snapshot = await update.refresh({ force: true });
      expect(snapshot.status).toBe("unavailable");
      expect(snapshot.failure).toBe(failure);
      expect(JSON.stringify(snapshot)).not.toContain("secret");
    }
  });

  test("retains only a previously newer release after failure and marks it stale", async () => {
    const cachePath = tempCachePath();
    const successful = service(cachePath, identity(), async () => Response.json({ latest: "1.2.4" }));
    expect((await successful.refresh({ force: true })).status).toBe("available");

    const failed = service(cachePath, identity(), async () => { throw new Error("offline"); });
    const snapshot = await failed.refresh({ force: true });
    expect(snapshot.status).toBe("available");
    expect(snapshot.latestVersion).toBe("1.2.4");
    expect(snapshot.stale).toBe(true);
    expect(snapshot.failure).toBe("network");

    const equalCache = tempCachePath();
    await service(equalCache, identity(), async () => Response.json({ latest: "1.2.3" })).refresh({ force: true });
    const equalFailure = await service(equalCache, identity(), async () => { throw new Error("offline"); }).refresh({ force: true });
    expect(equalFailure.status).toBe("unavailable");
    expect(equalFailure.stale).toBe(true);
  });

  test("future, malformed, and oversized caches cannot suppress a check", async () => {
    const now = new Date("2026-08-25T00:00:00.000Z");
    const fixtures = [
      JSON.stringify({
        schemaVersion: 1,
        lastAttemptAt: new Date(now.getTime() + UPDATE_CHECK_TTL_MS).toISOString(),
        lastAttemptSucceeded: true,
        checkedAt: new Date(now.getTime() + UPDATE_CHECK_TTL_MS).toISOString(),
        latestVersion: "9.9.9",
        failure: null,
      }),
      JSON.stringify({
        schemaVersion: 1,
        lastAttemptAt: now.toISOString(),
        lastAttemptSucceeded: true,
        checkedAt: new Date(now.getTime() + UPDATE_CHECK_TTL_MS).toISOString(),
        latestVersion: "1.2.4",
        failure: null,
      }),
      JSON.stringify({
        schemaVersion: 1,
        lastAttemptAt: now.toISOString(),
        lastAttemptSucceeded: true,
        checkedAt: now.toISOString(),
        latestVersion: "1.2.4-preview.1",
        failure: null,
      }),
      "{partial",
      "x".repeat(16 * 1024 + 1),
    ];
    for (const content of fixtures) {
      const cachePath = tempCachePath();
      mkdirSync(join(cachePath, ".."), { recursive: true });
      writeFileSync(cachePath, content);
      let requests = 0;
      const update = service(cachePath, identity(), async () => {
        requests += 1;
        return Response.json({ latest: "1.2.4" });
      }, now);
      expect((await update.refresh({ force: false })).status).toBe("available");
      expect(requests).toBe(1);
    }
  });

  test("unwritable cache reports degradation and keeps the in-process throttle", async () => {
    let requests = 0;
    const update = service(
      tempCachePath(),
      identity(),
      async () => {
        requests += 1;
        return Response.json({ latest: "1.2.4" });
      },
      new Date("2026-08-25T00:00:00.000Z"),
      {
        fileSystem: {
          open: async () => {
            throw new Error("read-only filesystem");
          },
        },
      },
    );
    const snapshot = await update.refresh({ force: false });
    expect(snapshot.status).toBe("available");
    expect(snapshot.failure).toBe("cache-write");
    expect((await update.refresh({ force: false })).status).toBe("available");
    expect(requests).toBe(1);
  });

  test("default-on opt-out suppresses ordinary work but explicit refresh remains available", async () => {
    let requests = 0;
    const update = createUpdateStatusService({
      enabled: false,
      cachePath: tempCachePath(),
      identityHint: identity(),
      detectInstall: async () => identity(),
      fetch: async () => {
        requests += 1;
        return Response.json({ latest: "1.2.4" });
      },
    });
    expect((await update.refresh({ force: false })).status).toBe("disabled");
    expect(requests).toBe(0);
    const forced = await update.refresh({ force: true });
    expect(forced.status).toBe("disabled");
    expect(forced.latestVersion).toBe("1.2.4");
    expect(requests).toBe(1);
  });
});
