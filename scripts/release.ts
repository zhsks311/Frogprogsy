#!/usr/bin/env bun
/**
 * Release helper (jawcode-style, single package). Not shipped in the registry tarball.
 *
 * Usage:
 *   bun scripts/release.ts prepare <version>
 *       On a clean develop branch, verify the version is unused and update only package.json.
 *   bun scripts/release.ts <version> [--tag latest|preview] [--publish] [--bootstrap]
 *       On a clean main branch whose package version already matches, typecheck, wait for all
 *       exact-SHA release gates, dispatch the Release workflow, and watch it.
 *       Dry-run by default; pass --publish to publish.
 *   bun scripts/release.ts watch
 *       Watch the most recent Release run.
 *
 * Example:  bun scripts/release.ts prepare 0.1.0
 *           bun scripts/release.ts 0.1.0                            # dry-run stable release
 *           bun scripts/release.ts 0.1.0 --publish                  # OIDC stable publish
 *           bun scripts/release.ts 0.0.1 --publish --bootstrap      # one-time first publish
 *
 * Requires: gh CLI (authed). Final publishing uses Trusted Publishing (OIDC), with no long-lived registry token.
 */
import { $ } from "bun";
import { registryVersionListed } from "./release-registry";

export interface GhRun {
  conclusion: string | null;
  databaseId: number;
  headSha: string;
  status: string;
  url: string;
}

type ReleaseTag = "latest" | "preview";

export type ReleaseCommand =
  | { kind: "watch" }
  | { kind: "prepare"; version: string }
  | { kind: "publish"; version: string; tag: ReleaseTag; dryRun: boolean; bootstrap: boolean };

const RELEASE_USAGE = [
  "Usage: bun scripts/release.ts prepare <version>",
  "       bun scripts/release.ts <version> [--tag latest|preview] [--publish] [--bootstrap]",
  "       bun scripts/release.ts watch",
].join("\n");
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

export function parseReleaseCommand(args: string[]): ReleaseCommand {
  if (args[0] === "watch") {
    return { kind: "watch" };
  }

  const preparing = args[0] === "prepare";
  const version = args[preparing ? 1 : 0];
  if (!version || !RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(RELEASE_USAGE);
  }
  if (preparing) {
    return { kind: "prepare", version };
  }

  const tag = args.includes("--tag")
    ? (args[args.indexOf("--tag") + 1] ?? "latest")
    : "latest";
  if (tag !== "latest" && tag !== "preview") {
    throw new Error(`✗ unsupported registry dist-tag: ${tag}`);
  }
  const prerelease = version.includes("-");
  if ((tag === "preview") !== prerelease) {
    throw new Error(`✗ ${tag} requires a ${tag === "preview" ? "prerelease" : "stable"} SemVer; got ${version}`);
  }
  const dryRun = !args.includes("--publish");
  const bootstrap = args.includes("--bootstrap");
  if (bootstrap && dryRun) {
    throw new Error("✗ --bootstrap requires --publish");
  }
  if (bootstrap && tag !== "latest") {
    throw new Error("✗ --bootstrap must publish a stable version to the latest channel");
  }

  return { kind: "publish", version, tag, dryRun, bootstrap };
}

export function assertReleaseBranch(kind: "prepare" | "publish", branch: string): void {
  const expectedBranch = kind === "prepare" ? "develop" : "main";
  if (branch !== expectedBranch) {
    throw new Error(`✗ must be on ${expectedBranch} (currently ${branch}).`);
  }
}

export function assertPublishPackageVersion(expectedVersion: string, actualVersion: unknown): void {
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `✗ package.json version ${String(actualVersion)} does not match requested release version ${expectedVersion}.`,
    );
  }
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// The local helper mirrors release.yml's fail-closed three-workflow gate for
// Cross-platform CI, Package lifecycle, and the deployed Pages catalog.
const CI_WORKFLOW = "ci.yml";
const PACKAGE_LIFECYCLE_WORKFLOW = "package-lifecycle.yml";
const PAGES_WORKFLOW = "deploy-docs.yml";
const RELEASE_GATE_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const RELEASE_GATE_POLL_MS = 10 * 1000;

interface ReleaseGate {
  workflow: string;
  label: string;
}

const RELEASE_GATES: ReleaseGate[] = [
  { workflow: CI_WORKFLOW, label: "Cross-platform CI" },
  { workflow: PACKAGE_LIFECYCLE_WORKFLOW, label: "Package lifecycle" },
  { workflow: PAGES_WORKFLOW, label: "Pages catalog" },
];

