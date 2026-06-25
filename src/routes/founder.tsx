// ─────────────────────────────────────────────────────────────────────────────
// Founder Executive Dashboard Route
//
// Accessible at /founder (super_admin only).
// Protected by the same Supabase auth check as /admin.
// ─────────────────────────────────────────────────────────────────────────────

import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { supabase } from "../lib/supabase";
import { checkSuperAdminAccess } from "../server-functions/admin-auth";
import { FounderDashboard } from "../components/FounderDashboard";

export const Route = createFileRoute("/founder")({
  component: FounderPage,
});

type Phase =
  | { tag: "loading" }
  | { tag: "denied" }
  | { tag: "ready" };

export default function FounderPage() {
  const [phase, setPhase] = useState<Phase>({ tag: "loading" });

  useEffect(() => {
    (async () => {
      try {
        const result = await checkSuperAdminAccess({ data: {} });
        if (result?.isSuperAdmin) {
          setPhase({ tag: "ready" });
        } else {
          setPhase({ tag: "denied" });
        }
      } catch {
        setPhase({ tag: "denied" });
      }
    })();
  }, []);

  if (phase.tag === "loading") {
    return (
      <div className="min-h-dvh bg-background flex items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (phase.tag === "denied") {
    return (
      <div className="min-h-dvh bg-background flex flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="size-16 rounded-3xl bg-red-500/20 grid place-items-center">
          <ShieldCheck className="size-8 text-red-400" />
        </div>
        <h1 className="text-xl font-extrabold text-white">Access Denied</h1>
        <p className="text-sm text-muted-foreground max-w-xs">
          This dashboard is restricted to super_admin accounts only.
        </p>
        <a href="/" className="text-sm text-cyan underline mt-2">Return to app</a>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-background">
      <FounderDashboard />
    </div>
  );
}
