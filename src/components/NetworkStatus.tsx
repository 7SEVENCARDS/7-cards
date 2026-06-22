import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { WifiOff } from "lucide-react";

export function NetworkStatus() {
  const [offline, setOffline] = useState(() => !navigator.onLine);
  const wasOffline = useRef(!navigator.onLine);

  useEffect(() => {
    const goOffline = () => {
      setOffline(true);
      wasOffline.current = true;
    };

    const goOnline = () => {
      setOffline(false);
      if (wasOffline.current) {
        toast.success("Back online — you're all set", {
          duration: 3000,
          icon: "📶",
        });
        wasOffline.current = false;
      }
    };

    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
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
      <WifiOff className="size-3.5 text-pink-400 shrink-0" />
      <span className="text-white/80">
        You're offline —{" "}
        <span className="text-white font-bold">trades will resume when you reconnect</span>
      </span>
      <span className="ml-1 size-1.5 rounded-full bg-pink-400 animate-pulse shrink-0" />
    </div>
  );
}
