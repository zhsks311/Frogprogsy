import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const root = new URL("../", import.meta.url);

interface Workflow {
  on: {
    pull_request?: { branches: string[]; paths?: string[]; types?: string[] };
    pull_request_target?: { branches: string[]; types: string[] };
    push?: { branches: string[]; paths?: string[] };
    workflow_dispatch?: {
      inputs?: Record<string, {
        description?: string;
        required?: boolean;
        type?: string;
        default?: string | boolean;
        options?: string[];
      }>;
    };
  };
  "run-name"?: string;
  permissions?: Record<string, string>;
  concurrency?: {
    group: string;
    cancel_in_progress?: boolean;
    "cancel-in-progress"?: boolean;
  };
  jobs: Record<string, {
    name?: string;
    if?: string;
    needs?: string | string[];
    permissions?: Record<string, string>;
    outputs?: Record<string, string>;
    steps?: Array<{
      name?: string;
      id?: string;
      uses?: string;
      with?: Record<string, unknown>;
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

async function readDispatchBindingScript(): Promise<string> {
  const workflow = await readWorkflow(".github/workflows/prepare-release.yml");
  const script = workflow.jobs.mutate.steps?.find(
    step => step.name === "Dispatch and bind exact-ref workflow run ids",
  )?.run;
  if (!script) {
    throw new Error("release dispatch-and-bind step is missing");
  }
  return script;
}

interface FakeWorkflowState {
  runs?: Array<Record<string, unknown>>;
  dispatchId: number;
  visibilityDelay?: number;
  failureMode?: "api" | "json" | "empty" | "whitespace" | "multiple";
  postDispatchFailureMode?: "api" | "json" | "empty" | "whitespace" | "multiple";
  postDispatchFailureInjected?: boolean;
  dispatched?: boolean;
  searches?: number;
  searchesAtDispatch?: number;
}

interface FakeGhState {
  workflows: Record<string, FakeWorkflowState>;
  dispatches: string[];
  statusWrites: number;
}

interface DispatchHarnessResult {
  status: number | null;
  stderr: string;
  state: FakeGhState;
  ciBinding: string | null;
  packageBinding: string | null;
}

const exactRunSha = "a".repeat(40);
const exactRunBranch = "develop";

function exactRun(
  id: unknown,
  createdAt: string,
  conclusion = "success",
): Record<string, unknown> {
  return {
    id,
    event: "workflow_dispatch",
    head_sha: exactRunSha,
    head_branch: exactRunBranch,
    created_at: createdAt,
    status: "completed",
    conclusion,
  };
}

function runDispatchBindingStep(
  script: string,
  workflows: Record<string, FakeWorkflowState>,
  plan: { effectiveSelection: string; pushRequired: boolean } = {
    effectiveSelection: "release:patch",
    pushRequired: false,
  },
  options: { snapshotDriftAt?: number } = {},
): DispatchHarnessResult {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "frog-release-dispatch-"));
  const binDir = join(fixtureRoot, "bin");
  const releasePlanDir = join(fixtureRoot, "release-plan");
  const statePath = join(fixtureRoot, "fake-gh-state.json");
  const fakeGhPath = join(binDir, "gh");
  const fakeGhScriptPath = join(fixtureRoot, "fake-gh.js");
  const fakeSleepPath = join(binDir, "sleep");
  mkdirSync(binDir);
  mkdirSync(releasePlanDir);

  const initialState: FakeGhState = {
    workflows,
    dispatches: [],
    statusWrites: 0,
  };
  writeFileSync(statePath, `${JSON.stringify(initialState)}\n`);
  writeFileSync(join(releasePlanDir, "plan.json"), `${JSON.stringify(plan)}\n`);
  writeFileSync(join(releasePlanDir, "post-snapshot.json"), "{}\n");
  writeFileSync(
    join(releasePlanDir, "collect-live.sh"),
    [
      "#!/bin/sh",
      'count_file="release-plan/collect-count"',
      "count=0",
      '[ ! -f "$count_file" ] || count="$(cat "$count_file")"',
      "count=$((count + 1))",
      'printf "%s\\n" "$count" > "$count_file"',
      'if [ -n "${SNAPSHOT_DRIFT_AT:-}" ] && [ "$count" -ge "$SNAPSHOT_DRIFT_AT" ]; then',
      '  printf \'{"drift":true}\\n\' > "$1"',
      "else",
      '  cp release-plan/post-snapshot.json "$1"',
      "fi",
      "",
    ].join("\n"),
  );
  writeFileSync(
    fakeGhPath,
    "#!/bin/sh\nexec \"$FAKE_BUN\" \"$FAKE_GH_SCRIPT\" \"$@\"\n",
  );
  writeFileSync(fakeSleepPath, "#!/bin/sh\nexit 0\n");
  for (const executable of [fakeGhPath, fakeSleepPath]) {
    chmodSync(executable, 0o755);
  }
  writeFileSync(
    fakeGhScriptPath,
    String.raw`
const statePath = process.env.FAKE_GH_STATE;
const state = await Bun.file(statePath).json();
const args = process.argv.slice(2);
const save = async () => {
  await Bun.write(statePath, JSON.stringify(state) + "\n");
};
const runsPath = args.find(arg => /\/actions\/workflows\/[^/]+\/runs$/.test(arg));
if (args[0] === "api" && runsPath) {
  const match = runsPath.match(/\/actions\/workflows\/([^/]+)\/runs$/);
  const workflow = match && match[1];
  const workflowState = state.workflows[workflow];
  if (!workflowState) throw new Error("unexpected workflow lookup: " + workflow);
  workflowState.searches = (workflowState.searches || 0) + 1;
  const postDispatchFailure = workflowState.dispatched
    && !workflowState.postDispatchFailureInjected
    ? workflowState.postDispatchFailureMode
    : undefined;
  if (postDispatchFailure) {
    workflowState.postDispatchFailureInjected = true;
  }
  const failureMode = postDispatchFailure || workflowState.failureMode;
  if (failureMode === "api") {
    await save();
    console.error("simulated gh api failure");
    process.exit(1);
  }
  if (failureMode === "json") {
    await save();
    process.stdout.write("{");
    process.exit(0);
  }
  if (failureMode === "empty") {
    await save();
    process.exit(0);
  }
  if (failureMode === "whitespace") {
    await save();
    process.stdout.write(" \n");
    process.exit(0);
  }
  if (failureMode === "multiple") {
    await save();
    process.stdout.write('{"workflow_runs":[]}\n{"workflow_runs":[]}\n');
    process.exit(0);
  }
  const runs = [...(workflowState.runs || [])];
  const visibleAfter = (workflowState.searchesAtDispatch || 0)
    + (workflowState.visibilityDelay || 0);
  if (workflowState.dispatched && workflowState.searches > visibleAfter) {
    runs.push({
      id: workflowState.dispatchId,
      event: "workflow_dispatch",
      head_sha: process.env.RESULT_SHA,
      head_branch: process.env.RESULT_BRANCH,
      created_at: "9999-12-31T23:59:59Z",
      status: "queued",
      conclusion: null,
    });
  }
  await save();
  process.stdout.write(JSON.stringify({ workflow_runs: runs }) + "\n");
  process.exit(0);
}
if (args[0] === "workflow" && args[1] === "run") {
  const workflow = args[2];
  const workflowState = state.workflows[workflow];
  if (!workflowState) throw new Error("unexpected workflow dispatch: " + workflow);
  state.dispatches.push(workflow);
  workflowState.dispatched = true;
  workflowState.searchesAtDispatch = workflowState.searches || 0;
  await save();
  process.exit(0);
}
if (args[0] === "api" && args.some(arg => /\/statuses\//.test(arg))) {
  state.statusWrites += 1;
  await save();
  process.stdout.write("{}\n");
  process.exit(0);
}
throw new Error("unexpected gh invocation: " + args.join(" "));
`,
  );

  try {
    const result = spawnSync("bash", ["-c", script], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        FAKE_BUN: process.execPath,
        FAKE_GH_SCRIPT: fakeGhScriptPath,
        FAKE_GH_STATE: statePath,
        REPOSITORY: "zhsks311/Frogprogsy",
        RESULT_SHA: exactRunSha,
        RESULT_BRANCH: exactRunBranch,
        SNAPSHOT_DRIFT_AT: options.snapshotDriftAt?.toString() ?? "",
      },
      encoding: "utf8",
    });
    const binding = (name: string): string | null => {
      const path = join(releasePlanDir, name);
      return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
    };
    return {
      status: result.status,
      stderr: result.stderr,
      state: JSON.parse(readFileSync(statePath, "utf8")) as FakeGhState,
      ciBinding: binding("ci.run-id"),
      packageBinding: binding("package.run-id"),
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe("develop to main branch promotion policy", () => {
  for (const path of [".github/workflows/ci.yml", ".github/workflows/package-lifecycle.yml"]) {
    test(`${path} runs for every main and develop pull request and matching pushes`, async () => {
      const workflow = await readWorkflow(path);

      expect(workflow.on.pull_request?.branches).toEqual(["main", "develop"]);
      expect(workflow.on.pull_request?.paths).toBeUndefined();
      expect(workflow.on.pull_request?.types).toEqual(["opened", "synchronize", "reopened", "edited"]);
      expect(workflow.on.push?.branches).toEqual(["main", "develop"]);
      expect(workflow.on.pull_request?.branches).not.toContain("dev");
      expect(workflow.on.push?.branches).not.toContain("dev");
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

  test("release workflow accepts only recorded exact-SHA preparation inputs", async () => {
    const workflow = await readWorkflow(".github/workflows/release.yml");
    const packageJson = JSON.parse(await read("package.json")) as {
      scripts?: Record<string, string>;
    };
    const inputs = workflow.on.workflow_dispatch?.inputs;
    const preflightSteps = workflow.jobs.preflight.steps ?? [];
    const buildSteps = workflow.jobs.build.steps ?? [];
    const checkout = buildSteps.find(step => step.name === "Checkout exact prepared SHA");
    const evidence = preflightSteps.find(step => step.name === "Reclassify immutable preparation evidence");

    expect(packageJson.scripts?.["release:prepare"]).toBeUndefined();
    expect(inputs?.["expected-sha"]).toMatchObject({ required: true, type: "string" });
    expect(inputs?.["source-branch"]).toMatchObject({
      required: true,
      type: "choice",
      options: ["develop", "main"],
    });
    expect(inputs?.recovery).toMatchObject({ required: true, type: "boolean", default: false });
    expect(checkout?.with?.ref).toBe("${{ inputs.expected-sha }}");
    expect(evidence?.run).toContain("classifyMergedRelease");
    expect(evidence?.run).toContain("parseReleaseRecord");
  });
});

describe("trusted release preparation workflow", () => {
  test("reconciles every pull request state change and supports PR-number recovery", async () => {
    const workflow = await readWorkflow(".github/workflows/prepare-release.yml");

    expect(workflow.on.pull_request_target).toEqual({
      branches: ["main", "develop"],
      types: ["opened", "reopened", "synchronize", "edited", "labeled", "unlabeled"],
    });
    expect(workflow.on.workflow_dispatch?.inputs?.pull_request_number).toEqual({
      description: "Open pull request number to reconcile",
      required: true,
      type: "string",
    });
    expect(workflow.concurrency).toEqual({
      group: "release-preparation-${{ github.repository }}",
      "cancel-in-progress": false,
    });
  });

  test.skipIf(process.platform === "win32")(
    "reuses each newest exact-ref run and dispatches only missing workflows after a no-push interruption",
    async () => {
      const script = await readDispatchBindingScript();
      const scenarios: Array<{
        name: string;
        workflows: Record<string, FakeWorkflowState>;
        dispatches: string[];
        ciBinding: string;
        packageBinding: string;
      }> = [
        {
          name: "neither exists",
          workflows: {
            "ci.yml": { dispatchId: 101, visibilityDelay: 2 },
            "package-lifecycle.yml": { dispatchId: 201, visibilityDelay: 2 },
          },
          dispatches: ["ci.yml", "package-lifecycle.yml"],
          ciBinding: "101",
          packageBinding: "201",
        },
        {
          name: "only CI exists",
          workflows: {
            "ci.yml": {
              runs: [exactRun(102, "2026-01-01T00:00:00Z")],
              dispatchId: 999,
            },
            "package-lifecycle.yml": { dispatchId: 202, visibilityDelay: 1 },
          },
          dispatches: ["package-lifecycle.yml"],
          ciBinding: "102",
          packageBinding: "202",
        },
        {
          name: "only Package lifecycle exists",
          workflows: {
            "ci.yml": { dispatchId: 103, visibilityDelay: 1 },
            "package-lifecycle.yml": {
              runs: [exactRun(203, "2026-01-01T00:00:00Z")],
              dispatchId: 999,
            },
          },
          dispatches: ["ci.yml"],
          ciBinding: "103",
          packageBinding: "203",
        },
        {
          name: "both exist and newest CI failed",
          workflows: {
            "ci.yml": {
              runs: [
                exactRun(104, "2026-01-01T00:00:00Z"),
                exactRun(105, "2026-01-02T00:00:00Z", "failure"),
              ],
              dispatchId: 999,
            },
            "package-lifecycle.yml": {
              runs: [exactRun(204, "2026-01-01T00:00:00Z")],
              dispatchId: 999,
            },
          },
          dispatches: [],
          ciBinding: "105",
          packageBinding: "204",
        },
      ];

      for (const scenario of scenarios) {
        const result = runDispatchBindingStep(script, scenario.workflows);
        expect(result.status, scenario.name).toBe(0);
        expect(result.state.dispatches, scenario.name).toEqual(scenario.dispatches);
        expect(result.ciBinding, scenario.name).toBe(scenario.ciBinding);
        expect(result.packageBinding, scenario.name).toBe(scenario.packageBinding);
      }
    },
    15_000,
  );

  test.skipIf(process.platform === "win32")(
    "rejects malformed matching run ids before creating a binding or dispatching",
    async () => {
      const script = await readDispatchBindingScript();
      for (const invalidId of ["", "\n", 0, -1, 1.5, null]) {
        const result = runDispatchBindingStep(script, {
          "ci.yml": {
            runs: [exactRun(invalidId, "2026-01-01T00:00:00Z")],
            dispatchId: 301,
          },
          "package-lifecycle.yml": { dispatchId: 302 },
        });
        expect(result.status, `invalid id ${JSON.stringify(invalidId)}`).not.toBe(0);
        expect(result.state.dispatches, `invalid id ${JSON.stringify(invalidId)}`).toEqual([]);
        expect(result.ciBinding, `invalid id ${JSON.stringify(invalidId)}`).toBeNull();
      }
    },
    15_000,
  );

  test.skipIf(process.platform === "win32")(
    "fails closed on workflow-run API and malformed response errors instead of dispatching",
    async () => {
      const script = await readDispatchBindingScript();
      for (const failureMode of ["api", "json", "empty", "whitespace", "multiple"] as const) {
        const result = runDispatchBindingStep(script, {
          "ci.yml": { dispatchId: 401, failureMode },
          "package-lifecycle.yml": { dispatchId: 402 },
        });
        expect(result.status, failureMode).not.toBe(0);
        expect(result.state.dispatches, failureMode).toEqual([]);
        expect(result.ciBinding, failureMode).toBeNull();
      }
    },
    15_000,
  );

  test.skipIf(process.platform === "win32")(
    "fails immediately when the first post-dispatch visibility response is invalid",
    async () => {
      const script = await readDispatchBindingScript();
      for (const postDispatchFailureMode of ["api", "json", "empty", "whitespace"] as const) {
        const result = runDispatchBindingStep(script, {
          "ci.yml": {
            dispatchId: 451,
            postDispatchFailureMode,
          },
          "package-lifecycle.yml": { dispatchId: 452 },
        });
        expect(result.status, postDispatchFailureMode).not.toBe(0);
        expect(result.state.dispatches, postDispatchFailureMode).toEqual(["ci.yml"]);
        expect(result.ciBinding, postDispatchFailureMode).toBeNull();
        expect(result.packageBinding, postDispatchFailureMode).toBeNull();
        expect(result.state.statusWrites, postDispatchFailureMode).toBe(0);
      }
    },
    15_000,
  );

  test.skipIf(process.platform === "win32")(
    "stops after a dispatched run when the sealed snapshot drifts",
    async () => {
      const script = await readDispatchBindingScript();
      const result = runDispatchBindingStep(
        script,
        {
          "ci.yml": { dispatchId: 461 },
          "package-lifecycle.yml": { dispatchId: 462 },
        },
        { effectiveSelection: "release:patch", pushRequired: false },
        { snapshotDriftAt: 3 },
      );
      expect(result.status).not.toBe(0);
      expect(result.state.dispatches).toEqual(["ci.yml"]);
      expect(result.ciBinding).toBe("461");
      expect(result.packageBinding).toBeNull();
      expect(result.state.statusWrites).toBe(0);
    },
    15_000,
  );

  test.skipIf(process.platform === "win32")(
    "keeps release:none no-push checks skipped while cancellation pushes reconcile both checks",
    async () => {
      const script = await readDispatchBindingScript();
      const noPush = runDispatchBindingStep(
        script,
        {
          "ci.yml": { dispatchId: 501 },
          "package-lifecycle.yml": { dispatchId: 502 },
        },
        { effectiveSelection: "release:none", pushRequired: false },
      );
      expect(noPush.status).toBe(0);
      expect(noPush.state.dispatches).toEqual([]);
      expect(noPush.ciBinding).toBeNull();
      expect(noPush.packageBinding).toBeNull();

      const cancellationPush = runDispatchBindingStep(
        script,
        {
          "ci.yml": { dispatchId: 503 },
          "package-lifecycle.yml": { dispatchId: 504 },
        },
        { effectiveSelection: "release:none", pushRequired: true },
      );
      expect(cancellationPush.status).toBe(0);
      expect(cancellationPush.state.dispatches).toEqual([
        "ci.yml",
        "package-lifecycle.yml",
      ]);
      expect(cancellationPush.ciBinding).toBe("503");
      expect(cancellationPush.packageBinding).toBe("504");
    },
    15_000,
  );

  test("requires one explicit selection label instead of treating no label as release:none", async () => {
    const workflow = await readWorkflow(".github/workflows/prepare-release.yml");
    const snapshotText = workflow.jobs.snapshot.steps
      ?.map(step => step.run ?? "")
      .join("\n") ?? "";

    expect(snapshotText).toContain("requireSingleReleaseSelection(snapshot.labels)");
    expect(snapshotText).toContain("const effectiveSelection = selectedLabel");
    expect(snapshotText).not.toContain('selectedLabel ?? "release:none"');
    expect(snapshotText).not.toContain("selectionLabels.length === 0");
  });

  test("proves exact registry tarball and signed promotion provenance without gitHead", async () => {
    const workflow = await readWorkflow(".github/workflows/prepare-release.yml");
    const snapshotText = workflow.jobs.snapshot.steps
      ?.map(step => step.run ?? "")
      .join("\n") ?? "";

    expect(snapshotText).not.toContain("gitHead");
    for (const requiredProof of [
      'npm view "${PACKAGE_NAME}@${version}" --json',
      "metadata.dist?.integrity !== integrity",
      "metadata.dist?.shasum !== sha1",
      "tar -xOf \"$tarball_file\" package/package.json",
      "package/src/generated/model-catalog-v1.json",
      "catalog.sourceCommit !== requiredSourceSha",
      "catalog.catalogDigest !== catalogDigest",
      'test -s "$bundle_file"',
      "gh attestation verify",
      "--digest-alg sha512",
      "--signer-workflow zhsks311/Frogprogsy/.github/workflows/release.yml",
      "certificate?.githubWorkflowRepository === expectedWorkflowRepository",
      "certificate.githubWorkflowRef === expectedWorkflowRef",
      "certificate.buildSignerURI === expectedBuildSignerUri",
      "certificate?.githubWorkflowSHA",
      "/^[0-9a-f]{40}$/.test(workflowSha)",
      "uniqueWorkflowShas.length === 0",
      'merge-base --is-ancestor "$workflow_sha" "$main_sha"',
      'collect_registry_proof "$npm_latest" ""',
      'merge-base --is-ancestor "$npm_latest_source_sha" "$main_sha"',
      "const stableSourceSha = snapshot.npmLatestProof?.sourceSha",
      "stableTag.sha !== stableSourceSha",
      "stableRelease.sourceSha.toLowerCase() !== stableSourceSha",
      "snapshot.npmPreviewProof?.sourceSha !== promotionSourceSha",
      "previewRelease.draft",
      "!previewRelease.prerelease",
      "stableRelease.draft",
      "stableRelease.prerelease",
    ]) {
      expect(snapshotText).toContain(requiredProof);
    }
    expect(snapshotText).not.toContain("bun install");
    expect(snapshotText).not.toContain("bun run");
    expect(snapshotText).not.toContain("resolvedDependencies");
    expect(snapshotText).not.toContain("externalParameters");
    expect(snapshotText).not.toContain('collect_registry_proof "$npm_latest" "$main_sha"');
    expect(snapshotText).not.toContain("snapshot.npmLatestProof?.sourceSha !== snapshot.mainSha");
  });

  test("reuses the verified promotion source when reconciling its prepared head", async () => {
    const workflow = await readWorkflow(".github/workflows/prepare-release.yml");
    const snapshotText = workflow.jobs.snapshot.steps
      ?.map(step => step.run ?? "")
      .join("\n") ?? "";

    expect(snapshotText).toContain(
      'const promotionSourceSha = pending?.selection === "release:promote"',
    );
    expect(snapshotText).toContain("pending.commitSha === snapshot.headSha");
    expect(snapshotText).toContain("? pending.sourceSha");
    expect(snapshotText).toContain(": snapshot.headSha");
    expect(snapshotText).toContain(
      "snapshot.npmPreviewProof?.sourceSha !== promotionSourceSha",
    );
    expect(snapshotText).toContain("developSha: promotionSourceSha");
  });

  test("keeps snapshot and mutation permissions separate and refuses fork writes", async () => {
    const workflow = await readWorkflow(".github/workflows/prepare-release.yml");
    const snapshot = workflow.jobs.snapshot;
    const mutate = workflow.jobs.mutate;
    const pushStep = mutate.steps?.find(
      step => step.name === "Create verified bot commits and update one ref fast-forward",
    );

    expect(workflow.permissions).toEqual({});
    expect(snapshot.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    });
    expect(mutate.permissions).toEqual({
      actions: "write",
      contents: "write",
      "pull-requests": "write",
      statuses: "write",
    });
    expect(pushStep?.env).toEqual({
      RELEASE_PUSH_DEPLOY_KEY: "${{ secrets.RELEASE_PUSH_DEPLOY_KEY }}",
    });
    expect(workflow.jobs["failure-state"].permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
      statuses: "write",
    });
    expect(workflow.jobs["failure-state"].if).toContain("always()");
    expect(workflow.jobs["failure-state"].if).toContain("needs.snapshot.result == 'failure'");
    expect(workflow.jobs["failure-state"].if).toContain("needs.mutate.result == 'failure'");
    expect(mutate.if).toContain("needs.snapshot.outputs.same_repository == 'true'");

    const snapshotScript = snapshot.steps?.map(step => step.run ?? "").join("\n") ?? "";
    const mutationScript = mutate.steps?.map(step => step.run ?? "").join("\n") ?? "";
    const failureScript = workflow.jobs["failure-state"].steps
      ?.map(step => step.run ?? "")
      .join("\n") ?? "";
    expect(failureScript).toContain('head_repository');
    expect(failureScript).toContain('${head_repository,,}" != "${REPOSITORY,,}');
    expect(failureScript).toContain("--remove-label release:ready");
    expect(failureScript).toContain('statuses/${head_sha}');
    expect(failureScript.indexOf('head_repository'))
      .toBeLessThan(failureScript.indexOf("--remove-label release:ready"));
    expect(snapshotScript).toContain("headRepository === repository");
    expect(snapshotScript).toContain('state !== "OPEN"');
    expect(mutationScript).not.toContain("bun install");
    expect(mutationScript).not.toContain("bun run");
    expect(mutationScript).not.toContain("actions/checkout");
    expect(mutate.steps?.some(step => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(snapshot.steps?.find(step => step.uses?.startsWith("actions/checkout@"))?.with?.ref)
      .toBe("${{ github.event.repository.default_branch }}");
  });

  test("creates GitHub-signed package-only commits on an ephemeral ref", async () => {
    const workflow = await readWorkflow(".github/workflows/prepare-release.yml");
    const snapshot = workflow.jobs.snapshot;
    const mutate = workflow.jobs.mutate;
    const snapshotText = snapshot.steps?.map(step => `${step.uses ?? ""}\n${step.run ?? ""}`).join("\n") ?? "";
    const mutationText = mutate.steps?.map(step => `${step.uses ?? ""}\n${step.run ?? ""}`).join("\n") ?? "";

    expect(snapshotText).toContain("snapshot.json");
    expect(snapshotText).toContain("plan.json");
    expect(snapshotText).toContain("package.before.json");
    expect(snapshotText).toContain("package.after.json");
    expect(snapshotText).toContain("packages/${index}.before.json");
    expect(snapshotText).toContain("packages/${index}.after.json");
    expect(snapshotText).toContain("beforeSha256");
    expect(snapshotText).toContain("afterSha256");
    expect(mutationText).toContain("operation package digest disagrees with sealed plan");
    expect(snapshotText).toContain("manifest.sha256");
    expect(snapshotText).toContain("shasum -a 256");
    expect(snapshotText).toContain("actions/upload-artifact@");
    expect(mutationText).toContain("actions/download-artifact@");
    expect(mutationText).toContain("shasum -a 256 --check manifest.sha256");
    expect(mutationText).toContain("operation changes more than package.json.version");
    expect(snapshotText).toContain("formatPreparationTrailers");
    expect(snapshotText).toContain("formatCancellationTrailers");
    expect(snapshotText).toContain("findLatestUncancelledPreparation");
    expect(snapshotText).toContain("pendingMatches");
    expect(snapshotText).toContain("restoreVersion");
    expect(snapshotText).toContain("Cancel release preparation");
    expect(snapshotText).toContain("Prepare ${targetVersion}");
    expect(mutationText).toContain('TEMP_BRANCH="release-preparation/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"');
    expect(mutationText).toContain('gh api --method POST "repos/${REPOSITORY}/git/refs"');
    expect(mutationText).toContain('{ref:$ref,sha:$sha}');
    expect(mutationText).toContain('gh api --method PUT "repos/${REPOSITORY}/contents/package.json"');
    expect(mutationText).toContain("message:$message,content:$content,sha:$sha,branch:$branch");
    expect(mutationText).toContain('gh api --method DELETE "repos/${REPOSITORY}/git/refs/heads/${TEMP_BRANCH}"');
    expect(mutationText).not.toContain('gh api --method POST "repos/${REPOSITORY}/git/blobs"');
    expect(mutationText).not.toContain('gh api --method POST "repos/${REPOSITORY}/git/trees"');
    expect(mutationText).not.toContain('gh api --method POST "repos/${REPOSITORY}/git/commits"');
    expect(mutationText).not.toContain("author:$author");
    expect(mutationText).not.toContain("committer:$committer");
    expect(mutationText).not.toContain("signature:$signature");
    expect(mutationText).toContain(".commit.verification.verified == true");
    expect(mutationText).toContain('.author.login == "github-actions[bot]"');
    expect(mutationText).toContain('.committer.login == "web-flow"');
    expect(mutationText).toContain('([.files[].filename] == ["package.json"])');
    expect(snapshotText).toContain("authorLogin");
    expect(snapshotText).toContain("committerLogin");
    expect(snapshotText).toContain("changedPaths");
    expect(snapshotText).toContain("commit.verified");
    expect(snapshotText).toContain('commit.authorLogin === "github-actions[bot]"');
    expect(snapshotText).toContain('commit.committerLogin === "web-flow"');
    expect(snapshotText).toContain("commit.parents.length === 1");
    expect(snapshotText).toContain('commit.changedPaths[0] === "package.json"');
    expect(snapshotText).toContain("parseReleaseRecord(commit)");
    expect(snapshotText).toContain(
      "immutableTag: { version: previewTag.version, sourceSha: previewTag.sha }",
    );
    expect(snapshotText).not.toContain("gh pr merge");
    expect(snapshotText).not.toContain("NODE_AUTH_TOKEN");
  });

});

describe("immutable prepared-release dispatcher", () => {
  test("preserves push SHA runs while allowing pull request attempts to supersede each other", async () => {
    for (const path of [".github/workflows/ci.yml", ".github/workflows/package-lifecycle.yml"]) {
      const workflow = await readWorkflow(path);
      const group = workflow.concurrency?.group ?? "";

      expect(group).toContain("github.event_name == 'push'");
      expect(group).toContain("github.sha");
      expect(group).toContain("github.ref");
      expect(group).not.toContain("github.event.pull_request.head.sha");
      expect(workflow.concurrency?.["cancel-in-progress"]).toBe(
        "${{ github.event_name == 'pull_request' }}",
      );
      expect(workflow.on.push?.paths).toEqual(expect.arrayContaining([
        ".github/workflows/prepare-release.yml",
        ".github/workflows/publish-prepared-release.yml",
        ".github/workflows/release.yml",
      ]));
    }
  });

  test("accepts develop and main pushes plus explicit exact-SHA recovery", async () => {
    const workflow = await readWorkflow(".github/workflows/publish-prepared-release.yml");

    expect(workflow.on.push?.branches).toEqual(["develop", "main"]);
    expect(workflow.on.workflow_dispatch?.inputs).toEqual({
      "expected-sha": {
        description: "Full lowercase prepared merge commit SHA to recover",
        required: true,
        type: "string",
      },
      "source-branch": {
        description: "Remote branch containing the prepared merge commit",
        required: true,
        type: "choice",
        options: ["develop", "main"],
      },
      "dry-run": {
        description: "Validate and build without publishing",
        required: true,
        type: "boolean",
        default: true,
      },
      "dispatch-id": {
        description: "Optional correlation ID for a manual dispatcher",
        required: false,
        type: "string",
        default: "",
      },
    });
    expect(workflow["run-name"]).toBe("Publish prepared release [${{ inputs.dispatch-id }}]");
    expect(workflow.concurrency).toEqual({
      group: "publish-prepared-release-${{ github.event_name == 'push' && github.event.after || inputs.expected-sha }}",
      "cancel-in-progress": false,
    });
  });

  test("classifies only verified bot-owned package-only source-side records from trusted main", async () => {
    const workflow = await readWorkflow(".github/workflows/publish-prepared-release.yml");
    const dispatch = workflow.jobs.dispatch;
    const checkout = dispatch.steps?.find(step => step.name === "Checkout trusted dispatcher");
    const classify = dispatch.steps?.find(step => step.id === "classify");
    const script = classify?.run ?? "";

    expect(workflow.permissions).toEqual({
      actions: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(checkout?.with).toMatchObject({
      ref: "main",
      "fetch-depth": 0,
      "fetch-tags": true,
    });
    expect(classify?.env).toMatchObject({
      PUSH_AFTER: "${{ github.event.after }}",
      PUSH_BRANCH: "${{ github.ref_name }}",
      RECOVERY_SHA: "${{ inputs.expected-sha }}",
      RECOVERY_BRANCH: "${{ inputs.source-branch }}",
    });
    expect(script).toContain('^[0-9a-f]{40}$');
    expect(script).toContain('merge-base --is-ancestor "$EXPECTED_SHA" "refs/remotes/origin/${SOURCE_BRANCH}"');
    expect(script).toContain('rev-list --reverse "${merge_parents[0]}..${merge_parents[1]}"');
    expect(script).toContain('.commit.verification.verified == true');
    expect(script).toContain('.committer.login // ""');
    expect(script).toContain('.author.login // ""');
    expect(script).toContain('[.parents[].sha | ascii_downcase]');
    expect(script).toContain('[.files[].filename] | sort');
    expect(script).toContain('commit.authorLogin !== "github-actions[bot]"');
    expect(script).toContain('commit.committerLogin !== "web-flow"');
    expect(script).toContain('commit.changedPaths[0] !== "package.json"');
    expect(script).toContain("classifyMergedRelease");
    expect(script).toContain('classification.kind === "no-release"');
    expect(script).toContain('const requiredBranch = tag === "preview" ? "develop" : "main"');
    expect(script).toContain("snapshot.sourceBranch !== requiredBranch");
    expect(script).toContain("snapshot.mergeVersion !== classification.preparation.targetVersion");
    expect(script).toContain("DRY_RUN=false");
    expect(script).toContain("RECOVERY=false");
    expect(script).toContain("RECOVERY=true");
    expect(script).not.toContain(".labels");
  });

  test("waits for and rechecks only the newest successful push attempt for the exact SHA and branch", async () => {
    const workflow = await readWorkflow(".github/workflows/publish-prepared-release.yml");
    const steps = workflow.jobs.dispatch.steps ?? [];
    const waitForGates = steps.find(step => step.id === "gates");
    const recheck = steps.find(step => step.name === "Recheck exact-SHA gates");
    const waitScript = waitForGates?.run ?? "";
    const recheckScript = recheck?.run ?? "";

    for (const script of [waitScript, recheckScript]) {
      expect(script).toContain('(.head_sha | ascii_downcase) == $sha');
      expect(script).toContain('.event == "push"');
      expect(script).toContain('.head_branch == $branch');
      expect(script).toContain("sort_by(.id, .run_attempt) | last");
      expect(script).toContain("head_sha=${EXPECTED_SHA}");
    }
    expect(waitScript).toContain("ci.yml");
    expect(waitScript).toContain("package-lifecycle.yml");
    expect(waitScript).toContain("deadline=");
    expect(waitScript).toContain("queued|in_progress|pending|requested|waiting");
    expect(waitScript).toContain('conclusion" != "success"');
    expect(recheckScript).toContain("Superseded exact-SHA");
  });

  test("dispatches the immutable release inputs from main without cancelling publication", async () => {
    const workflow = await readWorkflow(".github/workflows/publish-prepared-release.yml");
    const steps = workflow.jobs.dispatch.steps ?? [];
    const dispatch = steps.find(step => step.name === "Dispatch immutable release");
    const script = dispatch?.run ?? "";

    expect(dispatch?.env).toMatchObject({
      EXPECTED_SHA: "${{ steps.classify.outputs.expected-sha }}",
      SOURCE_BRANCH: "${{ steps.classify.outputs.source-branch }}",
      VERSION: "${{ steps.classify.outputs.version }}",
      TAG: "${{ steps.classify.outputs.tag }}",
      DRY_RUN: "${{ steps.classify.outputs.dry-run }}",
      RECOVERY: "${{ steps.classify.outputs.recovery }}",
      DISPATCH_ID: "${{ inputs.dispatch-id }}",
    });
    expect(script).toContain("gh workflow run release.yml");
    expect(script).toContain("--ref main");
    for (const input of [
      "expected-sha",
      "source-branch",
      "version",
      "tag",
      "dry-run",
      "bootstrap",
      "recovery",
      "dispatch-id",
    ]) {
      expect(script).toContain(`-f ${input}=`);
    }
    expect(script).toContain("-f bootstrap=false");
    expect(script).toContain('-f dispatch-id="$DISPATCH_ID"');
  });
});
