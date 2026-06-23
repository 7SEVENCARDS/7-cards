# 7SEVEN CARDS — Rollback Procedures

**Last Updated:** 2026-06-23

---

## When to Rollback

Rollback when a production deploy causes:
- HTTP 500 errors on more than 1% of requests
- `/api/health` returning `ok: false`
- Financial operation failures (payout, wallet credit)
- Authentication failures (login broken for users/vendors/admins)
- Data corruption (detected via reconciliation)

**Do not rollback for:** cosmetic UI bugs, non-critical feature regressions, or issues fixable with a forward commit.

---

## Method 1: Cloudflare Workers Rollback (fastest — < 2 minutes)

Cloudflare retains the previous 10 deployed versions. This is the preferred rollback for production outages.

```bash
# 1. List recent deployments
pnpm exec wrangler deployments list --env production

# 2. Rollback to the previous version
pnpm exec wrangler rollback --env production

# 3. Verify health
curl https://7evencards.xyz/api/health | jq .ok
```

This does NOT change git history — it only reverts the running Worker binary.

---

## Method 2: Git Revert + Redeploy

For issues caused by a specific commit (safe — does not rewrite shared history):

```bash
# 1. Identify the bad commit
git log --oneline -10

# 2. Revert it — creates a new commit reversing the changes
git revert <bad-commit-sha> --no-edit

# 3. Push — CI/CD will deploy automatically
git push origin main
```

**Important:** Always use `git revert`, never force-push to main.

---

## Method 3: Emergency Feature Flag

For financial or auth-critical features, disable them without redeploying:

```bash
# Disable payouts
printf 'false' | pnpm exec wrangler secret put PAYOUT_ENABLED --env production

# Enable maintenance mode
printf 'true' | pnpm exec wrangler secret put MAINTENANCE_MODE --env production
```

Re-enable after the fix is deployed:
```bash
printf 'true' | pnpm exec wrangler secret put PAYOUT_ENABLED --env production
printf 'false' | pnpm exec wrangler secret put MAINTENANCE_MODE --env production
```

---

## Method 4: Database Rollback (last resort)

**Only for schema-level issues — requires DBA approval.**

Supabase does not auto-rollback migrations. To undo a migration:

1. Write a reverse migration in `supabase/migrations/032_rollback_<name>.sql`
2. Apply it via Supabase dashboard or CLI
3. Notify the team — schema changes affect all workers simultaneously

---

## Post-Rollback Checklist

After any rollback:

- [ ] `/api/health` returns `ok: true`
- [ ] Spot-check admin login
- [ ] Spot-check vendor login
- [ ] Verify active trades are not stuck (check `reconciliation_runs`)
- [ ] Confirm no duplicate payouts (check `processed_webhook_events`)
- [ ] File a post-mortem within 24 hours (see template below)

---

## Post-Mortem Template

```markdown
## Incident: <date> — <one-line description>

**Duration:** <start> to <end>
**Severity:** P0 / P1 / P2
**Impact:** <# users affected, $ amount at risk>

### Timeline
- HH:MM — Event detected
- HH:MM — Root cause identified
- HH:MM — Rollback initiated
- HH:MM — Service restored

### Root Cause
<What broke and why>

### Resolution
<How it was fixed>

### Prevention
<What changes will prevent recurrence>
```

---

## Contacts

| Role | Contact |
|------|---------|
| Platform on-call | Telegram admin bot → admin handle |
| Supabase issues | https://status.supabase.com |
| Cloudflare issues | https://www.cloudflarestatus.com |
| Squad payment issues | Squad support dashboard |
