/**
 * Claude grant metadata + path safety (Branch-B core).
 *
 * A "grant" is an isolated Claude subscription login stored under a dedicated, config-dir-scoped
 * Claude home at `<frogprogsy-home>/claude-grants/<cg_id>`. This module owns ONLY metadata and path
 * safety: id shape, marker binding, deterministic list/resolve/add/remove, the scoped Keychain
 * service name, and a guided-login command that is guaranteed to invoke a REAL Claude executable
 * (never a frogprogsy shim/managed launcher). All Keychain/credential I/O lives in
 * `claude-grant-auth.ts`.
 *
 * Hard invariants enforced here:
 *  - Grant directories live strictly under the `claude-grants` root; reads/removes outside it throw.
 *  - Grant ids are `cg_<hex>` only — no path separators, no `..`.
 *  - Guided login never returns a bare `claude` (interceptable by a frogprogsy shim) and never a
 *    launcher-bin / source-dir / managed-launcher executable.
 */
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { atomicWriteFile, ensureConfigDirForWrite, getConfigDir } from "./config";
import { assertRealClaudeExecutable, claudeLauncherBinDir, findRealClaudeExecutable } from "./claude-launchers";
import type { ClaudeGrantRecord, FrogConfig } from "./types";

export const CLAUDE_GRANTS_DIR = "claude-grants";
export const GRANT_MARKER_FILE = ".frogprogsy-grant.json";
export const GRANT_CREDENTIALS_FILE = ".credentials.json";
export const GRANT_ID_PREFIX = "cg_";

/** Scoped Keychain service prefix. The native/global Claude Code service (unscoped) is off-limits. */
export const KEYCHAIN_SERVICE_PREFIX = "Claude Code-credentials-";
/** Native/global Claude Code Keychain service — grants must NEVER read or write this. */
export const NATIVE_KEYCHAIN_SERVICE = "Claude Code-credentials";


/** Default guided-login argv (after the resolved real executable). Overridable per call. */
export const DEFAULT_GRANT_LOGIN_ARGS: readonly string[] = ["auth", "login", "--claudeai"];

const GRANT_ID_RE = /^cg_[a-z0-9]{6,}$/;

export interface ClaudeGrantMarker {
  schemaVersion: 1;
  id: string;
  configDir: string;
  createdAt: string;
}

export interface ClaudeGrantLoginCommand {
  /** Absolute path to the resolved REAL Claude executable. */
  command: string;
  /** Login arguments passed to `command`. */
  args: string[];
  /** Environment that MUST be applied to the login process (scopes Claude Code to the grant dir). */
  env: Record<string, string>;
  /** Canonical grant config directory (also the value of `env.CLAUDE_CONFIG_DIR`). */
  configDir: string;
  /** Scoped Keychain service the login is expected to populate. */
  expectedService: string;
}

export interface GrantProvisionProbe {
  platform?: NodeJS.Platform;
  /** Returns true when the scoped Keychain service holds a credential (darwin). */
  hasScopedCredential?: (service: string) => boolean | Promise<boolean>;
  /** Returns true when the non-darwin `<configDir>/.credentials.json` fallback exists. */
  hasFileCredential?: (path: string) => boolean | Promise<boolean>;
}

// ── ids ───────────────────────────────────────────────────────────────────

export function isValidGrantId(id: unknown): id is string {
  return typeof id === "string" && GRANT_ID_RE.test(id);
}

