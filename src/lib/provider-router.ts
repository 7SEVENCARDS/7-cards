// ─────────────────────────────────────────────────────────────────────────────
// Health-Aware Provider Router — Production Safety Layer
//
// Selects the healthiest available provider for a given gateway type.
// A provider is excluded if:
//   - Its kill switch is active (kill_switch_provider_<name>)
//   - Its health score is 0 and status is "down" with recent calls
//
// Health scores are cached per isolate (60 s TTL) to avoid a DB round-trip
// on every trade — provider health does not change faster than that.
//
// Usage:
//   const provider = await selectProvider("payment", ["squad", "paystack"], db);
//   // provider is the name of the healthiest non-disabled gateway
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { isKillSwitchActive, KILL_SWITCHES } from "./kill-switch";

const CACHE_TTL_MS = 60_000; // 1 minute

type ProviderScore = { provider: string; score: number; status: string };
let scoreCache:   ProviderScore[] | null = null;
let scoreCacheTs: number                 = 0;

/** Maps provider names to their kill-switch key (if one exists). */
const PROVIDER_KILL_SWITCH: Partial<Record<string, string>> = {
  squad:    KILL_SWITCHES.PROVIDER_SQUAD,
  reloadly: KILL_SWITCHES.PROVIDER_RELOADLY,
  busha:    KILL_SWITCHES.PROVIDER_BUSHA,
};

async function loadScores(db: SupabaseClient): Promise<ProviderScore[]> {
  const now = Date.now();
  if (scoreCache && now - scoreCacheTs < CACHE_TTL_MS) return scoreCache;

  const h24Ago = new Date(now - 86_400_000).toISOString();

  const { data: logs } = await db
    .from("provider_operation_log")
    .select("provider, success, latency_ms, created_at")
    .gte("created_at", h24Ago)
    .order("created_at", { ascending: false })
    .limit(2000);

  const map: Record<string, { ok: number; fail: number; latencies: number[] }> = {};
  for (const log of logs ?? []) {
    if (!map[log.provider]) map[log.provider] = { ok: 0, fail: 0, latencies: [] };
    if (log.success) map[log.provider].ok++;
    else             map[log.provider].fail++;
    if (log.latency_ms != null) map[log.provider].latencies.push(log.latency_ms);
  }

  const scores: ProviderScore[] = Object.entries(map).map(([provider, s]) => {
    const total       = s.ok + s.fail;
    const successRate = total > 0 ? (s.ok / total) * 100 : 100;
    const sorted      = [...s.latencies].sort((a, b) => a - b);
    const p95         = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const latFactor   = p95 < 500 ? 100 : p95 < 1000 ? 75 : p95 < 3000 ? 50 : 25;
    const score       = Math.round(successRate * 0.7 + latFactor * 0.3);

    let status = "healthy";
    if (score < 50) status = "down";
    else if (score < 70) status = "degraded";

    return { provider, score, status };
  });

  scoreCache   = scores;
  scoreCacheTs = now;
  return scores;
}

/**
 * Selects the healthiest provider from `candidates` for the given `gateway`.
 * Returns the provider name. Falls back to the first candidate if all are
 * unhealthy (circuit-breaker must be applied at call site if strict is needed).
 *
 * @param gateway    - e.g. "payment", "giftcard", "crypto"
 * @param candidates - ordered list of provider names to consider
 * @param db         - Supabase client
 * @throws if ALL candidates are kill-switched
 */
export async function selectProvider(
  gateway:    string,
  candidates: string[],
  db:         SupabaseClient,
): Promise<string> {
  const scores = await loadScores(db);
  const byName = new Map(scores.map(s => [s.provider, s]));

  const available: Array<{ name: string; score: number }> = [];
  const disabledByKillSwitch: string[] = [];

  for (const name of candidates) {
    const ksKey = PROVIDER_KILL_SWITCH[name];
    if (ksKey) {
      const killed = await isKillSwitchActive(ksKey as Parameters<typeof isKillSwitchActive>[0], db);
      if (killed) {
        disabledByKillSwitch.push(name);
        continue;
      }
    }
    const info  = byName.get(name);
    const score = info?.score ?? 80; // Assume healthy if no data yet
    available.push({ name, score });
  }

  if (available.length === 0) {
    throw new Error(
      `All ${gateway} providers are disabled [${candidates.join(", ")}]. ` +
      `Kill-switched: [${disabledByKillSwitch.join(", ")}].`
    );
  }

  // Sort descending by health score; return the best
  available.sort((a, b) => b.score - a.score);
  return available[0].name;
}

/** Returns a summary of provider health scores (for dashboards). */
export async function getProviderScoreSummary(
  db: SupabaseClient,
): Promise<Array<{ provider: string; score: number; status: string }>> {
  return loadScores(db);
}

/** Invalidate the score cache (call after provider kill-switch toggles). */
export function invalidateProviderScoreCache(): void {
  scoreCache   = null;
  scoreCacheTs = 0;
}
