import type { FrogConfig } from "./types";

export function healthHost(hostname?: string): string {
  if (!hostname || hostname === "0.0.0.0" || hostname === "::") return "127.0.0.1";
  return hostname === "::1" || hostname === "[::1]" ? "[::1]" : hostname;
}

/** Runtime same-machine credentials are valid only on an independently fixed loopback destination. */
export function loopbackManagementBase(config: Pick<FrogConfig, "hostname">, port: number): string {
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
  const destination = hostname === "::1" || hostname === "[::1]" ? "[::1]" : "127.0.0.1";
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
