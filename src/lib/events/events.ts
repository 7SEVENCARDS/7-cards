// ─────────────────────────────────────────────────────────────────────────────
// Domain Event Definitions — Phase 6: Event-Driven Architecture
//
// Every significant business event in the platform has a canonical type here.
// The event bus emits these; subscribers react. The event_log table persists
// them as the immutable source of truth.
// ─────────────────────────────────────────────────────────────────────────────

export type ActorType = "user" | "vendor" | "admin" | "system";
export type EntityType = "user" | "vendor" | "trade" | "wallet" | "settlement" | "notification" | "feature_flag";

// ─── Event payloads ───────────────────────────────────────────────────────────

export interface UserRegisteredPayload {
  email: string;
  role: string;
  referral_code?: string;
}

export interface UserVerifiedPayload {
  kyc_status: "approved" | "rejected";
  verified_by: string;
}

export interface VendorApprovedPayload {
  vendor_id: string;
  business_name: string;
  approved_by: string;
}

export interface VendorSuspendedPayload {
  vendor_id: string;
  reason: string;
  suspended_by: string;
  deposit_forfeited?: number;
}

export interface TradeCreatedPayload {
  trade_id: string;
  brand: string;
  amount_usd: number;
  amount_ngn: number;
  payout_method: string;
  user_id: string;
}

export interface TradeAssignedPayload {
  trade_id: string;
  vendor_id: string;
  assignment_id: string;
}

export interface TradeAcceptedPayload {
  trade_id: string;
  vendor_id: string;
  assignment_id: string;
}

export interface TradeRejectedPayload {
  trade_id: string;
  vendor_id: string;
  assignment_id: string;
  reason?: string;
}

export interface TradeCompletedPayload {
  trade_id: string;
  amount_ngn: number;
  payout_method: string;
  vendor_id?: string;
}

export interface SettlementCreatedPayload {
  trade_id: string;
  amount_ngn: number;
  payout_method: string;
  reference: string;
}

export interface SettlementCompletedPayload {
  trade_id: string;
  amount_ngn: number;
  reference: string;
  provider: string;
}

export interface SettlementFailedPayload {
  trade_id: string;
  reference: string;
  error: string;
  will_retry: boolean;
}

export interface WalletCreditedPayload {
  user_id: string;
  currency: string;
  amount: number;
  balance_after: number;
  ref_type: string;
}

export interface WalletDebitedPayload {
  user_id: string;
  currency: string;
  amount: number;
  balance_after: number;
  ref_type: string;
}

export interface NotificationSentPayload {
  user_id: string;
  channel: "telegram" | "push" | "email" | "in_app";
  title: string;
}

export interface FraudDetectedPayload {
  vendor_id: string;
  assignment_id: string;
  verdict: "fraud_confirmed" | "system_error" | "inconclusive";
  deposit_forfeited_ngn: number;
}

export interface RiskFlaggedPayload {
  entity_type: EntityType;
  entity_id: string;
  risk_level: "low" | "medium" | "high" | "critical";
  signals: Record<string, unknown>;
}

export interface FeatureFlagChangedPayload {
  flag_key: string;
  old_enabled: boolean;
  new_enabled: boolean;
  changed_by: string;
}

export interface ReconciliationRunPayload {
  run_id: string;
  status: "completed" | "failed" | "partial";
  total_issues: number;
  unreconciled_trades: number;
  wallet_discrepancies: number;
}

// ─── Discriminated union of all event types ───────────────────────────────────

export type DomainEvent =
  | { type: "UserRegistered";        actorId: string | null; entityId: string; entityType: "user";         payload: UserRegisteredPayload }
  | { type: "UserVerified";          actorId: string | null; entityId: string; entityType: "user";         payload: UserVerifiedPayload }
  | { type: "VendorApproved";        actorId: string | null; entityId: string; entityType: "vendor";       payload: VendorApprovedPayload }
  | { type: "VendorSuspended";       actorId: string | null; entityId: string; entityType: "vendor";       payload: VendorSuspendedPayload }
  | { type: "TradeCreated";          actorId: string | null; entityId: string; entityType: "trade";        payload: TradeCreatedPayload }
  | { type: "TradeAssigned";         actorId: string | null; entityId: string; entityType: "trade";        payload: TradeAssignedPayload }
  | { type: "TradeAccepted";         actorId: string | null; entityId: string; entityType: "trade";        payload: TradeAcceptedPayload }
  | { type: "TradeRejected";         actorId: string | null; entityId: string; entityType: "trade";        payload: TradeRejectedPayload }
  | { type: "TradeCompleted";        actorId: string | null; entityId: string; entityType: "trade";        payload: TradeCompletedPayload }
  | { type: "SettlementCreated";     actorId: string | null; entityId: string; entityType: "settlement";   payload: SettlementCreatedPayload }
  | { type: "SettlementCompleted";   actorId: string | null; entityId: string; entityType: "settlement";   payload: SettlementCompletedPayload }
  | { type: "SettlementFailed";      actorId: string | null; entityId: string; entityType: "settlement";   payload: SettlementFailedPayload }
  | { type: "WalletCredited";        actorId: string | null; entityId: string; entityType: "wallet";       payload: WalletCreditedPayload }
  | { type: "WalletDebited";         actorId: string | null; entityId: string; entityType: "wallet";       payload: WalletDebitedPayload }
  | { type: "NotificationSent";      actorId: string | null; entityId: string; entityType: "notification"; payload: NotificationSentPayload }
  | { type: "FraudDetected";         actorId: string | null; entityId: string; entityType: "vendor";       payload: FraudDetectedPayload }
  | { type: "RiskFlagged";           actorId: string | null; entityId: string; entityType: EntityType;     payload: RiskFlaggedPayload }
  | { type: "FeatureFlagChanged";    actorId: string | null; entityId: string; entityType: "feature_flag"; payload: FeatureFlagChangedPayload }
  | { type: "ReconciliationRun";     actorId: string | null; entityId: string; entityType: "settlement";   payload: ReconciliationRunPayload };

export type EventType = DomainEvent["type"];
