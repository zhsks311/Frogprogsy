import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

interface Workflow {
  on: {
    pull_request: { branches: string[]; paths?: string[]; types?: string[] };
    push: { branches: string[]; paths?: string[] };
  };
  jobs: Record<string, {
    name?: string;
    if?: string;
    permissions?: Record<string, string>;
    steps?: Array<{
      name?: string;
      env?: Record<string, string>;
      run?: string;
    }>;
  }>;
}

async function read(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

async function readWorkflow(path: string): Promise<Workflow> {
  return Bun.YAML.parse(await read(path)) as Workflow;
}

describe("develop to main branch promotion policy", () => {
  for (const path of [".github/workflows/ci.yml", ".github/workflows/package-lifecycle.yml"]) {
    test(`${path} runs for every main and develop pull request and matching pushes`, async () => {
      const workflow = await readWorkflow(path);

      expect(workflow.on.pull_request.branches).toEqual(["main", "develop"]);
      expect(workflow.on.pull_request.paths).toBeUndefined();
      expect(workflow.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "edited"]);
      expect(workflow.on.push.branches).toEqual(["main", "develop"]);
      expect(workflow.on.pull_request.branches).not.toContain("dev");
      expect(workflow.on.push.branches).not.toContain("dev");
    });
  }

  test("CI accepts only this repository's develop branch for main promotions", async () => {
    const workflow = await readWorkflow(".github/workflows/ci.yml");
    const guard = workflow.jobs["promotion-guard"];

    expect(guard).toBeDefined();
    expect(guard.name).toBe("Develop promotion guard");
    expect(guard.if).toBeUndefined();
    expect(guard.permissions).toEqual({});
    expect(guard.steps).toHaveLength(1);
    expect(guard.steps?.[0]?.env).toEqual({
      EVENT_NAME: "${{ github.event_name }}",
      BASE_REF: "${{ github.base_ref }}",
      HEAD_REF: "${{ github.head_ref }}",
      HEAD_REPO: "${{ github.event.pull_request.head.repo.full_name }}",
      REPOSITORY: "${{ github.repository }}",
    });
    expect(guard.steps?.[0]?.run).toContain('[ "$HEAD_REF" != "develop" ] || [ "$HEAD_REPO" != "$REPOSITORY" ]');
  });

  test("release workflow directs version preparation through develop promotion", async () => {
    const workflow = await read(".github/workflows/release.yml");

    expect(workflow).toContain("bun run release:prepare <version>");
    expect(workflow).toContain("develop -> main");
    expect(workflow).not.toContain("Bump package.json on main");
    expect(workflow).not.toContain("bump package.json on main first");
    expect(workflow).not.toContain("bump+commit+push");
  });
});
