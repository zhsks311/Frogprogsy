import { spawn, spawnSync } from "node:child_process";
import {
  DEFAULT_PORT,
  loadConfig,
  readActivePort,
  readPid,
  removePid,
  removeActivePort,
  writeShutdownIntent,
} from "./config";
import { detectInstallIdentity } from "./install-identity";
import type { InstallKind } from "./install-identity";
import { compareSemVer, parseCanonicalStableSemVer, parseSemVer } from "./semver";
import { parseEnvFlag } from "./watchdog";

const PKG = "frogprogsy";

/** Explicit update follows the user's configured Bun registry rather than the automatic check endpoint. */
function latestVersionFromBun(): string | null {
  const result = spawnSync("bun", ["pm", "view", PKG, "version"], {
    encoding: "utf8",
    timeout: 12_000,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

// ---------------------------------------------------------------------------
// Health-poll helper (inlined — do not import from cli.ts to avoid circularity)
// ---------------------------------------------------------------------------

async function pollHealthz(resolvePort: () => number, timeoutMs = 12_000): Promise<{ ok: boolean; port: number }> {
  const deadline = Date.now() + timeoutMs;
  let port = resolvePort();
  while (Date.now() < deadline) {
    port = resolvePort(); // re-resolve each poll: the respawned proxy may pick a new port (findAvailablePort)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(750),
      });
      if (res.ok) return { ok: true, port };
    } catch { /* retry */ }
    await new Promise<void>(r => setTimeout(r, 200));
  }
  return { ok: false, port };
}

// ---------------------------------------------------------------------------
// Kill helper (inlined — do not import from cli.ts to avoid circularity)
// ---------------------------------------------------------------------------

function killRunningProxy(): void {
  const pid = readPid();
  if (!pid) return;
  try {
    writeShutdownIntent(pid);
    process.kill(pid, "SIGTERM");
    // Spin-wait up to 5 s for the process to exit.
    const deadline = Date.now() + 5_000;
    const marker = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; } // gone
      Atomics.wait(marker, 0, 0, 50);
    }
  } catch { /* already gone */ }
  removePid();
  removeActivePort();
}

// ---------------------------------------------------------------------------
// Public API (exported for tests)
// ---------------------------------------------------------------------------

/**
 * After a successful install-managed update, write shutdown intent, stop the running proxy,
 * spawn `frogp start` detached, then poll /healthz until healthy or deadline.
 * Exits the process with code 1 on failure.
 */
export async function ensureAfterUpdate(): Promise<void> {
  console.log("♻️  Restarting proxy after update…");
  killRunningProxy();

  const child = spawn(process.execPath, [process.argv[1], "start"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  const result = await pollHealthz(() => readActivePort() ?? loadConfig().port ?? DEFAULT_PORT);
  if (!result.ok) {
    console.error(
      `❌ Proxy did not become healthy on port ${result.port} after update. Run: frogp start`,
    );
    process.exit(1);
  }
  console.log(`✅ Proxy restarted and healthy on port ${result.port}.`);
}

/**
 * Decide what to do after a successful non-source update:
 * - source install → print manual hint
 * - FROGP_EXTERNAL_SUPERVISOR set → print external-supervisor restart hint
 * - otherwise → auto-ensure (stop + detached respawn + health poll)
 */
export async function planUpdateRestart(installer: InstallKind): Promise<void> {
  if (installer === "source") {
    console.log("Restart the proxy:  git pull && bun install && frogp stop && frogp start");
    return;
  }
  if (installer === "unsupported" || installer === "development") {
    console.log("This package is not eligible for an automatic restart after update.");
    return;
  }
  if (parseEnvFlag(process.env.FROGP_EXTERNAL_SUPERVISOR)) {
    // External-supervisor-managed proxies re-inject on their own restart; skip auto-ensure.
    console.log(
      "External-supervisor-managed proxy: the supervisor will restart. Or run manually: frogp stop && frogp start",
    );
    return;
  }
  await ensureAfterUpdate();
}

/**
 * `frogp update` — self-update a Bun-managed global package. Source checkouts
 * use git pull; packages installed by another manager are rejected explicitly.
 */
export async function runUpdate(noRestart = false): Promise<void> {
  const identity = await detectInstallIdentity();
  const installer = identity.kind;
  const current = identity.version;
  console.log(`frogprogsy v${current} (installed via ${installer})`);

  if (installer === "source") {
    console.log("Running from a source checkout — update with:  git pull && bun install");
    return;
  }
  if (installer === "unsupported") {
    console.error("⚠️  This installation is not managed by Bun.");
    console.error("    Reinstall with Bun: bun add -g frogprogsy");
    process.exit(1);
  }
  if (installer === "development") {
    console.error("⚠️  This is an explicitly installed development build.");
    console.error("    Replace it from the source repository with: bun run dev:package reinstall --yes");
    process.exit(1);
  }

  const latestRaw = latestVersionFromBun();
  const latest = latestRaw === null ? null : parseCanonicalStableSemVer(latestRaw);
  if (!latestRaw || !latest) {
    console.error("⚠️  Could not read a valid stable frogprogsy version from the package registry.");
    console.error("    Nothing was changed. If you installed from a git checkout, update with: git pull && bun install");
    process.exit(1);
  }
  const currentVersion = parseSemVer(current);
  if (!currentVersion) {
    console.error(`⚠️  Installed version ${current} is not valid SemVer; refusing to replace it automatically.`);
    process.exit(1);
  }
  const ordering = compareSemVer(latest, currentVersion);
  if (ordering <= 0) {
    console.log(ordering === 0
      ? `Already on the latest version (v${latestRaw}).`
      : `Installed version v${current} is newer than stable latest v${latestRaw}; nothing changed.`);
    return;
  }

  const cmdArgs = ["add", "-g", `${PKG}@latest`];
  console.log(`Updating to v${latestRaw}…\n$ bun ${cmdArgs.join(" ")}`);

  const result = spawnSync("bun", cmdArgs, { stdio: "inherit", timeout: 180_000, windowsHide: true });
  if (result.status === 0) {
    console.log(`\n✅ Updated to v${latestRaw}.`);
    if (noRestart) {
      console.log("Restart the proxy manually: frogp stop && frogp start");
    } else {
      await planUpdateRestart(installer);
    }
  } else {
    console.error(`\n⚠️  Update failed (bun exit ${result.status ?? "?"}). Try manually: bun ${cmdArgs.join(" ")}`);
    process.exit(1);
  }
}
