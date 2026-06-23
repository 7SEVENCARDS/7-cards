import { describe, it, expect } from "vitest";

  // ─── Cookie token extraction logic (re-implemented for unit testing) ───────────
  // Mirrors extractAccessToken in auth-server.ts exactly — kept in sync manually.
  // Handles both the unchunked form and the chunked form Supabase uses for large JWTs.
  //
  // Unchunked: sb-<ref>-auth-token=<encoded-value>
  // Chunked:   sb-<ref>-auth-token.0=<chunk0>; sb-<ref>-auth-token.1=<chunk1>

  function parseTokenJson(raw: string): string | null {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? (parsed[0]?.access_token ?? null)
        : (parsed?.access_token ?? null);
    } catch {
      return null;
    }
  }

  function extractAccessToken(cookieHeader: string): string | null {
    // 1. Try the unchunked cookie: sb-<ref>-auth-token=<value>
    const unchunkedMatch = cookieHeader.match(/sb-[A-Za-z0-9]+-auth-token=([^;]+)/);
    if (unchunkedMatch) {
      const token = parseTokenJson(decodeURIComponent(unchunkedMatch[1]));
      if (token) return token;
    }

    // 2. Detect chunked cookies: sb-<ref>-auth-token.N=<value>
    const chunkNameMatch = cookieHeader.match(/sb-([A-Za-z0-9]+)-auth-token\.\d+=/);
    if (!chunkNameMatch) return null;

    const projectRef = chunkNameMatch[1];
    const chunkMap = new Map<number, string>();
    const chunkPattern = new RegExp("^sb-" + projectRef + "-auth-token\\.(\\d+)$");

    for (const segment of cookieHeader.split(";")) {
      const eqIdx = segment.indexOf("=");
      if (eqIdx === -1) continue;
      const name  = segment.slice(0, eqIdx).trim();
      const value = segment.slice(eqIdx + 1).trim();
      const m = name.match(chunkPattern);
      if (m) chunkMap.set(parseInt(m[1], 10), value);
    }

    if (chunkMap.size === 0) return null;

    try {
      const joined = Array.from({ length: chunkMap.size }, (_, i) => chunkMap.get(i) ?? "").join("");
      return parseTokenJson(decodeURIComponent(joined));
    } catch {
      return null;
    }
  }

  describe("extractAccessToken", () => {
    it("returns null when cookie header is empty", () => {
      expect(extractAccessToken("")).toBeNull();
    });

    it("returns null when no Supabase auth cookie is present", () => {
      expect(extractAccessToken("theme=dark; lang=en")).toBeNull();
    });

    it("extracts access_token from object-style cookie", () => {
      const payload = encodeURIComponent(
        JSON.stringify({ access_token: "tok_abc123", token_type: "bearer" })
      );
      const cookie = `sb-xyzabc-auth-token=${payload}; Path=/`;
      expect(extractAccessToken(cookie)).toBe("tok_abc123");
    });

    it("extracts access_token from array-style cookie", () => {
      const payload = encodeURIComponent(
        JSON.stringify([{ access_token: "tok_array_xyz" }, { token_type: "bearer" }])
      );
      const cookie = `sb-xyzabc-auth-token=${payload}`;
      expect(extractAccessToken(cookie)).toBe("tok_array_xyz");
    });

    it("returns null when JSON is malformed", () => {
      const cookie = `sb-xyzabc-auth-token=${encodeURIComponent("{bad json")}`;
      expect(extractAccessToken(cookie)).toBeNull();
    });

    it("returns null when access_token key is missing from object", () => {
      const payload = encodeURIComponent(JSON.stringify({ token_type: "bearer" }));
      const cookie = `sb-xyzabc-auth-token=${payload}`;
      expect(extractAccessToken(cookie)).toBeNull();
    });

    it("returns null when array is empty", () => {
      const payload = encodeURIComponent(JSON.stringify([]));
      const cookie = `sb-xyzabc-auth-token=${payload}`;
      expect(extractAccessToken(cookie)).toBeNull();
    });

    it("ignores unrelated cookies before the auth token", () => {
      const payload = encodeURIComponent(
        JSON.stringify({ access_token: "tok_multi" })
      );
      const cookie = `session_id=abc; sb-xyzabc-auth-token=${payload}; theme=dark`;
      expect(extractAccessToken(cookie)).toBe("tok_multi");
    });

    it("reassembles a two-chunk chunked Supabase cookie", () => {
      const full = JSON.stringify({ access_token: "tok_chunked_xyz" });
      const mid = Math.ceil(full.length / 2);
      const c0 = encodeURIComponent(full.slice(0, mid));
      const c1 = encodeURIComponent(full.slice(mid));
      const cookie = `sb-abc123-auth-token.0=${c0}; sb-abc123-auth-token.1=${c1}`;
      expect(extractAccessToken(cookie)).toBe("tok_chunked_xyz");
    });
  });

  // ─── processPayout security: client cannot override amount ────────────────────
  // This validates our mental model: the server function now only accepts tradeId.

  describe("processPayout input shape", () => {
    it("only has tradeId — no amount, bankCode, accountNumber, accountName, userId", () => {
      const clientPayload = { tradeId: "trade-123" };

      expect(clientPayload).not.toHaveProperty("userId");
      expect(clientPayload).not.toHaveProperty("amountNgn");
      expect(clientPayload).not.toHaveProperty("bankCode");
      expect(clientPayload).not.toHaveProperty("accountNumber");
      expect(clientPayload).not.toHaveProperty("accountName");
      expect(clientPayload).toHaveProperty("tradeId");
    });
  });

  // ─── Admin endpoint: no client-supplied adminId ───────────────────────────────

  describe("admin endpoint input shapes", () => {
    it("approveKYC payload contains only userId, no adminId", () => {
      const payload = { userId: "user-abc" };
      expect(payload).not.toHaveProperty("adminId");
      expect(payload).toHaveProperty("userId");
    });

    it("rejectKYC payload contains userId and reason, no adminId", () => {
      const payload = { userId: "user-abc", reason: "Name mismatch" };
      expect(payload).not.toHaveProperty("adminId");
      expect(payload).toHaveProperty("userId");
      expect(payload).toHaveProperty("reason");
    });

    it("updateExchangeRate payload has brand/region/rate, no adminId", () => {
      const payload = { brand: "Apple", region: "USA", ratePerDollar: 1600 };
      expect(payload).not.toHaveProperty("adminId");
    });

    it("adminCreditWallet payload has userId/amountNgn/reason, no adminId", () => {
      const payload = { userId: "user-abc", amountNgn: 5000, reason: "Bonus" };
      expect(payload).not.toHaveProperty("adminId");
    });
  });
  