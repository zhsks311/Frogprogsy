import { existsSync, mkdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { ensureConfigDirForWrite } from "./config";

const LOCK_WAIT_MS = 30_000;
const TEST_GATE_ENV = "FROGP_TEST_CONFIG_LOCK_GATE";

export interface ConfigMutationLock {
  acquire: () => Promise<() => void>;
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "SQLITE_BUSY";
}

/** Test-only rendezvous after acquisition, used to make subprocess races deterministic without sleeps. */
async function waitAtTestGate(): Promise<void> {
  const gatePath = process.env.NODE_ENV === "test" ? process.env[TEST_GATE_ENV]?.trim() : undefined;
  if (!gatePath) return;

  const readyPath = `${gatePath}.${process.pid}.ready`;
  writeFileSync(readyPath, "ready", { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    if (existsSync(gatePath)) return;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let finished = false;
    const watcher = watch(dirname(gatePath), () => {
      if (finished || !existsSync(gatePath)) return;
      finished = true;
      watcher.close();
      resolve();
    });
    watcher.once("error", error => {
      if (finished) return;
      finished = true;
      watcher.close();
      reject(error);
    });
    if (existsSync(gatePath) && !finished) {
      finished = true;
      watcher.close();
      resolve();
    }
    await promise;
  } finally {
    rmSync(readyPath, { force: true });
  }
}

/** Shared critical section for startup publication and local-key config mutations. */
export function createConfigMutationLock(): ConfigMutationLock {
  return {
    async acquire() {
      const lockDir = join(ensureConfigDirForWrite("config/start/local-key lock"), "locks");
      let database: Database;
      try {
        mkdirSync(lockDir, { recursive: true, mode: 0o700 });
        database = new Database(join(lockDir, "config-start-local-key.sqlite"), {
          create: true,
          strict: true,
        });
      } catch {
        throw new Error("could not prepare the config/start/local-key lock");
      }

      try {
        database.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_MS}`);
        database.exec("BEGIN IMMEDIATE");
      } catch (error) {
        database.close(false);
        if (isSqliteBusy(error)) {
          throw new Error("timed out acquiring the config/start/local-key lock");
        }
        throw new Error("could not acquire the config/start/local-key lock");
      }

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          database.exec("ROLLBACK");
        } catch {
          // Closing the connection below still releases SQLite's process-owned lock.
        } finally {
          database.close(false);
        }
      };

      try {
        await waitAtTestGate();
        return release;
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}
