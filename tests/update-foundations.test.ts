import { describe, expect, test } from "bun:test";
import { healthHost, loopbackManagementBase, readBoundedJson } from "../src/cli-local-api";
import { detectInstallIdentity } from "../src/install-identity";
import { compareSemVer, parseCanonicalStableSemVer, parseSemVer } from "../src/semver";

function compare(left: string, right: string): number {
  const parsedLeft = parseSemVer(left);
  const parsedRight = parseSemVer(right);
  if (!parsedLeft || !parsedRight) throw new Error("test fixture must be valid SemVer");
  return compareSemVer(parsedLeft, parsedRight);
}

describe("shared SemVer", () => {
  test("orders stable and prerelease versions by SemVer precedence", () => {
    expect(compare("1.0.0-preview.2", "1.0.0-preview.10")).toBeLessThan(0);
    expect(compare("1.0.0-preview.10", "1.0.0")).toBeLessThan(0);
    expect(compare("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compare("v1.2.3+build.4", "1.2.3+other")).toBe(0);
  });

  test("keeps the stable release channel canonical and rejects unsafe forms", () => {
    expect(parseCanonicalStableSemVer("1.2.3")).not.toBeNull();
    for (const invalid of ["v1.2.3", "1.2.3-preview.1", "1.2.3+build", "01.2.3", "9007199254740992.0.0"]) {
      expect(parseCanonicalStableSemVer(invalid)).toBeNull();
    }
    expect(parseSemVer("1.2.3-preview.01")).toBeNull();
  });
});

describe("safe local management client", () => {
  test("pins runtime-token destinations to loopback and formats IPv6 safely", () => {
    expect(loopbackManagementBase({}, 3764)).toBe("http://127.0.0.1:3764");
    expect(loopbackManagementBase({ hostname: "0.0.0.0" }, 3764)).toBe("http://127.0.0.1:3764");
    expect(loopbackManagementBase({ hostname: "localhost" }, 3764)).toBe("http://127.0.0.1:3764");
    expect(loopbackManagementBase({ hostname: "::1" }, 3764)).toBe("http://[::1]:3764");
    expect(healthHost("::1")).toBe("[::1]");
    expect(() => loopbackManagementBase({ hostname: "relay.example" }, 3764)).toThrow(/never sent/);
    expect(() => loopbackManagementBase({ hostname: "192.0.2.10" }, 3764)).toThrow(/never sent/);
  });

  test("rejects oversized local JSON before parsing", async () => {
    await expect(readBoundedJson(new Response("x".repeat(5)), 4)).rejects.toThrow(/exceeds/);
    await expect(readBoundedJson(Response.json({ ok: true }), 128)).resolves.toEqual({ ok: true });
  });
});

describe("install identity", () => {
  const packageRoot = "/tmp/frog/node_modules/frogprogsy";
  const bin = "/tmp/frog/bin/frogp";
  const realpath = (path: string) => path === bin ? `${packageRoot}/src/cli.ts` : path;
  const exists = (path: string) => path === bin;

  test("source checkouts never invoke Bun ownership discovery", async () => {
    let calls = 0;
    const identity = await detectInstallIdentity({
      packageRoot: "/tmp/frog/source",
      version: "1.2.3",
      bunGlobalBin: async () => {
        calls += 1;
        return "/tmp/frog/bin";
      },
    });
    expect(identity).toEqual({ kind: "source", version: "1.2.3" });
    expect(calls).toBe(0);
  });

  test("distinguishes Bun, development receipt, and unsupported package roots", async () => {
    const bun = await detectInstallIdentity({
      packageRoot,
      version: "1.2.3",
      bunGlobalBin: async () => "/tmp/frog/bin",
      exists,
      realpath,
      devReceiptExists: false,
    });
    const development = await detectInstallIdentity({
      packageRoot,
      version: "1.2.3",
      bunGlobalBin: async () => "/tmp/frog/bin",
      exists,
      realpath,
      devReceiptExists: true,
    });
    const unsupported = await detectInstallIdentity({
      packageRoot,
      version: "1.2.3",
      bunGlobalBin: async () => "/tmp/other/bin",
      exists: () => false,
      realpath,
    });
    expect(bun.kind).toBe("bun");
    expect(development.kind).toBe("development");
    expect(unsupported.kind).toBe("unsupported");
  });
  test("recognizes Bun's Windows launcher beside the canonical global package tree", async () => {
    const windowsRoot = "/tmp/windows-bun/install/global/node_modules/frogprogsy";
    const windowsBin = "/tmp/windows-bun/bin/frogp.exe";
    const identity = await detectInstallIdentity({
      packageRoot: windowsRoot,
      version: "1.2.3",
      bunGlobalBin: async () => "/tmp/windows-bun/bin",
      exists: path => path === windowsBin,
      realpath: path => path,
      devReceiptExists: false,
    });
    expect(identity).toEqual({ kind: "bun", version: "1.2.3" });
  });
});