export function createClaudeGrantId(existing: Iterable<string> = []): string {
  const taken = new Set(existing);
  for (let i = 0; i < 1000; i++) {
    const id = `${GRANT_ID_PREFIX}${randomBytes(6).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
  throw new Error("unable to allocate a unique claude grant id");
}

// ── paths ─────────────────────────────────────────────────────────────────

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function grantsRoot(): string {
  return join(canonical(getConfigDir()), CLAUDE_GRANTS_DIR);
}

/**
 * Canonicalize `targetPath` and assert it is strictly inside the claude-grants root. Throws on the
 * root itself or anything outside it. Returned value is the canonical, in-root path.
 */
export function assertInsideGrantsRoot(operation: string, targetPath: string): string {
  const root = canonical(grantsRoot());
  const target = canonical(targetPath);
  if (target === root) {
    throw new Error(`${operation} refused: target equals the claude-grants root ${root}`);
  }
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error(`${operation} refused: ${target} is outside the claude-grants root ${root}`);
  }
  return target;
}

/** Canonical grant directory for a valid id. Rejects malformed ids and out-of-root results. */
export function grantConfigDir(id: string): string {
  if (!isValidGrantId(id)) throw new Error(`invalid claude grant id: ${JSON.stringify(id)}`);
  return assertInsideGrantsRoot("resolve claude grant dir", join(grantsRoot(), id));
}

export function grantMarkerPath(configDir: string): string {
  return join(assertInsideGrantsRoot("resolve grant marker path", configDir), GRANT_MARKER_FILE);
}

export function grantCredentialsPath(configDir: string): string {
  return join(assertInsideGrantsRoot("resolve grant credentials path", configDir), GRANT_CREDENTIALS_FILE);
}

// ── keychain service derivation ─────────────────────────────────────────────

/**
 * Scoped Keychain service for a grant config dir: `Claude Code-credentials-<sha256(dir)[0..8]>`.
 * Canonicalizes the dir first so the value matches the exact `CLAUDE_CONFIG_DIR` string handed to
 * Claude Code during guided login. This is intentionally NEVER the unscoped native service.
 */
export function expectedKeychainService(configDir: string): string {
  const dir = canonical(configDir);
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return `${KEYCHAIN_SERVICE_PREFIX}${hash}`;
}

export function isScopedKeychainService(service: string): boolean {
  return service !== NATIVE_KEYCHAIN_SERVICE && service.startsWith(KEYCHAIN_SERVICE_PREFIX);
}

/** Throw unless `service` is a scoped grant service (guards accidental native/global writes). */
export function assertScopedKeychainService(operation: string, service: string): string {
  if (!isScopedKeychainService(service)) {
    throw new Error(`${operation} refused: ${JSON.stringify(service)} is not a scoped grant Keychain service`);
  }
  return service;
}

// ── marker ──────────────────────────────────────────────────────────────────

export function writeGrantMarker(configDir: string, marker: ClaudeGrantMarker): void {
  const path = grantMarkerPath(configDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFile(path, JSON.stringify(marker, null, 2) + "\n");
}

export function readGrantMarker(configDir: string): ClaudeGrantMarker | null {
  const path = grantMarkerPath(configDir);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ClaudeGrantMarker>;
    if (parsed?.schemaVersion === 1 && isValidGrantId(parsed.id) && typeof parsed.configDir === "string" && typeof parsed.createdAt === "string") {
      return parsed as ClaudeGrantMarker;
    }
  } catch {
    /* missing / corrupt marker */
  }
  return null;
}

// ── config collection ─────────────────────────────────────────────────────

export function ensureClaudeGrants(config: FrogConfig): NonNullable<FrogConfig["claudeGrants"]> {
  const existing = config.claudeGrants;
  if (!existing || existing.schemaVersion !== 1 || !Array.isArray(existing.grants)) {
    config.claudeGrants = { schemaVersion: 1, grants: Array.isArray(existing?.grants) ? existing!.grants : [] };
  }
  return config.claudeGrants!;
}

export function listClaudeGrants(config: FrogConfig): ClaudeGrantRecord[] {
  return ensureClaudeGrants(config).grants.filter(grant => isValidGrantId(grant.id));
}

export function getClaudeGrantById(config: FrogConfig, id: string): ClaudeGrantRecord | undefined {
  return listClaudeGrants(config).find(grant => grant.id === id);
}

/** Resolve a grant by id (preferred) or exact label. Throws on missing / ambiguous label. */
export function resolveClaudeGrant(config: FrogConfig, selector: string): ClaudeGrantRecord {
  const grants = listClaudeGrants(config);
  const byId = grants.find(grant => grant.id === selector);
  if (byId) return byId;
  const byLabel = grants.filter(grant => grant.label === selector);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) throw new Error(`claude grant label ${JSON.stringify(selector)} is ambiguous; use the id`);
  throw new Error(`claude grant not found: ${selector}`);
}

/**
 * Create a grant: allocate an id, materialize the scoped dir + marker, and append the record to the
 * config object (in memory — the caller persists). Does not perform any login.
 */
export function addClaudeGrant(config: FrogConfig, input: { label: string; id?: string }): ClaudeGrantRecord {
  const collection = ensureClaudeGrants(config);
  const id = input.id ?? createClaudeGrantId(collection.grants.map(grant => grant.id));
  if (!isValidGrantId(id)) throw new Error(`invalid claude grant id: ${JSON.stringify(id)}`);
  if (collection.grants.some(grant => grant.id === id)) throw new Error(`claude grant already exists: ${id}`);

  ensureConfigDirForWrite("add claude grant");
  const configDir = grantConfigDir(id);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const createdAt = new Date().toISOString();
  writeGrantMarker(configDir, { schemaVersion: 1, id, configDir, createdAt });

  const record: ClaudeGrantRecord = { id, label: input.label, configDir, createdAt };
  collection.grants.push(record);
  return record;
}

/**
 * Validate every destructive filesystem invariant without mutating the credential store, directory,
 * or config. Callers that also delete a scoped credential MUST run this preflight first.
 */
export function assertClaudeGrantRemovalSafe(config: FrogConfig, selector: string): ClaudeGrantRecord {
  const record = resolveClaudeGrant(config, selector);
  const dir = assertInsideGrantsRoot("remove claude grant", record.configDir);
  const expected = canonical(join(grantsRoot(), record.id));
  if (dir !== expected) {
    throw new Error(`remove claude grant refused: ${dir} does not match the expected ${expected}`);
  }
  if (existsSync(dir)) {
    const marker = readGrantMarker(dir);
    if (!marker || marker.id !== record.id) {
      throw new Error(`remove claude grant refused: marker id ${marker?.id ?? "(missing)"} does not bind ${record.id}`);
    }
  }
  return record;
}

/**
 * Remove a grant record and its scoped dir. Refuses to delete anything outside the claude-grants
 * root, anything whose path is not exactly `<root>/<id>`, or a dir whose marker binds a different id.
 */
export function removeClaudeGrant(config: FrogConfig, selector: string): ClaudeGrantRecord {
  const collection = ensureClaudeGrants(config);
  const record = assertClaudeGrantRemovalSafe(config, selector);
  const dir = assertInsideGrantsRoot("remove claude grant", record.configDir);

  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  collection.grants = collection.grants.filter(grant => grant.id !== record.id);
  return record;
}

// ── guided login (real-executable enforcement) ──────────────────────────────

// The real-executable validator lives in `claude-launchers.ts`: every check it performs depends on that
// module (launcher bin dir, launcher detection, source dir), and grants already imports from it, so keeping
// it here would require a cycle. Re-exported so existing grant callers and tests keep one import site.
export { assertRealClaudeExecutable } from "./claude-launchers";

/**
 * Build a guided-login command for a grant. The executable is either caller-provided (`realClaude`)
 * or resolved via `resolveRealClaude` (default: `findRealClaudeExecutable`, skipping the launcher bin
 * and grants root). Whatever is chosen must pass `assertRealClaudeExecutable`, so this can never
 * return a bare `claude` or a frogprogsy shim.
 */
export function buildClaudeGrantLoginCommand(input: {
  grant: Pick<ClaudeGrantRecord, "id" | "configDir">;
  realClaude?: string;
  resolveRealClaude?: (skipDirs: string[]) => string;
  loginArgs?: readonly string[];
}): ClaudeGrantLoginCommand {
  const configDir = assertInsideGrantsRoot("claude grant login", input.grant.configDir);
  const binDir = claudeLauncherBinDir();
  const resolver = input.resolveRealClaude ?? ((skip: string[]) => findRealClaudeExecutable(skip));
  const candidate = input.realClaude ?? resolver([binDir, grantsRoot()]);
  const command = assertRealClaudeExecutable(candidate);
  return {
    command,
    args: [...(input.loginArgs ?? DEFAULT_GRANT_LOGIN_ARGS)],
    env: { CLAUDE_CONFIG_DIR: configDir },
    configDir,
    expectedService: expectedKeychainService(configDir),
  };
}

/**
 * Setup contract: a grant is only usable once its expected scoped credential exists after login.
 * The actual credential existence check is injected (darwin: Keychain; non-darwin: file), keeping
 * this module free of credential I/O. Throws when the credential is absent.
 */
export async function verifyClaudeGrantProvisioned(
  grant: Pick<ClaudeGrantRecord, "id" | "configDir">,
  probe: GrantProvisionProbe = {},
): Promise<{ ok: true; service: string; configDir: string }> {
  const configDir = assertInsideGrantsRoot("verify claude grant", grant.configDir);
  const service = expectedKeychainService(configDir);
  const platform = probe.platform ?? process.platform;

  let present: boolean;
  if (platform === "darwin") {
    if (!probe.hasScopedCredential) {
      throw new Error("verify claude grant requires a scoped-credential probe on darwin");
    }
    present = await probe.hasScopedCredential(service);
  } else {
    if (!probe.hasFileCredential) {
      throw new Error("verify claude grant requires a file-credential probe off darwin");
    }
    present = await probe.hasFileCredential(grantCredentialsPath(configDir));
  }

  if (!present) {
    throw new Error(`claude grant ${grant.id} is not provisioned: expected scoped credential ${service} was not found after login`);
  }
  return { ok: true, service, configDir };
}
