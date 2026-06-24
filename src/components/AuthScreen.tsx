import { useState } from "react";
  import { Mail, Lock, User, ArrowRight, Eye, EyeOff, ShieldCheck, CheckCircle2, Gift } from "lucide-react";
  import { supabase } from "../lib/supabase";

  const PROD_URL = "https://7evencards.xyz";

  type AuthMode = "signin" | "signup";

  interface AuthScreenProps {
    onAuthenticated: () => void;
    /** Referral code from ?ref= URL param. Stored to localStorage before signUp. */
    referralCode?: string;
  }

  export function AuthScreen({ onAuthenticated, referralCode }: AuthScreenProps) {
    const [mode, setMode] = useState<AuthMode>("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [fullName, setFullName] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [resetSent, setResetSent] = useState(false);

    const switchMode = (next: AuthMode) => {
      setMode(next); setError(""); setEmail(""); setPassword(""); setFullName("");
    };

    const handleSignIn = async () => {
      setError("");
      if (!email.trim()) { setError("Enter your email address"); return; }
      if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
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
      if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
      if (fullName.trim().length < 2) { setError("Enter your full name"); return; }
      setLoading(true);
      try {
        // Persist referral code BEFORE signUp so it survives email-confirmation redirects
        if (referralCode) localStorage.setItem("7sc_pending_ref", referralCode);

        const { data, error: err } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { full_name: fullName.trim() },
            // Always use the production domain — never window.location.origin (which is localhost in dev)
            emailRedirectTo: PROD_URL,
          },
        });
        if (err) throw err;
        if (data.user) {
          await supabase.from("profiles").upsert(
            { id: data.user.id, full_name: fullName.trim() },
            { onConflict: "id" }
          );
        }
        onAuthenticated();
      } catch (e: unknown) {
        localStorage.removeItem("7sc_pending_ref");
        const msg = e instanceof Error ? e.message : "Sign up failed";
        setError(msg.includes("already registered")
          ? "An account with this email already exists. Sign in instead."
          : msg);
      } finally {
        setLoading(false);
      }
    };

    const handleForgotPassword = async () => {
      if (!email.trim()) { setError("Enter your email first, then click Forgot Password"); return; }
      setLoading(true);
      try {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          // Always use production URL — never window.location.origin
          redirectTo: `${PROD_URL}/reset-password`,
        });
        if (err) throw err;
        setError(""); setResetSent(true);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to send reset email");
      } finally {
        setLoading(false);
      }
    };

    return (
      <div className="min-h-dvh bg-background text-foreground flex flex-col">
        <div className="mx-auto w-full max-w-[480px] flex flex-col min-h-dvh">

          {/* Hero */}
          <div className="bg-gradient-hero px-6 pt-14 pb-10 rounded-b-[2.5rem] shadow-glow-jungle relative overflow-hidden flex-shrink-0">
            <div className="absolute -right-16 -top-16 size-56 rounded-full bg-gold/10 blur-3xl" />
            <div className="absolute -left-8 bottom-0 size-40 rounded-full bg-cyan/10 blur-2xl" />
            <div className="relative">
              <img
                src="/logo-full.png"
                alt="7SEVEN CARDS"
                className="h-9 object-contain"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              <h1 className="text-3xl font-extrabold text-white mt-4 leading-tight">
                Verify Fast.<br />Get Paid Faster.
              </h1>
              <p className="text-sm text-white/70 mt-1.5 font-medium">
                Sell gift cards &amp; crypto for Naira in under 5 minutes.
              </p>
              <div className="mt-5 grid grid-cols-3 gap-2.5">
                {[
                  { value: "\u20A60", label: "Fees" },
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
              {(["signin", "signup"] as AuthMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => switchMode(m)}
                  className={`py-2.5 rounded-xl text-sm font-bold transition ${mode === m ? "bg-card shadow text-foreground" : "text-muted-foreground"}`}
                >
                  {m === "signin" ? "Sign In" : "Create Account"}
                </button>
              ))}
            </div>
          </div>

          {/* Form */}
          <div className="flex-1 px-6 pt-5 pb-8 flex flex-col gap-4">

            {/* Referral badge */}
            {mode === "signup" && referralCode && (
              <div className="flex items-center gap-2.5 rounded-2xl bg-gold/10 border border-gold/30 px-4 py-3">
                <div className="size-8 rounded-xl bg-gold/20 grid place-items-center flex-shrink-0">
                  <Gift className="size-4 text-gold" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-extrabold text-gold">You've been invited!</p>
                  <p className="text-[11px] text-gold/70">
                    Code <span className="font-mono font-bold">{referralCode}</span> — you both earn +100 XP on your first trade
                  </p>
                </div>
              </div>
            )}

            {/* Full name — sign-up only */}
            {mode === "signup" && (
              <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
                <div className="size-10 rounded-xl bg-secondary grid place-items-center flex-shrink-0">
                  <User className="size-5 text-muted-foreground" />
                </div>
                <input
                  type="text"
                  placeholder="Full name"
                  aria-label="Full name"
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
                aria-label="Email address"
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
                placeholder="Password (min 8 chars)"
                aria-label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (mode === "signin" ? handleSignIn() : handleSignUp())}
                className="bg-transparent outline-none text-base font-semibold flex-1 placeholder:text-muted-foreground/50"
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="text-muted-foreground flex-shrink-0"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="size-4.5" /> : <Eye className="size-4.5" />}
              </button>
            </div>

            {/* Error */}
            {error && <p className="text-sm text-pink font-semibold text-center px-2">{error}</p>}

            {/* CTA */}
            <button
              onClick={mode === "signin" ? handleSignIn : handleSignUp}
              disabled={loading}
              className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold active:scale-[0.99] transition disabled:opacity-60"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="size-4 border-2 border-jungle-deep/30 border-t-jungle-deep rounded-full animate-spin" />
                  {mode === "signin" ? "Signing in\u2026" : "Creating account\u2026"}
                </span>
              ) : mode === "signin" ? (
                <><ShieldCheck className="size-5" /> Sign In</>
              ) : (
                <>Create Account <ArrowRight className="size-5" /></>
              )}
            </button>

            {/* Forgot password */}
            {mode === "signin" && (
              resetSent ? (
                <div className="flex items-center justify-center gap-2 rounded-2xl bg-jungle/20 border border-jungle/40 px-4 py-3">
                  <CheckCircle2 className="size-4 text-cyan shrink-0" />
                  <p className="text-xs text-cyan font-semibold">Reset link sent — check your inbox</p>
                </div>
              ) : (
                <button
                  onClick={handleForgotPassword}
                  disabled={loading}
                  className="text-xs text-muted-foreground font-semibold text-center hover:text-foreground transition"
                >
                  Forgot password?
                </button>
              )
            )}

            <p className="text-center text-[11px] text-muted-foreground mt-auto pt-2">
              By continuing you agree to our{" "}
              <a href="/terms" className="underline underline-offset-2">Terms of Service</a> and{" "}
              <a href="/privacy" className="underline underline-offset-2">Privacy Policy</a>.
              <br />7SEVEN CARDS \u00B7 Built for Africa \uD83C\uDF0D
            </p>
          </div>
        </div>
      </div>
    );
  }
  