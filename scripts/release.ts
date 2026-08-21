#!/usr/bin/env bun
/**
 * Trusted release workflow dispatcher. This helper never prepares or publishes a
 * package locally. Label automation owns ordinary releases; this file exposes
 * only explicit immutable recovery, the one-time package bootstrap, and watch.
 *
 * Usage:
 *   bun scripts/release.ts recover <expected-sha> --source-branch develop|main [--publish]
 *   bun scripts/release.ts bootstrap <version> --expected-sha <sha> --publish
 *   bun scripts/release.ts watch
 */
import { $ } from "bun";
import { randomUUID } from "node:crypto";

type ReleaseSourceBranch = "develop" | "main";

export type ReleaseCommand =
  | { kind: "watch" }
  | {
    kind: "recovery";
    expectedSha: string;
    sourceBranch: ReleaseSourceBranch;
    dryRun: boolean;
  }
  | {
    kind: "bootstrap";
    version: string;
    expectedSha: string;
  };

export interface WorkflowRun {
  databaseId: number;
  displayTitle: string;
  createdAt: string;
  event: string;
  headBranch: string;
  status: string;
  url: string;
}


const RELEASE_USAGE = [
  "Usage: bun scripts/release.ts recover <expected-sha> --source-branch develop|main [--publish]",
  "       bun scripts/release.ts bootstrap <version> --expected-sha <sha> --publish",
  "       bun scripts/release.ts watch",
].join("\n");
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_RUN_WAIT_TIMEOUT_MS = 2 * 60 * 1000;
const RELEASE_RUN_POLL_MS = 2000;

