import { describe, it, expect } from "vitest";
import { AuthError, ForbiddenError } from "../lib/auth-server";

// ─── AuthError ────────────────────────────────────────────────────────────────

describe("AuthError", () => {
  it("has status 401", () => {
    const err = new AuthError();
    expect(err.status).toBe(401);
  });

  it("uses default message", () => {
    const err = new AuthError();
    expect(err.message).toBe("Authentication required");
  });

  it("accepts custom message", () => {
    const err = new AuthError("Session expired");
    expect(err.message).toBe("Session expired");
  });

  it("is an instance of Error", () => {
    expect(new AuthError()).toBeInstanceOf(Error);
  });

  it("has name AuthError", () => {
    expect(new AuthError().name).toBe("AuthError");
  });
});

// ─── ForbiddenError ───────────────────────────────────────────────────────────

describe("ForbiddenError", () => {
  it("has status 403", () => {
    const err = new ForbiddenError();
    expect(err.status).toBe(403);
  });

  it("uses default message", () => {
    const err = new ForbiddenError();
    expect(err.message).toBe("Forbidden");
  });

  it("accepts custom message", () => {
    const err = new ForbiddenError("Admin access required");
    expect(err.message).toBe("Admin access required");
  });

  it("is an instance of Error", () => {
    expect(new ForbiddenError()).toBeInstanceOf(Error);
  });

  it("has name ForbiddenError", () => {
    expect(new ForbiddenError().name).toBe("ForbiddenError");
  });
});

// ─── Status code distinctness ─────────────────────────────────────────────────

describe("Error status codes", () => {
  it("AuthError and ForbiddenError have different status codes", () => {
    expect(new AuthError().status).not.toBe(new ForbiddenError().status);
  });

  it("AuthError is distinguishable from ForbiddenError", () => {
    const err: Error = new ForbiddenError("Admin only");
    expect(err).not.toBeInstanceOf(AuthError);
    expect(err).toBeInstanceOf(ForbiddenError);
  });
});
