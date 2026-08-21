export const RELEASE_SELECTION_LABELS = [
  "release:none",
  "release:patch",
  "release:minor",
  "release:major",
  "release:preview-patch",
  "release:preview-minor",
  "release:preview-major",
  "release:promote",
] as const;

export type ReleaseSelection = (typeof RELEASE_SELECTION_LABELS)[number];
export type StableBump = "patch" | "minor" | "major";
export type BumpReleaseSelection = Exclude<
  ReleaseSelection,
  "release:none" | "release:promote"
>;
export type PreparationSelection = Exclude<ReleaseSelection, "release:none">;

export interface StableVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface PreviewVersion extends StableVersion {
  preview: number;
}

export type StrictVersion = StableVersion | PreviewVersion;

export interface VersionStores {
  npmVersions: readonly string[];
  gitTags: readonly string[];
  githubReleases: readonly string[];
}

export interface PullRequestSelectionInput {
  selection: ReleaseSelection;
  repository: string;
  headRepository: string;
  headBranch: string;
  baseBranch: string;
}

export interface OpenPullRequest {
  number: number;
  labels: readonly string[];
}

export interface PreviewPublicationRecord {
  version: string;
  sourceSha: string;
}

export interface ImmutableTagRecord {
  version: string;
  sourceSha: string;
}

export interface GithubReleaseRecord {
  version: string;
  sourceSha: string;
  prerelease: boolean;
  packageDigest?: string;
}

export interface PromotionState {
  registryPreview: PreviewPublicationRecord;
  previewDistTag: string;
  immutableTag: ImmutableTagRecord;
  githubPrerelease: GithubReleaseRecord;
  developSha: string;
}

export interface ExpectedStablePublication {
  version: string;
  sourceSha: string;
  packageDigest: string;
}

export interface NpmPublicationRecord extends ExpectedStablePublication {
  channel: "latest" | "preview";
}

export interface StableTargetOccupancyInput {
  expected: ExpectedStablePublication;
  npmVersion: NpmPublicationRecord | null;
  immutableTag: ImmutableTagRecord | null;
  githubRelease: GithubReleaseRecord | null;
}

export type StableTargetOccupancy =
  | { kind: "all-absent" }
  | {
      kind: "npm-present-recoverable";
      missing: readonly ("immutable-tag" | "github-release")[];
    }
  | {
      kind: "invalid-npm-absent-metadata";
      present: readonly ("immutable-tag" | "github-release")[];
    }
  | { kind: "conflict"; conflicts: readonly string[] };

export interface CommitRecord {
  sha: string;
  message: string;
  parents: readonly string[];
}

export interface PreparationBinding {
  pullRequest: number;
  selection: PreparationSelection;
  stableBaseline: string;
  targetVersion: string;
  baseSha: string;
  sourceSha: string;
}

export interface PreparationRecord extends PreparationBinding {
  kind: "preparation";
  commitSha: string;
}

export interface CancellationRecord extends PreparationBinding {
  kind: "cancellation";
  commitSha: string;
  cancelTarget: string;
}

export type ReleaseRecord = PreparationRecord | CancellationRecord;

export interface PendingPreparationSearch {
  pullRequest: number;
  commitsOldestFirst: readonly CommitRecord[];
  ownedCommitShas: readonly string[];
}

export interface MergedReleaseInput {
  pullRequest: number;
  mergeCommit: CommitRecord;
  sourceSideCommitsOldestFirst: readonly CommitRecord[];
}

export type MergeClassification =
  | { kind: "preview"; preparation: PreparationRecord }
  | { kind: "latest"; preparation: PreparationRecord }
  | { kind: "no-release" };

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.([1-9]\d*))?$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const RELEASE_TRAILER_PREFIX = "Frogprogsy-Release-";
const VERSION_STORE_KEYS = ["npmVersions", "gitTags", "githubReleases"] as const;
const RELEASE_TRAILERS = {
  record: "Frogprogsy-Release-Record",
  pullRequest: "Frogprogsy-Release-PR",
  selection: "Frogprogsy-Release-Selection",
  stableBaseline: "Frogprogsy-Release-Baseline",
  targetVersion: "Frogprogsy-Release-Version",
  baseSha: "Frogprogsy-Release-Base-SHA",
  sourceSha: "Frogprogsy-Release-Source-SHA",
  cancelTarget: "Frogprogsy-Release-Cancel-Target",
} as const;
const KNOWN_RELEASE_TRAILERS: Readonly<Record<string, true>> = {
  [RELEASE_TRAILERS.record]: true,
  [RELEASE_TRAILERS.pullRequest]: true,
  [RELEASE_TRAILERS.selection]: true,
  [RELEASE_TRAILERS.stableBaseline]: true,
  [RELEASE_TRAILERS.targetVersion]: true,
  [RELEASE_TRAILERS.baseSha]: true,
  [RELEASE_TRAILERS.sourceSha]: true,
  [RELEASE_TRAILERS.cancelTarget]: true,
};