function requireSingleOption(args: readonly string[], option: string): string {
  const positions = args.flatMap((value, index) => value === option ? [index] : []);
  if (positions.length !== 1) {
    throw new Error(`${option} must be provided exactly once\n${RELEASE_USAGE}`);
  }
  const value = args[positions[0] + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value\n${RELEASE_USAGE}`);
  }
  return value;
}

function assertOnlyKnownArguments(
  args: readonly string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[],
): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (valueOptions.includes(argument)) {
      index += 1;
      if (index >= args.length || args[index].startsWith("--")) {
        throw new Error(`${argument} requires a value\n${RELEASE_USAGE}`);
      }
      continue;
    }
    if (flagOptions.includes(argument)) {
      continue;
    }
    throw new Error(`unsupported release argument: ${argument}\n${RELEASE_USAGE}`);
  }
}

function requireLowercaseSha(value: string): string {
  if (!SHA_PATTERN.test(value)) {
    throw new Error("expected-sha must be a full lowercase 40-character commit SHA");
  }
  return value;
}

export function parseReleaseCommand(args: string[]): ReleaseCommand {
  if (args.length === 1 && args[0] === "watch") {
    return { kind: "watch" };
  }

  if (args[0] === "recover") {
    const expectedSha = requireLowercaseSha(args[1] ?? "");
    const options = args.slice(2);
    assertOnlyKnownArguments(options, ["--source-branch"], ["--publish"]);
    const sourceBranch = requireSingleOption(options, "--source-branch");
    if (sourceBranch !== "develop" && sourceBranch !== "main") {
      throw new Error("source-branch must be develop or main");
    }
    if (options.filter(argument => argument === "--publish").length > 1) {
      throw new Error("--publish may be provided only once");
    }
    return {
      kind: "recovery",
      expectedSha,
      sourceBranch,
      dryRun: !options.includes("--publish"),
    };
  }

  if (args[0] === "bootstrap") {
    const version = args[1] ?? "";
    if (!STABLE_VERSION_PATTERN.test(version)) {
      throw new Error(`bootstrap version must be a stable X.Y.Z SemVer\n${RELEASE_USAGE}`);
    }
    const options = args.slice(2);
    assertOnlyKnownArguments(options, ["--expected-sha"], ["--publish"]);
    const expectedSha = requireLowercaseSha(requireSingleOption(options, "--expected-sha"));
    if (options.filter(argument => argument === "--publish").length !== 1) {
      throw new Error("bootstrap requires --publish");
    }
    return { kind: "bootstrap", version, expectedSha };
  }

  throw new Error(RELEASE_USAGE);
}

async function listWorkflowRuns(workflow: string): Promise<WorkflowRun[]> {
  const output = await $`gh run list --workflow ${workflow} --limit 100 --json databaseId,createdAt,displayTitle,event,headBranch,status,url`.text();
  const runs = JSON.parse(output) as WorkflowRun[];
  return runs.filter(run =>
    Number.isSafeInteger(run.databaseId)
    && run.databaseId > 0
    && typeof run.createdAt === "string"
    && typeof run.displayTitle === "string"
    && typeof run.event === "string"
    && typeof run.headBranch === "string"
  );
}

export function selectDispatchedWorkflowRun(
  runs: readonly WorkflowRun[],
  displayTitle: string,
  dispatchedAt: number,
): WorkflowRun | null {
  const earliestCreatedAt = Math.floor(dispatchedAt / 1000) * 1000;
  return runs.find(run =>
    run.displayTitle === displayTitle
    && run.event === "workflow_dispatch"
    && run.headBranch === "main"
    && Date.parse(run.createdAt) >= earliestCreatedAt
  ) ?? null;
}

async function waitForDispatchedWorkflowRun(
  workflow: string,
  displayTitle: string,
  dispatchedAt: number,
): Promise<WorkflowRun> {
  const deadline = Date.now() + RELEASE_RUN_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const runs = await listWorkflowRuns(workflow);
    const run = selectDispatchedWorkflowRun(runs, displayTitle, dispatchedAt);
    if (run) {
      console.log(`Bound ${workflow} run ${run.databaseId}: ${run.url}`);
      return run;
    }
    await Bun.sleep(RELEASE_RUN_POLL_MS);
  }
  throw new Error(`Timed out waiting for ${workflow} run titled ${displayTitle}`);
}

async function watchRun(databaseId: number): Promise<void> {
  console.log(`Watching workflow run ${databaseId}`);
  await $`gh run watch ${databaseId} --exit-status --interval 10`;
}

async function watchMostRecentRelease(): Promise<void> {
  const runs = (await listWorkflowRuns("release.yml"))
    .filter(run => run.event === "workflow_dispatch" && run.headBranch === "main")
    .sort((left, right) => right.databaseId - left.databaseId);
  const run = runs[0];
  if (!run) {
    throw new Error("No workflow_dispatch/main Release runs found.");
  }
  await watchRun(run.databaseId);
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const command = parseReleaseCommand(args);
  if (command.kind === "watch") {
    await watchMostRecentRelease();
    return;
  }

  const dispatchId = randomUUID();
  const dispatchedAt = Date.now();
  if (command.kind === "recovery") {
    const dispatcherTitle = `Publish prepared release [${dispatchId}]`;
    const releaseTitle = `Release [${dispatchId}]`;
    console.log(
      `Dispatch immutable recovery (sha=${command.expectedSha}, branch=${command.sourceBranch}, dry-run=${command.dryRun})`,
    );
    await $`gh workflow run publish-prepared-release.yml --ref main -f expected-sha=${command.expectedSha} -f source-branch=${command.sourceBranch} -f dry-run=${String(command.dryRun)} -f dispatch-id=${dispatchId}`;
    const dispatcherRun = await waitForDispatchedWorkflowRun(
      "publish-prepared-release.yml",
      dispatcherTitle,
      dispatchedAt,
    );
    await watchRun(dispatcherRun.databaseId);
    const releaseRun = await waitForDispatchedWorkflowRun("release.yml", releaseTitle, dispatchedAt);
    await watchRun(releaseRun.databaseId);
    return;
  }

  const releaseTitle = `Release [${dispatchId}]`;
  console.log(`Dispatch one-time bootstrap (sha=${command.expectedSha}, version=${command.version})`);
  await $`gh workflow run release.yml --ref main -f version=${command.version} -f expected-sha=${command.expectedSha} -f source-branch=main -f tag=latest -f dry-run=false -f bootstrap=true -f recovery=false -f dispatch-id=${dispatchId}`;
  const releaseRun = await waitForDispatchedWorkflowRun("release.yml", releaseTitle, dispatchedAt);
  await watchRun(releaseRun.databaseId);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
