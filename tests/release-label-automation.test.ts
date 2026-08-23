import { describe, expect, test } from "bun:test";
import {
  RELEASE_SELECTION_LABELS,
  allocatePreviewVersion,
  assertSoleSelectedPullRequest,
  bumpStableVersion,
  calculatePromotionTarget,
  calculateStableTarget,
  classifyMergedRelease,
  classifyStableTargetOccupancy,
  findLatestUncancelledPreparation,
  formatCancellationTrailers,
  formatPreparationTrailers,
  parseReleaseRecord,
  parseStrictVersion,
  replacePackageVersion,
  requireSingleReleaseSelection,
  validatePullRequestSelection,
  type CommitRecord,
  type PreparationBinding,
  type PromotionState,
  type StableTargetOccupancyInput,
} from "../scripts/release-policy";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const SHA_E = "e".repeat(40);
const DIGEST = `sha512-${"A".repeat(32)}`;

interface ReleaseWorkflow {
  on: {
    workflow_dispatch: {
      inputs: Record<string, {
        description?: string;
        required?: boolean;
        type?: string;
        default?: string | boolean;
        options?: string[];
      }>;
    };
  };
  "run-name": string;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, {
    if?: string;
    needs?: string | string[];
    permissions?: Record<string, string>;
    env?: Record<string, string>;
    outputs?: Record<string, string>;
    steps: Array<{
      name?: string;
      id?: string;
      if?: string;
      uses?: string;
      with?: Record<string, unknown>;
      env?: Record<string, string>;
      run?: string;
    }>;
  }>;
}

const repositoryRoot = new URL("../", import.meta.url);

async function readReleaseWorkflow(): Promise<{ parsed: ReleaseWorkflow; source: string }> {
  const source = await Bun.file(new URL(".github/workflows/release.yml", repositoryRoot)).text();
  return {
    parsed: Bun.YAML.parse(source) as ReleaseWorkflow,
    source,
  };
}

const previewBinding: PreparationBinding = {
  pullRequest: 41,
  selection: "release:preview-minor",
  stableBaseline: "1.2.3",
  targetVersion: "1.3.0-preview.4",
  baseSha: SHA_A,
  sourceSha: SHA_B,
};

function commit(sha: string, message: string, parents: readonly string[] = [SHA_A]): CommitRecord {
  return { sha, message, parents };
}

function preparationCommit(
  sha: string,
  binding: PreparationBinding = previewBinding,
): CommitRecord {
  return commit(sha, `Prepare release\n\n${formatPreparationTrailers(binding)}`, [binding.sourceSha]);
}

function cancellationCommit(
  sha: string,
  cancelTarget: string,
  binding: PreparationBinding = previewBinding,
): CommitRecord {
  return commit(
    sha,
    `Cancel release preparation\n\n${formatCancellationTrailers({ ...binding, cancelTarget })}`,
  );
}

function promotionState(overrides: Partial<PromotionState> = {}): PromotionState {
  return {
    registryPreview: {
      version: "1.3.0-preview.4",
      sourceSha: SHA_B,
    },
    previewDistTag: "1.3.0-preview.4",
    immutableTag: {
      version: "1.3.0-preview.4",
      sourceSha: SHA_B,
    },
    githubPrerelease: {
      version: "1.3.0-preview.4",
      sourceSha: SHA_B,
      prerelease: true,
    },
    developSha: SHA_B,
    ...overrides,
  };
}

function occupancyInput(
  overrides: Partial<StableTargetOccupancyInput> = {},
): StableTargetOccupancyInput {
  return {
    expected: {
      version: "1.3.0",
      sourceSha: SHA_C,
      packageDigest: DIGEST,
    },
    npmVersion: null,
    immutableTag: null,
    githubRelease: null,
    ...overrides,
  };
}