export function parseStrictVersion(version: string): StrictVersion {
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(`${version} is not a strict release version`);
  }

  const major = parseSafeVersionNumber(match[1], version);
  const minor = parseSafeVersionNumber(match[2], version);
  const patch = parseSafeVersionNumber(match[3], version);
  if (match[4] === undefined) {
    return { major, minor, patch };
  }

  return {
    major,
    minor,
    patch,
    preview: parseSafeVersionNumber(match[4], version),
  };
}

export function replacePackageVersion(packageJson: string, targetVersion: string): string {
  parseStrictVersion(targetVersion);
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    throw new Error("package.json must contain valid JSON");
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !("version" in parsed)
    || typeof parsed.version !== "string"
  ) {
    throw new Error("package.json must contain a string version field");
  }

  const version = parsed.version;
  parseStrictVersion(version);
  const versionField = /("version"\s*:\s*)("(?:\\.|[^"\\])*")/g;
  const matches = [...packageJson.matchAll(versionField)];
  if (matches.length !== 1 || JSON.parse(matches[0][2]) !== version) {
    throw new Error("package.json must contain exactly one textual version field");
  }
  return packageJson.replace(versionField, `$1${JSON.stringify(targetVersion)}`);
}

export function bumpStableVersion(version: string, bump: StableBump): string {
  const parsed = requireStableVersion(version);
  if (bump === "patch") {
    return formatStableVersion(parsed.major, parsed.minor, increment(parsed.patch, version));
  }
  if (bump === "minor") {
    return formatStableVersion(parsed.major, increment(parsed.minor, version), 0);
  }
  return formatStableVersion(increment(parsed.major, version), 0, 0);
}

export function calculateStableTarget(
  mainVersion: string,
  npmLatestVersion: string,
  selection: BumpReleaseSelection,
): string {
  requireStableVersion(mainVersion);
  requireStableVersion(npmLatestVersion);
  if (mainVersion !== npmLatestVersion) {
    throw new Error(
      `stable baseline mismatch: main has ${mainVersion}, npm latest has ${npmLatestVersion}`,
    );
  }

  return bumpStableVersion(mainVersion, bumpForSelection(selection));
}

export function allocatePreviewVersion(stableTarget: string, stores: VersionStores): string {
  const target = requireStableVersion(stableTarget);
  const consumed = new Set<number>();

  for (const storeKey of VERSION_STORE_KEYS) {
    const versions = stores[storeKey];
    for (const reference of versions) {
      const parsed = parseStoreVersion(reference);
      if (
        parsed
        && "preview" in parsed
        && parsed.major === target.major
        && parsed.minor === target.minor
        && parsed.patch === target.patch
      ) {
        consumed.add(parsed.preview);
      }
    }
  }

  let preview = 1;
  while (consumed.has(preview)) {
    preview = increment(preview, stableTarget);
  }
  return `${stableTarget}-preview.${preview}`;
}

export function requireSingleReleaseSelection(labels: readonly string[]): ReleaseSelection {
  let selection: ReleaseSelection | null = null;
  let selectionCount = 0;
  for (const label of labels) {
    if (isReleaseSelection(label)) {
      selection = label;
      selectionCount += 1;
    }
  }
  if (selectionCount !== 1 || selection === null) {
    throw new Error(
      `expected exactly one release selection label, found ${selectionCount}`,
    );
  }
  return selection;
}

export function validatePullRequestSelection(input: PullRequestSelectionInput): void {
  const {
    selection,
    repository,
    headRepository,
    headBranch,
    baseBranch,
  } = input;

  if (selection === "release:none") {
    if (baseBranch !== "develop" && baseBranch !== "main") {
      throw new Error("release:none requires a supported base branch (develop or main)");
    }
    return;
  }

  if (selection.startsWith("release:preview-")) {
    if (baseBranch !== "develop") {
      throw new Error(`${selection} must target develop`);
    }
    if (repository.toLowerCase() !== headRepository.toLowerCase()) {
      throw new Error(`${selection} requires a same repository source branch`);
    }
    if (!headBranch || headBranch === baseBranch) {
      throw new Error(`${selection} requires a source branch distinct from develop`);
    }
    return;
  }

  if (
    baseBranch !== "main"
    || headBranch !== "develop"
    || repository.toLowerCase() !== headRepository.toLowerCase()
  ) {
    throw new Error(`${selection} requires a same-repository develop to main pull request`);
  }
}

