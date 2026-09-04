import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export interface AtomicCacheFileHandle {
  writeFile(data: string, options?: { encoding?: BufferEncoding }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicCacheFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  open(path: string, flags: string, mode?: number): Promise<AtomicCacheFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** Durable cache replacement: private temp file, file fsync, then atomic rename with cleanup on failure. */
export async function writeCacheAtomically(
  path: string,
  content: string,
  fileSystem: AtomicCacheFileSystem,
): Promise<boolean> {
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: AtomicCacheFileHandle | null = null;
  try {
    await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await fileSystem.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporaryPath, path);
    let directoryHandle: AtomicCacheFileHandle | null = null;
    try {
      directoryHandle = await fileSystem.open(directory, "r");
      await directoryHandle.sync();
    } catch {
      // Some supported platforms cannot open directories; file fsync + rename remains the fallback.
    } finally {
      await directoryHandle?.close().catch(() => undefined);
    }
    return true;
  } catch {
    await handle?.close().catch(() => undefined);
    await fileSystem.unlink(temporaryPath).catch(() => undefined);
    return false;
  }
}