describe("strict release versions", () => {
  test("parses only stable versions and positive preview numbers without leading zeroes", () => {
    expect(parseStrictVersion("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(parseStrictVersion("12.34.56-preview.7")).toEqual({
      major: 12,
      minor: 34,
      patch: 56,
      preview: 7,
    });

    for (const invalid of [
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2",
      "1.2.3-preview.0",
      "1.2.3-preview.01",
      "1.2.3-alpha.1",
      "1.2.3+build.1",
      "v1.2.3",
      " 1.2.3",
      `${Number.MAX_SAFE_INTEGER + 1}.0.0`,
    ]) {
      expect(() => parseStrictVersion(invalid)).toThrow("strict release version");
    }
  });

  test("bumps only a stable version", () => {
    expect(bumpStableVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpStableVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpStableVersion("1.2.3", "major")).toBe("2.0.0");
    expect(() => bumpStableVersion("1.2.3-preview.1", "patch")).toThrow(
      "stable version",
    );
  });

  test("calculates stable and preview targets only from an agreeing stable baseline", () => {
    expect(calculateStableTarget("1.2.3", "1.2.3", "release:patch")).toBe("1.2.4");
    expect(calculateStableTarget("1.2.3", "1.2.3", "release:preview-minor")).toBe(
      "1.3.0",
    );
    expect(calculateStableTarget("1.2.3", "1.2.3", "release:major")).toBe("2.0.0");
    expect(() => calculateStableTarget("1.2.3", "1.2.2", "release:patch")).toThrow(
      "stable baseline",
    );
    expect(() => calculateStableTarget("1.2.3-preview.2", "1.2.3", "release:patch")).toThrow(
      "stable version",
    );
  });

  test("direct stable selection is independent of abandoned preview versions", () => {
    expect(calculateStableTarget("1.2.3", "1.2.3", "release:minor")).toBe("1.3.0");
  });

  test("allocates the smallest preview number absent from npm, tags, and releases", () => {
    expect(allocatePreviewVersion("1.3.0", {
      npmVersions: ["1.3.0-preview.1", "1.3.0-preview.5"],
      gitTags: ["v1.3.0-preview.2", "v9.9.9"],
      githubReleases: ["v1.3.0-preview.3"],
    })).toBe("1.3.0-preview.4");
  });

  test("returning to an old preview target skips all numbers consumed for that target", () => {
    expect(allocatePreviewVersion("1.2.4", {
      npmVersions: ["1.2.4-preview.1", "1.3.0-preview.8"],
      gitTags: ["v1.2.4-preview.2", "v2.0.0-preview.1"],
      githubReleases: ["v1.2.4-preview.3", "v1.3.0-preview.9"],
    })).toBe("1.2.4-preview.4");
  });

  test("replaces only the top-level package version while preserving exact formatting", () => {
    const before = '{\n  "name": "frogprogsy",\n  "version": "1.2.3",\n  "private": false\n}\n';
    const after = replacePackageVersion(before, "1.3.0-preview.1");

    expect(after).toBe(
      '{\n  "name": "frogprogsy",\n  "version": "1.3.0-preview.1",\n  "private": false\n}\n',
    );
    expect(() => replacePackageVersion('{"name":"frogprogsy"}', "1.2.4")).toThrow(
      "string version field",
    );
    expect(() => replacePackageVersion('{"version":"1.2.3"}', "1.2.4-alpha.1")).toThrow(
      "strict release version",
    );
  });
});

describe("label, branch, and repository ownership policy", () => {
  test("recognizes exactly the eight selection labels and excludes release:ready", () => {
    expect(RELEASE_SELECTION_LABELS).toEqual([
      "release:none",
      "release:patch",
      "release:minor",
      "release:major",
      "release:preview-patch",
      "release:preview-minor",
      "release:preview-major",
      "release:promote",
    ]);
    expect(requireSingleReleaseSelection(["documentation", "release:ready", "release:patch"])).toBe(
      "release:patch",
    );
    expect(() => requireSingleReleaseSelection(["release:ready"])).toThrow(
      "exactly one release selection label",
    );
    expect(() => requireSingleReleaseSelection(["release:patch", "release:minor"])).toThrow(
      "exactly one release selection label",
    );
  });

  test("allows stable and promotion selections only from develop to main", () => {
    for (const selection of [
      "release:patch",
      "release:minor",
      "release:major",
      "release:promote",
    ] as const) {
      expect(() => validatePullRequestSelection({
        selection,
        repository: "owner/frogprogsy",
        headRepository: "owner/frogprogsy",
        headBranch: "develop",
        baseBranch: "main",
      })).not.toThrow();
      expect(() => validatePullRequestSelection({
        selection,
        repository: "owner/frogprogsy",
        headRepository: "owner/frogprogsy",
        headBranch: "topic",
        baseBranch: "main",
      })).toThrow("develop to main");
    }
  });

  test("allows previews only from a same-repository branch to develop", () => {
    expect(() => validatePullRequestSelection({
      selection: "release:preview-patch",
      repository: "Owner/Frogprogsy",
      headRepository: "owner/frogprogsy",
      headBranch: "feature/a",
      baseBranch: "develop",
    })).not.toThrow();
    expect(() => validatePullRequestSelection({
      selection: "release:preview-minor",
      repository: "owner/frogprogsy",
      headRepository: "fork/frogprogsy",
      headBranch: "feature/a",
      baseBranch: "develop",
    })).toThrow("same repository");
    expect(() => validatePullRequestSelection({
      selection: "release:preview-major",
      repository: "owner/frogprogsy",
      headRepository: "owner/frogprogsy",
      headBranch: "feature/a",
      baseBranch: "main",
    })).toThrow("target develop");
  });

  test("allows release:none on either supported base without granting a preparation slot", () => {
    for (const baseBranch of ["develop", "main"] as const) {
      expect(() => validatePullRequestSelection({
        selection: "release:none",
        repository: "owner/frogprogsy",
        headRepository: "fork/frogprogsy",
        headBranch: "topic",
        baseBranch,
      })).not.toThrow();
    }
    expect(() => validatePullRequestSelection({
      selection: "release:none",
      repository: "owner/frogprogsy",
      headRepository: "owner/frogprogsy",
      headBranch: "topic",
      baseBranch: "maintenance",
    })).toThrow("supported base branch");
  });

  test("requires the current PR to be the repository-wide sole non-none selection owner", () => {
    const openPullRequests = [
      { number: 10, labels: ["release:none"] },
      { number: 11, labels: ["release:ready", "release:preview-patch"] },
      { number: 12, labels: ["documentation"] },
    ];
    expect(() => assertSoleSelectedPullRequest(11, openPullRequests)).not.toThrow();
    expect(() => assertSoleSelectedPullRequest(10, openPullRequests)).toThrow(
      "owned by pull request #11",
    );
    expect(() => assertSoleSelectedPullRequest(11, [
      ...openPullRequests,
      { number: 13, labels: ["release:major"] },
    ])).toThrow("multiple pull requests");
    expect(() => assertSoleSelectedPullRequest(11, [
      { number: 11, labels: ["release:preview-patch", "release:minor"] },
    ])).toThrow("exactly one release selection label");
  });
});

