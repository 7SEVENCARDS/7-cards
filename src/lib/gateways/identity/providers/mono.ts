// ─────────────────────────────────────────────────────────────────────────────
// Mono Identity Provider Adapter
// Implements BVN/NIN lookup via Mono's KYC Lookup API.
// Docs:    https://docs.mono.co/identity
// API:     https://api.mono.co/v2/lookup/bvn  (POST)
//          https://api.mono.co/v2/lookup/nin  (POST)
// Env:     MONO_SECRET_KEY  (Bearer token — from Mono dashboard)
//
// PLACEHOLDER: Credentials not yet active. isConfigured() returns false until
// MONO_SECRET_KEY is set in GitHub Secrets / Cloudflare environment.
// ─────────────────────────────────────────────────────────────────────────────

import { getEnv } from "../../worker-env";
import { fetchWithTimeout } from "../../fetch-with-timeout";
import type {
  IdentityProvider,
  BVNLookupResult,
  NINLookupResult,
  IdentityMatchResult,
  PhoneVerifyResult,
  IdentityProviderName,
} from "../types";

const MONO_BASE = "https://api.mono.co";

function getMonoHeaders() {
  const secretKey = getEnv("MONO_SECRET_KEY");
  if (!secretKey || secretKey.includes("YOUR_")) {
    throw new Error("[Mono] MONO_SECRET_KEY not configured");
  }
  return {
    "mono-sec-key": secretKey,
    "Content-Type": "application/json",
  };
}

async function monoFetch(path: string, body: Record<string, unknown>) {
  const res = await fetchWithTimeout(`${MONO_BASE}${path}`, {
    method: "POST",
    headers: getMonoHeaders(),
    body: JSON.stringify(body),
  });

  const data = await res.json() as Record<string, unknown>;

  if (!res.ok || data.status === "error") {
    const msg = (data.message as string) || `HTTP ${res.status}`;
    throw new Error(`[Mono] ${path}: ${msg}`);
  }

  return data;
}

export class MonoIdentityProvider implements IdentityProvider {
  readonly name: IdentityProviderName = "mono";

  isConfigured(): boolean {
    const key = getEnv("MONO_SECRET_KEY");
    return !!(key && !key.includes("YOUR_") && key.length > 10);
  }

  async verifyBVN(bvn: string): Promise<BVNLookupResult> {
    // POST /v2/lookup/bvn
    // Body: { bvn, consent: "true" }
    const data = await monoFetch("/v2/lookup/bvn", {
      bvn,
      consent: "true",
    }) as {
      data: {
        bvn: string;
        firstname?: string;
        middlename?: string;
        lastname?: string;
        date_of_birth?: string;
        phone_number?: string;
        gender?: string;
        image?: string;
      };
    };

    const d = data.data;
    return {
      bvn: d.bvn,
      firstName: d.firstname ?? "",
      middleName: d.middlename,
      lastName: d.lastname ?? "",
      dateOfBirth: d.date_of_birth,
      phoneNumber: d.phone_number,
      gender: d.gender,
      photo: d.image,
    };
  }

  async verifyNIN(nin: string): Promise<NINLookupResult> {
    // POST /v2/lookup/nin
    // Body: { nin }
    const data = await monoFetch("/v2/lookup/nin", { nin }) as {
      data: {
        nin: string;
        firstname?: string;
        middlename?: string;
        lastname?: string;
        date_of_birth?: string;
        phone_number?: string;
        gender?: string;
        photo?: string;
      };
    };

    const d = data.data;
    return {
      nin: d.nin,
      firstName: d.firstname ?? "",
      middleName: d.middlename,
      lastName: d.lastname ?? "",
      dateOfBirth: d.date_of_birth,
      phoneNumber: d.phone_number,
      gender: d.gender,
      photo: d.photo,
    };
  }

  async matchIdentity(params: {
    firstName: string;
    lastName: string;
    dateOfBirth?: string;
    bvn?: string;
    nin?: string;
  }): Promise<IdentityMatchResult> {
    const norm = (s: string) =>
      s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z\s]/g, "").trim();

    const regTokens = new Set(
      `${params.firstName} ${params.lastName}`.split(/\s+/).map(norm).filter(Boolean)
    );

    let verifiedFirst = "";
    let verifiedLast = "";

    if (params.bvn) {
      const r = await this.verifyBVN(params.bvn);
      verifiedFirst = r.firstName;
      verifiedLast = r.lastName;
    } else if (params.nin) {
      const r = await this.verifyNIN(params.nin);
      verifiedFirst = r.firstName;
      verifiedLast = r.lastName;
    }

    const verifiedTokens = `${verifiedFirst} ${verifiedLast}`.split(/\s+/).map(norm).filter(Boolean);
    const shared = verifiedTokens.filter(t => regTokens.has(t)).length;
    const confidence = verifiedTokens.length ? shared / verifiedTokens.length : 0;

    return { match: confidence >= 0.5, confidence };
  }

  async verifyPhone(phone: string): Promise<PhoneVerifyResult> {
    // POST /v2/lookup/phone
    const data = await monoFetch("/v2/lookup/phone", { phone }) as {
      data: { valid?: boolean; carrier?: string; line_type?: string };
    };
    return {
      valid: data.data.valid ?? false,
      carrier: data.data.carrier,
      lineType: data.data.line_type,
    };
  }
}
