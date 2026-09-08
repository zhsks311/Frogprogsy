import type { FrogConfig } from "./types";

export type LoopbackManagementHost = "127.0.0.1" | "[::1]";

/** Runtime same-machine credentials use only fixed loopback destinations, optionally pinned to a verified family. */
export function loopbackManagementBase(
  config: Pick<FrogConfig, "hostname">,
  port: number,
  verifiedHost?: LoopbackManagementHost,
): string {
  const hostname = config.hostname?.trim().toLowerCase();
  if (hostname
    && hostname !== "0.0.0.0"
    && hostname !== "::"
    && hostname !== "localhost"
    && hostname !== "127.0.0.1"
    && hostname !== "::1"
    && hostname !== "[::1]") {
    throw new Error("same-machine management credentials are never sent to a non-loopback hostname");
  }
  if (verifiedHost !== undefined && verifiedHost !== "127.0.0.1" && verifiedHost !== "[::1]") {
    throw new Error("same-machine management credentials require a verified loopback destination");
  }
  const configuredDestination = hostname === "::" || hostname === "::1" || hostname === "[::1]"
    ? "[::1]"
    : "127.0.0.1";
  if (verifiedHost !== undefined && hostname !== "localhost" && verifiedHost !== configuredDestination) {
    throw new Error("same-machine management credentials require the configured address family");
  }
  const destination = verifiedHost ?? configuredDestination;
  return `http://${destination}:${port}`;
}

/** Bound local HTTP bodies before parsing, including unauthenticated health responses on stale ports. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isInteger(declared) || declared < 0 || declared > maxBytes) {
      throw new Error("response body exceeds the local management limit");
    }
  }
  if (!response.body) throw new Error("response body is missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response body exceeds the local management limit");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text);
}