export function assertSoleSelectedPullRequest(
  currentPullRequest: number,
  openPullRequests: readonly OpenPullRequest[],
): void {
  requirePositiveInteger(currentPullRequest, "pull request number");
  let owner: number | null = null;
  const seen = new Set<number>();

  for (const pullRequest of openPullRequests) {
    requirePositiveInteger(pullRequest.number, "pull request number");
    if (seen.has(pullRequest.number)) {
      throw new Error(`pull request #${pullRequest.number} appears more than once`);
    }
    seen.add(pullRequest.number);

    let selection: ReleaseSelection | null = null;
    for (const label of pullRequest.labels) {
      if (!isReleaseSelection(label)) {
        continue;
      }
      if (selection !== null) {
        throw new Error(
          `pull request #${pullRequest.number} must have exactly one release selection label`,
        );
      }
      selection = label;
    }

    if (selection !== null && selection !== "release:none") {
      if (owner !== null) {
        throw new Error(
          `multiple pull requests own the release selection slot: ${owner}, ${pullRequest.number}`,
        );
      }
      owner = pullRequest.number;
    }
  }

  if (owner === null) {
    throw new Error(`pull request #${currentPullRequest} does not own the release selection slot`);
  }
  if (owner !== currentPullRequest) {
    throw new Error(`release selection slot is owned by pull request #${owner}`);
  }
}

export function calculatePromotionTarget(state: PromotionState): string {
  const registryVersion = requirePreviewVersion(
    state.registryPreview.version,
    "registry preview version",
  );
  const registrySha = requireSha(
    state.registryPreview.sourceSha,
    "registry preview source SHA",
  );
  requirePreviewVersion(state.previewDistTag, "preview dist-tag");
  requirePreviewVersion(state.immutableTag.version, "immutable preview tag");
  const tagSha = requireSha(
    state.immutableTag.sourceSha,
    "immutable preview tag source SHA",
  );
  requirePreviewVersion(state.githubPrerelease.version, "GitHub prerelease version");
  const releaseSha = requireSha(
    state.githubPrerelease.sourceSha,
    "GitHub prerelease source SHA",
  );
  const developSha = requireSha(state.developSha, "develop SHA");

  if (
    state.registryPreview.version !== state.previewDistTag
    || state.registryPreview.version !== state.immutableTag.version
    || state.registryPreview.version !== state.githubPrerelease.version
  ) {
    throw new Error("promotion versions disagree");
  }
  if (!state.githubPrerelease.prerelease) {
    throw new Error("promotion requires a GitHub prerelease");
  }
  if (registrySha !== tagSha || registrySha !== releaseSha || registrySha !== developSha) {
    throw new Error("promotion source SHAs disagree with the current develop SHA");
  }

  return formatStableVersion(registryVersion.major, registryVersion.minor, registryVersion.patch);
}

