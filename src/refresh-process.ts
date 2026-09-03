export interface StaleProxyTerminationOps {
  writeShutdownIntent: (pid: number) => void;
  terminate: (pid: number) => void;
  isAlive: (pid: number) => boolean;
  clearShutdownIntent: () => void;
}

export type StaleProxyTerminationResult =
  | { ok: true }
  | { ok: false; error: unknown };

/** Preserve watchdog ownership unless the stale process is confirmed terminated. */
export function terminateStaleProxyForRefresh(
  pid: number,
  ops: StaleProxyTerminationOps,
): StaleProxyTerminationResult {
  try {
    ops.writeShutdownIntent(pid);
    ops.terminate(pid);
    return { ok: true };
  } catch (error) {
    if (!ops.isAlive(pid)) return { ok: true };
    ops.clearShutdownIntent();
    return { ok: false, error };
  }
}
