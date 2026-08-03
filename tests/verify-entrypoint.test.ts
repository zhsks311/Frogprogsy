import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  DEFAULT_TARGETS,
  parseVerificationRequest,
  trackedRegressionTargets,
  VerificationInputError,
} from "../scripts/verify";

const repositoryRoot = join(import.meta.dir, "..");

describe("shared verification entrypoint", () => {
  test("uses the proxy conformance suite as the default target gate", () => {
    expect(parseVerificationRequest(["target"], repositoryRoot)).toEqual({
      mode: "target",
      targets: [...DEFAULT_TARGETS],
    });
  });

  test("accepts explicit existing test files without changing their order", () => {
    expect(parseVerificationRequest([
      "target",
      "tests/messages-bridge.test.ts",
      "tests/error-fidelity.test.ts",
    ], repositoryRoot)).toEqual({
      mode: "target",
      targets: ["tests/messages-bridge.test.ts", "tests/error-fidelity.test.ts"],
    });
  });

  test("enumerates the immutable tracked regression oracle without directory discovery", () => {
    const targets = trackedRegressionTargets(repositoryRoot);
    expect(targets.length).toBeGreaterThan(100);
    expect(targets).toContain("tests/verify-entrypoint.test.ts");
    expect(targets.every((target) => target.endsWith(".test.ts"))).toBe(true);
  });

  test("rejects command options, traversal, non-tests, and missing tests", () => {
    for (const target of [
      "--preload=payload.ts",
      "../outside.test.ts",
      "src/index.test.ts",
      "tests/not-present.test.ts",
    ]) {
      expect(() => parseVerificationRequest(["target", target], repositoryRoot)).toThrow(VerificationInputError);
    }
  });

  test("rejects unsupported modes and extra arguments for fixed gates", () => {
    expect(() => parseVerificationRequest([], repositoryRoot)).toThrow(VerificationInputError);
    expect(() => parseVerificationRequest(["quick"], repositoryRoot)).toThrow(VerificationInputError);
    expect(() => parseVerificationRequest(["regression", "tests/messages-bridge.test.ts"], repositoryRoot))
      .toThrow(VerificationInputError);
    expect(() => parseVerificationRequest(["package", "tests/messages-bridge.test.ts"], repositoryRoot))
      .toThrow(VerificationInputError);
  });
});