describe("promotion and stable-target recovery", () => {
  test("promotes only one fully converged preview at the current develop SHA", () => {
    expect(calculatePromotionTarget(promotionState())).toBe("1.3.0");
  });

  test("rejects every promotion disagreement", () => {
    const disagreements: PromotionState[] = [
      promotionState({ previewDistTag: "1.3.0-preview.3" }),
      promotionState({
        immutableTag: { version: "1.3.0-preview.3", sourceSha: SHA_B },
      }),
      promotionState({
        immutableTag: { version: "1.3.0-preview.4", sourceSha: SHA_C },
      }),
      promotionState({
        githubPrerelease: {
          version: "1.3.0-preview.3",
          sourceSha: SHA_B,
          prerelease: true,
        },
      }),
      promotionState({
        githubPrerelease: {
          version: "1.3.0-preview.4",
          sourceSha: SHA_C,
          prerelease: true,
        },
      }),
      promotionState({
        githubPrerelease: {
          version: "1.3.0-preview.4",
          sourceSha: SHA_B,
          prerelease: false,
        },
      }),
      promotionState({ registryPreview: { version: "1.3.0-preview.4", sourceSha: SHA_C } }),
      promotionState({ developSha: SHA_C }),
      promotionState({ registryPreview: { version: "1.3.0", sourceSha: SHA_B } }),
    ];

    for (const state of disagreements) {
      expect(() => calculatePromotionTarget(state)).toThrow("promotion");
    }
  });

  test("allows promotion preparation only to the next patch, minor, or major target", () => {
    for (const targetVersion of ["1.2.4", "1.3.0", "2.0.0"]) {
      expect(() => formatPreparationTrailers({
        ...previewBinding,
        selection: "release:promote",
        targetVersion,
      })).not.toThrow();
    }

    for (const targetVersion of ["1.2.3", "1.4.0", "3.0.0"]) {
      expect(() => formatPreparationTrailers({
        ...previewBinding,
        selection: "release:promote",
        targetVersion,
      })).toThrow("next patch, minor, or major");
    }

    const maximum = Number.MAX_SAFE_INTEGER;
    expect(() => formatPreparationTrailers({
      ...previewBinding,
      selection: "release:promote",
      stableBaseline: `${maximum}.${maximum}.3`,
      targetVersion: `${maximum}.${maximum}.4`,
    })).not.toThrow();
  });

  test("classifies a completely unused stable target", () => {
    expect(classifyStableTargetOccupancy(occupancyInput())).toEqual({ kind: "all-absent" });
  });

  test("classifies matching npm provenance with complete or missing immutable metadata", () => {
    const npmVersion = {
      version: "1.3.0",
      sourceSha: SHA_C,
      channel: "latest" as const,
      packageDigest: DIGEST,
    };
    const immutableTag = { version: "1.3.0", sourceSha: SHA_C };
    const githubRelease = { version: "1.3.0", sourceSha: SHA_C, prerelease: false };

    expect(classifyStableTargetOccupancy(occupancyInput({
      npmVersion,
      immutableTag,
      githubRelease,
    }))).toEqual({ kind: "npm-present-recoverable", missing: [] });
    expect(classifyStableTargetOccupancy(occupancyInput({ npmVersion }))).toEqual({
      kind: "npm-present-recoverable",
      missing: ["immutable-tag", "github-release"],
    });
  });

  test("blocks npm-absent immutable metadata even when it points at the expected release", () => {
    expect(classifyStableTargetOccupancy(occupancyInput({
      immutableTag: { version: "1.3.0", sourceSha: SHA_C },
    }))).toEqual({
      kind: "invalid-npm-absent-metadata",
      present: ["immutable-tag"],
    });
  });

  test("classifies any mismatched version, SHA, channel, digest, or release kind as conflict", () => {
    const conflictingInputs: StableTargetOccupancyInput[] = [
      occupancyInput({
        npmVersion: {
          version: "1.3.1",
          sourceSha: SHA_C,
          channel: "latest",
          packageDigest: DIGEST,
        },
      }),
      occupancyInput({
        npmVersion: {
          version: "1.3.0",
          sourceSha: SHA_D,
          channel: "latest",
          packageDigest: DIGEST,
        },
      }),
      occupancyInput({
        npmVersion: {
          version: "1.3.0",
          sourceSha: SHA_C,
          channel: "preview",
          packageDigest: DIGEST,
        },
      }),
      occupancyInput({
        npmVersion: {
          version: "1.3.0",
          sourceSha: SHA_C,
          channel: "latest",
          packageDigest: "sha512-different",
        },
      }),
      occupancyInput({ immutableTag: { version: "1.3.0", sourceSha: SHA_D } }),
      occupancyInput({
        githubRelease: { version: "1.3.0", sourceSha: SHA_C, prerelease: true },
      }),
      occupancyInput({
        githubRelease: {
          version: "1.3.0",
          sourceSha: SHA_C,
          prerelease: false,
          packageDigest: "sha512-different",
        },
      }),
    ];

    for (const input of conflictingInputs) {
      expect(classifyStableTargetOccupancy(input).kind).toBe("conflict");
    }
  });
});

