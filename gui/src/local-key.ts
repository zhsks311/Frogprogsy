/**
 * Relay access key handling for the dashboard.
 *
 * When the relay runs with `localAccess` enabled (required for a non-loopback bind), every `/api/*`
 * request must carry a key. The dashboard has 40+ fetch call sites, so the key is attached by wrapping
 * `window.fetch` once instead of threading a header through every caller. The key lives in
 * sessionStorage only: it is never written to localStorage or a cookie, so it disappears with the tab
 * and is not sent automatically by the browser to anything else.
 */
const STORAGE_KEY = "frogp.localKey";
export const LOCAL_KEY_HEADER = "x-frogp-local-key";
/** Empty (same-origin) in a served build; a dev server points it at the relay's own origin. */
export const API_BASE: string = import.meta.env.VITE_API_BASE || "";

/** The one origin the key may be sent to: the relay this dashboard talks to. */
function relayOrigin(): string {
  try {
    return new URL(API_BASE || window.location.href, window.location.href).origin;
  } catch {
    return window.location.origin;
  }
}

export function readLocalKey(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeLocalKey(key: string): void {
  try {
    const trimmed = key.trim();
    if (trimmed) sessionStorage.setItem(STORAGE_KEY, trimmed);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // A blocked sessionStorage only costs the key on reload; requests in this tab still carry it.
  }
}

let inMemoryKey = "";

/** Attach the stored key to the relay's own management/data-plane requests. Idempotent. */
export function installLocalKeyFetch(): void {
  const native = window.fetch;
  if ((native as { __frogpLocalKey?: boolean }).__frogpLocalKey) return;
  inMemoryKey = readLocalKey();

  const wrapped: typeof window.fetch = (input, init) => {
    const key = inMemoryKey || readLocalKey();
    if (!key) return native(input, init);
    const raw = input instanceof Request ? input.url : String(input);
    // Resolve against the page so a relative URL and an absolute one are judged the same way: the key
    // is a credential for this relay only and must never travel to another origin.
    let url: URL;
    try {
      url = new URL(raw, window.location.href);
    } catch {
      return native(input, init);
    }
    if (url.origin !== relayOrigin()) return native(input, init);
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/v1/")) return native(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(LOCAL_KEY_HEADER, key);
    return native(input, { ...init, headers });
  };
  (wrapped as { __frogpLocalKey?: boolean }).__frogpLocalKey = true;
  window.fetch = wrapped;
}

export function setLocalKey(key: string): void {
  inMemoryKey = key.trim();
  storeLocalKey(key);
}

export type LocalKeyProbe = "ok" | "required" | "rejected";

/**
 * Ask the relay whether the current key is accepted. `required` means no key is stored (or none was
 * sent) and the relay wants one; `rejected` means the stored key was refused.
 */
export async function probeLocalKey(apiBase: string): Promise<LocalKeyProbe> {
  try {
    const res = await fetch(`${apiBase}/api/settings`);
    if (res.status !== 401) return "ok";
    return (inMemoryKey || readLocalKey()) ? "rejected" : "required";
  } catch {
    // Network/relay-down errors are surfaced by the pages themselves, not by the key gate.
    return "ok";
  }
}
