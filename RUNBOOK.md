# 7SEVEN CARDS — Operations Runbook

**Platform:** 7evencards.xyz + vendor.7evencards.xyz + admin.7evencards.xyz  
**Stack:** TanStack Start · Cloudflare Workers · Supabase · pnpm  
**Last Updated:** 2026-06-23

---

## 1. Health Checks

### Quick Status
```bash
# Main app
curl https://7evencards.xyz/api/health | jq .

# Vendor portal
curl -o /dev/null -w "%{http_code}" https://vendor.7evencards.xyz/

# Admin portal
curl -o /dev/null -w "%{http_code}" https://admin.7evencards.xyz/

# API worker
curl https://api.7evencards.xyz/api/healthz
```

### Expected Healthy Response
```json
{
  "ok": true,
  "critical": {
    "supabase": true, "squadco": true, "reloadly": true,
    "busha": true, "onesignal": true, "app_secret": true, "cron": true
  },
  "db": { "ok": true, "latencyMs": 80 }
}
```

A `503` response or any `critical` field being `false` indicates a degraded or broken service.

---

## 2. Deployment

### Standard Deploy
Push to `main` — GitHub Actions handles CI + Cloudflare Workers deploy automatically.

```bash
git push origin main
```

CI gate (must pass before deploy): typecheck → test → lint → dependency audit  
Deploy target: Cloudflare Workers via `wrangler deploy --env production`

### Manual Deploy (emergency)
```bash
pnpm install --no-frozen-lockfile
pnpm run build
node scripts/patch-cf-scheduled.mjs
pnpm exec wrangler deploy --config wrangler.toml --env production
```

### Check Deploy Status
- GitHub Actions: https://github.com/7SEVENCARDS/7-cards/actions
- Cloudflare Dashboard: Workers & Pages → 7evencards-xyz

---

## 3. Secrets Management

All runtime secrets live in **Cloudflare Workers secrets** (not `.env`).

### Critical Secrets (platform fails without these)
| Secret | Purpose |
|--------|---------|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase admin key (bypasses RLS) |
| `SQUADCO_SECRET_KEY` | Squad payout HMAC signing |
| `RELOADLY_CLIENT_ID` | Gift card verification |
| `RELOADLY_CLIENT_SECRET` | Gift card verification |
| `BUSHA_API_KEY` | Crypto rates |
| `ONESIGNAL_APP_ID` | Push notifications |
| `ONESIGNAL_REST_API_KEY` | Push notifications |
| `APP_SECRET` | Internal API auth |
| `CRON_SECRET` | Cron job auth header |

### Add/Rotate a Secret
```bash
printf 'new-secret-value' | pnpm exec wrangler secret put SECRET_NAME --env production
```

After rotating a secret, trigger a fresh deploy so the new value propagates.

---

## 4. Database Operations

### Run Supabase Migrations (dev)
```bash
pnpm --filter @workspace/db run push
```

### Apply Migrations to Production
Migrations in `supabase/migrations/` must be applied via the Supabase dashboard or CLI:
```bash
supabase db push --db-url "$PROD_DATABASE_URL"
```

**Never** run `db push` against production without first testing in staging.

### Make a User Admin
```sql
UPDATE profiles SET role = 'admin' WHERE id = '<user-uuid>';
```

### Check Wallet Ledger Integrity
```sql
-- Detect any wallet balance that doesn't match its ledger sum
SELECT * FROM v_wallet_ledger_discrepancies;
```

---

## 5. Monitoring & Alerting

| Tool | URL | What to Check |
|------|-----|---------------|
| Sentry | https://de.sentry.io/ | Error rate, new issues, P0 alerts |
| Cloudflare Analytics | Dash → Workers | Request rate, error rate, CPU |
| Supabase Dashboard | Dash → Logs | Slow queries, RLS violations |
| GitHub Actions | /actions | CI failures, deploy status |

### Key Metrics (normal ranges)
- P99 response time: < 500ms
- Error rate: < 0.5%
- Supabase DB latency (health check): < 200ms

---

## 6. Incident Response

### P0 — Platform Down (HTTP 500 / all users affected)
1. Check `GET /api/health` — identify which critical service is `false`
2. Check Cloudflare Workers logs for runtime errors
3. Check Sentry for the root exception
4. If secrets missing: rotate via `wrangler secret put` and redeploy
5. If SSR crash: check last commit diff, rollback if needed (see ROLLBACK.md)

### P1 — Financial Integrity Issue
1. **Stop new payouts immediately** — set feature flag `PAYOUT_ENABLED=false` in Cloudflare env
2. Run the reconciliation cron manually:
   ```bash
   curl -X POST https://7evencards.xyz/api/cron/reconcile \
     -H "x-cron-secret: $CRON_SECRET"
   ```
3. Check `reconciliation_runs` table for discrepancies
4. Check `trade_audit_log` for the affected trade IDs
5. Contact Squad support if a duplicate payout was initiated

### P2 — Vendor Portal Issues
1. Check vendor session: `GET /api/vendor-session`
2. Verify vendor status in DB: `SELECT status FROM vendors WHERE user_id = '<uuid>'`
3. Check for `requireVendorAuth` 403 errors in Sentry (tag: `vendor_subdomain`)

### P3 — KYC / Verification Failures
1. Check `DOJAH_APP_ID` and `DOJAH_SECRET_KEY` secrets are present
2. Check Dojah dashboard for API outages
3. Fallback: manually approve KYC via the admin dashboard

---

## 7. Cron Jobs

| Route | Schedule | Purpose |
|-------|---------|---------|
| `/api/cron/rate-check` | Every 6 hours (CF Cron) | Send rate check to active vendors |
| `/api/cron/reconcile` | Daily 02:00 UTC | Ledger reconciliation |
| `/api/cron/weekly-commission` | Thursday 18:00 UTC | ₦500 commission to qualifying traders |

### Manual Cron Trigger
```bash
curl -X POST https://7evencards.xyz/api/cron/reconcile \
  -H "x-cron-secret: $CRON_SECRET"
```

---

## 8. Vendor Operations

### Approve a Vendor
Admin dashboard → Vendors → Select vendor → Approve

Or via SQL:
```sql
UPDATE vendors SET status = 'active' WHERE id = '<vendor-id>';
```

### Suspend a Vendor
```sql
UPDATE vendors
SET status = 'suspended', suspension_reason = 'Reason here'
WHERE id = '<vendor-id>';
```

### Investigate a Failed Assignment
```sql
SELECT * FROM trade_audit_log
WHERE trade_id = '<trade-id>'
ORDER BY server_ts_ms;
```

---

## 9. Support Escalation Path

| Severity | Channel | Response Target |
|----------|---------|----------------|
| P0 (outage) | Telegram admin bot + Sentry alert | 15 minutes |
| P1 (financial) | Telegram admin bot | 1 hour |
| P2 (feature broken) | Support inbox | 4 hours |
| P3 (user question) | Support inbox | 24 hours |

---

## 10. Pre-Launch Checklist

Before any production deploy:

- [ ] All CI checks pass (typecheck, test, lint)
- [ ] `/api/health` returns `ok: true` with all critical fields true
- [ ] Admin login verified
- [ ] Vendor login verified
- [ ] `processPayout` tested in staging
- [ ] Reconciliation run completed without errors
- [ ] Sentry receiving events
- [ ] Rate limiting confirmed active (check Cloudflare Workers logs)

See also: `ROLLBACK.md` for rollback procedures.