export function classifyStableTargetOccupancy(
  input: StableTargetOccupancyInput,
): StableTargetOccupancy {
  requireStableVersion(input.expected.version);
  requireSha(input.expected.sourceSha, "expected source SHA");
  if (!input.expected.packageDigest) {
    throw new Error("expected package digest must not be empty");
  }

  const conflicts: string[] = [];
  if (input.npmVersion) {
    if (input.npmVersion.version !== input.expected.version) {
      conflicts.push("npm version");
    }
    if (!sameSha(input.npmVersion.sourceSha, input.expected.sourceSha)) {
      conflicts.push("npm provenance source SHA");
    }
    if (input.npmVersion.channel !== "latest") {
      conflicts.push("npm channel");
    }
    if (input.npmVersion.packageDigest !== input.expected.packageDigest) {
      conflicts.push("npm package digest");
    }
  }

  if (input.immutableTag) {
    if (input.immutableTag.version !== input.expected.version) {
      conflicts.push("immutable tag version");
    }
    if (!sameSha(input.immutableTag.sourceSha, input.expected.sourceSha)) {
      conflicts.push("immutable tag source SHA");
    }
  }

  if (input.githubRelease) {
    if (input.githubRelease.version !== input.expected.version) {
      conflicts.push("GitHub Release version");
    }
    if (!sameSha(input.githubRelease.sourceSha, input.expected.sourceSha)) {
      conflicts.push("GitHub Release source SHA");
    }
    if (input.githubRelease.prerelease) {
      conflicts.push("GitHub Release channel");
    }
    if (
      input.githubRelease.packageDigest !== undefined
      && input.githubRelease.packageDigest !== input.expected.packageDigest
    ) {
      conflicts.push("GitHub Release package digest");
    }
  }

  if (conflicts.length > 0) {
    return { kind: "conflict", conflicts };
  }

  const presentMetadata: ("immutable-tag" | "github-release")[] = [];
  if (input.immutableTag) {
    presentMetadata.push("immutable-tag");
  }
  if (input.githubRelease) {
    presentMetadata.push("github-release");
  }

  if (!input.npmVersion) {
    if (presentMetadata.length === 0) {
      return { kind: "all-absent" };
    }
    return { kind: "invalid-npm-absent-metadata", present: presentMetadata };
  }

  const missing: ("immutable-tag" | "github-release")[] = [];
  if (!input.immutableTag) {
    missing.push("immutable-tag");
  }
  if (!input.githubRelease) {
    missing.push("github-release");
  }
  return { kind: "npm-present-recoverable", missing };
}

export function formatPreparationTrailers(binding: PreparationBinding): string {
  validatePreparationBinding(binding);
  return formatTrailers("preparation", binding);
}

export function formatCancellationTrailers(
  cancellation: PreparationBinding & { cancelTarget: string },
): string {
  requireSha(cancellation.cancelTarget, "cancel target SHA");
  validatePreparationBinding(cancellation);
  return [
    formatTrailers("cancellation", cancellation),
    `${RELEASE_TRAILERS.cancelTarget}: ${cancellation.cancelTarget.toLowerCase()}`,
  ].join("\n");
}

export function parseReleaseRecord(commit: CommitRecord): ReleaseRecord | null {
  const trailers = terminalTrailers(commit.message);
  const values = new Map<string, string>();
  for (const [key, value] of trailers) {
    if (!key.startsWith(RELEASE_TRAILER_PREFIX)) {
      continue;
    }
    if (!Object.hasOwn(KNOWN_RELEASE_TRAILERS, key)) {
      throw new Error(`unknown release trailer ${key}`);
    }
    if (values.has(key)) {
      throw new Error(`duplicate release trailer ${key}`);
    }
    values.set(key, value);
  }
  if (values.size === 0) {
    return null;
  }

  const recordKind = requiredTrailer(values, RELEASE_TRAILERS.record);
  if (recordKind !== "preparation" && recordKind !== "cancellation") {
    throw new Error(`invalid release record kind ${recordKind}`);
  }

  const pullRequestText = requiredTrailer(values, RELEASE_TRAILERS.pullRequest);
  if (!/^[1-9]\d*$/.test(pullRequestText)) {
    throw new Error(`invalid release pull request number ${pullRequestText}`);
  }
  const pullRequest = Number(pullRequestText);
  requirePositiveInteger(pullRequest, "release pull request number");

  const selectionText = requiredTrailer(values, RELEASE_TRAILERS.selection);
  if (!isPreparationSelection(selectionText)) {
    throw new Error(`invalid preparation selection ${selectionText}`);
  }

  const binding: PreparationBinding = {
    pullRequest,
    selection: selectionText,
    stableBaseline: requiredTrailer(values, RELEASE_TRAILERS.stableBaseline),
    targetVersion: requiredTrailer(values, RELEASE_TRAILERS.targetVersion),
    baseSha: requiredTrailer(values, RELEASE_TRAILERS.baseSha).toLowerCase(),
    sourceSha: requiredTrailer(values, RELEASE_TRAILERS.sourceSha).toLowerCase(),
  };
  validatePreparationBinding(binding);
  const commitSha = requireSha(commit.sha, "release record commit SHA");

  if (recordKind === "preparation") {
    if (values.has(RELEASE_TRAILERS.cancelTarget)) {
      throw new Error("preparation record must not have a cancel target");
    }
    return { kind: "preparation", commitSha, ...binding };
  }

  const cancelTarget = requireSha(
    requiredTrailer(values, RELEASE_TRAILERS.cancelTarget),
    "cancel target SHA",
  );
  return { kind: "cancellation", commitSha, cancelTarget, ...binding };
}

