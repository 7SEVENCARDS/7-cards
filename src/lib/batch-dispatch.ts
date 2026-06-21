// ─────────────────────────────────────────────────────────────────────────────
// Batch Dispatch — Multi-Card Risk Distribution Engine
//
// Core guarantee: when a user submits N cards, each card goes to a DIFFERENT
// vendor (if N vendors are available). No vendor sees more than one card from
// the same batch.
//
// Strategy:
//   round_robin  — vendor[i % totalVendors] per card, fastest option
//   sequential   — 1 vendor; queue cards and release them one at a time so no
//                  vendor holds multiple live card codes simultaneously
//
// Called from submitCardBatch server function in trades.ts.
// directDispatchToVendor is in vendor-broadcast.ts (needs telegram + audit access).
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

export type EligibleVendor = {
  id: string;
  business_name: string;
  contact_name: string | null;
  telegram_chat_id: number;
  preferred_rate_ngn_per_usd: number | null;
};

// ─── 1. Fetch all vendors eligible for direct dispatch ────────────────────────
// Eligible = active status, has a Telegram chat_id, not in a rate-check convo,
// sorted by least-recently assigned (fairness / load balancing).
export async function getEligibleVendors(db: SupabaseClient): Promise<EligibleVendor[]> {
  const { data, error } = await db
    .from("vendors")
    .select("id, business_name, contact_name, telegram_chat_id, preferred_rate_ngn_per_usd")
    .eq("status", "active")
    .not("telegram_chat_id", "is", null)
    .is("telegram_bot_state", null) // not mid-conversation
    .order("last_assignment_at", { ascending: true, nullsFirst: true }) as {
      data: (EligibleVendor & { last_assignment_at: string | null })[] | null;
      error: unknown;
    };

  if (error || !data) {
    console.warn("[BatchDispatch] Failed to fetch eligible vendors:", error);
    return [];
  }

  return data;
}

// ─── 2. Pick strategy based on available vendor count ────────────────────────
export function getDispatchStrategy(
  vendorCount: number,
  cardCount: number
): "round_robin" | "sequential" {
  if (vendorCount === 0) throw new Error("No eligible vendors available");
  if (vendorCount === 1) return "sequential";
  // Even if vendors < cards, still round_robin (cards will cycle back, but
  // each card still starts at a different vendor position)
  return "round_robin";
}

// ─── 3. Assign vendors to card slots ─────────────────────────────────────────
// Returns an array of the same length as cards, each slot having one vendor.
// Round-robin: card[0]→vendor[0], card[1]→vendor[1], card[2]→vendor[0], …
// Sequential: all cards get the same (only) vendor, but cards 1..N-1 are queued.
export function assignVendorsToCards(
  vendors: EligibleVendor[],
  cardCount: number,
  strategy: "round_robin" | "sequential"
): Array<{ vendor: EligibleVendor; queued: boolean }> {
  if (vendors.length === 0) throw new Error("No eligible vendors");

  if (strategy === "sequential") {
    const v = vendors[0];
    return Array.from({ length: cardCount }, (_, i) => ({
      vendor: v,
      queued: i > 0, // only first card dispatched immediately; rest queued
    }));
  }

  // Round-robin: spread across available vendors
  // Guarantee: no vendor gets a second card until every other vendor has one
  return Array.from({ length: cardCount }, (_, i) => ({
    vendor: vendors[i % vendors.length],
    queued: false,
  }));
}

// ─── 4. Mark vendor as assigned (update last_assignment_at for fairness) ──────
export async function recordVendorAssignment(
  db: SupabaseClient,
  vendorId: string
): Promise<void> {
  await db
    .from("vendors")
    .update({ last_assignment_at: new Date().toISOString() } as Record<string, unknown>)
    .eq("id", vendorId)
    .catch((e: Error) =>
      console.warn("[BatchDispatch] Failed to update last_assignment_at:", e.message)
    );
}

// ─── 5. Result types for submitCardBatch ─────────────────────────────────────
export type BatchCardInput = {
  cardCode: string;
  cardPin?: string;
};

export type BatchCardResult = {
  position: number;           // 1-based card index
  tradeId: string | null;
  status: "verified" | "queued" | "failed";
  failureReason?: string;
  assignedVendorName?: string;
  assignedVendorId?: string;
  amountNgn: number;
};

export type BatchResult = {
  batchId: string;
  strategy: "round_robin" | "sequential";
  vendorCount: number;
  cards: BatchCardResult[];
  verifiedCount: number;
  failedCount: number;
  queuedCount: number;
};
