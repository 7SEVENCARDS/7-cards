import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { WifiOff } from "lucide-react";

// ─── Connectivity probe ────────────────────────────────────────────────────────
// navigator.onLine is notoriously unreliable on mobile browsers (especially iOS
// Safari on LTE/5G — it often reports false even with a working connection).
// We verify offline status by attempting a lightweight fetch to our own health
// endpoint before ever showing the banner.

const PROBE_URL = "/api/health";
const PROBE_TIMEOUT_MS = 5_000;
// Wait this long after an "offline" event before probing — handles brief
// Wi-Fi ↔ cellular handoffs that self-recover within a second.
const DEBOUNCE_MS = 2_500;

async function isActuallyOffline(): Promise<boolean> {
  try {
    const res = await fetch(PROBE_URL, {
      method: "HEAD",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return !res.ok;
  } catch {
    // fetch() threw — genuinely unreachable
    return true;
  }
}

export function NetworkStatus() {
  // Default to ONLINE. Never read navigator.onLine as the initial state —
  // it lies on iOS Safari and causes false positives on first render.
  const [offline, setOffline] = useState(false);
  const wasOffline = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleOffline = () => {
      // Debounce: wait before probing so brief handoffs don't trigger the banner
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(async () => {
        const really = await isActuallyOffline();
        if (really) {
          setOffline(true);
          wasOffline.current = true;
        }
      }, DEBOUNCE_MS);
    };

    const handleOnline = () => {
      // Cancel any pending debounced offline probe
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      setOffline(false);
      if (wasOffline.current) {
        toast.success("Back online — you're all set", {
          duration: 3_000,
          icon: "📶",
        });
        wasOffline.current = false;
      }
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed top-0 left-0 right-0 z-[9999] flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white"
      style={{
        background: "linear-gradient(90deg, #1a1a2e 0%, #16213e 50%, #1a1a2e 100%)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        paddingTop: "max(0.625rem, env(safe-area-inset-top))",
      }}
    >
      <WifiOff className="size-3.5 text-pink-400 shrink-0" aria-hidden="true" />
      <span className="text-white/80">
        You're offline —{" "}
        <span className="text-white font-bold">trades will resume when you reconnect</span>
      </span>
      <span className="ml-1 size-1.5 rounded-full bg-pink-400 animate-pulse shrink-0" aria-hidden="true" />
    </div>
  );
}
