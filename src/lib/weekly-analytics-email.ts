// ─────────────────────────────────────────────────────────────────────────────
// Weekly Analytics Email — Monday 08:00 UTC (09:00 WAT)
// Queries the same 9 BI metrics as Mission Control and emails a branded
// summary + attached CSV to ADMIN_EMAIL via Resend.
//
// Env vars: RESEND_API_KEY, ADMIN_EMAIL (falls back to admin@7evencards.xyz)
// Called by: /api/cron/weekly-analytics  (CF Cron "0 8 * * 1")
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "./worker-env";
import { fetchWithTimeout } from "./fetch-with-timeout";
import { sendAdminBotMessage, isAdminBotConfigured } from "./telegram";

const FROM_NAME    = "7SEVEN CARDS";
const FROM_ADDRESS = "noreply@7evencards.xyz";
const BRAND_GOLD   = "#f59e0b";
const BRAND_BG     = "#0a0a0a";
const CARD_BG      = "#111111";
const BORDER       = "#1f1f1f";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WeeklyMetrics {
  generatedAt: string;
  weekLabel:   string;  // "Week of Mon DD MMM YYYY"

  // Platform
  users:  { total: number; kycVerified: number; premium: number; newThisWeek: number };
  trades: { paid: number; failed: number; thisWeek: number; volume7dNgn: number; volume7dUsd: number };

  // 9 BI metrics
  userLtv:           { avgNgn: number; avgUsd: number; avgTradesPerUser: number; activePayingUsers: number } | null;
  vendorLtv:         { avgLifetimeNgn: number; totalFundedNgn: number; totalBalanceNgn: number; vendorCount: number } | null;
  premiumConversion: { premiumUsers: number; totalUsers: number; conversionRate: number } | null;
  fraudRate:         { fraudCount7d: number; totalTrades: number; ratePct: number } | null;
  inventoryVelocity: { avgMinutes: number; medianMinutes: number; p90Minutes: number; sampleSize: number } | null;
  treasuryVelocity:  { totalDecisions7d: number; buyRate7dPct: number } | null;
  profitByBrand:     Array<{ brand: string; count: number; totalNgn: number; totalUsd: number; avgRateNgn: number }>;
  providerHealth:    Array<{ provider: string; successRate: number; totalCalls: number; avgLatencyMs: number }>;
  regionalPerf:      Array<{ region: string; count: number; sharePct: number; totalNgn: number; totalUsd: number }>;
}

// ─── Query helpers ─────────────────────────────────────────────────────────────

function n(v: unknown): number {
  const x = Number(v);
  return isFinite(x) ? Math.round(x * 100) / 100 : 0;
}

function pct(num: number, den: number): number {
  return den === 0 ? 0 : Math.round((num / den) * 1000) / 10;
}