describe("immutable preparation evidence", () => {
  test("formats and parses complete preparation trailers", () => {
    const parsed = parseReleaseRecord(preparationCommit(SHA_C));
    expect(parsed).toEqual({
      kind: "preparation",
      commitSha: SHA_C,
      ...previewBinding,
    });
    expect(formatPreparationTrailers(previewBinding).split("\n")).toEqual([
      "Frogprogsy-Release-Record: preparation",
      "Frogprogsy-Release-PR: 41",
      "Frogprogsy-Release-Selection: release:preview-minor",
      "Frogprogsy-Release-Baseline: 1.2.3",
      "Frogprogsy-Release-Version: 1.3.0-preview.4",
      `Frogprogsy-Release-Base-SHA: ${SHA_A}`,
      `Frogprogsy-Release-Source-SHA: ${SHA_B}`,
    ]);
  });

  test("formats and parses a cancellation bound to the exact preparation", () => {
    expect(parseReleaseRecord(cancellationCommit(SHA_D, SHA_C))).toEqual({
      kind: "cancellation",
      commitSha: SHA_D,
      cancelTarget: SHA_C,
      ...previewBinding,
    });
  });

  test("returns null for ordinary commits and rejects malformed release trailer blocks", () => {
    expect(parseReleaseRecord(commit(SHA_C, "Ordinary change"))).toBeNull();
    expect(() => parseReleaseRecord(commit(
      SHA_C,
      `Broken\n\n${formatPreparationTrailers(previewBinding)}\nFrogprogsy-Release-PR: 42`,
    ))).toThrow("duplicate release trailer");
    expect(() => parseReleaseRecord(commit(
      SHA_C,
      "Broken\n\nFrogprogsy-Release-Record: preparation\nFrogprogsy-Release-PR: 41",
    ))).toThrow("missing release trailer");
  });

  test("finds only the current PR's latest uncancelled preparation in its owned range", () => {
    const ancestorForSamePr = preparationCommit(SHA_C, {
      ...previewBinding,
      targetVersion: "1.3.0-preview.3",
    });
    const otherPr = preparationCommit(SHA_D, {
      ...previewBinding,
      pullRequest: 99,
    });
    const current = preparationCommit(SHA_E);
    const commitsOldestFirst = [ancestorForSamePr, otherPr, current];

    expect(findLatestUncancelledPreparation({
      pullRequest: 41,
      commitsOldestFirst,
      ownedCommitShas: [SHA_D, SHA_E],
    })).toEqual({ kind: "preparation", commitSha: SHA_E, ...previewBinding });
  });

  test("a later matching cancellation removes only its named preparation", () => {
    const preparation = preparationCommit(SHA_C);
    const cancellation = cancellationCommit(SHA_D, SHA_C);
    expect(findLatestUncancelledPreparation({
      pullRequest: 41,
      commitsOldestFirst: [preparation, cancellation],
      ownedCommitShas: [SHA_C, SHA_D],
    })).toBeNull();

    const cancellationForOtherPr = cancellationCommit(SHA_E, SHA_C, {
      ...previewBinding,
      pullRequest: 99,
    });
    expect(findLatestUncancelledPreparation({
      pullRequest: 41,
      commitsOldestFirst: [preparation, cancellationForOtherPr],
      ownedCommitShas: [SHA_C, SHA_E],
    })).toEqual({ kind: "preparation", commitSha: SHA_C, ...previewBinding });
  });

  test("classifies a two-parent merge only when its parents match the preparation", () => {
    const previewPreparation = preparationCommit(SHA_C);
    const previewMerge = commit("f".repeat(40), "Merge pull request #41", [SHA_A, SHA_C]);
    expect(classifyMergedRelease({
      pullRequest: 41,
      mergeCommit: previewMerge,
      sourceSideCommitsOldestFirst: [previewPreparation],
    })).toEqual({
      kind: "preview",
      preparation: { kind: "preparation", commitSha: SHA_C, ...previewBinding },
    });

    const stableBinding: PreparationBinding = {
      ...previewBinding,
      selection: "release:minor",
      targetVersion: "1.3.0",
    };
    const stablePreparation = preparationCommit(SHA_D, stableBinding);
    const stableMerge = commit("f".repeat(40), "Merge pull request #41", [SHA_A, SHA_D]);
    expect(classifyMergedRelease({
      pullRequest: 41,
      mergeCommit: stableMerge,
      sourceSideCommitsOldestFirst: [stablePreparation],
    }).kind).toBe("latest");

    expect(classifyMergedRelease({
      pullRequest: 41,
      mergeCommit: stableMerge,
      sourceSideCommitsOldestFirst: [
        previewPreparation,
        cancellationCommit(SHA_D, SHA_C),
      ],
    })).toEqual({ kind: "no-release" });
  });

  test("rejects a moved base, an added source commit, or a preparation with the wrong parent", () => {
    const preparation = preparationCommit(SHA_C);
    expect(() => classifyMergedRelease({
      pullRequest: 41,
      mergeCommit: commit("f".repeat(40), "Merge pull request #41", [SHA_E, SHA_C]),
      sourceSideCommitsOldestFirst: [preparation],
    })).toThrow("base SHA");

    expect(() => classifyMergedRelease({
      pullRequest: 41,
      mergeCommit: commit("f".repeat(40), "Merge pull request #41", [SHA_A, SHA_D]),
      sourceSideCommitsOldestFirst: [
        preparation,
        commit(SHA_D, "Change after preparation", [SHA_C]),
      ],
    })).toThrow("second parent");

    expect(() => classifyMergedRelease({
      pullRequest: 41,
      mergeCommit: commit("f".repeat(40), "Merge pull request #41", [SHA_A, SHA_C]),
      sourceSideCommitsOldestFirst: [{
        ...preparation,
        parents: [SHA_D],
      }],
    })).toThrow("recorded source SHA");

    expect(() => classifyMergedRelease({
      pullRequest: 41,
      mergeCommit: commit("f".repeat(40), "Merge pull request #41", [SHA_A, SHA_C]),
      sourceSideCommitsOldestFirst: [{
        ...preparation,
        parents: [SHA_B, SHA_D],
      }],
    })).toThrow("single parent");
  });

  test("rejects release classification for a merge without exactly two parents", () => {
    expect(() => classifyMergedRelease({
      pullRequest: 41,
      mergeCommit: commit(SHA_E, "Squashed", [SHA_A]),
      sourceSideCommitsOldestFirst: [preparationCommit(SHA_C)],
    })).toThrow("exactly two parents");
  });

  test("treats an ordinary two-parent merge without an owned preparation as a no-op", () => {
    expect(classifyMergedRelease({
      pullRequest: 41,
      mergeCommit: commit(SHA_E, "Merge pull request #41", [SHA_A, SHA_C]),
      sourceSideCommitsOldestFirst: [commit(SHA_C, "Ordinary source change", [SHA_B])],
    })).toEqual({ kind: "no-release" });
  });

  test("maps a promotion preparation to the stable publication channel", () => {
    const promotionBinding: PreparationBinding = {
      ...previewBinding,
      selection: "release:promote",
      targetVersion: "1.3.0",
    };
    const preparation = preparationCommit(SHA_C, promotionBinding);

    expect(classifyMergedRelease({
      pullRequest: 41,
      mergeCommit: commit(SHA_E, "Merge pull request #41", [SHA_A, SHA_C]),
      sourceSideCommitsOldestFirst: [preparation],
    })).toEqual({
      kind: "latest",
      preparation: { kind: "preparation", commitSha: SHA_C, ...promotionBinding },
    });
  });
});

