// ─────────────────────────────────────────────────────────────────────────────
// Upload Security — Client-Side Utilities            Phase 15
//
// All validation happens BEFORE the file touches Supabase Storage, so
// malformed/oversized/wrong-type files are rejected instantly in-browser.
// ─────────────────────────────────────────────────────────────────────────────

// ── Constants ─────────────────────────────────────────────────────────────────

/** Absolute maximum bytes per card image (10 MB). */
export const MAX_FILE_BYTES = 10 * 1_024 * 1_024;

/** Allowed MIME types (browser-reported). */
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

/** Allowed file extensions (lower-case). */
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif"]);

/**
 * Magic-byte signatures for the file types we accept.
 * We read only the first 12 bytes to identify the format.
 */
const MAGIC: Array<{ label: string; offset: number; bytes: number[] }> = [
  // JPEG — FF D8 FF
  { label: "jpeg", offset: 0, bytes: [0xff, 0xd8, 0xff] },
  // PNG  — 89 50 4E 47 0D 0A 1A 0A
  { label: "png",  offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // WebP — RIFF????WEBP  (bytes 0-3 = 52 49 46 46, bytes 8-11 = 57 45 42 50)
  { label: "webp", offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  // HEIC / HEIF — ISO Base Media File Format: bytes 4-7 = "ftyp"
  { label: "heic", offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchesMagic(buf: Uint8Array, sig: { offset: number; bytes: number[] }): boolean {
  if (buf.length < sig.offset + sig.bytes.length) return false;
  return sig.bytes.every((b, i) => buf[sig.offset + i] === b);
}

function ext(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

/** Strip everything that could be used for path traversal or shell injection. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "image"; // strip any directory component
  return base
    .replace(/[^a-zA-Z0-9._-]/g, "_")  // allow only safe characters
    .replace(/\.{2,}/g, ".")            // collapse .. sequences
    .replace(/^\./, "_")                // don't start with a dot
    .slice(0, 120);                     // hard cap on length
}

// ── Main validator ────────────────────────────────────────────────────────────

export type UploadValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate a File before upload. Checks:
 *  1. File exists and is non-empty
 *  2. Size ≤ MAX_FILE_BYTES
 *  3. MIME type is in the allow-list
 *  4. Extension is in the allow-list
 *  5. Magic bytes match a known image format
 *
 * @param file - The browser File object to validate.
 */
export async function validateUploadFile(file: File): Promise<UploadValidationResult> {
  // 1. Non-empty
  if (!file || file.size === 0) {
    return { ok: false, error: "File is empty." };
  }

  // 2. Size limit
  if (file.size > MAX_FILE_BYTES) {
    const mb = (file.size / 1_048_576).toFixed(1);
    return { ok: false, error: `Image too large (${mb} MB). Maximum is 10 MB.` };
  }

  // 3. MIME type
  const mime = file.type.toLowerCase();
  if (mime && !ALLOWED_MIME.has(mime)) {
    return { ok: false, error: `File type "${mime}" is not allowed. Use JPEG, PNG, WebP, or HEIC.` };
  }

  // 4. Extension
  const fileExt = ext(file.name);
  if (fileExt && !ALLOWED_EXT.has(fileExt)) {
    return { ok: false, error: `File extension ".${fileExt}" is not allowed.` };
  }

  // 5. Magic bytes — read the first 12 bytes
  let header: Uint8Array;
  try {
    const slice = file.slice(0, 12);
    const buf   = await slice.arrayBuffer();
    header      = new Uint8Array(buf);
  } catch {
    return { ok: false, error: "Could not read file. Please try again." };
  }

  const matched = MAGIC.some(sig => matchesMagic(header, sig));
  if (!matched) {
    return {
      ok: false,
      error: "File content does not match an accepted image format. Use an original photo, not a screenshot of a file.",
    };
  }

  // Extra: for WebP, confirm bytes 8-11 = "WEBP"
  if (matchesMagic(header, MAGIC[2]) /* RIFF header */) {
    const webpMarker = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
    if (header.length >= 12) {
      const isWebp = webpMarker.every((b, i) => header[8 + i] === b);
      if (!isWebp) {
        return { ok: false, error: "RIFF file does not appear to be a valid WebP image." };
      }
    }
  }

  return { ok: true };
}

/**
 * Build a safe Supabase Storage path for a card image.
 * Format: `{userId}/{timestamp}_{index}_{sanitizedName}`
 */
export function buildStoragePath(userId: string, index: number, file: File): string {
  const safeName = sanitizeFilename(file.name);
  return `${userId}/${Date.now()}_${index}_${safeName}`;
}