async function runQuiet(command: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

interface PackageMetadata {
  name: string;
  version: unknown;
}

async function readPackageMetadata(path = "package.json"): Promise<PackageMetadata> {
  try {
    const pkg = JSON.parse(await Bun.file(path).text()) as { name?: unknown; version?: unknown };
    if (typeof pkg.name !== "string" || !pkg.name) {
      console.error(`✗ ${path} is missing a valid name`);
      process.exit(1);
    }
    return { name: pkg.name, version: pkg.version };
  } catch (error) {
    console.error(`✗ failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export async function writePackageVersion(version: string, path = "package.json"): Promise<boolean> {
  const pkg = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
  if (pkg.version === version) return false;
  pkg.version = version;
  await Bun.write(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

async function registryVersionExists(packageName: string, version: string): Promise<boolean> {
  const result = await runQuiet(["bun", "pm", "view", packageName, "versions", "--json"]);
  if (result.exitCode === 0) {
    try {
      return registryVersionListed(result.stdout, version);
    } catch (error) {
      console.error(`✗ invalid registry versions response for ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (output.includes("e404") || output.includes("404 not found") || output.includes("does not exist in this registry") || output.includes("no match found")) {
    return false;
  }

  console.error(`✗ failed to check registry versions for ${packageName}`);
  if (result.stderr) console.error(result.stderr);
  process.exit(1);
}

async function remoteTagSha(tagName: string): Promise<string | null> {
  const result = await runQuiet(["git", "ls-remote", "origin", `refs/tags/${tagName}`, `refs/tags/${tagName}^{}`]);
  if (result.exitCode !== 0) {
    console.error(`✗ failed to check remote tag ${tagName}`);
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }

  const lines = result.stdout.split("\n").filter(Boolean);
  const peeled = lines.find(line => line.endsWith(`refs/tags/${tagName}^{}`));
  const exact = lines.find(line => line.endsWith(`refs/tags/${tagName}`));
  const selected = peeled ?? exact;
  return selected ? selected.split(/\s+/)[0] ?? null : null;
}

async function githubReleaseExists(tagName: string): Promise<boolean> {
  const result = await runQuiet(["gh", "release", "view", tagName, "--json", "tagName"]);
  if (result.exitCode === 0) return true;

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (output.includes("release not found")) return false;

  console.error(`✗ failed to check GitHub Release ${tagName}`);
  if (result.stderr) console.error(result.stderr);
  process.exit(1);
}

async function assertUnusedReleaseVersion(packageName: string, version: string): Promise<void> {
  const releaseTag = `v${version}`;
  const [registryUsed, tagSha, releaseUsed] = await Promise.all([
    registryVersionExists(packageName, version),
    remoteTagSha(releaseTag),
    githubReleaseExists(releaseTag),
  ]);

  const failures: string[] = [];
  if (registryUsed) failures.push(`- package registry already has ${packageName}@${version}`);
  if (tagSha) failures.push(`- remote Git tag ${releaseTag} already exists at ${tagSha}`);
  if (releaseUsed) failures.push(`- GitHub Release ${releaseTag} already exists`);

  if (failures.length > 0) {
    console.error(`✗ release version ${version} is already partially or fully used:`);
    console.error(failures.join("\n"));
    console.error("Choose the next unused patch version, or make an explicit human decision to repair public metadata.");
    process.exit(1);
  }
}

async function watchLatest(): Promise<void> {
  const id = (await $`gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId'`.text()).trim();
  if (!id) { console.error("No Release runs found yet."); process.exit(1); }
  console.log(`→ watching Release run ${id}`);
  await $`gh run watch ${id} --exit-status --interval 10`;
}

async function listWorkflowRuns(workflow: string, sha: string): Promise<GhRun[]> {
  const raw = await $`gh run list --workflow ${workflow} --commit ${sha} --limit 20 --json conclusion,databaseId,headSha,status,url`.text();
  const runs = JSON.parse(raw) as GhRun[];
  return runs.filter(run => run.headSha === sha);
}

export function latestWorkflowRun(runs: readonly GhRun[]): GhRun | null {
  return runs.reduce<GhRun | null>(
    (latest, run) => latest === null || run.databaseId > latest.databaseId ? run : latest,
    null,
  );
}

// Judge only the newest attempt for this exact SHA. An older successful run
// cannot hide a newer queued, in-progress, cancelled, or failed retry.
async function waitForSuccessfulGate(gate: ReleaseGate, sha: string): Promise<GhRun> {
  const deadline = Date.now() + RELEASE_GATE_WAIT_TIMEOUT_MS;
  let attempt = 1;
  while (Date.now() < deadline) {
    const runs = await listWorkflowRuns(gate.workflow, sha);
    const latest = latestWorkflowRun(runs);
    if (latest?.status === "completed" && latest.conclusion === "success") {
      console.log(`→ ${gate.label} (${gate.workflow}) passed: ${latest.url}`);
      return latest;
    }

    if (latest?.status === "completed" && latest.conclusion && latest.conclusion !== "success") {
      console.error(`✗ ${gate.label} (${gate.workflow}) failed for ${sha}: ${latest.url}`);
      process.exit(1);
    }

    const state = latest === null
      ? "not started yet"
      : `${latest.status}${latest.conclusion ? `/${latest.conclusion}` : ""} (run ${latest.databaseId})`;
    console.log(`→ waiting for ${gate.label} (${sha.slice(0, 7)}) attempt ${attempt}: ${state}`);
    attempt += 1;
    await Bun.sleep(RELEASE_GATE_POLL_MS);
  }

  console.error(`✗ timed out waiting for ${gate.label} (${gate.workflow}) on ${sha}`);
  process.exit(1);
}

// The three gates are independent, so wait for them in parallel. Each keeps its
// own bounded timeout and fail-closed latest-attempt semantics.
async function waitForReleaseGates(sha: string): Promise<void> {
  await Promise.all(RELEASE_GATES.map(gate => waitForSuccessfulGate(gate, sha)));
}

async function remoteMainSha(): Promise<string> {
  const out = (await $`git ls-remote origin refs/heads/main`.text()).trim();
  const [sha] = out.split(/\s+/);
  if (!sha) {
    console.error("✗ could not resolve origin/main");
    process.exit(1);
  }
  return sha;
}

async function assertOriginMainMatches(releaseSha: string): Promise<void> {
  const originMain = await remoteMainSha();
  if (originMain !== releaseSha) {
    console.error(`✗ origin/main does not match HEAD (${originMain} != ${releaseSha}); aborting release.`);
    process.exit(1);
  }
}

async function main(args = process.argv.slice(2)): Promise<void> {
  let command: ReleaseCommand;
  try {
    command = parseReleaseCommand(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (command.kind === "watch") {
    await watchLatest();
    return;
  }

  const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
  try {
    assertReleaseBranch(command.kind, branch);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if ((await $`git status --porcelain`.text()).trim()) {
    console.error("✗ working tree not clean — commit or stash first.");
    process.exit(1);
  }

  const packageMetadata = await readPackageMetadata();
  console.log(`→ release metadata preflight (${packageMetadata.name}@${command.version})`);

  if (command.kind === "prepare") {
    await assertUnusedReleaseVersion(packageMetadata.name, command.version);
    console.log(`→ package.json version → ${command.version}`);
    const versionChanged = await writePackageVersion(command.version);
    console.log(versionChanged
      ? "\n✓ package.json is ready. Commit the version change on develop and include it in the develop -> main promotion PR."
      : "\n✓ package.json already has this version. Include the existing change in the develop -> main promotion PR.");
    return;
  }

  const { version, tag, dryRun, bootstrap } = command;

  try {
    assertPublishPackageVersion(version, packageMetadata.version);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  await assertUnusedReleaseVersion(packageMetadata.name, version);
  console.log("→ typecheck");
  await $`bun x tsc --noEmit`;

  const releaseSha = (await $`git rev-parse HEAD`.text()).trim();
  await assertOriginMainMatches(releaseSha);
  console.log(`→ wait for release gates (${RELEASE_GATES.map(gate => gate.workflow).join(" + ")}) on ${releaseSha}`);
  await waitForReleaseGates(releaseSha);

  await assertOriginMainMatches(releaseSha);
  console.log(`→ dispatch Release (sha=${releaseSha}, tag=${tag}, dry-run=${dryRun}, bootstrap=${bootstrap})`);
  await $`gh workflow run release.yml --ref main -f version=${version} -f expected-sha=${releaseSha} -f tag=${tag} -f dry-run=${String(dryRun)} -f bootstrap=${String(bootstrap)}`;
  await Bun.sleep(4000);

  await watchLatest();
  console.log(dryRun
    ? "\n✓ Dry run complete. Re-run with --publish to publish for real."
    : "\n✓ Published. Try:  bun add -g frogprogsy");
}

if (import.meta.main) {
  await main();
}
