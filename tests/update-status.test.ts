import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename as renameFile } from "node:fs/promises";
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
      schemaVersion: 2,
      attemptCompleted: true,
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

  test("deduplicates a forced refresh with an ordinary in-flight check", async () => {
    const ordinaryGate = Promise.withResolvers<Response>();
    const ordinaryRequested = Promise.withResolvers<void>();
    let requests = 0;
    const update = service(tempCachePath(), identity(), async () => {
      requests += 1;
      ordinaryRequested.resolve();
      return ordinaryGate.promise;
    });

    const ordinary = update.refresh({ force: false });
    await ordinaryRequested.promise;
    const forced = update.refresh({ force: true });
    expect(forced).toBe(ordinary);
    expect(requests).toBe(1);
    ordinaryGate.resolve(Response.json({ latest: "1.2.4" }));
    expect((await ordinary).latestVersion).toBe("1.2.4");
    expect(await forced).toEqual(await ordinary);
    expect(requests).toBe(1);
  });

  test("a concurrent forced refresh still bypasses a fresh ordinary-check cache", async () => {
    const cachePath = tempCachePath();
    let requests = 0;
    await service(cachePath, identity(), async () => {
      requests += 1;
      return Response.json({ latest: "1.2.4" });
    }).refresh({ force: true });

    const restarted = service(cachePath, identity(), async () => {
      requests += 1;
      return Response.json({ latest: "1.2.5" });
    });
    const ordinary = restarted.refresh({ force: false });
    const forced = restarted.refresh({ force: true });
    expect(forced).toBe(ordinary);
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

  test("legacy v1 migration retries incomplete attempts but retains completed failure throttles", async () => {
    const now = new Date("2026-08-25T00:00:00.000Z");
    const legacyRecord = {
      schemaVersion: 1,
      lastAttemptAt: now.toISOString(),
      lastAttemptSucceeded: false,
      checkedAt: new Date(now.getTime() - 60_000).toISOString(),
      latestVersion: "1.2.4",
      failure: null,
    };
    const incompletePath = tempCachePath();
    mkdirSync(join(incompletePath, ".."), { recursive: true });
    writeFileSync(incompletePath, JSON.stringify(legacyRecord));
    let incompleteRequests = 0;
    const incomplete = service(incompletePath, identity(), async () => {
      incompleteRequests += 1;
      throw new Error("registry unavailable");
    }, now);
    expect(await incomplete.refresh({ force: false })).toMatchObject({
      status: "available",
      latestVersion: "1.2.4",
      stale: true,
      failure: "network",
    });
    expect(incompleteRequests).toBe(1);

    const completedFailurePath = tempCachePath();
    mkdirSync(join(completedFailurePath, ".."), { recursive: true });
    writeFileSync(completedFailurePath, JSON.stringify({ ...legacyRecord, failure: "network" }));
    let completedFailureRequests = 0;
    const completedFailure = service(completedFailurePath, identity(), async () => {
      completedFailureRequests += 1;
      return Response.json({ latest: "1.2.4" });
    }, now);
    expect(await completedFailure.refresh({ force: false })).toMatchObject({
      status: "available",
      latestVersion: "1.2.4",
      stale: true,
      failure: "network",
    });
    expect(completedFailureRequests).toBe(0);
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

  test("an interrupted final cache write preserves prior history and cannot suppress the next process check", async () => {
    const cachePath = tempCachePath();
    let requests = 0;
    await service(
      cachePath,
      identity(),
      async () => {
        requests += 1;
        return Response.json({ latest: "1.2.4" });
      },
      new Date("2026-08-24T00:00:00.000Z"),
    ).refresh({ force: false });

    let renames = 0;
    const interrupted = service(
      cachePath,
      identity(),
      async () => {
        requests += 1;
        return Response.json({ latest: "1.2.5" });
      },
      new Date("2026-08-25T00:00:00.000Z"),
      {
        fileSystem: {
          rename: async (oldPath, newPath) => {
            renames += 1;
            if (renames === 2) throw new Error("final cache replacement failed");
            await renameFile(oldPath, newPath);
          },
        },
      },
    );

    expect(await interrupted.refresh({ force: true })).toMatchObject({
      status: "available",
      latestVersion: "1.2.5",
      failure: "cache-write",
    });
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toMatchObject({
      schemaVersion: 2,
      attemptCompleted: false,
      lastAttemptSucceeded: false,
      latestVersion: "1.2.4",
    });

    const restarted = service(
      cachePath,
      identity(),
      async () => {
        requests += 1;
        throw new Error("registry unavailable");
      },
      new Date("2026-08-25T00:00:00.000Z"),
    );
    expect(await restarted.refresh({ force: false })).toMatchObject({
      status: "available",
      latestVersion: "1.2.4",
      stale: true,
      failure: "network",
    });
    expect(requests).toBe(3);
  });

  test("opt-out stays initially disabled and retains each successful explicit result for passive polls", async () => {
    for (const [latestVersion, expectedStatus] of [
      ["1.2.4", "available"],
      ["1.2.3", "up-to-date"],
    ] as const) {
      let requests = 0;
      const update = createUpdateStatusService({
        enabled: false,
        cachePath: tempCachePath(),
        identityHint: identity(),
        detectInstall: async () => identity(),
        fetch: async () => {
          requests += 1;
          return Response.json({ latest: latestVersion });
        },
      });
      expect(update.snapshot()).toMatchObject({
        enabled: false,
        status: "disabled",
        nextCheckAt: null,
      });
      expect((await update.refresh({ force: false })).status).toBe("disabled");
      expect(requests).toBe(0);

      const forced = await update.refresh({ force: true });
      expect(forced).toMatchObject({
        enabled: false,
        status: expectedStatus,
        latestVersion,
        nextCheckAt: null,
      });
      expect(requests).toBe(1);
      expect(update.snapshot()).toMatchObject({
        enabled: false,
        status: expectedStatus,
        latestVersion,
        nextCheckAt: null,
      });
    }
  });
});
