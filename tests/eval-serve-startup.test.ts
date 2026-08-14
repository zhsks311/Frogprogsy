import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEvalServer } from "../evals/fusion/src/serve";


describe("fusion eval server startup", () => {
  test("publishes the PID only after async server startup succeeds", async () => {
    const home = mkdtempSync(join(tmpdir(), "frog-eval-serve-startup-"));
    const pidFile = join(home, "run", "server.pid");
    const gate = Promise.withResolvers<{ stop(force?: boolean): void }>();

    try {
      const starting = startEvalServer(3764, pidFile, () => gate.promise);
      await Promise.resolve();
      expect(existsSync(pidFile)).toBe(false);

      const server = { stop() {} };
      gate.resolve(server);
      expect(await starting).toBe(server);
      expect(readFileSync(pidFile, "utf8")).toBe(`${process.pid}\n`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not publish the PID when async server startup rejects", async () => {
    const home = mkdtempSync(join(tmpdir(), "frog-eval-serve-reject-"));
    const pidFile = join(home, "run", "server.pid");

    try {
      await expect(startEvalServer(3764, pidFile, async () => {
        throw new Error("bind failed");
      })).rejects.toThrow("bind failed");
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
