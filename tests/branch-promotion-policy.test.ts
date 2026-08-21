import { describe, expect, test } from "bun:test";

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
      "snapshot.npmLatestProof?.sourceSha !== snapshot.mainSha",
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

  test("content-addresses new preparation and cancellation plans with package-only commits", async () => {
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
    expect(mutationText).toContain('gh api --method POST "repos/${REPOSITORY}/git/commits"');
    expect(mutationText).toContain("message:$message,tree:$tree,parents:[$parent]");
    expect(mutationText).not.toContain("author:$author");
    expect(mutationText).not.toContain("committer:$committer");
    expect(mutationText).not.toContain("signature:$signature");
    expect(mutationText).toContain(".commit.verification.verified == true");
    expect(mutationText).toContain('.committer.login == "github-actions[bot]"');
    expect(mutationText).toContain('([.files[].filename] == ["package.json"])');
    expect(snapshotText).toContain("committerLogin");
    expect(snapshotText).toContain("changedPaths");
    expect(snapshotText).toContain("commit.verified");
    expect(snapshotText).toContain('commit.committerLogin === "github-actions[bot]"');
    expect(snapshotText).toContain("commit.parents.length === 1");
    expect(snapshotText).toContain('commit.changedPaths[0] === "package.json"');
    expect(snapshotText).toContain("parseReleaseRecord(commit)");
    expect(snapshotText).toContain(
      "immutableTag: { version: previewTag.version, sourceSha: previewTag.sha }",
    );
    expect(snapshotText).not.toContain("gh pr merge");
    expect(snapshotText).not.toContain("NODE_AUTH_TOKEN");
  });

  test("revalidates exact live state before one fast-forward ref update and exact-head readiness", async () => {
    const workflow = await readWorkflow(".github/workflows/prepare-release.yml");
    const mutationText = workflow.jobs.mutate.steps
      ?.map(step => `${step.name ?? ""}\n${step.run ?? ""}`)
      .join("\n") ?? "";

    expect(mutationText).toContain("cmp --silent release-plan/snapshot.json release-plan/live-snapshot.json");
    expect(mutationText).toContain("gh auth setup-git");
    expect(mutationText).toContain("bash release-plan/collect-live.sh");
    expect(mutationText).toContain("This comparison is unconditional");
    expect(mutationText.match(/(?:^|\n)\s*release-plan\/collect-live\.sh/g)).toBeNull();
    expect(mutationText).toContain('git/refs/heads/${RESULT_BRANCH}');
    expect(mutationText).toContain("{sha:$sha,force:false}");
    expect(mutationText).not.toContain("git push origin");
    expect(mutationText).not.toContain("force:true");
    expect(mutationText).toContain("gh workflow run ci.yml");
    expect(mutationText).toContain("gh workflow run package-lifecycle.yml");
    expect(mutationText).toContain("A newer exact-ref workflow_dispatch superseded the bound run");
    expect(mutationText).toContain("latest_exact_ref_run_id ci.yml");
    expect(mutationText).toContain("latest_exact_ref_run_id package-lifecycle.yml");
    expect(mutationText).toContain("require_bound_runs_are_latest");
    expect(mutationText.lastIndexOf("require_bound_runs_are_latest"))
      .toBeLessThan(mutationText.lastIndexOf('--add-label release:ready'));
    expect(mutationText).toContain("release-plan/ci.run-id");
    expect(mutationText).toContain("release-plan/package.run-id");
    expect(mutationText).toContain('.event == "workflow_dispatch"');
    expect(mutationText).toContain(".head_branch == $branch");
    expect(mutationText).toContain(".created_at >= $since");
    expect(mutationText).toContain("Release state");
    expect(mutationText).toContain("RESULT_SHA");
    expect(mutationText).toContain("release:ready");
    expect(mutationText.indexOf("This comparison is unconditional"))
      .toBeLessThan(mutationText.indexOf('git/refs/heads/${RESULT_BRANCH}'));
    expect(mutationText.lastIndexOf("revalidate_ready_state"))
      .toBeLessThan(mutationText.lastIndexOf('--add-label release:ready'));
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
    expect(script).toContain('[.parents[].sha | ascii_downcase]');
    expect(script).toContain('[.files[].filename] | sort');
    expect(script).toContain('commit.committerLogin !== "github-actions[bot]"');
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