async function fetchMetrics(db: SupabaseClient): Promise<WeeklyMetrics> {
  const now       = new Date();
  const ago7d     = new Date(now.getTime() - 7  * 86_400_000).toISOString();
  const ago30d    = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const ago1h     = new Date(now.getTime() - 3_600_000).toISOString();
  const weekLabel = `Week of ${now.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`;

  const [
    usersRes, newUsersRes, premiumRes,
    tradesRes, vol7dRes,
    userLtvRes, vendorLtvRes,
    fraudRes, settleRes, treasuryRes,
    brandsRes, providerRes, regionRes,
  ] = await Promise.all([
    // total + kyc
    db.from("profiles").select("id, kyc_verified", { count: "exact" }),
    // new this week
    db.from("profiles").select("id", { count: "exact" }).gte("created_at", ago7d),
    // premium
    db.from("profiles").select("id", { count: "exact" }).eq("premium", true),

    // trades: paid + failed
    db.from("trades").select("status", { count: "exact" }),
    // 7-day volume
    db.from("trades")
      .select("amount_ngn, amount_usd")
      .eq("status", "paid")
      .gte("created_at", ago7d),

    // user LTV (30d)
    db.from("trades")
      .select("user_id, amount_ngn, amount_usd")
      .eq("status", "paid")
      .gte("created_at", ago30d),

    // vendor LTV
    db.from("vendor_wallets")
      .select("total_funded, balance"),

    // fraud (7d)
    db.from("fraud_events")
      .select("id", { count: "exact" })
      .gte("created_at", ago7d),

    // inventory velocity
    db.from("trades")
      .select("created_at, settled_at")
      .eq("status", "paid")
      .not("settled_at", "is", null)
      .gte("settled_at", ago7d)
      .limit(200),

    // treasury 7d
    db.from("treasury_decisions")
      .select("decision")
      .gte("decided_at", ago7d),

    // profit by brand
    db.from("trades")
      .select("brand, amount_ngn, amount_usd")
      .eq("status", "paid")
      .gte("created_at", ago7d),

    // provider health (1h)
    db.from("provider_operation_log")
      .select("provider, success, latency_ms")
      .gte("created_at", ago1h)
      .limit(2000),

    // regional
    db.from("trades")
      .select("region, amount_ngn, amount_usd")
      .eq("status", "paid")
      .gte("created_at", ago7d),
  ]);

  // ── Platform ──────────────────────────────────────────────────────────────
  const allProfiles = usersRes.data ?? [];
  const totalUsers   = usersRes.count ?? allProfiles.length;
  const kycVerified  = allProfiles.filter((p: { kyc_verified?: boolean }) => p.kyc_verified).length;
  const premiumUsers = premiumRes.count ?? 0;
  const newThisWeek  = newUsersRes.count ?? 0;

  const allTrades  = tradesRes.data ?? [];
  const paidCount  = allTrades.filter((t: { status: string }) => t.status === "paid").length;
  const failedCount = allTrades.filter((t: { status: string }) => t.status === "failed").length;
  const vol7dRows  = vol7dRes.data ?? [];
  const vol7dNgn   = vol7dRows.reduce((s: number, t: { amount_ngn?: number }) => s + n(t.amount_ngn), 0);
  const vol7dUsd   = vol7dRows.reduce((s: number, t: { amount_usd?: number }) => s + n(t.amount_usd), 0);
  const thisWeek   = vol7dRows.length;

  // ── User LTV ──────────────────────────────────────────────────────────────
  let userLtv: WeeklyMetrics["userLtv"] = null;
  const ltvRows = userLtvRes.data ?? [];
  if (ltvRows.length > 0) {
    const userMap = new Map<string, { ngn: number; usd: number; count: number }>();
    for (const t of ltvRows as Array<{ user_id: string; amount_ngn?: number; amount_usd?: number }>) {
      const e = userMap.get(t.user_id) ?? { ngn: 0, usd: 0, count: 0 };
      e.ngn += n(t.amount_ngn); e.usd += n(t.amount_usd); e.count++;
      userMap.set(t.user_id, e);
    }
    const vals = [...userMap.values()];
    userLtv = {
      avgNgn:            Math.round(vals.reduce((s, v) => s + v.ngn, 0) / vals.length),
      avgUsd:            Math.round(vals.reduce((s, v) => s + v.usd, 0) / vals.length * 100) / 100,
      avgTradesPerUser:  Math.round(vals.reduce((s, v) => s + v.count, 0) / vals.length * 10) / 10,
      activePayingUsers: vals.length,
    };
  }

  // ── Vendor LTV ────────────────────────────────────────────────────────────
  let vendorLtv: WeeklyMetrics["vendorLtv"] = null;
  const vRows = vendorLtvRes.data ?? [];
  if (vRows.length > 0) {
    const totalFunded  = vRows.reduce((s: number, v: { total_funded?: number }) => s + n(v.total_funded), 0);
    const totalBalance = vRows.reduce((s: number, v: { balance?: number }) => s + n(v.balance), 0);
    vendorLtv = {
      avgLifetimeNgn: Math.round(totalFunded / vRows.length),
      totalFundedNgn: Math.round(totalFunded),
      totalBalanceNgn: Math.round(totalBalance),
      vendorCount: vRows.length,
    };
  }

  // ── Premium Conversion ────────────────────────────────────────────────────
  const premiumConversion = {
    premiumUsers,
    totalUsers: n(totalUsers),
    conversionRate: pct(premiumUsers, n(totalUsers)),
  };

  // ── Fraud Rate ────────────────────────────────────────────────────────────
  let fraudRate: WeeklyMetrics["fraudRate"] = null;
  const fraudCount7d = fraudRes.count ?? 0;
  fraudRate = { fraudCount7d, totalTrades: n(tradesRes.count), ratePct: pct(fraudCount7d, n(tradesRes.count)) };

  // ── Inventory Velocity ────────────────────────────────────────────────────
  let inventoryVelocity: WeeklyMetrics["inventoryVelocity"] = null;
  const settleRows = settleRes.data ?? [];
  if (settleRows.length > 0) {
    const mins = (settleRows as Array<{ created_at: string; settled_at: string }>)
      .map(r => (new Date(r.settled_at).getTime() - new Date(r.created_at).getTime()) / 60_000)
      .filter(m => m >= 0)
      .sort((a, b) => a - b);
    if (mins.length > 0) {
      inventoryVelocity = {
        avgMinutes:    Math.round(mins.reduce((s, m) => s + m, 0) / mins.length),
        medianMinutes: Math.round(mins[Math.floor(mins.length / 2)]),
        p90Minutes:    Math.round(mins[Math.floor(mins.length * 0.9)]),
        sampleSize:    mins.length,
      };
    }
  }

  // ── Treasury Velocity ─────────────────────────────────────────────────────
  let treasuryVelocity: WeeklyMetrics["treasuryVelocity"] = null;
  const tRows = treasuryRes.data ?? [];
  if (tRows.length > 0) {
    const buyCount = tRows.filter((r: { decision?: string }) => r.decision === "buy").length;
    treasuryVelocity = { totalDecisions7d: tRows.length, buyRate7dPct: pct(buyCount, tRows.length) };
  }

  // ── Profit by Brand ───────────────────────────────────────────────────────
  const brandMap = new Map<string, { count: number; ngn: number; usd: number }>();
  for (const t of (brandsRes.data ?? []) as Array<{ brand?: string; amount_ngn?: number; amount_usd?: number }>) {
    const k = t.brand ?? "Unknown";
    const e = brandMap.get(k) ?? { count: 0, ngn: 0, usd: 0 };
    e.count++; e.ngn += n(t.amount_ngn); e.usd += n(t.amount_usd);
    brandMap.set(k, e);
  }
  const profitByBrand = [...brandMap.entries()]
    .sort((a, b) => b[1].ngn - a[1].ngn)
    .slice(0, 10)
    .map(([brand, v]) => ({
      brand,
      count: v.count,
      totalNgn: Math.round(v.ngn),
      totalUsd: Math.round(v.usd * 100) / 100,
      avgRateNgn: v.usd > 0 ? Math.round(v.ngn / v.usd) : 0,
    }));

  // ── Provider Health ───────────────────────────────────────────────────────
  const provMap = new Map<string, { ok: number; total: number; latSum: number }>();
  for (const r of (providerRes.data ?? []) as Array<{ provider?: string; success?: boolean; latency_ms?: number }>) {
    const k = r.provider ?? "unknown";
    const e = provMap.get(k) ?? { ok: 0, total: 0, latSum: 0 };
    e.total++; if (r.success) e.ok++; e.latSum += n(r.latency_ms);
    provMap.set(k, e);
  }
  const providerHealth = [...provMap.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([provider, v]) => ({
      provider,
      successRate: pct(v.ok, v.total),
      totalCalls: v.total,
      avgLatencyMs: v.total > 0 ? Math.round(v.latSum / v.total) : 0,
    }));

  // ── Regional ──────────────────────────────────────────────────────────────
  const regMap = new Map<string, { count: number; ngn: number; usd: number }>();
  for (const t of (regionRes.data ?? []) as Array<{ region?: string; amount_ngn?: number; amount_usd?: number }>) {
    const k = t.region ?? "Unknown";
    const e = regMap.get(k) ?? { count: 0, ngn: 0, usd: 0 };
    e.count++; e.ngn += n(t.amount_ngn); e.usd += n(t.amount_usd);
    regMap.set(k, e);
  }
  const totalRegTrades = [...regMap.values()].reduce((s, v) => s + v.count, 0);
  const regionalPerf = [...regMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([region, v]) => ({
      region,
      count: v.count,
      sharePct: pct(v.count, totalRegTrades),
      totalNgn: Math.round(v.ngn),
      totalUsd: Math.round(v.usd * 100) / 100,
    }));

  return {
    generatedAt: now.toISOString(),
    weekLabel,
    users:  { total: n(totalUsers), kycVerified, premium: premiumUsers, newThisWeek },
    trades: { paid: paidCount, failed: failedCount, thisWeek, volume7dNgn: Math.round(vol7dNgn), volume7dUsd: Math.round(vol7dUsd * 100) / 100 },
    userLtv,
    vendorLtv,
    premiumConversion,
    fraudRate,
    inventoryVelocity,
    treasuryVelocity,
    profitByBrand,
    providerHealth,
    regionalPerf,
  };
}

