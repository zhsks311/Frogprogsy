import { describe, expect, test } from "bun:test";
import { registryVersionListed } from "../scripts/release-registry";
import {
  parseReleaseCommand,
  selectDispatchedWorkflowRun,
  type WorkflowRun,
} from "../scripts/release";

const root = new URL("../", import.meta.url);

async function read(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("Bun-first release and installation contract", () => {
  test("release helper keeps registry inspection Bun-first without a local version-preparation path", async () => {
    const source = await read("scripts/release.ts");
    expect(source).not.toContain("writePackageVersion");
    expect(source).not.toContain('kind: "prepare"');
    expect(source).not.toContain("npm version");
    expect(source).not.toContain("npm install -g");
  });

  test("release registry preflight distinguishes used and unused versions", () => {
    const versions = JSON.stringify(["0.0.1", "0.0.2-preview.1"]);
    expect(registryVersionListed(versions, "0.0.2-preview.1")).toBe(true);
    expect(registryVersionListed(versions, "0.0.2-preview.2")).toBe(false);
    expect(registryVersionListed(JSON.stringify("0.0.1"), "0.0.1")).toBe(true);
    expect(() => registryVersionListed(JSON.stringify([42]), "0.0.1")).toThrow(
      "registry versions response must contain only strings",
    );
  });

  test("release helper exposes only explicit recovery, bootstrap, and watch commands", () => {
    const sha = "a".repeat(40);
    expect(parseReleaseCommand([
      "recover",
      sha,
      "--source-branch",
      "develop",
      "--publish",
    ])).toEqual({
      kind: "recovery",
      expectedSha: sha,
      sourceBranch: "develop",
      dryRun: false,
    });
    expect(parseReleaseCommand([
      "recover",
      sha,
      "--source-branch",
      "main",
    ])).toEqual({
      kind: "recovery",
      expectedSha: sha,
      sourceBranch: "main",
      dryRun: true,
    });
    expect(parseReleaseCommand([
      "bootstrap",
      "0.0.1",
      "--expected-sha",
      sha,
      "--publish",
    ])).toEqual({
      kind: "bootstrap",
      version: "0.0.1",
      expectedSha: sha,
    });
    expect(parseReleaseCommand(["watch"])).toEqual({ kind: "watch" });
    expect(() => parseReleaseCommand(["prepare", "1.2.3"])).toThrow("Usage:");
    expect(() => parseReleaseCommand([
      "recover",
      sha.toUpperCase(),
      "--source-branch",
      "develop",
    ])).toThrow("lowercase");
    expect(() => parseReleaseCommand([
      "recover",
      sha,
      "--source-branch",
      "feature",
    ])).toThrow("develop or main");
  });

  test("release helper binds only the exact correlated workflow_dispatch run on main", () => {
    const dispatchedAt = Date.parse("2026-08-21T12:00:00.500Z");
    const run = (
      databaseId: number,
      displayTitle: string,
      createdAt: string,
      event = "workflow_dispatch",
      headBranch = "main",
    ): WorkflowRun => ({
      databaseId,
      displayTitle,
      createdAt,
      event,
      headBranch,
      status: "queued",
      url: `https://example.test/runs/${databaseId}`,
    });
    const expectedTitle = "Release [0f5527d4-0406-4fb1-9bf7-8c56b2319f4c]";

    expect(selectDispatchedWorkflowRun([
      run(20, "Release [other-id]", "2026-08-21T12:00:05Z"),
      run(12, expectedTitle, "2026-08-21T12:00:01Z"),
      run(21, expectedTitle, "2026-08-21T12:00:03Z", "push"),
      run(22, expectedTitle, "2026-08-21T12:00:04Z", "workflow_dispatch", "develop"),
      run(23, expectedTitle, "2026-08-21T11:59:59Z"),
    ], expectedTitle, dispatchedAt)).toMatchObject({ databaseId: 12 });

    expect(selectDispatchedWorkflowRun([
      run(20, "Release [other-id]", "2026-08-21T12:00:05Z"),
      run(21, expectedTitle, "2026-08-21T12:00:03Z", "push"),
    ], expectedTitle, dispatchedAt)).toBeNull();
  });

  test("release helper dispatches only explicit recovery or one-time bootstrap inputs", async () => {
    const source = await read("scripts/release.ts");
    const packageJson = JSON.parse(await read("package.json")) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.release).toBe("bun scripts/release.ts");
    expect(packageJson.scripts?.["release:prepare"]).toBeUndefined();
    expect(packageJson.scripts?.["release:watch"]).toBe("bun scripts/release.ts watch");
    expect(source).not.toContain("git add");
    expect(source).not.toContain("git commit");
    expect(source).not.toContain("git push");
    expect(source).not.toContain("waitForReleaseGates");
    expect(source).not.toContain("assertOriginMainMatches");

    expect(source).toContain("gh workflow run publish-prepared-release.yml");
    expect(source).toContain("-f expected-sha=${command.expectedSha}");
    expect(source).toContain("-f source-branch=${command.sourceBranch}");
    expect(source).toContain("-f dry-run=${String(command.dryRun)}");
    expect(source).toContain("gh workflow run release.yml");
    expect(source).toContain("-f source-branch=main");
    expect(source).toContain("-f tag=latest");
    expect(source).toContain("-f bootstrap=true");
    expect(source).toContain("-f recovery=false");
    expect(source).toContain("randomUUID()");
    expect(source).toContain("-f dispatch-id=${dispatchId}");
    expect(source).toContain("waitForDispatchedWorkflowRun");
    expect(source).toContain("run.displayTitle === displayTitle");
    expect(source).toContain('run.event === "workflow_dispatch"');
    expect(source).toContain('run.headBranch === "main"');
    expect(source).toContain("RELEASE_RUN_WAIT_TIMEOUT_MS");
    expect(source).toContain("await watchRun(releaseRun.databaseId)");
    expect(source).not.toContain("snapshotWorkflowRuns");
    expect(source).not.toContain("Bun.sleep(4000)");
    expect(source).not.toContain("--limit 1 --json");
  });


  test("release workflow confines npm to the final trusted-publish lane", async () => {
    const workflow = await read(".github/workflows/release.yml");
    expect(workflow).toContain("bun install");
    expect(workflow).toContain("bun pm view");
    expect(workflow).toContain("bun run prepublishOnly");
    expect(workflow).toContain("bun scripts/dev-package.ts build --skip-gates");
    expect(workflow).not.toContain("bun publish");
    expect(workflow).not.toMatch(/npm publish[^\r\n]*--token/);
    expect(workflow).toContain('npm publish "$TARBALL" --tag "$REGISTRY_DIST_TAG" --access public');
    expect(workflow).not.toContain("npm pack");
    expect(workflow).not.toContain("npm run prepublishOnly");
    expect(workflow).toContain('npm view "$PACKAGE_NAME" dist-tags --json');
    expect(workflow).not.toContain('release_tag="v${{ inputs.');
    expect(workflow).not.toContain('if [ "${{ inputs.');
    expect(workflow).toContain("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683");
    expect(workflow).toContain("oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76");
    expect(workflow).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(workflow).toContain("bun-version: 1.3.14");
    expect(workflow).not.toContain("actions/checkout@v");
    expect(workflow).not.toContain("oven-sh/setup-bun@v");
    expect(workflow).not.toContain("actions/setup-node@v");
    expect(workflow).toContain("npm install -g npm@11.5.1");
    expect(workflow).not.toContain("npm install -g npm@latest");
  });

  test("release policy keeps OIDC normal publication and isolates bootstrap credentials", async () => {
    const workflow = await read(".github/workflows/release.yml");
    const pkg = JSON.parse(await read("package.json")) as { repository?: { url?: string } };

    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "${{ inputs.expected-sha }}"');
    expect(workflow).toContain("latest requires X.Y.Z");
    expect(workflow).toContain("preview requires X.Y.Z-preview.N");
    expect(workflow).toContain("bootstrap is one-time only");
    expect(workflow).toContain("bootstrap must use source-branch main and tag latest");
    expect(workflow).toContain('bun pm view "$pkg_name" versions --json');
    expect(workflow).toContain('versions.every(version => typeof version === "string")');
    expect(workflow).not.toContain('import { registryVersionListed } from "./scripts/release-registry"');
    expect(workflow).toContain("Invalid registry versions response for ${pkg_name}");
    expect(workflow).toContain("Unable to determine whether GitHub Release ${release_tag} exists");
    expect(workflow).toContain("secrets.NPM_BOOTSTRAP_TOKEN");
    expect(workflow).toContain('if [ "$BOOTSTRAP" = "true" ] && [ -z "$NODE_AUTH_TOKEN" ]');
    const buildIndex = workflow.indexOf("bun scripts/dev-package.ts build --skip-gates");
    const secretIndex = workflow.indexOf("NODE_AUTH_TOKEN:");
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ inputs.bootstrap && secrets.NPM_BOOTSTRAP_TOKEN || '' }}");
    expect(workflow.split("NODE_AUTH_TOKEN:").length - 1).toBe(1);
    expect(buildIndex).toBeGreaterThan(-1);
    expect(secretIndex).toBeGreaterThan(buildIndex);
    expect(workflow).toContain("The bootstrap credential exists only in this no-source mutation step");
    expect(workflow.split("PACKAGE_NAME: frogprogsy")).toHaveLength(3);
    expect(workflow).not.toContain("needs.inspect.outputs.package_name");
    expect(workflow).not.toContain('Bun.file("package.json")');
    expect(pkg.repository?.url).toBe("git+https://github.com/zhsks311/Frogprogsy.git");
    expect(workflow).toContain("release_flags=(--prerelease=false --latest)");
    expect(workflow).toContain("release_flags=(--prerelease --latest=false)");
    expect(workflow).not.toContain("gh release edit");
    expect(workflow).toContain('gh release create "$release_tag" --target "$EXPECTED_SHA"');
  });

  test("package lifecycle workflow builds the shared tarball once and installs it across three OSes", async () => {
    const lifecycle = await read(".github/workflows/package-lifecycle.yml");
    const count = (needle: string) => lifecycle.split(needle).length - 1;

    // A package.json-only main push must still trigger the workflow (release gate
    // needs a green run for the exact version-bump commit).
    expect(lifecycle).toContain("push:");
    expect(lifecycle).toContain("branches: [main, develop]");
    expect(lifecycle).toContain('- "package.json"');
    expect(lifecycle).toContain('- ".github/workflows/package-lifecycle.yml"');

    // Least privilege + safe concurrency.
    expect(lifecycle).toContain("contents: read");
    expect(lifecycle).toContain("concurrency:");
    expect(lifecycle).toContain("group: package-lifecycle-${{ github.event_name == 'push' && github.sha || github.ref }}");
    expect(lifecycle).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");

    // Bun 1.3.14 frozen install -> GUI build -> build once -> resolve path.
    expect(lifecycle).toContain("bun-version: 1.3.14");
    expect(lifecycle).toContain("bun install --frozen-lockfile");
    expect(lifecycle).toContain("bun run build:gui");
    expect(lifecycle).toContain("bun run dev:package path");

    // The tarball is built exactly ONCE (ubuntu build job), then uploaded once.
    expect(count("bun run dev:package build --skip-gates")).toBe(1);
    expect(count("actions/upload-artifact@")).toBe(1);
    expect(count("actions/download-artifact@")).toBe(1);

    // The matrix installs the SAME downloaded artifact on all three platforms and
    // never rebuilds it there.
    expect(lifecycle).toContain("needs: build");
    expect(lifecycle).toContain("- os: ubuntu-latest");
    expect(lifecycle).toContain("- os: windows-latest");
    expect(lifecycle).toContain("- os: macos-latest");
    expect(lifecycle).toContain("name: package-tarball");
    expect(lifecycle).toContain("bun scripts/package-lifecycle-smoke.ts --tarball-dir dist-tarball");

    // Third-party actions are commit-SHA pinned (no floating tags) with timeouts.
    expect(lifecycle).toContain("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683");
    expect(lifecycle).toContain("oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76");
    expect(lifecycle).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(lifecycle).toContain("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
    expect(lifecycle).not.toContain("actions/checkout@v");
    expect(lifecycle).not.toContain("oven-sh/setup-bun@v");
    expect(lifecycle).not.toContain("actions/upload-artifact@v");
    expect(lifecycle).not.toContain("actions/download-artifact@v");
    expect(lifecycle).toContain("timeout-minutes:");
  });

  test("release rechecks newest exact-SHA gates with channel-specific Pages policy", async () => {
    const workflow = await read(".github/workflows/release.yml");

    expect(workflow).toContain("latest_run() {");
    expect(workflow).toContain("require_latest_success ci.yml");
    expect(workflow).toContain("require_latest_success package-lifecycle.yml");
    expect(workflow).toContain("wait_for_latest_success deploy-docs.yml");
    expect(workflow).toContain('if [ "$REGISTRY_DIST_TAG" = "latest" ]; then');
    expect(workflow).toContain("head_sha=${EXPECTED_SHA}");
    expect(workflow).toContain('.event == "push"');
    expect(workflow).toContain(".head_branch == $branch");
    expect(workflow).toContain("sort_by(.id, .run_attempt) | last");
    expect(workflow).not.toContain("--status success");
    expect(workflow).toContain('test "$status" = "completed"');
    expect(workflow).toContain('test "$conclusion" = "success"');
    expect(workflow).toContain("Superseded exact-SHA");
  });

  test("runtime update and package removal are Bun-managed", async () => {
    const update = await read("src/update.ts");
    const cli = await read("src/cli.ts");
    expect(update).toContain('spawnSync("bun", ["pm", "view"');
    expect(update).toContain('spawnSync("bun", cmdArgs');
    expect(update).not.toContain('spawnSync("npm"');
    expect(cli).toContain('spawnSync("bun", cmdArgs');
    expect(cli).not.toContain('spawnSync("npm"');
    expect(cli).toContain(".frogprogsy-dev-build.json");
    expect(cli).toContain("installedDevBuildId");
  });

  test("public installation commands use Bun in every locale", async () => {
    const files = [
      "README.md",
      "README.ko.md",
      "README.zh-CN.md",
      "docs-site/content/docs/en/getting-started/installation.md",
      "docs-site/content/docs/ko/getting-started/installation.md",
      "docs-site/content/docs/zh-cn/getting-started/installation.md",
    ];
    for (const file of files) {
      const source = await read(file);
      expect(source).toContain("bun add -g .");
      expect(source).toContain("bun add -g frogprogsy");
      expect(source).not.toContain("npm install -g");
    }
  });

  test("active product and release surfaces contain no retired product name", async () => {
    const files = [
      "package.json",
      "scripts/dev-package.ts",
      "scripts/release.ts",
      "src/update.ts",
      "src/cli.ts",
      "structure/06_docs-and-release.md",
      "README.md",
      "README.ko.md",
      "README.zh-CN.md",
    ];
    const retiredName = ["open", "claudecode"].join("-");
    for (const file of files) {
      expect((await read(file)).toLowerCase()).not.toContain(retiredName);
    }
  });
});
