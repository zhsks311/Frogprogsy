import { describe, expect, test } from "bun:test";
import { MODEL_CATALOG_REMOTE_URL } from "../src/model-catalog-runtime";

const root = new URL("../", import.meta.url);

async function read(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("model catalog publication workflows", () => {
  test("runtime and publication use the repository's actual Pages base path", async () => {
    const pkg = JSON.parse(await read("package.json")) as {
      repository: { url: string };
      homepage: string;
    };
    const repository = new URL(pkg.repository.url.replace(/^git\+/, ""));
    const [owner, repositoryNameWithSuffix] = repository.pathname.slice(1).split("/");
    const repositoryName = repositoryNameWithSuffix!.replace(/\.git$/, "");
    const pagesBaseUrl = `https://${owner}.github.io/${repositoryName}`;
    const catalogUrl = `${pagesBaseUrl}/catalog/v1/model-catalog.json`;
    const docsConfig = await read("docs-site/next.config.mjs");
    const deployWorkflow = await read(".github/workflows/deploy-docs.yml");
    const releaseWorkflow = await read(".github/workflows/release.yml");

    expect(pkg.homepage).toBe(`${pagesBaseUrl}/`);
    expect(MODEL_CATALOG_REMOTE_URL).toBe(catalogUrl);
    expect(docsConfig).toContain(`basePath: "/${repositoryName}"`);
    expect(docsConfig).toContain(`assetPrefix: "/${repositoryName}"`);
    expect(deployWorkflow).toContain(`PAGES_CATALOG_URL: ${catalogUrl}`);
    expect(releaseWorkflow).toContain(`PAGES_CATALOG_URL: ${catalogUrl}`);
  });

  test("every main commit publishes an exact-SHA catalog to the Pages artifact", async () => {
    const workflow = await read(".github/workflows/deploy-docs.yml");
    const pushTrigger = workflow.slice(workflow.indexOf("  push:"), workflow.indexOf("  workflow_dispatch:"));

    expect(pushTrigger).toContain("branches: [main]");
    expect(pushTrigger).not.toContain("paths:");
    expect(workflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(workflow).toContain("git fetch --no-tags origin main");
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"');
    expect(workflow).toContain('SOURCE_COMMIT="$GITHUB_SHA"');
    expect(workflow).toContain('GENERATED_AT="$(git show -s --format=%cI "$GITHUB_SHA")"');
    expect(workflow).toContain("bun run generate:model-catalog --");
    expect(workflow).toContain("modelCatalogDocumentV1Schema.parse");
    expect(workflow).toContain("catalogDataDigest");
    expect(workflow).toContain("existing.catalogDigest !== candidate.catalogDigest");
    expect(workflow).toContain("candidate.catalogRevision <= existing.catalogRevision");
    expect(workflow).toContain("docs-site/out/catalog/v1/model-catalog.json");
    expect(workflow).toContain("cp src/generated/model-catalog-v1.json docs-site/out/catalog/v1/model-catalog.json");
    expect(workflow).toContain('catalog_url="${PAGES_CATALOG_URL}?run=${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"');
    expect(workflow).toContain("Cache-Control: no-cache");
    expect(workflow).toContain("Pragma: no-cache");
    expect(workflow).toContain("--retry 3");
  });

  test("package lifecycle generates the catalog before GUI build and exact tarball packing", async () => {
    const workflow = await read(".github/workflows/package-lifecycle.yml");
    const pkg = JSON.parse(await read("package.json")) as { scripts?: Record<string, string> };
    const generatorIndex = workflow.indexOf("bun run generate:model-catalog --");
    const guiIndex = workflow.indexOf("bun run build:gui");
    const packageIndex = workflow.indexOf("bun run dev:package build --skip-gates");

    expect(generatorIndex).toBeGreaterThan(-1);
    expect(guiIndex).toBeGreaterThan(generatorIndex);
    expect(packageIndex).toBeGreaterThan(guiIndex);
    expect(workflow).toContain('SOURCE_COMMIT="$(git rev-parse HEAD)"');
    expect(workflow).toContain('GENERATED_AT="$(git show -s --format=%cI "$SOURCE_COMMIT")"');
    expect(pkg.scripts?.["generate:model-catalog:git"]).toBe("bun run generate:model-catalog -- --git-derived");
    expect(pkg.scripts?.prepublishOnly?.indexOf("bun run generate:model-catalog:git")).toBe(0);
  });

  test("release accepts only exact successful gates and matching inspected Pages/package catalogs", async () => {
    const workflow = await read(".github/workflows/release.yml");

    expect(workflow).toContain("require_latest_success() {");
    expect(workflow).toContain("require_latest_success ci.yml");
    expect(workflow).toContain("require_latest_success package-lifecycle.yml");
    expect(workflow).toContain("wait_for_latest_success deploy-docs.yml");
    expect(workflow).toContain("head_sha=${EXPECTED_SHA}");
    expect(workflow).toContain('.event == "push"');
    expect(workflow).toContain(".head_branch == $branch");
    expect(workflow).toContain("sort_by(.id, .run_attempt) | last");
    expect(workflow).not.toContain("--status success");

    const inspectIndex = workflow.indexOf("Inspect exact artifact bytes and package identity");
    const catalogGateIndex = workflow.indexOf("packageCatalog.catalogRevision !== pagesCatalog.catalogRevision");
    const mutationIndex = workflow.indexOf("if: ${{ inputs.dry-run != true }}");
    const publishIndex = workflow.indexOf('npm publish "$TARBALL"');
    expect(inspectIndex).toBeGreaterThan(-1);
    expect(catalogGateIndex).toBeGreaterThan(inspectIndex);
    expect(catalogGateIndex).toBeLessThan(mutationIndex);
    expect(catalogGateIndex).toBeLessThan(publishIndex);
    expect(workflow).toContain("package/src/generated/model-catalog-v1.json");
    expect(workflow).toContain("catalog.sourceCommit !== process.env.EXPECTED_SHA");
    expect(workflow).toContain("pagesCatalog.sourceCommit !== process.env.EXPECTED_SHA");
    expect(workflow).toContain("packageCatalog.catalogRevision !== pagesCatalog.catalogRevision");
    expect(workflow).toContain("packageCatalog.catalogDigest !== pagesCatalog.catalogDigest");
    expect(workflow).toContain("Cache-Control: no-cache");
    expect(workflow).toContain("Pragma: no-cache");
    expect(workflow).toContain("--retry 3");
  });
});
