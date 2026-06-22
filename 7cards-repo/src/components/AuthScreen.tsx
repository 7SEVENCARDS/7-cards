import { useState } from "react";
import { ShieldCheck, Mail, Eye, EyeOff, ArrowRight, KeyRound } from "lucide-react";
import { supabase } from "../lib/supabase";
import logoFullAsset from "../assets/logo-full.png.asset.json";

type AuthStep = "login" | "register" | "verify-email" | "name";

interface AuthScreenProps {
  onAuthenticated: () => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [step, setStep] = useState<AuthStep>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const handleLogin = async () => {
    setError("");
    if (!email.trim()) { setError("Enter your email address"); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
    setLoading(true);
    try {
      const { data, error: err } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (err) throw err;
      if (!data.session) throw new Error("No session returned");

      const { data: profile } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", data.session.user.id)
        .single();

      if (!profile?.full_name) {
        setStep("name");
      } else {
        onAuthenticated();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Login failed";
      if (msg.toLowerCase().includes("invalid login") || msg.toLowerCase().includes("invalid credentials")) {
        setError("Incorrect email or password. Try again or create an account.");
      } else if (msg.toLowerCase().includes("email not confirmed")) {
        setInfo("Please verify your email first — check your inbox.");
        setError("");
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    setError("");
    if (!email.trim()) { setError("Enter your email address"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Enter a valid email address"); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
    setLoading(true);
    try {
      const { data, error: err } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          emailRedirectTo: window.location.origin,
        },
      });
      if (err) throw err;

      if (data.session) {
        // Email confirmations disabled — immediately signed in
        const { data: profile } = await supabase
          .from("profiles")
          .select("full_name")
          .eq("id", data.session.user.id)
          .single();
        if (!profile?.full_name) {
          setStep("name");
        } else {
          onAuthenticated();
        }
      } else {
        // Email confirmation required
        setStep("verify-email");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Registration failed";
      if (msg.toLowerCase().includes("already registered") || msg.toLowerCase().includes("user already registered")) {
        setError("This email is already registered. Please log in.");
        setStep("login");
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResendVerification = async () => {
    setError("");
    setLoading(true);
    try {
      const { error: err } = await supabase.auth.resend({
        type: "signup",
        email: email.trim().toLowerCase(),
      });
      if (err) throw err;
      setInfo("Verification email resent — check your inbox.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to resend");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveName = async () => {
    setError("");
    if (fullName.trim().length < 2) {
      setError("Enter your full name");
      return;
    }
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      await supabase
        .from("profiles")
        .update({ full_name: fullName.trim() })
        .eq("id", user.id);

      onAuthenticated();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save name");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <div className="mx-auto w-full max-w-[480px] flex flex-col min-h-screen">

        {/* Hero */}
        <div className="bg-gradient-hero px-6 pt-16 pb-12 rounded-b-[2.5rem] shadow-glow-jungle relative overflow-hidden flex-shrink-0">
          <div className="absolute -right-16 -top-16 size-56 rounded-full bg-gold/10 blur-3xl" />
          <div className="absolute -left-8 bottom-0 size-40 rounded-full bg-cyan/10 blur-2xl" />

          <div className="relative">
            <img
              src={logoFullAsset.url}
              alt="7SEVEN CARDS"
              className="h-10 object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
            <h1 className="text-3xl font-extrabold text-white mt-5 leading-tight">
              Verify Fast.<br />Get Paid Faster.
            </h1>
            <p className="text-sm text-white/70 mt-2 font-medium">
              Sell gift cards for Naira in under 5 minutes.
            </p>

            <div className="mt-6 grid grid-cols-3 gap-3">
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

        {/* Form */}
        <div className="flex-1 px-6 py-8 flex flex-col gap-5">

          {/* Tab toggle: Login / Register */}
          {(step === "login" || step === "register") && (
            <div className="flex gap-1 bg-card p-1 rounded-2xl border border-border">
              <button
                onClick={() => { setStep("login"); setError(""); setInfo(""); }}
                className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition ${step === "login" ? "bg-gold text-jungle-deep" : "text-muted-foreground"}`}
              >
                Log In
              </button>
              <button
                onClick={() => { setStep("register"); setError(""); setInfo(""); }}
                className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition ${step === "register" ? "bg-gold text-jungle-deep" : "text-muted-foreground"}`}
              >
                Create Account
              </button>
            </div>
          )}

          {/* Email field */}
          {(step === "login" || step === "register") && (
            <>
              <div className="space-y-3">
                <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
                  <div className="size-10 rounded-xl bg-secondary grid place-items-center flex-shrink-0">
                    <Mail className="size-5 text-muted-foreground" />
                  </div>
                  <input
                    type="email"
                    placeholder="you@email.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (step === "login" ? handleLogin() : handleRegister())}
                    className="bg-transparent outline-none text-base font-semibold flex-1 placeholder:text-muted-foreground/50"
                    inputMode="email"
                    autoComplete="email"
                  />
                </div>

                <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
                  <div className="size-10 rounded-xl bg-secondary grid place-items-center flex-shrink-0">
                    <KeyRound className="size-5 text-muted-foreground" />
                  </div>
                  <input
                    type={showPassword ? "text" : "password"}
                    placeholder="Password (min 6 characters)"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (step === "login" ? handleLogin() : handleRegister())}
                    className="bg-transparent outline-none text-base font-semibold flex-1 placeholder:text-muted-foreground/50"
                    autoComplete={step === "login" ? "current-password" : "new-password"}
                  />
                  <button onClick={() => setShowPassword((v) => !v)} className="text-muted-foreground flex-shrink-0">
                    {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
                  </button>
                </div>
              </div>

              {error && <p className="text-sm text-pink font-semibold text-center">{error}</p>}
              {info && <p className="text-sm text-cyan font-semibold text-center">{info}</p>}

              <button
                onClick={step === "login" ? handleLogin : handleRegister}
                disabled={loading}
                className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold active:scale-[0.99] transition disabled:opacity-60"
              >
                {loading
                  ? (step === "login" ? "Signing in…" : "Creating account…")
                  : step === "login"
                    ? <><ShieldCheck className="size-5" /> Sign In</>
                    : <>Create Account <ArrowRight className="size-5" /></>
                }
              </button>

              {step === "login" && (
                <button
                  onClick={() => { setStep("register"); setError(""); setInfo(""); }}
                  className="text-center text-xs text-muted-foreground font-semibold"
                >
                  No account yet? <span className="text-gold underline">Create one free</span>
                </button>
              )}
            </>
          )}

          {/* Email verification step */}
          {step === "verify-email" && (
            <>
              <div className="text-center space-y-3">
                <div className="size-16 rounded-full bg-cyan/15 grid place-items-center mx-auto">
                  <Mail className="size-8 text-cyan" />
                </div>
                <h2 className="text-xl font-extrabold">Check your inbox</h2>
                <p className="text-sm text-muted-foreground">
                  We sent a verification link to<br />
                  <span className="text-foreground font-semibold">{email}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Click the link in the email to verify your account, then come back and log in.
                </p>
              </div>

              {error && <p className="text-sm text-pink font-semibold text-center">{error}</p>}
              {info && <p className="text-sm text-cyan font-semibold text-center">{info}</p>}

              <button
                onClick={handleResendVerification}
                disabled={loading}
                className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold active:scale-[0.99] transition disabled:opacity-60"
              >
                {loading ? "Resending…" : "Resend Verification Email"}
              </button>

              <button
                onClick={() => { setStep("login"); setError(""); setInfo(""); }}
                className="text-center text-xs text-muted-foreground font-semibold"
              >
                Already verified? <span className="text-gold underline">Log in</span>
              </button>
            </>
          )}

          {/* Name step */}
          {step === "name" && (
            <>
              <div>
                <h2 className="text-xl font-extrabold">What's your name?</h2>
                <p className="text-sm text-muted-foreground mt-1">Used on your profile and payouts</p>
              </div>

              <div className="bg-card rounded-2xl border border-border p-4">
                <input
                  type="text"
                  placeholder="Tunde Adebayo"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSaveName()}
                  className="bg-transparent outline-none text-base font-semibold w-full placeholder:text-muted-foreground/50"
                />
              </div>

              {error && <p className="text-sm text-pink font-semibold text-center">{error}</p>}

              <button
                onClick={handleSaveName}
                disabled={loading}
                className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold active:scale-[0.99] transition disabled:opacity-60"
              >
                {loading ? "Saving…" : <>Let's Go <ArrowRight className="size-5" /></>}
              </button>
            </>
          )}

          <p className="text-center text-[11px] text-muted-foreground mt-auto pt-4">
            By continuing you agree to our Terms of Service and Privacy Policy.
            <br />7SEVEN CARDS · Built for Africa 🌍
          </p>
        </div>
      </div>
    </div>
  );
}
