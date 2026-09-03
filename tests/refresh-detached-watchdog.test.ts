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

  test("refresh never signals a live PID without a FrogProgsy health identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-refresh-unverified-pid-"));
    const frogHome = join(root, "frog-home");
    const claudeHome = join(root, "claude-home");
    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    mkdirSync(frogHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port;
    reservation.stop(true);
    const unrelated = Bun.spawn(
      [process.execPath, "-e", "await Promise.withResolvers<void>().promise"],
      { stdout: "ignore", stderr: "ignore" },
    );
    writeFileSync(join(frogHome, "config.json"), JSON.stringify({
      port,
      hostname: "127.0.0.1",
      watchdog: { enabled: false },
      providers: {},
    }, null, 2) + "\n");
    writeFileSync(join(frogHome, "frogp.pid"), String(unrelated.pid));
    const env = {
      ...process.env,
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: claudeHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      FROGPROGSY_NO_CLAUDE_WRITES: "1",
    };

    try {
      const refresh = Bun.spawn([process.execPath, cliPath, "refresh"], {
        cwd: join(import.meta.dir, ".."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([
        new Response(refresh.stderr).text(),
        refresh.exited,
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("live PID is not authenticated by a FrogProgsy health response");
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
      expect(readFileSync(join(frogHome, "frogp.pid"), "utf8")).toBe(String(unrelated.pid));
    } finally {
      unrelated.kill();
      await unrelated.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test.skipIf(process.platform === "win32")("failed watchdog handoff stops only its replacement and restores native Claude routing", async () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-refresh-watchdog-rollback-"));
    const frogHome = join(root, "frog-home");
    const claudeHome = join(root, "claude-home");
    const settingsPath = join(claudeHome, "settings.json");
    const pidPath = join(frogHome, "frogp.pid");
    const portPath = join(frogHome, "frogp.port");
    const watchdogPidPath = join(frogHome, "watchdog.pid");
    const watchdogOwnerPath = join(frogHome, "watchdog.owner.json");
    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    mkdirSync(frogHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    const nativeSettings = { env: { USER_SETTING: "keep-native" } };
    writeFileSync(settingsPath, JSON.stringify(nativeSettings, null, 2) + "\n");
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port;
    reservation.stop(true);
    writeFileSync(join(frogHome, "config.json"), JSON.stringify({
      port,
      hostname: "127.0.0.1",
      watchdog: { enabled: true, pollIntervalMs: 50, backoffMs: [50] },
      providers: {},
      claudeProfiles: {
        schemaVersion: 1,
        defaultProfileId: "cp_default",
        profiles: [{ id: "cp_default", name: "Default", claudeHome, injected: false }],
      },
    }, null, 2) + "\n");
    const watchdogOwnerBlocker = Bun.spawn(
      [process.execPath, "-e", "await Promise.withResolvers<void>().promise"],
      { stdout: "ignore", stderr: "ignore" },
    );
    writeFileSync(watchdogPidPath, String(watchdogOwnerBlocker.pid));
    const newerWatchdogOwner = {
      schemaVersion: 1,
      instanceId: "newer-watchdog-owner",
      watchdogPid: watchdogOwnerBlocker.pid,
      proxyPid: watchdogOwnerBlocker.pid,
    };
    writeFileSync(watchdogOwnerPath, JSON.stringify(newerWatchdogOwner) + "\n");
    const env = {
      ...process.env,
      HOME: root,
      NODE_ENV: "test",
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: claudeHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      FROGP_REAL_CLAUDE: join(root, "missing-claude"),
    };
    delete env.FROGPROGSY_NO_CLAUDE_WRITES;
    let replacementPid: number | null = null;

    try {
      const refresh = Bun.spawn([process.execPath, cliPath, "refresh"], {
        cwd: join(import.meta.dir, ".."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      await waitForPath(pidPath);
      replacementPid = Number(readFileSync(pidPath, "utf8"));
      const [stderr, exitCode] = await Promise.all([
        new Response(refresh.stderr).text(),
        refresh.exited,
      ]);
      expect(stderr).toContain("Restored Claude Code settings");
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Replacement proxy started without confirmed watchdog ownership");
      expect(() => process.kill(watchdogOwnerBlocker.pid, 0)).not.toThrow();
      expect(readFileSync(watchdogPidPath, "utf8")).toBe(String(watchdogOwnerBlocker.pid));
      expect(JSON.parse(readFileSync(watchdogOwnerPath, "utf8"))).toEqual(newerWatchdogOwner);
      expect(existsSync(pidPath)).toBe(false);
      expect(existsSync(portPath)).toBe(false);
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(nativeSettings);
      const restoredConfig = JSON.parse(readFileSync(join(frogHome, "config.json"), "utf8"));
      expect(restoredConfig.claudeProfiles.profiles[0].injected).toBe(false);
    } finally {
      if (replacementPid !== null) {
        try {
          process.kill(replacementPid, "SIGTERM");
        } catch {
          // The rollback should already have stopped its exact replacement.
        }
      }
      watchdogOwnerBlocker.kill();
      await watchdogOwnerBlocker.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  // Windows taskkill cannot be observed safely through Bun's child-process reaper in one test process.
  test.skipIf(process.platform === "win32")("refresh serializes stale replacement against a concurrent start", async () => {
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
        stale.exited,
        oldWatchdog.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(`Proxy running on port ${port}`);
      const replacementPid = Number(readFileSync(join(frogHome, "frogp.pid"), "utf8"));
      expect(replacementPid).not.toBe(stale.pid);
      if (replacementPid !== concurrent.pid) expect(await concurrent.exited).toBe(1);
      replacementWatchdogPid = await waitForPidReplacement(watchdogPidPath, oldWatchdog.pid);
      expect(() => process.kill(replacementWatchdogPid!, 0)).not.toThrow();
      const watchdogOwner = JSON.parse(readFileSync(join(frogHome, "watchdog.owner.json"), "utf8"));
      expect(watchdogOwner).toMatchObject({
        schemaVersion: 1,
        watchdogPid: replacementWatchdogPid,
        proxyPid: replacementPid,
      });
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
      if (replacementWatchdogPid !== null) await waitForPathRemoval(watchdogPidPath);
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

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

    expect(source).toContain("if (!refreshShutdown");
    expect(source).toContain("!parseEnvFlag(process.env.FROGP_EXTERNAL_SUPERVISOR)");
    expect(source).toContain("&& !process.env.FROGP_DETACHED");
    expect(source).toContain("resolveWatchdogEnabled(_startConfig, process.env");
  });

  test("watchdog seeds last-known pid from the supervised parent", () => {
    const watchdogSource = readFileSync(join(import.meta.dir, "..", "src", "watchdog.ts"), "utf8");

    expect(watchdogSource).toContain("let lastKnownManagedPid: number | null = opts.parentPidHint ?? null");
  });
});
