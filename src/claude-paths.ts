import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

function defaultClaudeCodeHome(): string {
  return join(homedir(), ".claude");
}

export function resolveClaudeCodeHome(explicitHome?: string): string {
  const raw = explicitHome?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || process.env.CLAUDE_HOME?.trim();
  if (raw) {
    const path = resolve(raw);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      const source = explicitHome ? "Claude Code home" : process.env.CLAUDE_CONFIG_DIR?.trim() ? "CLAUDE_CONFIG_DIR" : "CLAUDE_HOME";
      throw new Error(`${source} points to a path that could not be read`);
    }
    if (!stat.isDirectory()) {
      const source = explicitHome ? "Claude Code home" : process.env.CLAUDE_CONFIG_DIR?.trim() ? "CLAUDE_CONFIG_DIR" : "CLAUDE_HOME";
      throw new Error(`${source} points to a path that is not a directory`);
    }
    try {
      return realpathSync.native(path);
    } catch {
      const source = explicitHome ? "Claude Code home" : process.env.CLAUDE_CONFIG_DIR?.trim() ? "CLAUDE_CONFIG_DIR" : "CLAUDE_HOME";
      throw new Error(`${source} points to a path that could not be read`);
    }
  }
  return defaultClaudeCodeHome();
}

// Do not resolve the environment-selected home at module import time. A bad CLAUDE_CONFIG_DIR used to
// throw before CLI entrypoints could catch it, printing the raw path and an OS stack trace. Every accessor
// below resolves only when the operation actually needs a home, inside the caller's normal error boundary.
export function claudeConfigTomlPath(claudeHome = resolveClaudeCodeHome()): string {
  return join(claudeHome, "config.toml");
}

export function claudeLegacyProfilePath(claudeHome = resolveClaudeCodeHome()): string {
  return join(claudeHome, "frogprogsy.config.toml");
}

export function claudeCatalogPath(claudeHome = resolveClaudeCodeHome()): string {
  return join(claudeHome, "frogprogsy-catalog.json");
}

export function claudeModelsCachePath(claudeHome = resolveClaudeCodeHome()): string {
  return join(claudeHome, "models_cache.json");
}
export function claudeGatewayModelsCachePath(claudeHome = resolveClaudeCodeHome()): string {
  return join(claudeHome, "cache", "gateway-models.json");
}

export function assertSafeClaudeHomeWrite(operation: string, targetPath = resolveClaudeCodeHome()): void {
  if (process.env.NODE_ENV !== "test") return;
  const target = resolve(targetPath);
  const defaultHome = resolve(defaultClaudeCodeHome());
  if (target === defaultHome || target.startsWith(`${defaultHome}${sep}`)) {
    throw new Error(`${operation} refused to write to ${target} while NODE_ENV=test. Set CLAUDE_CONFIG_DIR or CLAUDE_HOME to an isolated temp directory before this operation.`);
  }
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function parseTomlString(raw: string): string {
  if (raw.startsWith("\"")) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw.slice(1, -1);
}

export function readRootTomlString(content: string, key: string): string | null {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const rootLines = firstTable === -1 ? lines : lines.slice(0, firstTable);
  for (const line of rootLines) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(\"(?:\\\\.|[^\"])*\"|'[^']*')`));
    if (m) return parseTomlString(m[1]);
  }
  return null;
}

export function resolveClaudeCodeConfigPath(path: string, claudeHome = resolveClaudeCodeHome()): string {
  return isAbsolute(path) ? path : join(claudeHome, path);
}
