# 7SEVEN CARDS — Supabase Setup Guide

## 1. Create a Supabase project
Go to [https://supabase.com](https://supabase.com) → New Project → pick a region close to Nigeria (EU West works well).

## 2. Run the schema
In Supabase dashboard → **SQL Editor** → paste the entire contents of `supabase/schema.sql` → Run.

## 3. Enable Phone Auth (OTP)
Dashboard → **Authentication** → **Providers** → Phone → Enable → add your Twilio credentials (SID, Auth Token, Messaging Service SID).

## 4. Set your environment variables
Copy `.env.example` to `.env` and fill in:

```
VITE_SUPABASE_URL=https://xxxx.supabase.co         # Project → Settings → API → URL
VITE_SUPABASE_ANON_KEY=eyJ...                       # Project → Settings → API → anon key
SUPABASE_SERVICE_ROLE_KEY=eyJ...                    # Project → Settings → API → service_role key (keep secret)
```

## 5. Reloadly (Gift Card Verification)
1. Sign up at [https://developers.reloadly.com](https://developers.reloadly.com)
2. Create an app → get Client ID + Client Secret
3. Use **sandbox** for testing, **production** for live
```
RELOADLY_CLIENT_ID=...
RELOADLY_CLIENT_SECRET=...
RELOADLY_ENV=sandbox
```

## 6. Squad by GT (Payouts — replaces Paystack)
1. Sign up at [https://dashboard.squadco.com](https://dashboard.squadco.com)
2. Settings → API Keys → copy sandbox key
3. Set `SQUADCO_ENV=sandbox` for testing, `production` when live
```
SQUADCO_API_KEY=...
SQUADCO_SECRET_KEY=...
SQUADCO_ENV=sandbox
```

## 7. Busha (Crypto Rates)
1. Sign up at [https://busha.co](https://busha.co)
2. Developer → API Keys → generate key
```
BUSHA_API_KEY=...
```

## 8. App Secret
Generate a 32+ character random string:
```bash
openssl rand -hex 32
```
```
APP_SECRET=...
```

## What each credential does
| Variable | Used for |
|---|---|
| `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` | Client-side auth, real-time |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side DB writes (bypasses RLS) |
| `RELOADLY_CLIENT_ID/SECRET` | Gift card verification + exchange rates |
| `SQUADCO_API_KEY` | NGN bank transfer payouts |
| `BUSHA_API_KEY` | Live crypto → NGN rates |

## Graceful fallback (demo mode)
If credentials contain `YOUR_`, the app automatically falls back:
- **Reloadly not configured** → card is marked verified (demo trade flow works)
- **Squadco not configured** → NGN credited directly to wallet without real bank transfer
- **Busha not configured** → uses hardcoded fallback crypto rates
- **Supabase not configured** → exchange rate API returns seeded defaults

This means you can test the full UI without any credentials, and go live by simply filling in `.env`.
