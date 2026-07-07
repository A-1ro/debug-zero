import { describe, it, expect } from "vitest";
import { verifyRebind, timingSafeEqualStr } from "../../src/server/room/rebindAuth";

describe("verifyRebind", () => {
  it("allows and issues a token when the player has none stored (legacy join)", () => {
    expect(verifyRebind(undefined, undefined)).toEqual({ allow: true, issueNew: true });
    expect(verifyRebind(undefined, "anything")).toEqual({ allow: true, issueNew: true });
  });

  it("allows a rebind with the exact stored token", () => {
    expect(verifyRebind("secret-token", "secret-token")).toEqual({ allow: true, issueNew: false });
  });

  it("rejects a rebind with a wrong token", () => {
    expect(verifyRebind("secret-token", "wrong-token")).toEqual({ allow: false, issueNew: false });
  });

  it("rejects a rebind with a missing token", () => {
    expect(verifyRebind("secret-token", undefined)).toEqual({ allow: false, issueNew: false });
  });

  it("rejects non-string tokens (malformed payloads)", () => {
    expect(verifyRebind("secret-token", 123)).toEqual({ allow: false, issueNew: false });
    expect(verifyRebind("secret-token", { token: "secret-token" })).toEqual({ allow: false, issueNew: false });
    expect(verifyRebind("secret-token", null)).toEqual({ allow: false, issueNew: false });
  });

  it("rejects prefix and superstring tokens", () => {
    expect(verifyRebind("secret-token", "secret")).toEqual({ allow: false, issueNew: false });
    expect(verifyRebind("secret-token", "secret-token-x")).toEqual({ allow: false, issueNew: false });
  });
});

describe("timingSafeEqualStr", () => {
  it("matches equal strings", () => {
    expect(timingSafeEqualStr("", "")).toBe(true);
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
  });

  it("rejects different strings of equal length", () => {
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
  });

  it("rejects different lengths", () => {
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
    expect(timingSafeEqualStr("abcd", "abc")).toBe(false);
  });
});
