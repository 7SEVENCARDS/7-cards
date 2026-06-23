// ─────────────────────────────────────────────────────────────────────────────
// Dojah Identity Provider Adapter
// Wraps src/lib/dojah.ts behind the IdentityProvider interface.
// Docs: https://docs.dojah.io
// Env:  DOJAH_APP_ID, DOJAH_SECRET_KEY
// ─────────────────────────────────────────────────────────────────────────────

import { getEnv } from "../../../worker-env";
import type {
  IdentityProvider,
  BVNLookupResult,
  NINLookupResult,
  IdentityMatchResult,
  PhoneVerifyResult,
  IdentityProviderName,
} from "../types";

export class DojahProvider implements IdentityProvider {
  readonly name: IdentityProviderName = "dojah";

  isConfigured(): boolean {
    const appId = getEnv("DOJAH_APP_ID");
    const secretKey = getEnv("DOJAH_SECRET_KEY");
    return !!(
      appId && !appId.includes("YOUR_") &&
      secretKey && !secretKey.includes("YOUR_")
    );
  }

  async verifyBVN(bvn: string): Promise<BVNLookupResult> {
    const { lookupBVN } = await import("../../../dojah");
    const raw = await lookupBVN(bvn);
    return {
      bvn: raw.bvn,
      firstName: raw.first_name ?? "",
      middleName: raw.middle_name,
      lastName: raw.last_name ?? "",
      dateOfBirth: raw.date_of_birth,
      phoneNumber: raw.phone_number,
      gender: raw.gender,
      photo: raw.image,
    };
  }

  async verifyNIN(nin: string): Promise<NINLookupResult> {
    const { lookupNIN } = await import("../../../dojah");
    const raw = await lookupNIN(nin);
    return {
      nin: raw.nin,
      firstName: raw.first_name ?? "",
      middleName: raw.middle_name,
      lastName: raw.last_name ?? "",
      dateOfBirth: raw.date_of_birth,
      phoneNumber: raw.phone,
      gender: raw.gender,
      photo: raw.photo,
    };
  }

  async matchIdentity(params: {
    firstName: string;
    lastName: string;
    dateOfBirth?: string;
    bvn?: string;
    nin?: string;
  }): Promise<IdentityMatchResult> {
    // Dojah identity match is derived from the BVN/NIN lookup results.
    // If we already have a verified BVN/NIN result this is a local comparison.
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

  async verifyPhone(_phone: string): Promise<PhoneVerifyResult> {
    // Dojah phone verification (not yet used — implement when needed)
    throw new Error("[Dojah] verifyPhone not yet implemented");
  }
}
