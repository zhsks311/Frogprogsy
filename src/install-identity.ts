import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstallKind } from "./update-status-contract";
export type { InstallKind } from "./update-status-contract";


export interface InstallIdentity {
  kind: InstallKind;
  version: string;
}

export interface InstallIdentityDeps {
  packageRoot?: string;
  version?: string;
  devReceiptExists?: boolean;
  bunGlobalBin?: () => Promise<string | null>;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
}

const DEFAULT_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_BUN_BIN_OUTPUT_BYTES = 16 * 1024;
const BUN_BIN_TIMEOUT_MS = 3_000;

export function installedPackageVersion(packageRoot = DEFAULT_PACKAGE_ROOT): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object" || !("version" in parsed)) return "?";
    const version = parsed.version;
    return typeof version === "string" && version.length > 0 ? version : "?";
  } catch {
    return "?";
  }
}

/** Fast fail-closed identity used before asynchronous Bun ownership verification completes. */
export function installIdentityHint(packageRoot = DEFAULT_PACKAGE_ROOT): InstallIdentity {
  const version = installedPackageVersion(packageRoot);
  if (!packageRoot.split(/[\\/]+/).includes("node_modules")) return { kind: "source", version };
  if (existsSync(join(packageRoot, ".frogprogsy-dev-build.json"))) return { kind: "development", version };
  return { kind: "unsupported", version };
}

async function queryBunGlobalBin(): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const child = spawn(process.execPath, ["pm", "bin", "-g"], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  let output = "";
  let settled = false;
  let timer: NodeJS.Timeout;
  const finish = (value: string | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const abortProbe = () => {
    if (settled) return;
    child.stdout.removeAllListeners("data");
    child.stdout.destroy();
    child.kill("SIGKILL");
    child.unref();
    finish(null);
  };
  timer = setTimeout(abortProbe, BUN_BIN_TIMEOUT_MS);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    if (settled) return;
    output += chunk;
    if (Buffer.byteLength(output) > MAX_BUN_BIN_OUTPUT_BYTES) abortProbe();
  });
  child.once("error", () => finish(null));
  child.once("close", code => finish(code === 0 ? output.trim() || null : null));
  return promise;
}

/** Resolve package ownership without blocking Bun's event loop on a synchronous package-manager command. */
export async function detectInstallIdentity(deps: InstallIdentityDeps = {}): Promise<InstallIdentity> {
  const packageRoot = deps.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const version = deps.version ?? installedPackageVersion(packageRoot);
  const exists = deps.exists ?? existsSync;
  const realpath = deps.realpath ?? realpathSync;
  if (!packageRoot.split(/[\\/]+/).includes("node_modules")) return { kind: "source", version };

  const binDir = await (deps.bunGlobalBin ?? queryBunGlobalBin)();
  if (!binDir) return { kind: "unsupported", version };
  let packageRootReal: string;
  try {
    packageRootReal = realpath(packageRoot);
  } catch {
    return { kind: "unsupported", version };
  }
  let bunLayoutRootReal: string | null = null;
  try {
    bunLayoutRootReal = realpath(join(dirname(binDir), "install", "global", "node_modules", "frogprogsy"));
  } catch {
    // A linked/global layout may still be proven by the executable's real target below.
  }
  let bunManaged = false;
  for (const name of ["frogp", "frogp.exe", "frogp.cmd"]) {
    const bin = join(binDir, name);
    if (!exists(bin)) continue;
    if (bunLayoutRootReal === packageRootReal) {
      bunManaged = true;
      break;
    }
    try {
      bunManaged = realpath(dirname(dirname(realpath(bin)))) === packageRootReal;
    } catch {
      continue;
    }
    if (bunManaged) break;
  }
  if (!bunManaged) return { kind: "unsupported", version };
  const devReceiptExists = deps.devReceiptExists ?? exists(join(packageRoot, ".frogprogsy-dev-build.json"));
  return { kind: devReceiptExists ? "development" : "bun", version };
}
