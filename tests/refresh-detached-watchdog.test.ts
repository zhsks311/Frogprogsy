import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { processProbeErrorMeansAlive, terminateStaleProxyForRefresh } from "../src/refresh-process";

const cliSource = () => readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");

function waitForPath(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), () => {
    if (!existsSync(path)) return;
    watcher.close();
    resolve();
  });
  watcher.once("error", error => {
    watcher.close();
    reject(error);
  });
  if (existsSync(path)) {
    watcher.close();
    resolve();
  }
  return promise;
}

function waitForPathRemoval(path: string): Promise<void> {
  if (!existsSync(path)) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), () => {
    if (existsSync(path)) return;
    watcher.close();
    resolve();
  });
  watcher.once("error", error => {
    watcher.close();
    reject(error);
  });
  if (!existsSync(path)) {
    watcher.close();
    resolve();
  }
  return promise;
}


function waitForPidReplacement(path: string, previousPid: number): Promise<number> {
  const currentPid = () => {
    try {
      const pid = Number(readFileSync(path, "utf8"));
      return Number.isSafeInteger(pid) && pid > 0 && pid !== previousPid ? pid : null;
    } catch {
      return null;
    }
  };
  const current = currentPid();
  if (current !== null) return Promise.resolve(current);
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const watcher = watch(dirname(path), () => {
    const replacement = currentPid();
    if (replacement === null) return;
    watcher.close();
    resolve(replacement);
  });
  watcher.once("error", error => {
    watcher.close();
    reject(error);
  });
  const replacement = currentPid();
  if (replacement !== null) {
    watcher.close();
    resolve(replacement);
  }
  return promise;
}
describe("frogp refresh detached lifecycle", () => {
  test("refresh termination restores watchdog ownership on failure and accepts an already-dead process", () => {
    const failedEvents: string[] = [];
    const failed = terminateStaleProxyForRefresh(101, {
      writeShutdownIntent: pid => failedEvents.push(`intent:${pid}`),
      terminate: () => {
        failedEvents.push("terminate");
        throw new Error("permission denied");
      },
      isAlive: () => true,
      clearShutdownIntent: () => {
        failedEvents.push("clear-intent");
      },
    });
    expect(failed).toMatchObject({ ok: false, error: new Error("permission denied") });
    expect(failedEvents).toEqual(["intent:101", "terminate", "clear-intent"]);

    let clearedAfterDeath = false;
    const alreadyDead = terminateStaleProxyForRefresh(102, {
      writeShutdownIntent: () => undefined,
      terminate: () => {
        throw new Error("process disappeared during termination");
      },
      isAlive: () => false,
      clearShutdownIntent: () => {
        clearedAfterDeath = true;
      },
    });
    expect(alreadyDead).toEqual({ ok: true });
    expect(clearedAfterDeath).toBe(false);
    expect(processProbeErrorMeansAlive(Object.assign(new Error("denied"), { code: "EPERM" }))).toBe(true);
    expect(processProbeErrorMeansAlive(Object.assign(new Error("gone"), { code: "ESRCH" }))).toBe(false);
  });

  test("refresh serializes stale replacement against a concurrent start on every platform", async () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-refresh-stale-build-"));
    const frogHome = join(root, "frog-home");
    const claudeHome = join(root, "claude-home");
    const lockGate = join(root, "refresh-lock-gate");
    const fixturePath = join(root, "stale-server.ts");
    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    const watchdogPidPath = join(frogHome, "watchdog.pid");
    mkdirSync(frogHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(fixturePath, [
      "const server = Bun.serve({",
      '  hostname: "127.0.0.1",',
      "  port: 0,",
      "  fetch(request) {",
      "    const url = new URL(request.url);",
      '    if (url.pathname === "/healthz") {',
      '      return Response.json({ status: "ok", serverBuildId: "frogprogsy-server@0.0.0-stale" });',
      "    }",
      '    return new Response("not found", { status: 404 });',
      "  },",
      "});",
      "console.log(server.port);",
      "await Promise.withResolvers<void>().promise;",
    ].join("\n"));

    const stale = Bun.spawn([process.execPath, fixturePath], {
      stdout: "pipe",
      stderr: "ignore",
    });
    let oldWatchdog: { pid: number; exited: Promise<number>; kill: () => void } | undefined;
    let replacementWatchdogPid: number | null = null;
    const env = {
      ...process.env,
      NODE_ENV: "test",
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: claudeHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      FROGPROGSY_NO_CLAUDE_WRITES: "1",
      FROGP_TEST_CONFIG_LOCK_GATE: lockGate,
    };
    let concurrent: { pid: number; exited: Promise<number>; kill: () => void } | undefined;

    try {
      const staleOutput = stale.stdout.getReader();
      const announced = await staleOutput.read();
      staleOutput.releaseLock();
      const port = Number(new TextDecoder().decode(announced.value).trim());
      expect(announced.done).toBe(false);
      expect(Number.isInteger(port) && port > 0).toBe(true);
      writeFileSync(join(frogHome, "config.json"), JSON.stringify({
        port,
        hostname: "127.0.0.1",
        watchdog: { enabled: true, pollIntervalMs: 50 },
        providers: {},
      }, null, 2) + "\n");
      writeFileSync(join(frogHome, "frogp.pid"), String(stale.pid));
      writeFileSync(join(frogHome, "frogp.port"), String(port));
      oldWatchdog = Bun.spawn(
        [process.execPath, cliPath, "__watchdog", "--parent", String(stale.pid), "--port", String(port)],
        { cwd: join(import.meta.dir, ".."), env, stdout: "ignore", stderr: "ignore" },
      );
      await waitForPath(watchdogPidPath);
      expect(Number(readFileSync(watchdogPidPath, "utf8"))).toBe(oldWatchdog.pid);

      const refresh = Bun.spawn([process.execPath, cliPath, "refresh"], {
        cwd: join(import.meta.dir, ".."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      await waitForPath(`${lockGate}.${refresh.pid}.ready`);
      concurrent = Bun.spawn([process.execPath, cliPath, "start"], {
        cwd: join(import.meta.dir, ".."),
        env,
        stdout: "ignore",
        stderr: "ignore",
      });
      writeFileSync(lockGate, "release");
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(refresh.stdout).text(),
        new Response(refresh.stderr).text(),
        refresh.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(`Proxy running on port ${port}`);
      await stale.exited;
      const replacementPid = Number(readFileSync(join(frogHome, "frogp.pid"), "utf8"));
      expect(replacementPid).not.toBe(stale.pid);
      if (replacementPid !== concurrent.pid) expect(await concurrent.exited).toBe(1);
      await oldWatchdog.exited;
      replacementWatchdogPid = await waitForPidReplacement(watchdogPidPath, oldWatchdog.pid);
      expect(() => process.kill(replacementWatchdogPid!, 0)).not.toThrow();
      const health = await fetch(`http://127.0.0.1:${port}/healthz`).then(response => response.json()) as {
        serverBuildId?: string;
      };
      const version = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version;
      expect(health.serverBuildId).toBe(`frogprogsy-server@${version}`);
    } finally {
      writeFileSync(lockGate, "release");
      const stop = Bun.spawn([process.execPath, cliPath, "stop"], {
        cwd: join(import.meta.dir, ".."),
        env,
        stdout: "ignore",
        stderr: "ignore",
      });
      await stop.exited;
      stale.kill();
      await stale.exited;
      concurrent?.kill();
      if (concurrent) await concurrent.exited;
      oldWatchdog?.kill();
      if (oldWatchdog) await oldWatchdog.exited;
      if (replacementWatchdogPid !== null) {
        try {
          process.kill(replacementWatchdogPid, "SIGTERM");
        } catch {
          // The graceful stop may already have ended the replacement watchdog.
        }
        await waitForPathRemoval(watchdogPidPath);
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("refresh preserves a current proxy that wins the startup lock race", async () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-refresh-current-race-"));
    const frogHome = join(root, "frog-home");
    const claudeHome = join(root, "claude-home");
    const lockGate = join(root, "start-lock-gate");
    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    mkdirSync(frogHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port;
    reservation.stop(true);
    writeFileSync(join(frogHome, "config.json"), JSON.stringify({
      port,
      hostname: "127.0.0.1",
      watchdog: { enabled: false },
      providers: {},
    }, null, 2) + "\n");
    const env = {
      ...process.env,
      NODE_ENV: "test",
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: claudeHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      FROGPROGSY_NO_CLAUDE_WRITES: "1",
      FROGP_TEST_CONFIG_LOCK_GATE: lockGate,
    };
    const start = Bun.spawn([process.execPath, cliPath, "start"], {
      cwd: join(import.meta.dir, ".."),
      env,
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForPath(`${lockGate}.${start.pid}.ready`);
      const refresh = Bun.spawn([process.execPath, cliPath, "refresh"], {
        cwd: join(import.meta.dir, ".."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      writeFileSync(lockGate, "release");
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(refresh.stdout).text(),
        new Response(refresh.stderr).text(),
        refresh.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(`Proxy running on port ${port}`);
      expect(Number(readFileSync(join(frogHome, "frogp.pid"), "utf8"))).toBe(start.pid);
      const health = await fetch(`http://127.0.0.1:${port}/healthz`).then(response => response.json()) as {
        serverBuildId?: string;
      };
      const version = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version;
      expect(health.serverBuildId).toBe(`frogprogsy-server@${version}`);
    } finally {
      writeFileSync(lockGate, "release");
      const stop = Bun.spawn([process.execPath, cliPath, "stop"], {
        cwd: join(import.meta.dir, ".."),
        env,
        stdout: "ignore",
        stderr: "ignore",
      });
      await stop.exited;
      start.kill();
      await start.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("refresh does not mark its background proxy as externally service-managed", () => {
    const source = cliSource();
    const refreshStart = source.indexOf("async function handleRefresh()");
    expect(refreshStart).toBeGreaterThanOrEqual(0);
    const refreshSource = source.slice(refreshStart, source.indexOf("function killProxy", refreshStart));

    expect(refreshSource).toContain('FROGP_DETACHED: "1"');
    expect(refreshSource).toContain("FROGP_EXTERNAL_SUPERVISOR: undefined");
    expect(refreshSource).not.toContain('FROGP_EXTERNAL_SUPERVISOR: "1"');
  });

  test("detached proxies keep Claude settings injected without suppressing watchdog", () => {
    const source = cliSource();

    expect(source).toContain("!parseEnvFlag(process.env.FROGP_EXTERNAL_SUPERVISOR) && !process.env.FROGP_DETACHED");
    expect(source).toContain("resolveWatchdogEnabled(_startConfig, process.env");
  });

  test("watchdog seeds last-known pid from the supervised parent", () => {
    const watchdogSource = readFileSync(join(import.meta.dir, "..", "src", "watchdog.ts"), "utf8");

    expect(watchdogSource).toContain("let lastKnownManagedPid: number | null = opts.parentPidHint ?? null");
  });
});
