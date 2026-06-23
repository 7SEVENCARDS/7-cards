import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import {
  ShieldCheck, Loader2, Lock, AlertTriangle, Eye, EyeOff,
  LogOut, ChevronRight, Shield,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import { checkAdminAccess } from "../server-functions/admin-auth";
import { AdminScreen } from "../components/AdminScreen";

export const Route = createFileRoute("/admin")({
  component: AdminPortal,
});

// ─── Auth state machine ────────────────────────────────────────────────────────
type Phase =
  | { tag: "loading" }
  | { tag: "login"; error?: string }
  | { tag: "checking" }
  | { tag: "denied" }
  | { tag: "authenticated"; adminId: string; role: string };

// ─── Root component ────────────────────────────────────────────────────────────
function AdminPortal() {
  const [phase, setPhase] = useState<Phase>({ tag: "loading" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  const verifyAdminSession = useCallback(async () => {
    try {
      const result = await checkAdminAccess({ data: {} });
      if (result.isAdmin && result.adminId) {
        setPhase({ tag: "authenticated", adminId: result.adminId, role: result.role ?? "admin" });
      } else {
        setPhase({ tag: "login" });
      }
    } catch {
      setPhase({ tag: "login" });
    }
  }, []);

  useEffect(() => {
    verifyAdminSession();
  }, [verifyAdminSession]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setSigningIn(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) {
        setPhase({ tag: "login", error: error.message });
        return;
      }
      setPhase({ tag: "checking" });
      const result = await checkAdminAccess({ data: {} });
      if (result.isAdmin && result.adminId) {
        setPhase({ tag: "authenticated", adminId: result.adminId, role: result.role ?? "admin" });
      } else {
        await supabase.auth.signOut();
        setPhase({ tag: "denied" });
      }
    } catch {
      setPhase({ tag: "login", error: "Login failed. Please try again." });
    } finally {
      setSigningIn(false);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setEmail("");
    setPassword("");
    setPhase({ tag: "login" });
  };

  // ── Loading / Checking ───────────────────────────────────────────────────────
  if (phase.tag === "loading" || phase.tag === "checking") {
    return (
      <div className="min-h-screen bg-[#030712] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 text-yellow-400 animate-spin" />
          <p className="text-sm text-zinc-400">
            {phase.tag === "checking" ? "Verifying access…" : "Loading admin portal…"}
          </p>
        </div>
      </div>
    );
  }

  // ── Access Denied ────────────────────────────────────────────────────────────
  if (phase.tag === "denied") {
    return (
      <div className="min-h-screen bg-[#030712] flex items-center justify-center px-4">
        <div className="max-w-sm w-full text-center">
          <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="h-8 w-8 text-red-400" />
          </div>
          <h2 className="text-lg font-semibold text-white mb-2">Access Denied</h2>
          <p className="text-sm text-zinc-400 mb-6">
            Your account does not have admin privileges. Contact a super admin if
            you believe this is an error.
          </p>
          <button
            onClick={() => setPhase({ tag: "login" })}
            className="w-full py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm text-white transition-colors"
          >
            Try a different account
          </button>
        </div>
      </div>
    );
  }

  // ── Authenticated: full admin dashboard ──────────────────────────────────────
  if (phase.tag === "authenticated") {
    return (
      <div className="min-h-screen bg-[#030712]">
        {/* Admin portal header bar */}
        <div className="border-b border-zinc-800 bg-[#0a0f1e] px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-yellow-400" />
            <span className="text-xs font-semibold text-yellow-400 uppercase tracking-widest">
              Admin Portal
            </span>
            {phase.role === "super_admin" && (
              <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-500/20 text-purple-400 border border-purple-500/30 uppercase tracking-wider">
                Super Admin
              </span>
            )}
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>

        {/* Admin dashboard content */}
        <AdminScreen adminId={phase.adminId} onBack={handleLogout} />
      </div>
    );
  }

  // ── Login form ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#030712] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo + title */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-yellow-400/10 border border-yellow-400/20 flex items-center justify-center mx-auto mb-4">
            <ShieldCheck className="h-7 w-7 text-yellow-400" />
          </div>
          <h1 className="text-xl font-bold text-white">Admin Portal</h1>
          <p className="mt-1 text-sm text-zinc-400">7SEVEN CARDS — Admin Access</p>
        </div>

        {/* Error banner */}
        {phase.error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2.5">
            <AlertTriangle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
            <p className="text-xs text-red-300">{phase.error}</p>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">
              Admin Email
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="admin@7evencards.xyz"
              required
              autoComplete="username"
              className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-yellow-400/50 focus:ring-1 focus:ring-yellow-400/20 transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">
              Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
                className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-yellow-400/50 focus:ring-1 focus:ring-yellow-400/20 transition-colors pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(p => !p)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={signingIn || !email || !password}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-yellow-400 hover:bg-yellow-300 text-black text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-2"
          >
            {signingIn ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Authenticating…
              </>
            ) : (
              <>
                <Lock className="h-4 w-4" />
                Sign In to Admin Portal
                <ChevronRight className="h-4 w-4" />
              </>
            )}
          </button>
        </form>

        {/* Footer */}
        <div className="mt-8 text-center">
          <p className="text-xs text-zinc-600">
            Restricted access. Unauthorised attempts are logged.
          </p>
          <p className="mt-1 text-xs text-zinc-700">
            <a href="https://7evencards.xyz" className="hover:text-zinc-500 transition-colors">
              ← Back to 7SEVEN CARDS
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
