import { useState } from "react";
import { Mail, Lock, User, ArrowRight, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { supabase } from "../lib/supabase";
import logoFullAsset from "../assets/logo-full.png.asset.json";

type AuthMode = "signin" | "signup";
type AuthStep = "credentials" | "name";

interface AuthScreenProps {
  onAuthenticated: () => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [step, setStep] = useState<AuthStep>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError("");
    setEmail("");
    setPassword("");
    setFullName("");
  };

  const handleSignIn = async () => {
    setError("");
    if (!email.trim()) { setError("Enter your email address"); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
    setLoading(true);
    try {
      const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (err) throw err;
      onAuthenticated();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Sign in failed";
      setError(msg.includes("Invalid login") ? "Incorrect email or password" : msg);
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async () => {
    setError("");
    if (!email.trim()) { setError("Enter your email address"); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
    if (fullName.trim().length < 2) { setError("Enter your full name"); return; }
    setLoading(true);
    try {
      const { data, error: err } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { full_name: fullName.trim() } },
      });
      if (err) throw err;
      if (data.user) {
        await supabase.from("profiles").upsert({
          id: data.user.id,
          full_name: fullName.trim(),
        }, { onConflict: "id" });
      }
      onAuthenticated();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Sign up failed";
      setError(msg.includes("already registered") ? "An account with this email already exists. Sign in instead." : msg);
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email.trim()) { setError("Enter your email first, then click Forgot Password"); return; }
    setLoading(true);
    try {
      const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (err) throw err;
      setError("");
      alert(`Password reset email sent to ${email.trim()}. Check your inbox.`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to send reset email");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <div className="mx-auto w-full max-w-[480px] flex flex-col min-h-screen">

        {/* Hero */}
        <div className="bg-gradient-hero px-6 pt-14 pb-10 rounded-b-[2.5rem] shadow-glow-jungle relative overflow-hidden flex-shrink-0">
          <div className="absolute -right-16 -top-16 size-56 rounded-full bg-gold/10 blur-3xl" />
          <div className="absolute -left-8 bottom-0 size-40 rounded-full bg-cyan/10 blur-2xl" />
          <div className="relative">
            <img
              src={logoFullAsset.url}
              alt="7SEVEN CARDS"
              className="h-9 object-contain"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            <h1 className="text-3xl font-extrabold text-white mt-4 leading-tight">
              Verify Fast.<br />Get Paid Faster.
            </h1>
            <p className="text-sm text-white/70 mt-1.5 font-medium">
              Sell gift cards & crypto for Naira in under 5 minutes.
            </p>
            <div className="mt-5 grid grid-cols-3 gap-2.5">
              {[
                { value: "₦0", label: "Fees" },
                { value: "<5min", label: "Payout" },
                { value: "50+ XP", label: "Per Trade" },
              ].map((s) => (
                <div key={s.label} className="bg-white/10 backdrop-blur rounded-2xl p-3 border border-white/15 text-center">
                  <p className="text-base font-extrabold text-white">{s.value}</p>
                  <p className="text-[10px] text-white/70 font-semibold">{s.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Mode toggle */}
        <div className="px-6 pt-6">
          <div className="bg-secondary rounded-2xl p-1 grid grid-cols-2 gap-1">
            <button
              onClick={() => switchMode("signin")}
              className={`py-2.5 rounded-xl text-sm font-bold transition ${mode === "signin" ? "bg-card shadow text-foreground" : "text-muted-foreground"}`}
            >
              Sign In
            </button>
            <button
              onClick={() => switchMode("signup")}
              className={`py-2.5 rounded-xl text-sm font-bold transition ${mode === "signup" ? "bg-card shadow text-foreground" : "text-muted-foreground"}`}
            >
              Create Account
            </button>
          </div>
        </div>

        {/* Form */}
        <div className="flex-1 px-6 pt-5 pb-8 flex flex-col gap-4">

          {/* Full name — sign up only */}
          {mode === "signup" && (
            <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
              <div className="size-10 rounded-xl bg-secondary grid place-items-center flex-shrink-0">
                <User className="size-5 text-muted-foreground" />
              </div>
              <input
                type="text"
                placeholder="Full name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="bg-transparent outline-none text-base font-semibold flex-1 placeholder:text-muted-foreground/50"
                autoComplete="name"
              />
            </div>
          )}

          {/* Email */}
          <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
            <div className="size-10 rounded-xl bg-secondary grid place-items-center flex-shrink-0">
              <Mail className="size-5 text-muted-foreground" />
            </div>
            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (mode === "signin" ? handleSignIn() : handleSignUp())}
              className="bg-transparent outline-none text-base font-semibold flex-1 placeholder:text-muted-foreground/50"
              autoComplete="email"
              inputMode="email"
            />
          </div>

          {/* Password */}
          <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
            <div className="size-10 rounded-xl bg-secondary grid place-items-center flex-shrink-0">
              <Lock className="size-5 text-muted-foreground" />
            </div>
            <input
              type={showPassword ? "text" : "password"}
              placeholder="Password (min 6 chars)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (mode === "signin" ? handleSignIn() : handleSignUp())}
              className="bg-transparent outline-none text-base font-semibold flex-1 placeholder:text-muted-foreground/50"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="text-muted-foreground flex-shrink-0"
              tabIndex={-1}
            >
              {showPassword ? <EyeOff className="size-4.5" /> : <Eye className="size-4.5" />}
            </button>
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-pink font-semibold text-center px-2">{error}</p>
          )}

          {/* CTA */}
          <button
            onClick={mode === "signin" ? handleSignIn : handleSignUp}
            disabled={loading}
            className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold active:scale-[0.99] transition disabled:opacity-60"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="size-4 border-2 border-jungle-deep/30 border-t-jungle-deep rounded-full animate-spin" />
                {mode === "signin" ? "Signing in…" : "Creating account…"}
              </span>
            ) : mode === "signin" ? (
              <><ShieldCheck className="size-5" /> Sign In</>
            ) : (
              <>Create Account <ArrowRight className="size-5" /></>
            )}
          </button>

          {/* Forgot password */}
          {mode === "signin" && (
            <button
              onClick={handleForgotPassword}
              disabled={loading}
              className="text-xs text-muted-foreground font-semibold text-center hover:text-foreground transition"
            >
              Forgot password?
            </button>
          )}

          <p className="text-center text-[11px] text-muted-foreground mt-auto pt-2">
            By continuing you agree to our{" "}
            <a href="/terms" className="underline underline-offset-2">Terms of Service</a> and{" "}
            <a href="/privacy" className="underline underline-offset-2">Privacy Policy</a>.
            <br />7SEVEN CARDS · Built for Africa 🌍
          </p>
        </div>
      </div>
    </div>
  );
}
