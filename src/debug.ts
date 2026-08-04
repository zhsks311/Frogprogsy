// Opt-in frame-drop visibility. The streaming path is intentionally quiet (no unconditional
// console output), so this no-ops unless FROGP_DEBUG_FRAMES=1. Lets a malformed/chunk-split
// upstream frame be detected instead of silently truncating content.
const DEBUG_FRAMES = process.env.FROGP_DEBUG_FRAMES === "1";

export function debugDroppedFrame(adapter: string, payload: string): void {
  if (!DEBUG_FRAMES) return;
  const preview = payload.length > 200 ? `${payload.slice(0, 200)}…` : payload;
  console.error(`[frogp:frame-drop] ${adapter}: ${preview}`);
}

// Opt-in visibility for intentionally-swallowed errors. Several paths deliberately continue on
// failure (best-effort filesystem, fire-and-forget side effects, usage accounting that must never
// break the data plane). Swallowing keeps the default output quiet, but it also hides the cause when
// something is actually wrong. Routing those catches through here keeps them silent by default yet
// observable with FROGP_DEBUG=1, so a discarded error can be diagnosed instead of lost forever.
// The env is read on each call so the flag can be toggled per process (and per test) without a reload.
export function debugSwallowed(scope: string, err: unknown): void {
  if (process.env.FROGP_DEBUG !== "1") return;
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[frogp:swallowed] ${scope}: ${message}`);
}
