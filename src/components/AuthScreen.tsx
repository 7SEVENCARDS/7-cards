import { useState } from "react";
import { ShieldCheck, Phone, ArrowRight, RotateCcw } from "lucide-react";
import { supabase } from "../lib/supabase";
import logoFullAsset from "../assets/logo-full.png.asset.json";

type AuthStep = "phone" | "otp" | "name";

interface AuthScreenProps {
  onAuthenticated: () => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [step, setStep] = useState<AuthStep>("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const formatPhone = (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("0")) return "+234" + digits.slice(1);
    if (digits.startsWith("234")) return "+" + digits;
    return "+" + digits;
  };

  const handleSendOTP = async () => {
    setError("");
    if (phone.replace(/\D/g, "").length < 10) {
      setError("Enter a valid Nigerian phone number");
      return;
    }
    setLoading(true);
    try {
      const { error: err } = await supabase.auth.signInWithOtp({
        phone: formatPhone(phone),
      });
      if (err) throw err;
      setStep("otp");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to send OTP");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async () => {
    setError("");
    if (otp.length < 6) {
      setError("Enter the 6-digit code");
      return;
    }
    setLoading(true);
    try {
      const { data, error: err } = await supabase.auth.verifyOtp({
        phone: formatPhone(phone),
        token: otp,
        type: "sms",
      });
      if (err) throw err;
      if (!data.session) throw new Error("No session returned");

      // Check if profile has a name
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
      setError(e instanceof Error ? e.message : "Invalid OTP code");
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
              Sell gift cards & crypto for Naira in under 5 minutes.
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

          {step === "phone" && (
            <>
              <div>
                <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider">Step 1 of 2</p>
                <h2 className="text-xl font-extrabold mt-1">Enter your phone number</h2>
                <p className="text-sm text-muted-foreground mt-1">We'll send you a verification code</p>
              </div>

              <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
                <div className="size-10 rounded-xl bg-secondary grid place-items-center flex-shrink-0">
                  <Phone className="size-5 text-muted-foreground" />
                </div>
                <input
                  type="tel"
                  placeholder="08012345678"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSendOTP()}
                  className="bg-transparent outline-none text-base font-semibold flex-1 placeholder:text-muted-foreground/50"
                  inputMode="tel"
                />
              </div>

              {error && (
                <p className="text-sm text-pink font-semibold text-center">{error}</p>
              )}

              <button
                onClick={handleSendOTP}
                disabled={loading}
                className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold active:scale-[0.99] transition disabled:opacity-60"
              >
                {loading ? "Sending…" : <>Send Code <ArrowRight className="size-5" /></>}
              </button>
            </>
          )}

          {step === "otp" && (
            <>
              <div>
                <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider">Step 2 of 2</p>
                <h2 className="text-xl font-extrabold mt-1">Enter verification code</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Sent to <span className="text-foreground font-semibold">{phone}</span>
                </p>
              </div>

              <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
                <input
                  type="text"
                  placeholder="123456"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => e.key === "Enter" && handleVerifyOTP()}
                  className="bg-transparent outline-none text-3xl font-extrabold flex-1 tracking-[0.4em] placeholder:text-muted-foreground/30 placeholder:tracking-normal"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
              </div>

              {error && (
                <p className="text-sm text-pink font-semibold text-center">{error}</p>
              )}

              <button
                onClick={handleVerifyOTP}
                disabled={loading}
                className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold active:scale-[0.99] transition disabled:opacity-60"
              >
                {loading ? "Verifying…" : <>Verify & Enter <ShieldCheck className="size-5" /></>}
              </button>

              <button
                onClick={() => { setStep("phone"); setOtp(""); setError(""); }}
                className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground font-semibold"
              >
                <RotateCcw className="size-3.5" /> Change number
              </button>
            </>
          )}

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

              {error && (
                <p className="text-sm text-pink font-semibold text-center">{error}</p>
              )}

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
