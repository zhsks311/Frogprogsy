import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generatePKCE } from "../src/oauth/pkce";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("PKCE generation", () => {
  test("verifier is 96 random bytes in base64url and never repeats", async () => {
    const a = await generatePKCE();
    const b = await generatePKCE();
    expect(a.verifier).toMatch(BASE64URL);
    expect(Buffer.from(a.verifier, "base64url")).toHaveLength(96);
    expect(a.verifier).not.toBe(b.verifier);
  });

  test("challenge is the base64url S256 digest of the verifier", async () => {
    const { verifier, challenge } = await generatePKCE();
    expect(challenge).toMatch(BASE64URL);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(Buffer.from(challenge, "base64url")).toHaveLength(32);
  });
});