export function findLatestUncancelledPreparation(
  search: PendingPreparationSearch,
): PreparationRecord | null {
  requirePositiveInteger(search.pullRequest, "pull request number");
  const ownedShas = new Set(search.ownedCommitShas.map(sha => requireSha(sha, "owned commit SHA")));
  const indexedRecords: { index: number; record: ReleaseRecord }[] = [];
  const seenCommits = new Set<string>();

  for (const [index, commit] of search.commitsOldestFirst.entries()) {
    const commitSha = requireSha(commit.sha, "commit SHA");
    if (seenCommits.has(commitSha)) {
      throw new Error(`commit ${commitSha} appears more than once`);
    }
    seenCommits.add(commitSha);
    if (!ownedShas.has(commitSha)) {
      continue;
    }
    const record = parseReleaseRecord(commit);
    if (record) {
      indexedRecords.push({ index, record });
    }
  }

  for (let candidateIndex = indexedRecords.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const candidate = indexedRecords[candidateIndex];
    const preparation = candidate.record;
    if (
      preparation.kind !== "preparation"
      || preparation.pullRequest !== search.pullRequest
    ) {
      continue;
    }

    const cancelled = indexedRecords.some(entry =>
      entry.index > candidate.index
      && entry.record.kind === "cancellation"
      && entry.record.pullRequest === search.pullRequest
      && entry.record.cancelTarget === preparation.commitSha
      && samePreparationBinding(entry.record, preparation)
    );
    if (!cancelled) {
      return preparation;
    }
  }

  return null;
}

export function classifyMergedRelease(input: MergedReleaseInput): MergeClassification {
  if (input.mergeCommit.parents.length !== 2) {
    throw new Error("release merge commit must have exactly two parents");
  }

  const preparation = findLatestUncancelledPreparation({
    pullRequest: input.pullRequest,
    commitsOldestFirst: input.sourceSideCommitsOldestFirst,
    ownedCommitShas: input.sourceSideCommitsOldestFirst.map(commit => commit.sha),
  });
  if (!preparation) {
    return { kind: "no-release" };
  }

  const mergeBaseParent = requireSha(input.mergeCommit.parents[0], "merge base parent SHA");
  const mergeSourceParent = requireSha(input.mergeCommit.parents[1], "merge source parent SHA");
  if (!sameSha(preparation.baseSha, mergeBaseParent)) {
    throw new Error("release preparation base SHA does not match the merge first parent");
  }
  if (!sameSha(preparation.commitSha, mergeSourceParent)) {
    throw new Error("release preparation commit must be the merge second parent");
  }

  let preparationCommit: CommitRecord | null = null;
  for (const commit of input.sourceSideCommitsOldestFirst) {
    if (sameSha(commit.sha, preparation.commitSha)) {
      preparationCommit = commit;
      break;
    }
  }
  if (preparationCommit === null) {
    throw new Error("release preparation commit is missing from the source-side range");
  }
  if (preparationCommit.parents.length !== 1) {
    throw new Error("release preparation commit must have a single parent");
  }
  if (!sameSha(preparationCommit.parents[0], preparation.sourceSha)) {
    throw new Error("release preparation commit parent does not match its recorded source SHA");
  }

  if (preparation.selection.startsWith("release:preview-")) {
    return { kind: "preview", preparation };
  }
  return { kind: "latest", preparation };
}

function parseSafeVersionNumber(value: string, version: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${version} is not a strict release version with safe numeric fields`);
  }
  return parsed;
}

function requireStableVersion(version: string): StableVersion {
  const parsed = parseStrictVersion(version);
  if ("preview" in parsed) {
    throw new Error(`${version} must be a stable version`);
  }
  return parsed;
}

function requirePreviewVersion(version: string, label: string): PreviewVersion {
  let parsed: StrictVersion;
  try {
    parsed = parseStrictVersion(version);
  } catch {
    throw new Error(`promotion ${label} must be a strict preview version`);
  }
  if (!("preview" in parsed)) {
    throw new Error(`promotion ${label} must be a preview version`);
  }
  return parsed;
}

function formatStableVersion(major: number, minor: number, patch: number): string {
  return `${major}.${minor}.${patch}`;
}

function increment(value: number, version: string): number {
  if (value === Number.MAX_SAFE_INTEGER) {
    throw new Error(`cannot increment version field in ${version}`);
  }
  return value + 1;
}

function bumpForSelection(selection: BumpReleaseSelection): StableBump {
  if (selection.endsWith("patch")) {
    return "patch";
  }
  if (selection.endsWith("minor")) {
    return "minor";
  }
  return "major";
}

function parseStoreVersion(reference: string): StrictVersion | null {
  const version = reference.startsWith("v") ? reference.slice(1) : reference;
  try {
    return parseStrictVersion(version);
  } catch {
    return null;
  }
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function requireSha(value: string, label: string): string {
  if (!SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a full hexadecimal SHA`);
  }
  return value.toLowerCase();
}