// ─── CSV builder ──────────────────────────────────────────────────────────────

function buildCsv(m: WeeklyMetrics): string {
  const rows: string[] = [];
  const c = (v: string | number) => { const s = String(v); return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; };
  const row = (...cols: (string | number)[]) => rows.push(cols.map(c).join(","));
  const blank = () => rows.push("");
  const sec = (t: string) => { blank(); rows.push(`# ${t}`); };

  rows.push("# 7SEVEN CARDS — Weekly Analytics Report");
  rows.push(`# ${m.weekLabel}`);
  rows.push(`# Generated: ${m.generatedAt}`);

  sec("PLATFORM SUMMARY");
  row("Metric", "Value");
  row("Total Users", m.users.total);
  row("KYC Verified", m.users.kycVerified);
  row("Premium Members", m.users.premium);
  row("New Users This Week", m.users.newThisWeek);
  row("Paid Trades (All-Time)", m.trades.paid);
  row("Failed Trades (All-Time)", m.trades.failed);
  row("Trades This Week", m.trades.thisWeek);
  row("Volume This Week (NGN)", m.trades.volume7dNgn);
  row("Volume This Week (USD)", m.trades.volume7dUsd);

  if (m.userLtv) {
    sec("USER LTV (Last 30 Days)");
    row("Metric", "Value");
    row("Avg LTV (NGN)", m.userLtv.avgNgn);
    row("Avg LTV (USD)", m.userLtv.avgUsd);
    row("Avg Trades / User", m.userLtv.avgTradesPerUser);
    row("Active Paying Users", m.userLtv.activePayingUsers);
  }

  if (m.vendorLtv) {
    sec("VENDOR LTV");
    row("Metric", "Value");
    row("Avg Lifetime Funded (NGN)", m.vendorLtv.avgLifetimeNgn);
    row("Total Funded All-Time (NGN)", m.vendorLtv.totalFundedNgn);
    row("Total Balance (NGN)", m.vendorLtv.totalBalanceNgn);
    row("Vendor Count", m.vendorLtv.vendorCount);
  }

  if (m.premiumConversion) {
    sec("PREMIUM CONVERSION");
    row("Metric", "Value");
    row("Premium Members", m.premiumConversion.premiumUsers);
    row("Total Users", m.premiumConversion.totalUsers);
    row("Conversion Rate (%)", m.premiumConversion.conversionRate);
  }

  if (m.fraudRate) {
    sec("FRAUD RATE (Last 7 Days)");
    row("Metric", "Value");
    row("Fraud Events", m.fraudRate.fraudCount7d);
    row("Total Trades (All-Time)", m.fraudRate.totalTrades);
    row("Fraud Rate (%)", m.fraudRate.ratePct);
  }

  if (m.inventoryVelocity && m.inventoryVelocity.sampleSize > 0) {
    sec("INVENTORY VELOCITY");
    row("Metric", "Minutes");
    row("Average Settlement", m.inventoryVelocity.avgMinutes);
    row("Median Settlement", m.inventoryVelocity.medianMinutes);
    row("P90 Settlement", m.inventoryVelocity.p90Minutes);
    row("Sample (trades)", m.inventoryVelocity.sampleSize);
  }

  if (m.treasuryVelocity) {
    sec("TREASURY VELOCITY (Last 7 Days)");
    row("Metric", "Value");
    row("Total Decisions", m.treasuryVelocity.totalDecisions7d);
    row("Buy Rate (%)", m.treasuryVelocity.buyRate7dPct);
  }

  if (m.profitByBrand.length > 0) {
    sec("PROFIT PER CARD TYPE (Last 7 Days)");
    row("Brand", "Trades", "Total NGN", "Total USD", "Avg NGN/$");
    for (const b of m.profitByBrand) row(b.brand, b.count, b.totalNgn, b.totalUsd, b.avgRateNgn);
  }

  if (m.providerHealth.length > 0) {
    sec("PROVIDER SUCCESS RATES (Last 1h)");
    row("Provider", "Success Rate (%)", "Total Calls", "Avg Latency (ms)");
    for (const p of m.providerHealth) row(p.provider, p.successRate, p.totalCalls, p.avgLatencyMs);
  }

  if (m.regionalPerf.length > 0) {
    sec("REGIONAL PERFORMANCE (Last 7 Days)");
    row("Region", "Trades", "Share (%)", "Total NGN", "Total USD");
    for (const r of m.regionalPerf) row(r.region, r.count, r.sharePct, r.totalNgn, r.totalUsd);
  }

  return rows.join("\n");
}

