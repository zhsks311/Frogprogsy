import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function read(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("model catalog publication workflows", () => {
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
    expect(pkg.scripts?.["generate:model-catalog:git"]).toContain("git rev-parse HEAD");
    expect(pkg.scripts?.["generate:model-catalog:git"]).toContain("git show -s --format=%cI HEAD");
    expect(pkg.scripts?.prepublishOnly?.indexOf("bun run generate:model-catalog:git")).toBe(0);
  });

  test("release accepts only latest successful gates and matching extracted Pages/package catalogs", async () => {
    const workflow = await read(".github/workflows/release.yml");

    expect(workflow).toContain("require_latest_success() {");
    expect(workflow).toContain("require_latest_success ci.yml");
    expect(workflow).toContain("require_latest_success package-lifecycle.yml");
    expect(workflow).toContain("require_latest_success deploy-docs.yml");
    expect(workflow).toContain('--commit "$GITHUB_SHA"');
    expect(workflow).not.toContain("--status success");
    expect(workflow).toContain("databaseId,conclusion,headSha,status,url,workflowName");
    expect(workflow).toContain('test "$gate_status" = "completed"');
    expect(workflow).toContain('test "$gate_conclusion" = "success"');

    const extractIndex = workflow.indexOf('tar -xzf "$TARBALL"');
    const catalogGateIndex = workflow.indexOf("Verify packaged catalog matches deployed Pages catalog");
    const dryRunIndex = workflow.indexOf('if [ "$DRY_RUN" = "true" ]');
    const publishIndex = workflow.indexOf('npm publish "$TARBALL"');
    expect(extractIndex).toBeGreaterThan(-1);
    expect(catalogGateIndex).toBeGreaterThan(extractIndex);
    expect(catalogGateIndex).toBeLessThan(dryRunIndex);
    expect(catalogGateIndex).toBeLessThan(publishIndex);
    expect(workflow).toContain("package/src/generated/model-catalog-v1.json");
    expect(workflow).toContain("modelCatalogDocumentV1Schema.parse");
    expect(workflow).toContain("catalogDataDigest");
    expect(workflow).toContain("packageCatalog.sourceCommit !== expectedSha");
    expect(workflow).toContain("pagesCatalog.sourceCommit !== expectedSha");
    expect(workflow).toContain("packageCatalog.catalogRevision !== pagesCatalog.catalogRevision");
    expect(workflow).toContain("packageCatalog.catalogDigest !== pagesCatalog.catalogDigest");
    expect(workflow).toContain('catalog_url="${PAGES_CATALOG_URL}?run=${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"');
    expect(workflow).toContain("Cache-Control: no-cache");
    expect(workflow).toContain("Pragma: no-cache");
    expect(workflow).toContain("--retry 3");
  });
});
