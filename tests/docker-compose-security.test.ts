import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("default Compose port publishes the relay on host loopback only", async () => {
  const composeText = await Bun.file(join(import.meta.dir, "..", "docker-compose.yml")).text();
  const compose = Bun.YAML.parse(composeText) as {
    services?: { frogp?: { ports?: unknown[]; environment?: Record<string, unknown> } };
  };

  expect(compose.services?.frogp?.ports).toContain("127.0.0.1:${FROGP_HOST_PORT:-3764}:3764");
  expect(compose.services?.frogp?.environment?.FROGP_LOCAL_ACCESS_KEY).toBe("${FROGP_LOCAL_ACCESS_KEY:-}");
});

function runEnsureConfig(home: string, localKey?: string) {
  const env = { ...process.env, FROGPROGSY_HOME: home, FROGP_DOCKER_BIND_HOSTNAME: "0.0.0.0" };
  delete env.FROGP_LOCAL_ACCESS_KEY;
  if (localKey) env.FROGP_LOCAL_ACCESS_KEY = localKey;
  return Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "..", "docker", "ensure-config.ts")],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("first non-loopback Docker start requires an explicit access key without writing a secret", () => {
  const home = mkdtempSync(join(tmpdir(), "frog-docker-key-required-"));
  try {
    const result = runEnsureConfig(home);
    const output = `${new TextDecoder().decode(result.stdout)}\n${new TextDecoder().decode(result.stderr)}`;

    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("FROGP_LOCAL_ACCESS_KEY");
    expect(output).not.toContain("frogp_");
    expect(existsSync(join(home, "config.json"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("existing enabled Docker key survives restart without the plaintext environment value", () => {
  const home = mkdtempSync(join(tmpdir(), "frog-docker-existing-key-"));
  const existingHash = `sha256:${"b".repeat(64)}`;
  writeFileSync(join(home, "config.json"), JSON.stringify({
    hostname: "0.0.0.0",
    localAccess: {
      enabled: true,
      keys: [{ id: "lk_existing", label: "existing", secretHash: existingHash }],
    },
  }));
  try {
    const result = runEnsureConfig(home);
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));

    expect(result.exitCode).toBe(0);
    expect(saved.localAccess).toEqual({
      enabled: true,
      keys: [{ id: "lk_existing", label: "existing", secretHash: existingHash }],
    });
    expect(new TextDecoder().decode(result.stdout)).not.toContain("frogp_");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