// ─── HTML email builder ───────────────────────────────────────────────────────

function fmt(n: number, opts?: Intl.NumberFormatOptions) {
  return n.toLocaleString("en-NG", opts);
}

function kpiBox(label: string, value: string, sub?: string): string {
  return `<td style="width:33%;padding:12px 8px;text-align:center;background:${CARD_BG};border-radius:8px;border:1px solid ${BORDER};">
    <div style="color:#666;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">${label}</div>
    <div style="color:${BRAND_GOLD};font-size:22px;font-weight:bold;line-height:1;">${value}</div>
    ${sub ? `<div style="color:#555;font-size:11px;margin-top:4px;">${sub}</div>` : ""}
  </td>`;
}

function section(title: string, icon: string, body: string): string {
  return `<div style="margin-top:24px;">
    <div style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">${icon} ${title}</div>
    <table style="width:100%;border-collapse:collapse;">${body}</table>
  </div>`;
}

function tr(label: string, value: string, valueColor = "#ffffff"): string {
  return `<tr>
    <td style="color:#666;padding:9px 0;border-bottom:1px solid ${BORDER};font-size:13px;width:55%;">${label}</td>
    <td style="color:${valueColor};padding:9px 0;border-bottom:1px solid ${BORDER};font-size:13px;font-weight:600;text-align:right;">${value}</td>
  </tr>`;
}