function sameSha(left: string, right: string): boolean {
  return SHA_PATTERN.test(left)
    && SHA_PATTERN.test(right)
    && left.toLowerCase() === right.toLowerCase();
}

function validatePreparationBinding(binding: PreparationBinding): void {
  requirePositiveInteger(binding.pullRequest, "release pull request number");
  if (!isPreparationSelection(binding.selection)) {
    throw new Error(`${binding.selection} cannot own a release preparation`);
  }
  const baseline = requireStableVersion(binding.stableBaseline);
  const target = parseStrictVersion(binding.targetVersion);
  requireSha(binding.baseSha, "release base SHA");
  requireSha(binding.sourceSha, "release source SHA");

  if (binding.selection === "release:promote") {
    if ("preview" in target) {
      throw new Error("release:promote preparation target must be stable");
    }
    const patchTarget = target.major === baseline.major
      && target.minor === baseline.minor
      && baseline.patch < Number.MAX_SAFE_INTEGER
      && target.patch === baseline.patch + 1;
    const minorTarget = target.major === baseline.major
      && baseline.minor < Number.MAX_SAFE_INTEGER
      && target.minor === baseline.minor + 1
      && target.patch === 0;
    const majorTarget = baseline.major < Number.MAX_SAFE_INTEGER
      && target.major === baseline.major + 1
      && target.minor === 0
      && target.patch === 0;
    if (!patchTarget && !minorTarget && !majorTarget) {
      throw new Error(
        "release:promote target must be the next patch, minor, or major from the stable baseline",
      );
    }
    return;
  }

  const expectedStableTarget = calculateStableTarget(
    binding.stableBaseline,
    binding.stableBaseline,
    binding.selection,
  );
  const actualStableTarget = formatStableVersion(target.major, target.minor, target.patch);
  if (actualStableTarget !== expectedStableTarget) {
    throw new Error(
      `${binding.targetVersion} does not match ${binding.selection} from ${binding.stableBaseline}`,
    );
  }

  const previewSelection = binding.selection.startsWith("release:preview-");
  if (previewSelection !== ("preview" in target)) {
    throw new Error(`${binding.targetVersion} has the wrong channel for ${binding.selection}`);
  }
}

function formatTrailers(
  kind: "preparation" | "cancellation",
  binding: PreparationBinding,
): string {
  return [
    `${RELEASE_TRAILERS.record}: ${kind}`,
    `${RELEASE_TRAILERS.pullRequest}: ${binding.pullRequest}`,
    `${RELEASE_TRAILERS.selection}: ${binding.selection}`,
    `${RELEASE_TRAILERS.stableBaseline}: ${binding.stableBaseline}`,
    `${RELEASE_TRAILERS.targetVersion}: ${binding.targetVersion}`,
    `${RELEASE_TRAILERS.baseSha}: ${binding.baseSha.toLowerCase()}`,
    `${RELEASE_TRAILERS.sourceSha}: ${binding.sourceSha.toLowerCase()}`,
  ].join("\n");
}

function terminalTrailers(message: string): [string, string][] {
  const lines = message.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const trailers: [string, string][] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(lines[index]);
    if (!match) {
      break;
    }
    trailers.unshift([match[1], match[2]]);
  }
  return trailers;
}

function requiredTrailer(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) {
    throw new Error(`missing release trailer ${key}`);
  }
  return value;
}

function samePreparationBinding(
  left: PreparationBinding,
  right: PreparationBinding,
): boolean {
  return left.pullRequest === right.pullRequest
    && left.selection === right.selection
    && left.stableBaseline === right.stableBaseline
    && left.targetVersion === right.targetVersion
    && sameSha(left.baseSha, right.baseSha)
    && sameSha(left.sourceSha, right.sourceSha);
}

function isReleaseSelection(value: string): value is ReleaseSelection {
  return RELEASE_SELECTION_LABELS.includes(value as ReleaseSelection);
}

function isPreparationSelection(value: string): value is PreparationSelection {
  return isReleaseSelection(value) && value !== "release:none";
}
