import { describe, it, expect } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Trade Lifecycle Integration Tests — GAP 6
// Pure logic tests extracted from server-functions — no live DB, no Worker
// runtime, no Supabase calls. Pattern mirrors business-logic.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. Status machine transitions ─────────────────────────────────────────────

type TradeStatus =
  | "pending"
  | "scanning"
  | "pending_review"
  | "verified"
  | "processing"
  | "paid"
  | "failed"
  | "invalid";

const VALID_TRANSITIONS: ReadonlyMap<TradeStatus, ReadonlySet<TradeStatus>> = new Map([
  ["pending",        new Set<TradeStatus>(["scanning", "invalid"])],
  ["scanning",       new Set<TradeStatus>(["pending_review", "verified", "invalid", "failed"])],
  ["pending_review", new Set<TradeStatus>(["verified", "invalid", "failed"])],
  ["verified",       new Set<TradeStatus>(["processing"])],
  ["processing",     new Set<TradeStatus>(["paid", "failed"])],
  ["paid",           new Set<TradeStatus>()],
  ["failed",         new Set<TradeStatus>()],
  ["invalid",        new Set<TradeStatus>()],
]);

function canTransition(from: TradeStatus, to: TradeStatus): boolean {
  return VALID_TRANSITIONS.get(from)?.has(to) ?? false;
}

describe("Status machine transitions", () => {
  // Valid forward path
  it("pending → scanning is valid", () => expect(canTransition("pending", "scanning")).toBe(true));
  it("scanning → verified is valid", () => expect(canTransition("scanning", "verified")).toBe(true));
  it("verified → processing is valid", () => expect(canTransition("verified", "processing")).toBe(true));
  it("processing → paid is valid", () => expect(canTransition("processing", "paid")).toBe(true));
  it("processing → failed is valid", () => expect(canTransition("processing", "failed")).toBe(true));
  it("scanning → pending_review is valid", () => expect(canTransition("scanning", "pending_review")).toBe(true));
  it("pending_review → verified is valid", () => expect(canTransition("pending_review", "verified")).toBe(true));

  // Invalid / backward transitions
  it("paid → verified is INVALID (no reversal)", () => expect(canTransition("paid", "verified")).toBe(false));
  it("processing → scanning is INVALID (no backward)", () => expect(canTransition("processing", "scanning")).toBe(false));
  it("paid → processing is INVALID (terminal)", () => expect(canTransition("paid", "processing")).toBe(false));
  it("failed → paid is INVALID (terminal)", () => expect(canTransition("failed", "paid")).toBe(false));
  it("invalid → verified is INVALID (terminal)", () => expect(canTransition("invalid", "verified")).toBe(false));
  it("paid → paid is INVALID (self-loop on terminal)", () => expect(canTransition("paid", "paid")).toBe(false));
  it("verified → paid is INVALID (must go through processing)", () => expect(canTransition("verified", "paid")).toBe(false));
});

// ── 2. Trade limit enforcement by tier ───────────────────────────────────────

type UserTier = "unverified" | "email" | "kyc" | "premium";

const TIER_LIMITS_USD: Record<UserTier, number> = {
  unverified: 200,
  email:      500,
  kyc:       5000,
  premium:  10000,
};

function checkTradeLimit(
  tier: UserTier,
  tradeAmountUsd: number,
): { allowed: boolean; reason?: string } {
  const limit = TIER_LIMITS_USD[tier];
  if (tradeAmountUsd > limit) {
    return {
      allowed: false,
      reason: `Trade amount $${tradeAmountUsd} exceeds ${tier} tier limit of $${limit}`,
    };
  }
  return { allowed: true };
}