function buildEmailHtml(m: WeeklyMetrics): string {
  const vol7dNgnFmt = `₦${fmt(m.trades.volume7dNgn)}`;
  const vol7dUsdFmt = `$${fmt(m.trades.volume7dUsd, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const convRate    = m.premiumConversion?.conversionRate ?? 0;
  const fraudPct    = m.fraudRate?.ratePct ?? 0;
  const fraudColor  = fraudPct > 2 ? "#ef4444" : fraudPct > 0.5 ? BRAND_GOLD : "#10b981";

  const kpiRow = `<table style="width:100%;border-collapse:separate;border-spacing:8px;">
    <tr>
      ${kpiBox("Trades This Week", fmt(m.trades.thisWeek))}
      ${kpiBox("Volume (NGN)", `₦${fmt(m.trades.volume7dNgn)}`)}
      ${kpiBox("Premium Conv.", `${convRate}%`, `${m.premiumConversion?.premiumUsers ?? 0} members`)}
    </tr>
  </table>`;

  const usersSection = section("Platform Health", "👥", `
    ${tr("Total Users", fmt(m.users.total))}
    ${tr("KYC Verified", fmt(m.users.kycVerified), "#10b981")}
    ${tr("Premium Members", fmt(m.users.premium), BRAND_GOLD)}
    ${tr("New This Week", `+${fmt(m.users.newThisWeek)}`, "#10b981")}
  `);

  const userLtvSection = m.userLtv ? section("User LTV (30-Day Cohort)", "💰", `
    ${tr("Avg LTV (NGN)", `₦${fmt(m.userLtv.avgNgn)}`)}
    ${tr("Avg LTV (USD)", `$${fmt(m.userLtv.avgUsd, { minimumFractionDigits: 2 })}`)}
    ${tr("Avg Trades / User", String(m.userLtv.avgTradesPerUser))}
    ${tr("Active Paying Users", fmt(m.userLtv.activePayingUsers))}
  `) : "";

  const vendorLtvSection = m.vendorLtv ? section("Vendor LTV", "🏦", `
    ${tr("Avg Lifetime Funded", `₦${fmt(m.vendorLtv.avgLifetimeNgn)}`)}
    ${tr("Total Pool Funded", `₦${fmt(m.vendorLtv.totalFundedNgn)}`)}
    ${tr("Current Pool Balance", `₦${fmt(m.vendorLtv.totalBalanceNgn)}`, "#10b981")}
    ${tr("Active Vendors", fmt(m.vendorLtv.vendorCount))}
  `) : "";

  const fraudSection = section("Fraud & Settlement", "🛡️", `
    ${tr("Fraud Events (7d)", fmt(m.fraudRate?.fraudCount7d ?? 0), fraudColor)}
    ${tr("Fraud Rate", `${fraudPct}%`, fraudColor)}
    ${m.inventoryVelocity ? tr("Avg Settlement Time", `${fmt(m.inventoryVelocity.avgMinutes)} min`) : ""}
    ${m.inventoryVelocity ? tr("P90 Settlement Time", `${fmt(m.inventoryVelocity.p90Minutes)} min`) : ""}
  `);

  const treasurySection = m.treasuryVelocity ? section("Treasury (7 Days)", "⚡", `
    ${tr("Total Decisions", fmt(m.treasuryVelocity.totalDecisions7d))}
    ${tr("Buy Rate", `${m.treasuryVelocity.buyRate7dPct}%`, BRAND_GOLD)}
  `) : "";

  const brandsRows = m.profitByBrand.slice(0, 5).map(b =>
    `<tr>
      <td style="color:#ccc;padding:8px 0;border-bottom:1px solid ${BORDER};font-size:13px;">${b.brand}</td>
      <td style="color:${BRAND_GOLD};padding:8px 0;border-bottom:1px solid ${BORDER};font-size:13px;text-align:right;">₦${fmt(b.totalNgn)}</td>
      <td style="color:#666;padding:8px 0;border-bottom:1px solid ${BORDER};font-size:11px;text-align:right;">${fmt(b.count)} trades</td>
    </tr>`
  ).join("");
  const brandsSection = m.profitByBrand.length > 0 ? `<div style="margin-top:24px;">
    <div style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">💳 Top Card Brands (Volume)</div>
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <th style="color:#555;font-size:11px;text-align:left;padding-bottom:6px;">Brand</th>
        <th style="color:#555;font-size:11px;text-align:right;padding-bottom:6px;">NGN Volume</th>
        <th style="color:#555;font-size:11px;text-align:right;padding-bottom:6px;">Trades</th>
      </tr>
      ${brandsRows}
    </table>
  </div>` : "";

  const regionRows = m.regionalPerf.slice(0, 5).map(r =>
    `<tr>
      <td style="color:#ccc;padding:8px 0;border-bottom:1px solid ${BORDER};font-size:13px;">${r.region}</td>
      <td style="color:${BRAND_GOLD};padding:8px 0;border-bottom:1px solid ${BORDER};font-size:13px;text-align:right;">${r.sharePct}%</td>
      <td style="color:#666;padding:8px 0;border-bottom:1px solid ${BORDER};font-size:11px;text-align:right;">${fmt(r.count)} trades</td>
    </tr>`
  ).join("");
  const regionSection = m.regionalPerf.length > 0 ? `<div style="margin-top:24px;">
    <div style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">🗺️ Regional Performance</div>
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <th style="color:#555;font-size:11px;text-align:left;padding-bottom:6px;">Region</th>
        <th style="color:#555;font-size:11px;text-align:right;padding-bottom:6px;">Share</th>
        <th style="color:#555;font-size:11px;text-align:right;padding-bottom:6px;">Trades</th>
      </tr>
      ${regionRows}
    </table>
  </div>` : "";

  const providerRows = m.providerHealth.map(p => {
    const color = p.successRate >= 99 ? "#10b981" : p.successRate >= 95 ? BRAND_GOLD : "#ef4444";
    return `<tr>
      <td style="color:#ccc;padding:8px 0;border-bottom:1px solid ${BORDER};font-size:13px;">${p.provider}</td>
      <td style="color:${color};padding:8px 0;border-bottom:1px solid ${BORDER};font-size:13px;text-align:right;">${p.successRate}%</td>
      <td style="color:#666;padding:8px 0;border-bottom:1px solid ${BORDER};font-size:11px;text-align:right;">${fmt(p.avgLatencyMs)}ms</td>
    </tr>`;
  }).join("");
  const providerSection = m.providerHealth.length > 0 ? `<div style="margin-top:24px;">
    <div style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">🔌 Provider Health (Last 1h)</div>
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <th style="color:#555;font-size:11px;text-align:left;padding-bottom:6px;">Provider</th>
        <th style="color:#555;font-size:11px;text-align:right;padding-bottom:6px;">Success</th>
        <th style="color:#555;font-size:11px;text-align:right;padding-bottom:6px;">Latency</th>
      </tr>
      ${providerRows}
    </table>
  </div>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Weekly Analytics — 7SEVEN CARDS</title>
</head>
<body style="margin:0;padding:0;background:${BRAND_BG};font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:32px auto;padding:16px;">
    <div style="background:${CARD_BG};border-radius:16px;padding:32px;border:1px solid ${BORDER};">
      <!-- Header -->
      <div style="margin-bottom:24px;">
        <span style="color:${BRAND_GOLD};font-size:22px;font-weight:bold;letter-spacing:-0.5px;">7SEVEN CARDS</span>
        <span style="color:#333;margin-left:8px;font-size:14px;">Admin Report</span>
      </div>
      <h1 style="color:#ffffff;margin:0 0 4px;font-size:20px;font-weight:bold;">📊 Weekly Analytics</h1>
      <p style="color:#555;margin:0 0 24px;font-size:14px;">${m.weekLabel}</p>

      <!-- KPI Row -->
      ${kpiRow}

      <!-- Volume row -->
      <div style="margin-top:12px;text-align:center;">
        <span style="color:#888;font-size:12px;">Week Volume: <strong style="color:#fff;">${vol7dNgnFmt}</strong></span>
        <span style="color:#444;margin:0 8px;">·</span>
        <span style="color:#888;font-size:12px;"><strong style="color:#fff;">${vol7dUsdFmt}</strong></span>
      </div>

      <!-- Sections -->
      ${usersSection}
      ${userLtvSection}
      ${vendorLtvSection}
      ${fraudSection}
      ${treasurySection}
      ${brandsSection}
      ${regionSection}
      ${providerSection}

      <!-- CTA -->
      <div style="margin-top:32px;">
        <a href="https://7evencards.xyz/admin"
           style="display:inline-block;background:${BRAND_GOLD};color:#000;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px;">
          Open Mission Control →
        </a>
        <span style="display:inline-block;margin-left:12px;color:#444;font-size:12px;vertical-align:middle;">CSV attached to this email</span>
      </div>

      <!-- Footer -->
      <p style="color:#333;margin-top:28px;font-size:11px;border-top:1px solid ${BORDER};padding-top:16px;">
        Automated weekly report &middot; Every Monday 09:00 WAT &middot;
        <a href="https://7evencards.xyz" style="color:#444;text-decoration:none;">7evencards.xyz</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ─── Telegram message builder ────────────────────────────────────────────────

function buildTelegramMessage(m: WeeklyMetrics): string {
  const fmtN  = (n: number) => n.toLocaleString("en-NG");
  const fmtNgn = (n: number) => `₦${fmtN(Math.round(n))}`;
  const fmtPct = (n: number) => `${n}%`;

  const lines: string[] = [
    `📊 <b>Week in Numbers</b> — ${m.weekLabel}`,
    ``,
    `👥 <b>Users</b>`,
    `  Total: ${fmtN(m.users.total)} · KYC: ${fmtN(m.users.kycVerified)} · +${fmtN(m.users.newThisWeek)} new`,
  ];

  lines.push(``, `💳 <b>Trading Activity</b>`);
  lines.push(`  ${fmtN(m.trades.thisWeek)} trades · ${fmtNgn(m.trades.volume7dNgn)} volume`);

  if (m.userLtv) {
    lines.push(``, `💰 <b>User LTV (30d cohort)</b>`);
    lines.push(`  Avg ${fmtNgn(m.userLtv.avgNgn)} · ${m.userLtv.avgTradesPerUser} trades/user`);
    lines.push(`  ${fmtN(m.userLtv.activePayingUsers)} active paying users`);
  }

  if (m.premiumConversion) {
    lines.push(``, `⭐ <b>Premium</b>`);
    lines.push(`  ${fmtPct(m.premiumConversion.conversionRate)} conversion · ${fmtN(m.premiumConversion.premiumUsers)} members`);
  }

  if (m.fraudRate) {
    const fraudOk = m.fraudRate.ratePct <= 0.5;
    const fraudIcon = m.fraudRate.ratePct > 2 ? "🚨" : m.fraudRate.ratePct > 0.5 ? "⚠️" : "✅";
    lines.push(``, `🛡️ <b>Fraud &amp; Settlement</b>`);
    lines.push(`  ${fraudIcon} Fraud rate: ${fmtPct(m.fraudRate.ratePct)} (${fmtN(m.fraudRate.fraudCount7d)} events)`);
    if (!fraudOk) lines.push(`  ⚠️ Review fraud queue in Mission Control`);
  }

  if (m.inventoryVelocity && m.inventoryVelocity.sampleSize > 0) {
    lines.push(`  ⏱ Settlement: avg ${fmtN(m.inventoryVelocity.avgMinutes)} min · P90 ${fmtN(m.inventoryVelocity.p90Minutes)} min`);
  }

  if (m.treasuryVelocity) {
    lines.push(``, `⚡ <b>Treasury (7d)</b>`);
    lines.push(`  ${fmtN(m.treasuryVelocity.totalDecisions7d)} decisions · ${fmtPct(m.treasuryVelocity.buyRate7dPct)} buy rate`);
  }

  if (m.vendorLtv) {
    lines.push(``, `🏦 <b>Vendor Pool</b>`);
    lines.push(`  Balance: ${fmtNgn(m.vendorLtv.totalBalanceNgn)} · ${fmtN(m.vendorLtv.vendorCount)} vendors`);
  }

  if (m.profitByBrand.length > 0) {
    const top = m.profitByBrand[0];
    lines.push(``, `💳 <b>Top Card Brand</b>: ${top.brand} — ${fmtNgn(top.totalNgn)} (${fmtN(top.count)} trades)`);
  }

  if (m.regionalPerf.length > 0) {
    const top = m.regionalPerf[0];
    lines.push(`🗺️ <b>Top Region</b>: ${top.region} — ${fmtPct(top.sharePct)} share`);
  }

  if (m.providerHealth.length > 0) {
    const degraded = m.providerHealth.filter(p => p.successRate < 99);
    if (degraded.length > 0) {
      lines.push(``, `🔌 <b>Provider Alerts</b>`);
      for (const p of degraded) lines.push(`  ⚠️ ${p.provider}: ${fmtPct(p.successRate)} success · ${fmtN(p.avgLatencyMs)}ms`);
    }
  }

  lines.push(``, `<a href="https://7evencards.xyz/admin">Open Mission Control →</a>`);
  return lines.join("\n");
}

// ─── Main exported function ───────────────────────────────────────────────────

export async function sendWeeklyAnalyticsEmail(db: SupabaseClient): Promise<{
  ok: boolean;
  recipientCount: number;
  weekLabel: string;
}> {
  const apiKey = getEnv("RESEND_API_KEY");
  if (!apiKey) {
    console.warn("[WeeklyAnalytics] RESEND_API_KEY not set — skipping email");
    return { ok: false, recipientCount: 0, weekLabel: "" };
  }

  console.info("[WeeklyAnalytics] Fetching metrics…");
  const metrics = await fetchMetrics(db);
  console.info("[WeeklyAnalytics] Metrics ready:", { trades: metrics.trades.thisWeek, week: metrics.weekLabel });

  const html     = buildEmailHtml(metrics);
  const csv      = buildCsv(metrics);
  const csvB64   = btoa(unescape(encodeURIComponent(csv)));
  const fileName = `7cards-weekly-${metrics.generatedAt.slice(0, 10)}.csv`;

  // Support comma-separated list of admin recipients
  const rawRecipients = getEnv("ADMIN_EMAIL") ?? "admin@7evencards.xyz";
  const recipients    = rawRecipients.split(",").map((e: string) => e.trim()).filter(Boolean);

  const body = JSON.stringify({
    from:        `${FROM_NAME} <${FROM_ADDRESS}>`,
    to:          recipients,
    subject:     `📊 Weekly Analytics — ${metrics.weekLabel}`,
    html,
    attachments: [{ filename: fileName, content: csvB64 }],
  });

  let emailOk = false;
  try {
    const res = await fetchWithTimeout(
      "https://api.resend.com/emails",
      {
        method:  "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
      },
      15_000,
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn("[WeeklyAnalytics] Resend error:", res.status, errText.slice(0, 300));
    } else {
      console.info("[WeeklyAnalytics] Email sent →", recipients.join(", "));
      emailOk = true;
    }
  } catch (e) {
    console.error("[WeeklyAnalytics] fetch failed:", e instanceof Error ? e.message : e);
  }

  // ── Telegram push ────────────────────────────────────────────────────────
  const adminChatId = getEnv("ADMIN_TELEGRAM_CHAT_ID");
  if (adminChatId && isAdminBotConfigured()) {
    try {
      const text = buildTelegramMessage(metrics);
      const tgRes = await sendAdminBotMessage(adminChatId, text, [[
        { text: "📊 Open Mission Control", callback_data: "open_admin" },
      ]]);
      if (tgRes.ok) {
        console.info("[WeeklyAnalytics] Telegram push sent, messageId:", tgRes.messageId);
      } else {
        console.warn("[WeeklyAnalytics] Telegram push failed:", tgRes.error);
      }
    } catch (e) {
      console.warn("[WeeklyAnalytics] Telegram push error:", e instanceof Error ? e.message : e);
    }
  } else {
    console.info("[WeeklyAnalytics] Telegram not configured — skipping push");
  }

  return { ok: emailOk, recipientCount: recipients.length, weekLabel: metrics.weekLabel };
}
