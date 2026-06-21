import type { Request, Response, NextFunction } from "express";

const windows = new Map<string, number[]>();

const WINDOW_MS = 60_000;

export function rateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const tenant = req.tenant;
  if (!tenant) {
    next();
    return;
  }

  const now = Date.now();
  const max = tenant.rateLimitRpm;
  const key = tenant.keyId;

  const prev = windows.get(key) ?? [];
  const active = prev.filter((t) => now - t < WINDOW_MS);

  if (active.length >= max) {
    const oldestTs = active[0] ?? now;
    const resetAfterSec = Math.ceil((oldestTs + WINDOW_MS - now) / 1000);
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", 0);
    res.setHeader("Retry-After", resetAfterSec);
    res.status(429).json({
      error: "Rate limit exceeded",
      limit: max,
      window: "60s",
      retry_after: resetAfterSec,
    });
    return;
  }

  active.push(now);
  windows.set(key, active);

  res.setHeader("X-RateLimit-Limit", max);
  res.setHeader("X-RateLimit-Remaining", max - active.length);

  next();
}

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, times] of windows.entries()) {
    const fresh = times.filter((t) => t > cutoff);
    if (fresh.length === 0) windows.delete(key);
    else windows.set(key, fresh);
  }
}, 120_000).unref();