describe("Trade limit enforcement by tier", () => {
  it("unverified user at exactly $200 is allowed", () =>
    expect(checkTradeLimit("unverified", 200).allowed).toBe(true));
  it("unverified user at $201 (101% of limit) is rejected", () =>
    expect(checkTradeLimit("unverified", 201).allowed).toBe(false));

  it("email user at exactly $500 is allowed", () =>
    expect(checkTradeLimit("email", 500).allowed).toBe(true));
  it("email user at $501 (101% of limit) is rejected", () =>
    expect(checkTradeLimit("email", 501).allowed).toBe(false));

  it("KYC user at exactly $5000 is allowed", () =>
    expect(checkTradeLimit("kyc", 5000).allowed).toBe(true));
  it("KYC user at $5001 (101% of limit) is rejected", () =>
    expect(checkTradeLimit("kyc", 5001).allowed).toBe(false));

  it("premium user at exactly $10000 is allowed", () =>
    expect(checkTradeLimit("premium", 10000).allowed).toBe(true));
  it("premium user at $10001 (101% of limit) is rejected", () =>
    expect(checkTradeLimit("premium", 10001).allowed).toBe(false));

  it("rejection includes a reason string", () => {
    const result = checkTradeLimit("unverified", 300);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/exceeds/i);
  });
});

// ── 3. Vendor score calculation ───────────────────────────────────────────────

interface VendorScoreInput {
  completionRate: number;  // 0–1
  accuracyRate:   number;  // 0–1
  totalRedeemed:  number;
}

type VendorTier = "Bronze" | "Silver" | "Gold" | "Platinum";

function calcVendorScore(input: VendorScoreInput): number {
  // Formula mirrors vendors.ts scoring: completion 50% weight, accuracy 50%
  const score = (input.completionRate * 50) + (input.accuracyRate * 50);
  return Math.round(score * 10) / 10;
}

function scoreToTier(score: number): VendorTier {
  if (score >= 90) return "Platinum";
  if (score >= 75) return "Gold";
  if (score >= 60) return "Silver";
  return "Bronze";
}

describe("Vendor score calculation", () => {
  it("100% completion + 100% accuracy = score 100 → Platinum", () => {
    const score = calcVendorScore({ completionRate: 1, accuracyRate: 1, totalRedeemed: 10 });
    expect(score).toBe(100);
    expect(scoreToTier(score)).toBe("Platinum");
  });

  it("0% accuracy rate → score 0 → Bronze", () => {
    const score = calcVendorScore({ completionRate: 0, accuracyRate: 0, totalRedeemed: 0 });
    expect(score).toBe(0);
    expect(scoreToTier(score)).toBe("Bronze");
  });

  it("90% completion + 90% accuracy = score 90 → Platinum boundary", () => {
    const score = calcVendorScore({ completionRate: 0.9, accuracyRate: 0.9, totalRedeemed: 5 });
    expect(score).toBe(90);
    expect(scoreToTier(score)).toBe("Platinum");
  });

  it("score 89 → Gold (just below Platinum)", () => {
    expect(scoreToTier(89)).toBe("Gold");
  });

  it("score 75 → Gold boundary", () => {
    expect(scoreToTier(75)).toBe("Gold");
  });

  it("score 74 → Silver (just below Gold)", () => {
    expect(scoreToTier(74)).toBe("Silver");
  });

  it("score 60 → Silver boundary", () => {
    expect(scoreToTier(60)).toBe("Silver");
  });

  it("score 59 → Bronze (just below Silver)", () => {
    expect(scoreToTier(59)).toBe("Bronze");
  });
});

// ── 4. Batch dispatch uniqueness ──────────────────────────────────────────────

interface MockVendor { id: string; score: number }
interface MockCard   { id: string; brand: string }

/**
 * Assign each card to a unique vendor (round-robin by score).
 * Returns a map of cardId → vendorId. Throws if |cards| > |vendors|.
 */
function dispatchBatch(
  vendors: MockVendor[],
  cards: MockCard[],
): Map<string, string> {
  if (cards.length > vendors.length) {
    throw new Error("Insufficient vendors for batch size");
  }
  // Sort vendors by score desc (highest first)
  const ranked = [...vendors].sort((a, b) => b.score - a.score);
  const assignments = new Map<string, string>();
  cards.forEach((card, i) => {
    assignments.set(card.id, ranked[i].id);
  });
  return assignments;
}

