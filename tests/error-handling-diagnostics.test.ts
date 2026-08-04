import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, getConfigPath, getDefaultConfig, loadConfig } from "../src/config";
import { loadAuthStore } from "../src/oauth/store";
import { debugSwallowed } from "../src/debug";

function captureWarn(fn: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

function captureError(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

describe("silently-swallowed errors are surfaced", () => {
  test("loadConfig warns and falls back to defaults when config.json is corrupt", () => {
    writeFileSync(getConfigPath(), "{ not valid json", "utf-8");
    let config: ReturnType<typeof loadConfig>;
    const warnings = captureWarn(() => { config = loadConfig(); });
    expect(config!).toEqual(getDefaultConfig());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("config.json");
    expect(warnings[0]).toContain("defaults");
  });

  test("loadConfig stays silent for a fresh install with no config file", () => {
    rmSync(getConfigPath(), { force: true });
    const warnings = captureWarn(() => { loadConfig(); });
    expect(warnings).toHaveLength(0);
  });

  test("loadAuthStore warns and returns an empty store when auth.json is corrupt", () => {
    writeFileSync(join(getConfigDir(), "auth.json"), "}}not json{{", "utf-8");
    let store: ReturnType<typeof loadAuthStore>;
    const warnings = captureWarn(() => { store = loadAuthStore(); });
    expect(store!).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("auth.json");
    expect(warnings[0]).toContain("overwrite");
  });
});

describe("debugSwallowed opt-in diagnostic", () => {
  test("no-ops when FROGP_DEBUG is unset", () => {
    const previous = process.env.FROGP_DEBUG;
    delete process.env.FROGP_DEBUG;
    try {
      const lines = captureError(() => { debugSwallowed("unit", new Error("boom")); });
      expect(lines).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.FROGP_DEBUG;
      else process.env.FROGP_DEBUG = previous;
    }
  });

  test("emits a scoped, tagged line when FROGP_DEBUG=1", () => {
    const previous = process.env.FROGP_DEBUG;
    process.env.FROGP_DEBUG = "1";
    try {
      const lines = captureError(() => { debugSwallowed("unit", new Error("boom")); });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("[frogp:swallowed]");
      expect(lines[0]).toContain("unit");
      expect(lines[0]).toContain("boom");
    } finally {
      if (previous === undefined) delete process.env.FROGP_DEBUG;
      else process.env.FROGP_DEBUG = previous;
    }
  });
});
