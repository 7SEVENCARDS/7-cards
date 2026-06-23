// ─────────────────────────────────────────────────────────────────────────────
// Event Bus — Phase 6: Event-Driven Architecture
//
// Lightweight typed in-process event bus for Cloudflare Workers.
//
// Design:
//   • Synchronous dispatch — handlers are awaited in order.
//   • Persistence — every event is written to the event_log table.
//   • Non-fatal — handler errors are logged, not re-thrown.
//   • No external broker dependency — works entirely within the Worker isolate.
//
// Usage:
//   eventBus.emit({ type: "TradeCompleted", actorId: userId, entityId: tradeId,
//                   entityType: "trade", payload: { ... } });
//
//   eventBus.subscribe("TradeCompleted", async (event) => { ... });
// ─────────────────────────────────────────────────────────────────────────────

import type { DomainEvent, EventType } from "./events";
import type { SupabaseClient } from "@supabase/supabase-js";

type Handler<E extends DomainEvent> = (event: E, db: SupabaseClient) => Promise<void>;
type AnyHandler = (event: DomainEvent, db: SupabaseClient) => Promise<void>;

class EventBus {
  private readonly handlers = new Map<EventType, AnyHandler[]>();

  subscribe<T extends EventType>(
    type: T,
    handler: Handler<Extract<DomainEvent, { type: T }>>
  ): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as AnyHandler);
    this.handlers.set(type, list);
  }

  async emit(event: DomainEvent, db: SupabaseClient, traceId?: string): Promise<void> {
    // ── 1. Persist to event_log ───────────────────────────────────────────────
    try {
      await db.from("event_log").insert({
        event_type:  event.type,
        actor_id:    event.actorId ?? null,
        actor_type:  event.actorId ? "user" : "system",
        entity_type: event.entityType,
        entity_id:   event.entityId ?? null,
        payload:     event.payload,
        occurred_at: new Date().toISOString(),
        trace_id:    traceId ?? null,
      });
    } catch (e) {
      console.error(`[EventBus] Failed to persist event ${event.type}:`, e instanceof Error ? e.message : e);
    }

    // ── 2. Dispatch to registered handlers ────────────────────────────────────
    const handlers = this.handlers.get(event.type) ?? [];
    for (const handler of handlers) {
      try {
        await handler(event, db);
      } catch (e) {
        console.error(
          `[EventBus] Handler error for ${event.type}:`,
          e instanceof Error ? e.message : e
        );
      }
    }
  }

  async emitBatch(events: DomainEvent[], db: SupabaseClient, traceId?: string): Promise<void> {
    for (const event of events) {
      await this.emit(event, db, traceId);
    }
  }
}

// ─── Singleton — one bus per Worker isolate ───────────────────────────────────
export const eventBus = new EventBus();

// ─── Built-in handlers ────────────────────────────────────────────────────────

// Trust score recomputation on user events
eventBus.subscribe("UserVerified", async (event, db) => {
  const { entityId: userId } = event;
  await db.rpc("compute_user_trust_score", { p_user_id: userId }).catch((e: unknown) => {
    console.warn("[EventBus] Trust score recompute failed after UserVerified:", e instanceof Error ? e.message : e);
  });
});

eventBus.subscribe("TradeCompleted", async (event, db) => {
  const { payload } = event;
  if (payload.user_id) {
    await db.rpc("compute_user_trust_score", { p_user_id: payload.user_id }).catch((e: unknown) => {
      console.warn("[EventBus] Trust score recompute failed after TradeCompleted:", e instanceof Error ? e.message : e);
    });
  }
  if (payload.vendor_id) {
    await db.rpc("recalculate_vendor_score", { p_vendor_id: payload.vendor_id }).catch((e: unknown) => {
      console.warn("[EventBus] Vendor score recompute failed after TradeCompleted:", e instanceof Error ? e.message : e);
    });
  }
});

eventBus.subscribe("FraudDetected", async (event, db) => {
  const { payload } = event;
  // Write a high/critical risk assessment for the vendor
  const riskLevel = payload.verdict === "fraud_confirmed" ? "critical" : "high";
  await db.from("risk_assessments").insert({
    entity_type:  "vendor",
    entity_id:    payload.vendor_id,
    risk_level:   riskLevel,
    risk_score:   riskLevel === "critical" ? 90 : 65,
    signals: {
      fraud_verdict:         payload.verdict,
      deposit_forfeited_ngn: payload.deposit_forfeited_ngn,
      assignment_id:         payload.assignment_id,
    },
    notes:       `Auto-flagged by Immutable Truth Engine: ${payload.verdict}`,
    assessed_by: "system",
  }).catch((e: unknown) => {
    console.warn("[EventBus] Risk assessment insert failed after FraudDetected:", e instanceof Error ? e.message : e);
  });
});

export type { DomainEvent, EventType };
