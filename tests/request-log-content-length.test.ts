import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { __requestLogTest } from "../src/server";

describe("Content-Length parsing in request logs", () => {
  beforeEach(() => {
    __requestLogTest.clear();
  });

  test("MAX_SAFE_INTEGER records exactly", () => {
    const ctx = __requestLogTest.createRequestLog(
      "/v1/messages",
      "POST",
      new Headers({ "content-length": "9007199254740991" })
    );
    expect(ctx.entry.request.requestBytes).toBe(9007199254740991);
  });

  test("MAX_SAFE_INTEGER + 1 omits requestBytes", () => {
    const ctx = __requestLogTest.createRequestLog(
      "/v1/messages",
      "POST",
      new Headers({ "content-length": "9007199254740992" })
    );
    expect(ctx.entry.request.requestBytes).toBeUndefined();
  });

  test("very large digit-only value omits requestBytes", () => {
    const ctx = __requestLogTest.createRequestLog(
      "/v1/messages",
      "POST",
      new Headers({ "content-length": "99999999999999999999" })
    );
    expect(ctx.entry.request.requestBytes).toBeUndefined();
  });

  test("normal request size records exactly", () => {
    const ctx = __requestLogTest.createRequestLog(
      "/v1/messages",
      "POST",
      new Headers({ "content-length": "1234567" })
    );
    expect(ctx.entry.request.requestBytes).toBe(1234567);
  });

  test("zero Content-Length records as 0", () => {
    const ctx = __requestLogTest.createRequestLog(
      "/v1/messages",
      "POST",
      new Headers({ "content-length": "0" })
    );
    expect(ctx.entry.request.requestBytes).toBe(0);
  });

  test("missing header omits requestBytes", () => {
    const ctx = __requestLogTest.createRequestLog(
      "/v1/messages",
      "POST",
      new Headers({})
    );
    expect(ctx.entry.request.requestBytes).toBeUndefined();
  });

  test("non-digit header omits requestBytes", () => {
    const ctx = __requestLogTest.createRequestLog(
      "/v1/messages",
      "POST",
      new Headers({ "content-length": "12x34" })
    );
    expect(ctx.entry.request.requestBytes).toBeUndefined();
  });
});