describe("immutable channel release workflow", () => {
  test("parses YAML and exposes the exact dispatcher input contract", async () => {
    const { parsed } = await readReleaseWorkflow();

    expect(parsed.on.workflow_dispatch.inputs).toEqual({
      version: {
        description: "Prepared version to publish",
        required: true,
        type: "string",
      },
      "expected-sha": {
        description: "Full lowercase prepared merge commit SHA",
        required: true,
        type: "string",
      },
      "source-branch": {
        description: "Remote branch containing the prepared merge commit",
        required: true,
        type: "choice",
        options: ["develop", "main"],
      },
      tag: {
        description: "Registry dist-tag derived from preparation evidence",
        required: true,
        type: "choice",
        options: ["latest", "preview"],
      },
      "dry-run": {
        description: "Validate and build without publishing",
        required: true,
        type: "boolean",
        default: true,
      },
      bootstrap: {
        description: "One-time first package publish with NPM_BOOTSTRAP_TOKEN",
        required: true,
        type: "boolean",
        default: false,
      },
      recovery: {
        description: "Recover an immutable previously prepared release",
        required: true,
        type: "boolean",
        default: false,
      },
      "dispatch-id": {
        description: "Optional correlation ID for a manual dispatcher",
        required: false,
        type: "string",
        default: "",
      },
    });
    expect(parsed["run-name"]).toBe("Release [${{ inputs.dispatch-id }}]");
    expect(parsed.permissions).toEqual({});
    expect(parsed.concurrency).toEqual({
      group: "release",
      "cancel-in-progress": false,
    });
  });

  test("keeps exact-SHA policy and gate binding in a trusted source-free preflight", async () => {
    const { parsed } = await readReleaseWorkflow();
    const preflight = parsed.jobs.preflight;
    const build = parsed.jobs.build;
    const dispatch = preflight.steps.find(step => step.name === "Verify dispatch identity and exact SHA containment");
    const evidence = preflight.steps.find(step => step.name === "Reclassify immutable preparation evidence");
    const checkout = build.steps.find(step => step.name === "Checkout exact prepared SHA");
    const preflightText = preflight.steps.map(step => `${step.uses ?? ""}\n${step.run ?? ""}`).join("\n");
    const evidenceScript = evidence?.run ?? "";

    expect(preflight.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "read",
    });
    expect(preflightText).not.toContain("actions/checkout@");
    expect(preflightText).not.toContain("bun install");
    expect(preflightText).not.toContain("prepublishOnly");
    expect(dispatch?.env).toMatchObject({
      TRUSTED_WORKFLOW_REF: "${{ github.workflow_ref }}",
      TRUSTED_WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(dispatch?.run).toContain('Release must use the trusted main workflow definition');
    expect(dispatch?.run).toContain('compare/${EXPECTED_SHA}...${SOURCE_BRANCH}');
    expect(dispatch?.run).toContain('compare/${TRUSTED_WORKFLOW_SHA}...main');
    expect(dispatch?.run).toContain('contents/package.json?ref=${EXPECTED_SHA}');
    expect(dispatch?.run).toContain('artifact_name=release-${EXPECTED_SHA}-${RUN_ID}-${RUN_ATTEMPT}');
    expect(dispatch?.run).toContain('pkg.name !== "frogprogsy"');
    expect(checkout?.with).toEqual({
      ref: "${{ inputs.expected-sha }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
    expect(evidenceScript).toContain('repos/${REPOSITORY}/commits/${EXPECTED_SHA}');
    expect(evidenceScript).toContain('compare/${merge_parents[0]}...${merge_parents[1]}');
    expect(evidenceScript).toContain('.commit.verification.verified == true');
    expect(evidenceScript).toContain('commit.authorLogin === "github-actions[bot]"');
    expect(evidenceScript).toContain('commit.committerLogin === "web-flow"');
    expect(evidenceScript).toContain('commit.changedPaths[0] === "package.json"');
    expect(evidenceScript).toContain('contents/scripts/release-policy.ts?ref=${TRUSTED_WORKFLOW_SHA}');
    expect(evidenceScript).toContain("parseReleaseRecord");
    expect(evidenceScript).toContain("classifyMergedRelease");
    expect(evidence?.if).toBe("${{ inputs.bootstrap != true }}");
    expect(evidenceScript).not.toContain(".labels");
  });

  test("isolates selected-source build outputs behind an untrusted artifact", async () => {
    const { parsed, source } = await readReleaseWorkflow();
    const build = parsed.jobs.build;
    const inspect = parsed.jobs.inspect;
    const buildText = build.steps.map(step => `${step.uses ?? ""}\n${step.run ?? ""}`).join("\n");
    const inspectText = inspect.steps.map(step => `${step.uses ?? ""}\n${step.run ?? ""}`).join("\n");
    const upload = build.steps.find(step => step.name === "Upload untrusted build artifact under preflight-fixed name");
    const download = inspect.steps.find(step => step.name === "Download preflight-named artifact");
    const artifact = inspect.steps.find(step => step.name === "Inspect exact artifact bytes and package identity");

    expect(build.needs).toBe("preflight");
    expect(build.permissions).toEqual({ actions: "read", contents: "read" });
    expect(build.outputs).toBeUndefined();
    expect(buildText).toContain("actions/checkout@");
    expect(buildText).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(buildText).toContain("bun run prepublishOnly");
    expect(inspect.env).toEqual({ PACKAGE_NAME: "frogprogsy" });
    expect(buildText).toContain("bun scripts/dev-package.ts build --skip-gates");
    expect(buildText).not.toContain("GITHUB_OUTPUT");
    expect(buildText).not.toContain("secrets.NPM_BOOTSTRAP_TOKEN");
    expect(upload?.with?.name).toBe("${{ needs.preflight.outputs.artifact_name }}");
    expect(inspect.needs).toEqual(["preflight", "build"]);
    expect(inspect.permissions).toEqual({ actions: "read", contents: "read" });
    expect(inspectText).not.toContain("actions/checkout@");
    expect(inspectText).not.toContain("bun install");
    expect(inspectText).not.toContain("prepublishOnly");
    expect(download?.with?.name).toBe("${{ needs.preflight.outputs.artifact_name }}");
    expect(artifact?.run).toContain('catalog.sourceCommit !== process.env.EXPECTED_SHA');
    expect(artifact?.run).toContain('catalog.catalogDigest !== catalogDigest');
    expect(artifact?.run).toContain("packageCatalog.catalogRevision !== pagesCatalog.catalogRevision");
    expect(artifact?.run).toContain("packageCatalog.catalogDigest !== pagesCatalog.catalogDigest");
    expect(source.split("bun scripts/dev-package.ts build --skip-gates")).toHaveLength(2);
  });

  test("gives write and OIDC only to the source-free mutation job and rejects substitution", async () => {
    const { parsed } = await readReleaseWorkflow();
    const mutate = parsed.jobs.mutate;
    const mutationText = mutate.steps.map(step => `${step.uses ?? ""}\n${step.run ?? ""}`).join("\n");
    const download = mutate.steps.find(step => step.name === "Download preflight-named artifact again");
    const verify = mutate.steps.find(step => step.name === "Reverify exact artifact bytes and identity");
    const publish = mutate.steps.find(step => step.name === "Publish exact inspected tarball");

    expect(mutate.needs).toEqual(["preflight", "inspect"]);
    expect(mutate.if).toBe("${{ inputs.dry-run != true }}");
    expect(mutate.permissions).toEqual({
      actions: "read",
      contents: "write",
      "id-token": "write",
    });
    expect(mutate.env).toEqual({ PACKAGE_NAME: "frogprogsy" });
    expect(verify?.env?.EXPECTED_PACKAGE_NAME).toBe("${{ env.PACKAGE_NAME }}");
    expect(mutationText).not.toContain("actions/checkout@");
    expect(mutationText).not.toContain("bun install");
    expect(mutationText).not.toContain("prepublishOnly");
    expect(mutationText).not.toContain("dev-package.ts build");
    expect(download?.with?.name).toBe("${{ needs.preflight.outputs.artifact_name }}");
    expect(verify?.run).toContain('actual_sha1="$(sha1sum "$TARBALL"');
    expect(verify?.run).toContain('actual_sha256="$(sha256sum "$TARBALL"');
    expect(verify?.run).toContain('actual_sha512_hex="$(sha512sum "$TARBALL"');
    expect(verify?.run).toContain('test "sha512-${actual_sha512_base64}" = "$EXPECTED_INTEGRITY"');
    expect(verify?.run).toContain("catalog.catalogDigest !== digest");
    expect(mutationText).toContain('npm publish "$TARBALL" --tag "$REGISTRY_DIST_TAG" --access public --provenance --ignore-scripts');
    expect(publish?.env?.NODE_AUTH_TOKEN).toBe("${{ inputs.bootstrap && secrets.NPM_BOOTSTRAP_TOKEN || '' }}");
  });

  test("recomputes external state and exact gate attempts immediately before mutation", async () => {
    const { parsed } = await readReleaseWorkflow();
    const gates = parsed.jobs.preflight.steps.find(step => step.name === "Bind newest exact-SHA gate attempts");
    const steps = parsed.jobs.mutate.steps;
    const stateIndex = steps.findIndex(step => step.name === "Recompute normal or recovery state immediately before mutation");
    const compareIndex = steps.findIndex(step => step.name === "Require unchanged inspected external state");
    const recheckIndex = steps.findIndex(step => step.name === "Recheck gates immediately before release mutation");
    const publishIndex = steps.findIndex(step => step.name === "Publish exact inspected tarball");
    const gateScript = gates?.run ?? "";
    const recheckScript = steps[recheckIndex]?.run ?? "";

    for (const script of [gateScript, recheckScript]) {
      expect(script).toContain("head_sha=${EXPECTED_SHA}");
      expect(script).toContain('.event == "push"');
      expect(script).toContain(".head_branch == $branch");
      expect(script).toContain("sort_by(.id, .run_attempt) | last");
      expect(script).toContain('test "$status" = "completed"');
      expect(script).toContain('test "$conclusion" = "success"');
    }
    expect(gateScript).toContain("require_latest_success ci.yml");
    expect(gateScript).toContain("require_latest_success package-lifecycle.yml");
    expect(gateScript).toContain("wait_for_latest_success deploy-docs.yml");
    expect(recheckScript).toContain("Superseded exact-SHA");
    expect(stateIndex).toBeGreaterThan(-1);
    expect(compareIndex).toBe(stateIndex + 1);
    expect(recheckIndex).toBe(compareIndex + 1);
    expect(publishIndex).toBe(recheckIndex + 1);
  });

  test("keeps dry-run, normal, recovery, and first-package bootstrap routing distinct", async () => {
    const { parsed } = await readReleaseWorkflow();
    const evidence = parsed.jobs.preflight.steps.find(
      step => step.name === "Reclassify immutable preparation evidence",
    );
    const gates = parsed.jobs.preflight.steps.find(step => step.name === "Bind newest exact-SHA gate attempts");
    const build = parsed.jobs.build;
    const inspect = parsed.jobs.inspect;
    const state = inspect.steps.find(step => step.name === "Resolve normal or recovery state");
    const stateScript = state?.run ?? "";

    expect(evidence?.if).toBe("${{ inputs.bootstrap != true }}");
    expect(gates?.if).toBeUndefined();
    expect(build.if).toBeUndefined();
    expect(inspect.if).toBeUndefined();
    expect(parsed.jobs.mutate.if).toBe("${{ inputs.dry-run != true }}");
    expect(state?.env).toMatchObject({
      BOOTSTRAP: "${{ inputs.bootstrap }}",
      DRY_RUN: "${{ inputs.dry-run }}",
      RECOVERY: "${{ inputs.recovery }}",
    });
    expect(stateScript).toContain('if [ "$BOOTSTRAP" = "true" ]; then');
    expect(stateScript).toContain("bootstrap is one-time only");
    expect(stateScript).toContain("bootstrap requires absent Git tag and GitHub Release metadata");
    expect(stateScript).toContain('if [ "$RECOVERY" != "true" ]; then');
    expect(stateScript).toContain("normal release requires npm version, Git tag, and GitHub Release all absent");
    expect(stateScript).toContain("Never republish an existing npm version");
  });

  test("uses cryptographic attestation verification for recovery and smoke", async () => {
    const { parsed, source } = await readReleaseWorkflow();
    const inspectState = parsed.jobs.inspect.steps.find(step => step.name === "Resolve normal or recovery state");
    const mutationState = parsed.jobs.mutate.steps.find(
      step => step.name === "Recompute normal or recovery state immediately before mutation",
    );
    const publish = parsed.jobs.mutate.steps.find(step => step.name === "Publish exact inspected tarball");
    const metadata = parsed.jobs.mutate.steps.find(step => step.name === "Create only missing immutable metadata");
    const smoke = parsed.jobs.mutate.steps.find(step => step.name === "Registry smoke and verified provenance");

    for (const script of [inspectState?.run ?? "", mutationState?.run ?? "", smoke?.run ?? ""]) {
      expect(script).toContain('cmp -s "$TARBALL" "$registry_tarball"');
      expect(script).toContain("gh attestation verify");
      expect(script).toContain("--bundle \"$bundle_file\"");
      expect(script).toContain("--signer-workflow zhsks311/Frogprogsy/.github/workflows/release.yml");
      expect(script).toContain("--source-ref refs/heads/main");
      expect(script).toContain("--digest-alg sha512");
      expect(script).toContain("statement?.predicateType");
      expect(script).toContain("subject.digest?.sha512 === expectedDigest");
      expect(script).toContain("verificationResult?.signature?.certificate");
      expect(script).toContain("certificate?.githubWorkflowRepository !== expectedRepository");
      expect(script).toContain("certificate.githubWorkflowRef !== expectedRef");
      expect(script).toContain("certificate.buildSignerURI !== expectedSignerUri");
      expect(script).toContain('!/^[0-9a-f]{40}$/.test(workflowSha)');
      expect(script).toContain("certificate.buildSignerDigest !== workflowSha");
      expect(script).toContain("certificate.buildConfigDigest !== workflowSha");
      expect(script).toContain('compare/${workflow_commit}...main');
      expect(script).not.toContain("statement.predicate?.buildDefinition");
      expect(script).not.toContain("resolvedDependencies");
      expect(script).not.toContain("metadata.gitHead");
    }
    expect(inspectState?.run).toContain("normal release requires npm version, Git tag, and GitHub Release all absent");
    expect(inspectState?.run).toContain('echo "publish_required=false" >> "$GITHUB_OUTPUT"');
    expect(publish?.if).toContain("needs.inspect.outputs.publish_required == 'true'");
    expect(metadata?.run).toContain('gh api --method POST "repos/${REPOSITORY}/git/refs"');
    expect(metadata?.run).toContain('gh release create "$release_tag" --target "$EXPECTED_SHA"');
    expect(source).toContain("release_flags=(--prerelease --latest=false)");
    expect(source).toContain("release_flags=(--prerelease=false --latest)");
  });

  test("reports manual preview cleanup without executing it", async () => {
    const { parsed, source } = await readReleaseWorkflow();
    const report = parsed.jobs.mutate.steps.find(
      step => step.name === "Report stable dist-tags and manual preview cleanup",
    );
    const command = "npm dist-tag rm frogprogsy preview";

    expect(report?.if).toContain("inputs.tag == 'latest'");
    expect(report?.run).toContain('npm view "$PACKAGE_NAME" dist-tags --json');
    expect(report?.run).toContain(`echo "${command}"`);
    expect(source.split(command)).toHaveLength(2);
  });
});
