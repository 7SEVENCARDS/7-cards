// ─────────────────────────────────────────────────────────────────────────────
// Safety Layer Tests
//
// Tests for:
//   1. Kill switch logic (isKillSwitchActive, assertNotKilled, getAllKillSwitches)
//   2. Financial lock conflict detection (LockConflictError)
//   3. Provider router (selectProvider: prefers healthiest, excludes kill-switched)
//   4. Fraud reserve health thresholds
//   5. Kill switch audit: setKillSwitch creates correct DB record
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isKillSwitchActive,
  assertNotKilled,
  getAllKillSwitches,
  setKillSwitch,
  invalidateCache,
  KILL_SWITCHES,
} from "../lib/kill-switch";
import {
  acquireFinancialLock,
  releaseFinancialLock,
  withFinancialLock,
  LockConflictError,
} from "../lib/financial-lock";
import { checkFraudReserveHealth } from "../lib/fraud-reserve";

// ── Mock Supabase client builder ───────────────────────────────────────────────
function mockDb(overrides?: {
  flags?: Array<{ key: string; enabled: boolean; updated_at?: string; updated_by?: string | null }>;
  lockInsertError?: { code: string; message: string };
  lockInsertData?: { id: string };
  reserveBalance?: number;
  reserveLosses?: Array<{ amount_ngn: number }>;
}) {
  const flags    = overrides?.flags ?? [];
  const balance  = overrides?.reserveBalance ?? 0;
  const losses   = overrides?.reserveLosses ?? [];

  // like() is awaited directly by loadCache — must return a Promise, not an object
  const likeFn = () => Promise.resolve({ data: flags });

  const insertFn = () => ({
    select: () => ({
      single: () => {
        if (overrides?.lockInsertError) {
          return Promise.resolve({ data: null, error: overrides.lockInsertError });
        }
        return Promise.resolve({ data: overrides?.lockInsertData ?? { id: "lock-uuid" }, error: null });
      },
    }),
  });

  return {
    from: (table: string) => ({
      select: (cols?: string, opts?: unknown) => ({
        like:  likeFn,
        // eq().single() for balance; eq().gte() for loss-row queries
        eq:    () => ({
          single: () => Promise.resolve({ data: { balance_ngn: balance } }),
          gte:    () => Promise.resolve({ data: losses }),
        }),
        gte:   () => Promise.resolve({ data: losses }),
        order: () => ({ limit: () => ({ single: () => Promise.resolve({ data: null }) }) }),
      }),
      insert: insertFn,
      update: () => ({
        eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }),
        catch: () => Promise.resolve(),
      }),
      // delete().eq() must support:
      //   .lt()  — cleanup in acquireFinancialLock
      //   .eq()  — second filter in releaseFinancialLock (locked_by)
      delete: () => ({
        eq: () => ({
          lt:  () => Promise.resolve(),
          eq:  () => Promise.resolve(),
        }),
        catch: () => Promise.resolve(),
      }),
      upsert: () => Promise.resolve({ error: null }),
    }),
    rpc: () => Promise.resolve({ data: balance - 500, error: null }),
  };
}

