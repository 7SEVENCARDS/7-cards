// ─────────────────────────────────────────────────────────────────────────────
// Dojah Identity Verification API Client
// Docs: https://docs.dojah.io
// Dashboard: https://app.dojah.io → Apps → API Keys
// Supports: BVN, NIN, CAC, Address, Liveness
// ─────────────────────────────────────────────────────────────────────────────

const DOJAH_BASE = "https://api.dojah.io";

function getDojahHeaders() {
  const appId = process.env.DOJAH_APP_ID;
  const secretKey = process.env.DOJAH_SECRET_KEY;

  if (!appId || appId.includes("YOUR_") || !secretKey || secretKey.includes("YOUR_")) {
    throw new Error("[Dojah] DOJAH_APP_ID and DOJAH_SECRET_KEY not configured");
  }

  return {
    AppId: appId,
    "X-SECRET-Key": secretKey,
    "Content-Type": "application/json",
  };
}

async function dojahFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${DOJAH_BASE}${path}`, {
    ...options,
    headers: {
      ...getDojahHeaders(),
      ...(options.headers || {}),
    },
  });

  const data = await res.json() as Record<string, unknown>;

  if (!res.ok || data.error) {
    const msg = (data.error as string) || (data.message as string) || `HTTP ${res.status}`;
    throw new Error(`[Dojah] ${path}: ${msg}`);
  }

  return data;
}

// ─── BVN Lookup ───────────────────────────────────────────────────────────────
export type BVNResult = {
  bvn: string;
  first_name: string;
  middle_name: string;
  last_name: string;
  date_of_birth: string;    // "DD-MM-YYYY"
  phone_number: string;
  phone_number2?: string;
  gender: string;
  image?: string;           // base64 passport photo
  enrollment_bank?: string;
  enrollment_branch?: string;
  level_of_account?: string;
  lga_of_origin?: string;
  lga_of_residence?: string;
  marital_status?: string;
  name_on_card?: string;
  nationality?: string;
  residential_address?: string;
  state_of_origin?: string;
  state_of_residence?: string;
  watch_listed?: string;
};

export async function lookupBVN(bvn: string): Promise<BVNResult> {
  const data = await dojahFetch(`/api/v1/kyc/bvn?bvn=${bvn}`) as {
    entity: BVNResult;
  };
  return data.entity;
}

// ─── NIN Lookup ───────────────────────────────────────────────────────────────
export type NINResult = {
  nin: string;
  first_name: string;
  middle_name?: string;
  last_name: string;
  date_of_birth: string;
  phone: string;
  gender: string;
  photo?: string;           // base64
  birthstate?: string;
  birthlga?: string;
  residence_state?: string;
  residence_lga?: string;
  residence_address?: string;
};

export async function lookupNIN(nin: string): Promise<NINResult> {
  const data = await dojahFetch(`/api/v1/kyc/nin?nin=${nin}`) as {
    entity: NINResult;
  };
  return data.entity;
}

// ─── Mask helpers (never expose raw BVN/NIN) ──────────────────────────────────
export function maskBVN(bvn: string): string {
  if (bvn.length < 7) return "***";
  return bvn.slice(0, 3) + "*".repeat(bvn.length - 6) + bvn.slice(-3);
}

export function maskNIN(nin: string): string {
  if (nin.length < 7) return "***";
  return nin.slice(0, 3) + "*".repeat(nin.length - 6) + nin.slice(-3);
}
