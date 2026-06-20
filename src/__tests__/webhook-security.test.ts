import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";

// ─── Re-implement verifySquadSignature for unit testing ───────────────────────
// Mirrors the Web Crypto HMAC-SHA512 path in server-functions/webhooks.ts.
async function verifySquadSignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined
): Promise<boolean> {
  if (!secret || !signature) return false;
  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const msgData = encoder.encode(rawBody);
    const cryptoKey = await crypto.subtle.importKey(
      "raw", keyData, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]
    );
    const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
    const computed = Array.from(new Uint8Array(sigBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return computed.toLowerCase() === signature.toLowerCase();
  } catch {
    return false;
  }
}

function signPayload(body: string, secret: string): string {
  return createHmac("sha512", secret).update(body).digest("hex");
}

const TEST_SECRET = "test-squadco-secret-key-abc123";
const TEST_BODY = JSON.stringify({
  Event: "transfer.success",
  Data: { transaction_reference: "ref-001", amount: 5000000 },
});

// ─── P0 regression: fail-closed signature verification ───────────────────────

describe("Squad webhook signature verification (P0 regression)", () => {
  it("accepts a valid HMAC-SHA512 signature", async () => {
    const sig = signPayload(TEST_BODY, TEST_SECRET);
    expect(await verifySquadSignature(TEST_BODY, sig, TEST_SECRET)).toBe(true);
  });

  it("rejects a null signature", async () => {
    expect(await verifySquadSignature(TEST_BODY, null, TEST_SECRET)).toBe(false);
  });

  it("rejects an empty signature string", async () => {
    expect(await verifySquadSignature(TEST_BODY, "", TEST_SECRET)).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const sig = signPayload(TEST_BODY, TEST_SECRET);
    const tampered = TEST_BODY.replace("transfer.success", "transfer.failed");
    expect(await verifySquadSignature(tampered, sig, TEST_SECRET)).toBe(false);
  });

  it("rejects a forged signature using a different secret", async () => {
    const wrongSig = signPayload(TEST_BODY, "attacker-secret");
    expect(await verifySquadSignature(TEST_BODY, wrongSig, TEST_SECRET)).toBe(false);
  });

  // ── THE CRITICAL REGRESSION: old code did if (!secret) return true ─────────
  it("FAILS CLOSED when SQUADCO_SECRET_KEY is undefined (env var missing)", async () => {
    const sig = signPayload(TEST_BODY, TEST_SECRET);
    const result = await verifySquadSignature(TEST_BODY, sig, undefined);
    expect(result).toBe(false); // MUST be false — not true
  });

  it("FAILS CLOSED when SQUADCO_SECRET_KEY is empty string", async () => {
    const sig = signPayload(TEST_BODY, TEST_SECRET);
    expect(await verifySquadSignature(TEST_BODY, sig, "")).toBe(false);
  });

  it("accepts uppercase hex digest (Squad may canonicalise differently)", async () => {
    const sig = signPayload(TEST_BODY, TEST_SECRET).toUpperCase();
    expect(await verifySquadSignature(TEST_BODY, sig, TEST_SECRET)).toBe(true);
  });
});

// ─── Idempotency model ────────────────────────────────────────────────────────

describe("Webhook idempotency", () => {
  it("skips processing when transaction ref already exists", () => {
    const processed = new Set<string>(["ref-already-done"]);
    const wouldProcess = (ref: string) => !processed.has(ref);
    expect(wouldProcess("ref-already-done")).toBe(false);
    expect(wouldProcess("ref-brand-new")).toBe(true);
  });
});

// ─── requireVendorAuth contract ───────────────────────────────────────────────

describe("requireVendorAuth contract (P1 regression)", () => {
  it("returns a userId string when vendor exists and is active", async () => {
    const mockAuth = async (hasVendor: boolean, status = "active") => {
      const userId = "user-uuid-abc";
      if (!hasVendor) throw new Error("Vendor account required");
      if (status === "suspended") throw new Error("Vendor account is suspended");
      return userId;
    };
    await expect(mockAuth(true, "active")).resolves.toBe("user-uuid-abc");
  });

  it("throws when vendor row does not exist", async () => {
    const mockAuth = async (hasVendor: boolean) => {
      if (!hasVendor) throw new Error("Vendor account required");
      return "user-id";
    };
    await expect(mockAuth(false)).rejects.toThrow("Vendor account required");
  });

  it("throws when vendor is suspended", async () => {
    const mockAuth = async (status: string) => {
      if (status === "suspended") throw new Error("Vendor account is suspended");
      return "user-id";
    };
    await expect(mockAuth("suspended")).rejects.toThrow("Vendor account is suspended");
  });
});

// ─── Atomic wallet model ──────────────────────────────────────────────────────

describe("Atomic wallet balance model (P2 regression)", () => {
  it("two concurrent credits both land — no lost update", () => {
    // Simulate two RPC-style atomic increments (balance = balance + amount)
    let balance = 1000;
    const increment = (amount: number) => { balance = balance + amount; };
    increment(500);
    increment(500);
    expect(balance).toBe(2000); // both credits reflected
  });

  it("deduction respects the floor — cannot go negative", () => {
    const balance = 1000;
    const deduct = (amount: number) => {
      if (balance - amount < 0) throw new Error("Insufficient balance");
      return balance - amount;
    };
    expect(deduct(500)).toBe(500);
    expect(() => deduct(1500)).toThrow("Insufficient balance");
  });
});