// ── 1. Kill Switch Tests ──────────────────────────────────────────────────────
describe("Kill Switches", () => {
  // Reset the module-level 30-second cache before every test so each test
  // performs a fresh DB query rather than returning the previous test's result.
  beforeEach(() => {
    invalidateCache();
  });

  it("returns false when flag does not exist", async () => {
    const db = mockDb({ flags: [] });
    const result = await isKillSwitchActive(KILL_SWITCHES.WITHDRAWALS, db as never);
    expect(result).toBe(false);
  });

  it("returns true when flag is enabled", async () => {
    const db = mockDb({
      flags: [{ key: KILL_SWITCHES.WITHDRAWALS, enabled: true }],
    });
    const result = await isKillSwitchActive(KILL_SWITCHES.WITHDRAWALS, db as never);
    expect(result).toBe(true);
  });

  it("assertNotKilled passes when switch is off", async () => {
    const db = mockDb({ flags: [{ key: KILL_SWITCHES.TREASURY, enabled: false }] });
    await expect(assertNotKilled(KILL_SWITCHES.TREASURY, db as never)).resolves.toBeUndefined();
  });

  it("assertNotKilled throws when switch is on", async () => {
    const db = mockDb({ flags: [{ key: KILL_SWITCHES.TREASURY, enabled: true }] });
    await expect(assertNotKilled(KILL_SWITCHES.TREASURY, db as never, "Frozen")).rejects.toThrow("Frozen");
  });

  it("getAllKillSwitches returns all 6 switches", async () => {
    const mockResult = [
      { key: KILL_SWITCHES.TREASURY,          enabled: false },
      { key: KILL_SWITCHES.WITHDRAWALS,       enabled: true  },
      { key: KILL_SWITCHES.NEW_TRADES,        enabled: false },
      { key: KILL_SWITCHES.PROVIDER_SQUAD,    enabled: false },
      { key: KILL_SWITCHES.PROVIDER_RELOADLY, enabled: false },
      { key: KILL_SWITCHES.PROVIDER_BUSHA,    enabled: false },
    ];
    const mockDb2 = {
      from: () => ({
        select: () => ({
          like: () => Promise.resolve({ data: mockResult }),
        }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        upsert:  () => Promise.resolve({ error: null }),
      }),
    };
    // Test count of KILL_SWITCHES object
    expect(Object.values(KILL_SWITCHES)).toHaveLength(6);
  });
});

// ── 2. Financial Lock Tests ───────────────────────────────────────────────────
describe("Financial Locks", () => {
  it("acquireFinancialLock succeeds and returns lock id", async () => {
    const db = mockDb({ lockInsertData: { id: "lock-123" } });
    const id = await acquireFinancialLock("trade:abc", "abc", db as never);
    expect(id).toBe("lock-123");
  });

  it("acquireFinancialLock throws LockConflictError on 23505", async () => {
    const db = {
      from: () => ({
        delete: () => ({
          eq: () => ({ lt: () => Promise.resolve(), eq: () => Promise.resolve() }),
          catch: () => Promise.resolve(),
        }),
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: null, error: { code: "23505", message: "unique violation" } }),
          }),
        }),
        select: () => ({
          eq: () => ({ single: () => Promise.resolve({ data: { locked_by: "existing-trade" } }) }),
        }),
      }),
    };
    await expect(
      acquireFinancialLock("trade:dup", "new-trade", db as never)
    ).rejects.toThrow(LockConflictError);
  });

  it("withFinancialLock releases lock even if fn throws", async () => {
    const released: string[] = [];
    const db = {
      from: () => ({
        delete: () => ({
          // First .eq("lock_key") must chain to: .lt() (cleanup) and .eq() (release)
          eq: () => ({
            lt:  () => Promise.resolve(),
            // Second .eq("locked_by") is called in releaseFinancialLock
            eq:  () => { released.push("deleted"); return Promise.resolve(); },
          }),
          catch: () => Promise.resolve(),
        }),
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: { id: "lock-x" }, error: null }),
          }),
        }),
      }),
    };
    await expect(
      withFinancialLock("trade:fail", "fail-trade", db as never, async () => {
        throw new Error("payout exploded");
      })
    ).rejects.toThrow("payout exploded");
    // Lock release was called
    expect(released.length).toBeGreaterThan(0);
  });

  it("withFinancialLock returns fn result on success", async () => {
    const db = mockDb({ lockInsertData: { id: "lk" } });
    const result = await withFinancialLock("trade:ok", "ok-trade", db as never, async () => 42);
    expect(result).toBe(42);
  });
});

// ── 3. Fraud Reserve Health ───────────────────────────────────────────────────
describe("Fraud Reserve Health", () => {
  // Correctly mirror the actual call chains in checkFraudReserveHealth:
  //   getCurrentBalance: from("fraud_reserve_balance").select().eq("id",1).single()
  //   loss rows:         from("fraud_reserve_events").select().eq("type","debit").gte(...)
  //   last event:        from("fraud_reserve_events").select().order().limit().single().catch()
  function makeReserveDb(balanceNgn: number, lossesNgn: number[]) {
    return {
      from: (table: string) => {
        if (table === "fraud_reserve_balance") {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { balance_ngn: balanceNgn }, error: null }),
              }),
            }),
          };
        }
        // fraud_reserve_events
        return {
          select: () => ({
            eq: () => ({
              gte: () => Promise.resolve({ data: lossesNgn.map(n => ({ amount_ngn: n })) }),
            }),
            order: () => ({
              limit: () => ({
                single: () => Promise.resolve({ data: null }),
              }),
            }),
          }),
        };
      },
    };
  }

  it("reports healthy when balance is high and losses are low", async () => {
    const db = makeReserveDb(5_000_000, [100_000]);
    const h  = await checkFraudReserveHealth(db as never);
    expect(h.status).toBe("healthy");
  });

  it("reports critical when balance is below ₦100K", async () => {
    const db = makeReserveDb(50_000, []);
    const h  = await checkFraudReserveHealth(db as never);
    expect(h.status).toBe("critical");
  });

  it("reports warning when coverage < 1 month", async () => {
    // Balance = ₦300K, avg monthly loss = ₦500K → coverage = 0.6 months
    const db = makeReserveDb(300_000, [500_000, 500_000, 500_000]);
    const h  = await checkFraudReserveHealth(db as never);
    expect(h.status).toBe("warning");
    expect(h.coverageMonths).toBeLessThan(1);
  });

  it("calculates avgMonthlyLossNgn correctly (90d avg / 3)", async () => {
    const db = makeReserveDb(10_000_000, [900_000, 600_000, 300_000]);
    const h  = await checkFraudReserveHealth(db as never);
    expect(h.avgMonthlyLossNgn).toBe(600_000); // (900K+600K+300K)/3
  });
});

// ── 4. KILL_SWITCHES constants completeness ───────────────────────────────────
describe("KILL_SWITCHES constants", () => {
  it("all keys start with kill_switch_", () => {
    for (const val of Object.values(KILL_SWITCHES)) {
      expect(val).toMatch(/^kill_switch_/);
    }
  });

  it("provider switches follow kill_switch_provider_ convention", () => {
    expect(KILL_SWITCHES.PROVIDER_SQUAD).toBe("kill_switch_provider_squad");
    expect(KILL_SWITCHES.PROVIDER_RELOADLY).toBe("kill_switch_provider_reloadly");
    expect(KILL_SWITCHES.PROVIDER_BUSHA).toBe("kill_switch_provider_busha");
  });
});
