// ─────────────────────────────────────────────────────────────────────────────
// Input Validation & Sanitization Utilities
//
// All helpers throw a 422-coded Error on invalid input so TanStack Start's
// error boundary surfaces a clear message and never writes garbage to the DB.
// ─────────────────────────────────────────────────────────────────────────────

function badInput(msg: string): Error {
  const e = new Error(msg);
  (e as Error & { statusCode: number }).statusCode = 422;
  return e;
}

// ─── String helpers ───────────────────────────────────────────────────────────

/**
 * Trim + enforce length. Returns the cleaned string.
 * Throws 422 if missing or too long.
 */
export function sanitizeStr(
  value: unknown,
  maxLen: number,
  fieldName = "field",
  { required = true } = {},
): string {
  if (value === undefined || value === null || value === "") {
    if (!required) return "";
    throw badInput(`${fieldName} is required`);
  }
  if (typeof value !== "string") throw badInput(`${fieldName} must be a string`);
  const s = value.trim();
  if (required && s.length === 0) throw badInput(`${fieldName} is required`);
  if (s.length > maxLen) throw badInput(`${fieldName} must be at most ${maxLen} characters`);
  return s;
}

/**
 * Like sanitizeStr but strips everything except alphanumeric + dash + space.
 * Good for gift-card codes, referral codes, etc.
 */
export function sanitizeCode(
  value: unknown,
  maxLen: number,
  fieldName = "code",
): string {
  const s = sanitizeStr(value, maxLen, fieldName);
  return s.replace(/[^A-Za-z0-9\-\s]/g, "").trim();
}

// ─── UUID ─────────────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: unknown, fieldName = "id"): string {
  const s = sanitizeStr(value, 36, fieldName);
  if (!UUID_RE.test(s)) throw badInput(`${fieldName} is not a valid identifier`);
  return s.toLowerCase();
}

// ─── Email ────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

export function assertEmail(value: unknown, fieldName = "email"): string {
  const s = sanitizeStr(value, 254, fieldName);
  if (!EMAIL_RE.test(s)) throw badInput(`${fieldName} is not a valid email address`);
  return s.toLowerCase();
}

// ─── Phone ────────────────────────────────────────────────────────────────────
// Accepts Nigerian formats: 080xxxxxxxx, 070xxxxxxxx, +234xxxxxxxxxx, etc.

const PHONE_RE = /^(\+?234|0)[789][01]\d{7,8}$/;

export function assertPhone(value: unknown, fieldName = "phone"): string {
  const raw = sanitizeStr(value, 20, fieldName);
  const cleaned = raw.replace(/[\s\-().]/g, "");
  if (!PHONE_RE.test(cleaned)) {
    throw badInput(`${fieldName} must be a valid Nigerian phone number (e.g. 08012345678)`);
  }
  return cleaned;
}

// ─── Numeric amounts ──────────────────────────────────────────────────────────

/**
 * Assert a positive numeric amount within an optional ceiling.
 * maxNgn defaults to ₦5,000,000 (platform's single-trade cap).
 */
export function assertAmount(
  value: unknown,
  maxValue = 5_000_000,
  fieldName = "amount",
): number {
  const n = typeof value === "string" ? parseFloat(value) : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw badInput(`${fieldName} must be a positive number`);
  }
  if (n > maxValue) {
    throw badInput(`${fieldName} exceeds the maximum allowed value (${maxValue.toLocaleString()})`);
  }
  return n;
}

/**
 * Assert a whole number (integer) within bounds. Good for page numbers, limits.
 */
export function assertInt(
  value: unknown,
  min = 1,
  max = 1000,
  fieldName = "value",
): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min || n > max) {
    throw badInput(`${fieldName} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

// ─── Enum ─────────────────────────────────────────────────────────────────────

export function assertOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fieldName = "value",
): T {
  if (!allowed.includes(value as T)) {
    throw badInput(`${fieldName} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

// ─── BVN / NIN ────────────────────────────────────────────────────────────────

export function assertBvn(value: unknown, fieldName = "BVN"): string {
  const s = sanitizeStr(value, 11, fieldName).replace(/\s/g, "");
  if (!/^\d{11}$/.test(s)) throw badInput(`${fieldName} must be exactly 11 digits`);
  return s;
}

export function assertNin(value: unknown, fieldName = "NIN"): string {
  const s = sanitizeStr(value, 11, fieldName).replace(/\s/g, "");
  if (!/^\d{11}$/.test(s)) throw badInput(`${fieldName} must be exactly 11 digits`);
  return s;
}

// ─── Password ─────────────────────────────────────────────────────────────────

export function assertPassword(value: unknown, fieldName = "password"): string {
  const s = sanitizeStr(value, 128, fieldName);
  if (s.length < 8) throw badInput(`${fieldName} must be at least 8 characters`);
  return s;
}