describe("Batch dispatch uniqueness", () => {
  const vendors: MockVendor[] = [
    { id: "v1", score: 95 },
    { id: "v2", score: 80 },
    { id: "v3", score: 70 },
  ];
  const cards: MockCard[] = [
    { id: "c1", brand: "Amazon" },
    { id: "c2", brand: "iTunes" },
    { id: "c3", brand: "Google Play" },
  ];

  it("each card is assigned to a different vendor (no duplicates)", () => {
    const assignments = dispatchBatch(vendors, cards);
    const assignedVendors = [...assignments.values()];
    const uniqueVendors = new Set(assignedVendors);
    expect(uniqueVendors.size).toBe(cards.length);
  });

  it("highest-scoring vendor gets the first card", () => {
    const assignments = dispatchBatch(vendors, cards);
    expect(assignments.get("c1")).toBe("v1");
  });

  it("throws when there are more cards than vendors", () => {
    const tooManyCards: MockCard[] = [
      { id: "c1", brand: "A" }, { id: "c2", brand: "B" },
      { id: "c3", brand: "C" }, { id: "c4", brand: "D" },
    ];
    expect(() => dispatchBatch(vendors, tooManyCards)).toThrow("Insufficient vendors");
  });

  it("1-card batch assigns to the highest-scoring vendor", () => {
    const assignments = dispatchBatch(vendors, [{ id: "c1", brand: "Amazon" }]);
    expect(assignments.get("c1")).toBe("v1");
  });
});

// ── 5. Atomic CAS guard on processPayout ─────────────────────────────────────

/**
 * Models the DB-level CAS used in processPayout.
 * `rowsUpdated` simulates the response from:
 *   UPDATE trades SET status='processing' WHERE id=? AND status='verified' → returning rows
 */
async function processPayout(
  tradeId: string,
  dbCas: (id: string, expectedStatus: string) => Promise<{ rowsUpdated: number }>,
  squadPayout: (id: string) => Promise<void>,
): Promise<{ success: boolean; reason?: string }> {
  const { rowsUpdated } = await dbCas(tradeId, "verified");

  if (rowsUpdated === 0) {
    // CAS lost — another request already grabbed this trade or status changed
    return { success: false, reason: "Trade already processing or not eligible" };
  }

  // CAS won — proceed to provider
  await squadPayout(tradeId);
  return { success: true };
}

describe("Atomic CAS guard — processPayout", () => {
  it("calls Squad payout when CAS wins (1 row updated)", async () => {
    let squadCalled = false;
    const cas = async () => ({ rowsUpdated: 1 });
    const squad = async () => { squadCalled = true; };

    const result = await processPayout("t1", cas, squad);
    expect(result.success).toBe(true);
    expect(squadCalled).toBe(true);
  });

  it("does NOT call Squad payout when CAS loses (0 rows updated)", async () => {
    let squadCalled = false;
    const cas = async () => ({ rowsUpdated: 0 });
    const squad = async () => { squadCalled = true; };

    const result = await processPayout("t1", cas, squad);
    expect(result.success).toBe(false);
    expect(squadCalled).toBe(false);
    expect(result.reason).toMatch(/already processing/i);
  });

  it("two concurrent requests — only one Squad payout fired", async () => {
    let dbStatus = "verified";
    let squadCallCount = 0;

    // Simulates atomic UPDATE ... WHERE status='verified'
    const cas = async (_id: string, expected: string) => {
      if (dbStatus === expected) {
        dbStatus = "processing"; // atomic transition
        return { rowsUpdated: 1 };
      }
      return { rowsUpdated: 0 };
    };
    const squad = async () => { squadCallCount++; };

    const [r1, r2] = await Promise.all([
      processPayout("t1", cas, squad),
      processPayout("t1", cas, squad),
    ]);

    expect(squadCallCount).toBe(1);
    const winners = [r1, r2].filter((r) => r.success);
    expect(winners).toHaveLength(1);
  });
});
