import { describe, expect, test } from "bun:test";
import { __requestLogTest } from "../src/server";
import type { FrogConfig } from "../src/types";

function config(): FrogConfig {
  return {
    port: 10190,
    defaultProvider: "saved",
    providers: {
      saved: {
        adapter: "openai-chat",
        baseUrl: "https://saved-provider.test/v1",
        apiKey: "sk-saved-secret-1234",
        defaultModel: "model-a",
        models: ["model-a"],
      },
    },
  };
}

async function mutate(url: string, init: RequestInit, clientAddress?: string) {
  const cfg = config();
  return __requestLogTest.handleManagementAPI(new Request(url, init), new URL(url), cfg, {
    clientAddress,
    saveConfig: () => {
      throw new Error("blocked request must not persist config");
    },
  });
}

describe("management API local-only guard", () => {
  test("blocks an Origin-less mutation from a non-loopback peer", async () => {
    const res = await mutate(
      "http://127.0.0.1:10190/api/default-provider",
      { method: "PUT", body: JSON.stringify({ name: "saved" }) },
      "203.0.113.7",
    );

    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "cross-origin request blocked" });
  });

  test("blocks a claude-projects read from a non-loopback peer", async () => {
    const res = await mutate("http://127.0.0.1:10190/api/claude-projects", { method: "GET" }, "203.0.113.7");

    expect(res?.status).toBe(403);
  });

  test("admits an Origin-less mutation from a loopback peer", async () => {
    const res = await mutate(
      "http://127.0.0.1:10190/api/default-provider",
      { method: "PUT", body: JSON.stringify({ name: "unknown" }) },
      "::ffff:127.0.0.1",
    );

    expect(res?.status).toBe(404);
  });

  test("admits a loopback-Origin mutation from a non-loopback peer (published port)", async () => {
    const res = await mutate(
      "http://127.0.0.1:10190/api/default-provider",
      { method: "PUT", headers: { Origin: "http://localhost:10190" }, body: JSON.stringify({ name: "unknown" }) },
      "172.17.0.1",
    );

    expect(res?.status).toBe(404);
  });

  test("keeps rejecting a cross-origin mutation from a loopback peer", async () => {
    const res = await mutate(
      "http://127.0.0.1:10190/api/default-provider",
      { method: "PUT", headers: { Origin: "https://evil.example" }, body: JSON.stringify({ name: "saved" }) },
      "127.0.0.1",
    );

    expect(res?.status).toBe(403);
  });
});
