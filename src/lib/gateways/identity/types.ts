// ─────────────────────────────────────────────────────────────────────────────
// Identity Gateway — Shared Types & Provider Interface
// All identity providers must implement IdentityProvider.
// Business logic must only depend on these types, never on provider internals.
// ─────────────────────────────────────────────────────────────────────────────

export type IdentityProviderName = "mono" | "dojah" | "prembly" | "verifyme";

// ── Normalised result types ───────────────────────────────────────────────────

export type BVNLookupResult = {
  bvn: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  dateOfBirth?: string;
  phoneNumber?: string;
  gender?: string;
  photo?: string;
};

export type NINLookupResult = {
  nin: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  dateOfBirth?: string;
  phoneNumber?: string;
  gender?: string;
  photo?: string;
};

export type IdentityMatchResult = {
  match: boolean;
  confidence: number;
  details?: Record<string, unknown>;
};

export type PhoneVerifyResult = {
  valid: boolean;
  carrier?: string;
  lineType?: string;
};

// ── Gateway response wrapper ──────────────────────────────────────────────────

export type GatewayResult<T> = {
  ok: true;
  data: T;
  provider: IdentityProviderName;
  reference?: string;
  latencyMs: number;
  failover: boolean;
} | {
  ok: false;
  error: string;
  provider: IdentityProviderName;
  latencyMs: number;
  failover: boolean;
};

// ── Provider interface contract ───────────────────────────────────────────────
// Every provider adapter must implement this interface exactly.
// Adding a new provider = writing one new class that implements IdentityProvider.

export interface IdentityProvider {
  readonly name: IdentityProviderName;

  /** Returns true if the credentials are configured for this provider. */
  isConfigured(): boolean;

  verifyBVN(bvn: string): Promise<BVNLookupResult>;
  verifyNIN(nin: string): Promise<NINLookupResult>;
  matchIdentity(params: {
    firstName: string;
    lastName: string;
    dateOfBirth?: string;
    bvn?: string;
    nin?: string;
  }): Promise<IdentityMatchResult>;
  verifyPhone(phone: string): Promise<PhoneVerifyResult>;
}

// ── Audit record (written to provider_operation_log) ─────────────────────────

export type ProviderOperationLog = {
  gateway: "identity" | "payment";
  provider: string;
  operation: string;
  reference?: string;
  requestId: string;
  success: boolean;
  failover: boolean;
  latencyMs: number;
  errorMessage?: string;
  userId?: string;
};
