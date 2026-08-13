import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chooseLatestBuild,
  classifyDevInstall,
  isDevBuildManifest,
  recordLatest,
  trackedSourceDirty,
  verifyNoOwnedPlainClaude,
  verifyPackagedModelCatalog,
  type DevBuildManifest,
  type InstalledDevBuildManifest,
} from "../scripts/dev-package";

const root = new URL("../", import.meta.url);

function manifest(overrides: Partial<DevBuildManifest> = {}): DevBuildManifest {
  return {
    schemaVersion: 1,
    buildId: "0.0.1-gabc123-20260718T120000000Z-1234567890ab",
    version: "0.0.1",
    gitCommit: "abc123",
    gitBranch: "feature/package",
    gitDirty: false,
    completedAt: "2026-07-18T12:00:00.000Z",
    tarballFile: "builds/build/frogprogsy.tgz",
    tarballSha256: "a".repeat(64),
    tarballBytes: 1024,
    ...overrides,
  };
}

function installed(overrides: Partial<InstalledDevBuildManifest> = {}): InstalledDevBuildManifest {
  return {
    ...manifest(),
    installedAt: "2026-07-18T12:01:00.000Z",
    ...overrides,
  };
}

describe("dev package manifest", () => {
  test("accepts a repository-relative immutable tarball receipt", () => {
    expect(isDevBuildManifest(manifest())).toBe(true);
  });

  test("rejects absolute and traversing tarball paths", () => {
    expect(isDevBuildManifest(manifest({ tarballFile: "/tmp/frogprogsy.tgz" }))).toBe(false);
    expect(isDevBuildManifest(manifest({ tarballFile: "../frogprogsy.tgz" }))).toBe(false);
    expect(isDevBuildManifest(manifest({ tarballFile: "builds/../../frogprogsy.tgz" }))).toBe(false);
  });

  test("rejects malformed hashes, timestamps, sizes, and build ids", () => {
    expect(isDevBuildManifest(manifest({ tarballSha256: "short" }))).toBe(false);
    expect(isDevBuildManifest(manifest({ completedAt: "not-a-date" }))).toBe(false);
    expect(isDevBuildManifest(manifest({ tarballBytes: 0 }))).toBe(false);
    expect(isDevBuildManifest(manifest({ buildId: "../escape" }))).toBe(false);
  });

  test("latest means the most recently completed successful package", () => {
    const older = manifest({ buildId: "older", completedAt: "2026-07-18T11:59:00.000Z" });
    const newer = manifest({ buildId: "newer", completedAt: "2026-07-18T12:01:00.000Z" });
    expect(chooseLatestBuild(older, newer).buildId).toBe("newer");
    expect(chooseLatestBuild(newer, older).buildId).toBe("newer");
  });

  test("a deterministic build-id tie break prevents last-writer ambiguity", () => {
    const a = manifest({ buildId: "build-a" });
    const b = manifest({ buildId: "build-b" });
    expect(chooseLatestBuild(a, b).buildId).toBe("build-b");
    expect(chooseLatestBuild(b, a).buildId).toBe("build-b");
  });

  test("serializes concurrent latest writes without regressing completion order", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "frogprogsy-latest-"));
    const candidates = Array.from({ length: 16 }, (_, index) => manifest({
      buildId: `build-${index.toString().padStart(2, "0")}`,
      completedAt: new Date(Date.parse("2026-07-18T12:00:00.000Z") + index).toISOString(),
    }));

    try {
      await Promise.all(candidates.slice().reverse().map(candidate => recordLatest(cacheRoot, candidate)));
      const latest = JSON.parse(readFileSync(join(cacheRoot, "latest.json"), "utf8")) as DevBuildManifest;
      expect(latest.buildId).toBe("build-15");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

describe("dev package install status", () => {
  test("distinguishes missing, untracked, current, and outdated installs", () => {
    const latest = manifest({ buildId: "latest" });
    expect(classifyDevInstall(latest, null, false)).toBe("not-installed");
    expect(classifyDevInstall(latest, null, true)).toBe("untracked");
    expect(classifyDevInstall(latest, installed({ buildId: "latest" }), true)).toBe("current");
    expect(classifyDevInstall(latest, installed({ buildId: "older" }), true)).toBe("outdated");
    expect(classifyDevInstall(null, installed({ buildId: "only" }), true)).toBe("installed-no-latest");
  });
});

describe("dev package command ownership", () => {
  test("rejects plain claude owned by any frogprogsy package root", () => {
    const root = mkdtempSync(join(tmpdir(), "frogprogsy-owned-claude-"));
    const packageRoot = join(root, "stale-package");
    const binDir = join(packageRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    try {
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "frogprogsy" }), "utf8");
      writeFileSync(join(binDir, "claude"), "#!/bin/sh\n", "utf8");

      expect(() => verifyNoOwnedPlainClaude(binDir)).toThrow(/still owns the plain claude command/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Bun-only development package contract", () => {
  test("package.json exposes the Bun development package command", async () => {
    const pkg = await Bun.file(new URL("package.json", root)).json() as {
      packageManager?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(pkg.packageManager).toMatch(/^bun@/);
    expect(pkg.scripts?.["dev:package"]).toBe("bun scripts/dev-package.ts");
    expect(pkg.scripts?.test).toBe("bun test --isolate ./tests");
    expect(pkg.dependencies?.zod).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("development packaging cannot invoke destructive product uninstall or npm", async () => {
    const source = await Bun.file(new URL("scripts/dev-package.ts", root)).text();
    expect(source).toContain('"pm", "pack"');
    expect(source).toContain('"add", "-g"');
    expect(source).toContain('"remove", "-g"');
    expect(source).toContain('"--git-common-dir"');
    expect(source).toContain("Global package replacement requires --yes");
    expect(source).toContain('run("bun", ["run", "test"])');
    expect(source).not.toContain("frogp uninstall");
    expect(source).not.toContain("getConfigDir");
    expect(source).not.toMatch(/spawnSync\(["']npm["']/);
    expect(source).not.toMatch(/run\(["']npm["']/);
  });

  test("prepublish catalog generation does not change clean or dirty source classification", async () => {
    const repositoryRoot = fileURLToPath(root);
    const pkg = await Bun.file(new URL("package.json", root)).json() as { scripts?: Record<string, string> };
    const generateCommand = pkg.scripts?.["generate:model-catalog:git"] ?? "";
    expect(generateCommand).toBe("bun run generate:model-catalog -- --git-derived");

    const tempRoot = mkdtempSync(join(tmpdir(), "frogprogsy-dirty-state-"));
    try {
      expect(spawnSync("git", ["init"], { cwd: tempRoot }).status).toBe(0);
      expect(spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: tempRoot }).status).toBe(0);
      expect(spawnSync("git", ["config", "user.name", "Test"], { cwd: tempRoot }).status).toBe(0);
      expect(spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tempRoot }).status).toBe(0);
      mkdirSync(join(tempRoot, ".git", "disabled-hooks"));
      expect(spawnSync("git", ["config", "core.hooksPath", ".git/disabled-hooks"], { cwd: tempRoot }).status).toBe(0);
      writeFileSync(join(tempRoot, "package.json"), JSON.stringify({
        scripts: {
          "generate:model-catalog": `bun ${join(repositoryRoot, "scripts", "generate-model-catalog.ts")}`,
          "generate:model-catalog:git": generateCommand,
        },
      }), "utf8");
      writeFileSync(join(tempRoot, "tracked.txt"), "clean\n", "utf8");
      expect(spawnSync("git", ["add", "package.json", "tracked.txt"], { cwd: tempRoot }).status).toBe(0);
      expect(spawnSync("git", ["commit", "-m", "fixture"], { cwd: tempRoot }).status).toBe(0);

      expect(trackedSourceDirty(tempRoot)).toBe(false);
      const generated = spawnSync("bun", ["run", "generate:model-catalog:git"], { cwd: tempRoot });
      expect(generated.status).toBe(0);
      expect(trackedSourceDirty(tempRoot)).toBe(false);

      const catalogOutsideWorktree = join(tempRoot, ".git", "frogprogsy-prepublish-model-catalog-v1.json");
      expect(readFileSync(catalogOutsideWorktree, "utf8")).toContain(`"sourceCommit":`);
      writeFileSync(join(tempRoot, "tracked.txt"), "dirty\n", "utf8");
      expect(trackedSourceDirty(tempRoot)).toBe(true);
      const dirtyGenerated = spawnSync("bun", ["run", "generate:model-catalog:git"], { cwd: tempRoot });
      expect(dirtyGenerated.status).toBe(0);
      expect(trackedSourceDirty(tempRoot)).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("build generates an exact tracked-SHA catalog before GUI build and validates it after packing", async () => {
    const source = await Bun.file(new URL("scripts/dev-package.ts", root)).text();
    const generator = source.indexOf('"generate:model-catalog"');
    const install = source.indexOf('run("bun", ["install", "--frozen-lockfile"])');
    const gui = source.indexOf('run("bun", ["run", "build:gui"])');
    const pack = source.indexOf('"pm", "pack"');
    const tarballValidation = source.indexOf("verifyPackagedModelCatalog(stagedTarball)");

    expect(source).toContain('commandResult("git", ["rev-parse", "HEAD"])');
    expect(source).toContain('commandResult("git", ["show", "-s", "--format=%cI", sourceCommit])');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(generator);
    expect(source).not.toContain('import { catalogDataDigest } from "../src/model-catalog-generator"');
    expect(source).not.toContain("  modelCatalogDocumentV1Schema,");
    expect(generator).toBeGreaterThan(-1);
    expect(gui).toBeGreaterThan(generator);
    expect(pack).toBeGreaterThan(gui);
    expect(tarballValidation).toBeGreaterThan(pack);
  });

  test("packed catalog validation extracts the real tarball member and enforces the strict schema", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "frogprogsy-catalog-tarball-"));
    const packageRoot = join(tempRoot, "package");
    const generatedDir = join(packageRoot, "src", "generated");
    const catalogPath = join(generatedDir, "model-catalog-v1.json");
    const tarball = join(tempRoot, "frogprogsy.tgz");
    const repositoryRoot = fileURLToPath(root);
    const sourceCommit = "a".repeat(40);
    const generatedAt = "2026-08-13T00:00:00Z";

    mkdirSync(generatedDir, { recursive: true });
    try {
      const generated = spawnSync(
        "bun",
        [
          "scripts/generate-model-catalog.ts",
          "--source-commit",
          sourceCommit,
          "--generated-at",
          generatedAt,
          "--out",
          catalogPath,
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      expect(generated.status).toBe(0);

      const packed = spawnSync("tar", ["-czf", tarball, "-C", tempRoot, "package"], { encoding: "utf8" });
      expect(packed.status).toBe(0);
      expect(verifyPackagedModelCatalog(tarball)).toMatchObject({ sourceCommit, generatedAt });

      const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Record<string, unknown>;
      catalog.unexpected = true;
      writeFileSync(catalogPath, JSON.stringify(catalog), "utf8");
      const repacked = spawnSync("tar", ["-czf", tarball, "-C", tempRoot, "package"], { encoding: "utf8" });
      expect(repacked.status).toBe(0);
      expect(() => verifyPackagedModelCatalog(tarball)).toThrow();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("install preflights before replacement and retains rollback", async () => {
    const source = await Bun.file(new URL("scripts/dev-package.ts", root)).text();
    const installStart = source.indexOf("async function installBuild");
    const installEnd = source.indexOf("function uninstallPackage", installStart);
    const installBody = source.slice(installStart, installEnd);
    const preflight = installBody.indexOf("preflightTarballInstall");
    const remove = installBody.indexOf("removeBunPackageOnly");
    const install = installBody.indexOf('run("bun", ["add", "-g"');
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(remove);
    expect(remove).toBeLessThan(install);
    expect(installBody).toContain("restorePreviousInstall");
  });
});
