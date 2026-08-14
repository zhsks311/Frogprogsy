import { describe, expect, test } from "bun:test";
import {
  ContinuityCircuit,
  continuityCandidates,
  isContinuityEligibleHttpFailure,
} from "../src/model-continuity";

describe("model continuity runtime", () => {
  test("circuit opens for 30 seconds and clears on success", () => {
    const circuit = new ContinuityCircuit();
    circuit.open("work/old", "http_5xx", 1_000);
    expect(circuit.isOpen("work/old", 30_999)).toBeTrue();
    expect(circuit.isOpen("work/old", 31_000)).toBeFalse();

    circuit.open("work/old", "http_5xx", 40_000);
    circuit.succeed("work/old");
    expect(circuit.isOpen("work/old", 40_001)).toBeFalse();
  });

  test("snapshot lazily expires entries and exposes only route, reason, and expiry", () => {
    const circuit = new ContinuityCircuit();
    circuit.open("work/old", "http_429", 2_000);

    expect(circuit.snapshot(31_999)).toEqual([
      { target: "work/old", reason: "http_429", until: 32_000 },
    ]);
    expect(circuit.snapshot(32_000)).toEqual([]);
  });

  test("candidate order is exact and excludes retired or open targets", () => {
    const circuit = new ContinuityCircuit();
    circuit.open("fallback/temporarily-down", "connect_failure", 1_000);

    expect(continuityCandidates(
      "primary/old",
      {
        automatic: "all",
        fallbacks: ["fallback/retired", "fallback/temporarily-down", "fallback/ready"],
      },
      new Set(["primary/old", "fallback/retired"]),
      circuit,
      2_000,
    )).toEqual(["fallback/ready"]);
  });

  test.each([
    [404, "http_404"],
    [410, "http_410"],
    [429, "http_429"],
    [500, "http_5xx"],
    [503, "http_5xx"],
    [599, "http_5xx"],
  ] as const)("HTTP %i is continuity eligible as %s", (status, reason) => {
    expect(isContinuityEligibleHttpFailure(status, {
      type: "upstream_error",
      message: "provider failed",
    })).toBe(reason);
  });

  test.each([400, 401, 402, 403, 409])("HTTP %i is not continuity eligible", status => {
    expect(isContinuityEligibleHttpFailure(status, {
      type: "upstream_error",
      message: "provider failed",
    })).toBeNull();
  });

  test("continuity classification trusts exact structured context fields, not free-form text", () => {
    expect(isContinuityEligibleHttpFailure(500, {
      type: "upstream_error",
      message: "context window exceeded",
    })).toBe("http_5xx");
    expect(isContinuityEligibleHttpFailure(500, {
      type: "invalid_request_error",
      code: "context_length_exceeded",
      message: "structured provider error",
    })).toBeNull();
    expect(isContinuityEligibleHttpFailure(500, {
      type: "context_length_exceeded",
      message: "structured provider error",
    })).toBeNull();
  });
});
