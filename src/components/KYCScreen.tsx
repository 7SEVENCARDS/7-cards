import React, { useState } from "react";
import {
  ChevronLeft, ChevronRight, ShieldCheck, AlertCircle,
  Loader2, CheckCircle2, Clock, User, CreditCard, Eye, EyeOff,
} from "lucide-react";
import { verifyBVN, verifyNIN, submitKYC } from "../server-functions/kyc";
import { useQueryClient } from "@tanstack/react-query";

type KYCStep = "intro" | "bvn" | "bvn-confirm" | "nin" | "submitted";

interface IdentityData {
  firstName: string;
  middleName: string;
  lastName: string;
  dateOfBirth: string;
  phoneNumber: string;
  gender: string;
  photo: string | null;
}

interface KYCScreenProps {
  userId: string;
  currentStatus: string;
  hasBVN: boolean;
  hasNIN: boolean;
  onBack: () => void;
  onComplete: () => void;
}

export function KYCScreen({
  userId, currentStatus, hasBVN, hasNIN, onBack, onComplete,
}: KYCScreenProps) {
  const qc = useQueryClient();
  const [step, setStep] = useState<KYCStep>(
    currentStatus === "verified" ? "submitted"
    : currentStatus === "submitted" ? "submitted"
    : "intro"
  );
  const [bvn, setBVN] = useState("");
  const [nin, setNIN] = useState("");
  const [showBVN, setShowBVN] = useState(false);
  const [showNIN, setShowNIN] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [identity, setIdentity] = useState<IdentityData | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const handleVerifyBVN = async () => {
    setError("");
    if (!/^\d{11}$/.test(bvn)) {
      setError("BVN must be exactly 11 digits");
      return;
    }
    setLoading(true);
    try {
      const result = await verifyBVN({ data: { bvn } });
      if ((result as { success: boolean }).success) {
        setIdentity((result as { identity: IdentityData }).identity);
        setStep("bvn-confirm");
      } else {
        setError((result as { error?: string }).error ?? "BVN verification failed");
      }
    } catch {
      setError("Service temporarily unavailable. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmBVN = async () => {
    setLoading(true);
    try {
      await submitKYC({ data: {} });
      qc.invalidateQueries({ queryKey: ["kyc-status", userId] });
      qc.invalidateQueries({ queryKey: ["profile", userId] });
      qc.invalidateQueries({ queryKey: ["notifications", userId] });
      setStep("nin");
    } catch {
      setError("Failed to save. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyNIN = async () => {
    setError("");
    if (nin && !/^\d{11}$/.test(nin)) {
      setError("NIN must be exactly 11 digits");
      return;
    }
    setLoading(true);
    try {
      if (nin) {
        await verifyNIN({ data: { nin } });
      }
      qc.invalidateQueries({ queryKey: ["profile", userId] });
      setStep("submitted");
      onComplete();
    } catch {
      setError("NIN verification failed. You can skip this step.");
    } finally {
      setLoading(false);
    }
  };

  const STATUS_BADGE: Record<string, { color: string; label: string; icon: React.ReactNode }> = {
    pending:   { color: "bg-secondary text-muted-foreground", label: "Not Started",    icon: <Clock className="size-3" /> },
    submitted: { color: "bg-gold/15 text-gold",               label: "Under Review",   icon: <Clock className="size-3" /> },
    verified:  { color: "bg-cyan/15 text-cyan",               label: "KYC Verified",   icon: <ShieldCheck className="size-3" /> },
    rejected:  { color: "bg-pink/15 text-pink",               label: "Rejected",       icon: <AlertCircle className="size-3" /> },
  };

  const badge = STATUS_BADGE[currentStatus] ?? STATUS_BADGE.pending;

  return (
    <div className="flex flex-col min-h-dvh bg-background">
      <div className="mx-auto w-full max-w-[480px] flex flex-col flex-1">

        {/* Header */}
        <header className="px-5 pt-safe-top pb-4 flex items-center gap-4">
          <button onClick={onBack} className="size-10 rounded-full bg-card border border-border grid place-items-center flex-shrink-0">
            <ChevronLeft className="size-5" />
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-extrabold">Identity Verification</h1>
            <p className="text-xs text-muted-foreground">Optional · Unlock higher trade limits</p>
          </div>
          <span className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold ${badge.color}`}>
            {badge.icon} {badge.label}
          </span>
        </header>

        {/* ── INTRO ──────────────────────────────────────────────────────────── */}
        {step === "intro" && (
          <div className="px-5 flex flex-col gap-5 flex-1">

            {/* Limits comparison */}
            <div className="rounded-2xl border border-white/10 overflow-hidden">
              <div className="grid grid-cols-2 divide-x divide-white/10">
                <div className="p-4 space-y-1">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Without KYC</p>
                  <p className="text-xl font-extrabold text-foreground">₦200k</p>
                  <p className="text-[11px] text-muted-foreground">per trade limit</p>
                  <div className="space-y-1 pt-2">
                    {["$200 max per trade", "Standard rates", "Normal processing"].map(t => (
                      <p key={t} className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                        <span className="size-1 rounded-full bg-muted-foreground/50 shrink-0" />{t}
                      </p>
                    ))}
                  </div>
                </div>
                <div className="p-4 space-y-1 bg-gold/5">
                  <p className="text-[10px] font-bold text-gold uppercase tracking-wider">✓ Verified</p>
                  <p className="text-xl font-extrabold text-gold">₦5M</p>
                  <p className="text-[11px] text-muted-foreground">per trade limit</p>
                  <div className="space-y-1 pt-2">
                    {["$5,000 max per trade", "+2% better rates", "Priority payouts"].map(t => (
                      <p key={t} className="text-[11px] text-gold/80 flex items-center gap-1.5">
                        <span className="size-1 rounded-full bg-gold shrink-0" />{t}
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Why KYC */}
            <div className="bg-card rounded-2xl border border-border p-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="size-12 rounded-2xl bg-cyan/15 grid place-items-center">
                  <ShieldCheck className="size-6 text-cyan" />
                </div>
                <div>
                  <p className="text-sm font-extrabold">What you unlock</p>
                  <p className="text-xs text-muted-foreground">One-time · Takes under 2 minutes</p>
                </div>
              </div>
              <div className="space-y-3">
                {[
                  { icon: "💰", text: "Sell cards worth up to $5,000 per trade" },
                  { icon: "📈", text: "+2% better exchange rates on every trade" },
                  { icon: "⚡", text: "Priority payout processing via Squad" },
                  { icon: "🔒", text: "Account protected against fraud & takeover" },
                ].map((i) => (
                  <div key={i.text} className="flex items-center gap-3">
                    <span className="text-lg">{i.icon}</span>
                    <p className="text-sm text-muted-foreground">{i.text}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* What you need */}
            <div>
              <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider mb-3">What you'll need</p>
              <div className="space-y-2">
                <KYCItem
                  icon={<CreditCard className="size-5 text-gold" />}
                  label="Bank Verification Number (BVN)"
                  sub="11-digit BVN from any Nigerian bank"
                  done={hasBVN}
                />
                <KYCItem
                  icon={<User className="size-5 text-cyan" />}
                  label="National Identity Number (NIN)"
                  sub="11-digit NIN from NIMC (optional but recommended)"
                  done={hasNIN}
                />
              </div>
            </div>

            <div className="bg-gold/10 border border-gold/30 rounded-2xl p-4 flex items-start gap-3">
              <ShieldCheck className="size-4 text-gold shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground">
                Your data is encrypted. We only verify your identity — your raw BVN is never stored.
                Powered by <span className="font-semibold text-foreground">Dojah</span>.
              </p>
            </div>

            <button
              onClick={() => setStep("bvn")}
              className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold"
            >
              Unlock Higher Limits <ChevronRight className="size-5" />
            </button>

            <button onClick={onBack} className="text-xs text-muted-foreground text-center py-1">
              Maybe later — continue with ₦200k limit
            </button>
          </div>
        )}

        {/* ── BVN ENTRY ──────────────────────────────────────────────────────── */}
        {step === "bvn" && (
          <div className="px-5 flex flex-col gap-5">
            <div className="bg-gradient-hero rounded-3xl p-5 shadow-glow-jungle">
              <div className="flex items-center gap-3 mb-1">
                <div className="size-10 rounded-xl bg-white/10 grid place-items-center">
                  <CreditCard className="size-5 text-white" />
                </div>
                <div>
                  <p className="text-xs text-white/70 font-bold uppercase tracking-wide">Step 1 of 2</p>
                  <p className="text-base font-extrabold text-white">Bank Verification Number</p>
                </div>
              </div>
              <p className="text-xs text-white/60 mt-2">
                Dial <span className="font-bold text-gold">*565*0#</span> on any registered line to get your BVN instantly.
              </p>
            </div>

            <div>
              <p className="text-xs text-muted-foreground font-bold mb-2">Enter your 11-digit BVN</p>
              <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
                <CreditCard className="size-5 text-muted-foreground shrink-0" />
                <input
                  type={showBVN ? "text" : "password"}
                  inputMode="numeric"
                  maxLength={11}
                  value={bvn}
                  onChange={(e) => setBVN(e.target.value.replace(/\D/g, "").slice(0, 11))}
                  placeholder="22*********"
                  className="bg-transparent outline-none text-xl font-mono font-bold flex-1 tracking-widest placeholder:text-muted-foreground/30 placeholder:text-base placeholder:font-sans placeholder:tracking-normal"
                />
                <button onClick={() => setShowBVN((v) => !v)} className="text-muted-foreground">
                  {showBVN ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              <div className="flex justify-between mt-1.5 px-1">
                <p className="text-[11px] text-muted-foreground">Starts with 22</p>
                <p className="text-[11px] text-muted-foreground">{bvn.length}/11</p>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 bg-pink/10 border border-pink/30 rounded-2xl p-3">
                <AlertCircle className="size-4 text-pink shrink-0 mt-0.5" />
                <p className="text-xs font-semibold text-pink">{error}</p>
              </div>
            )}

            <button
              onClick={handleVerifyBVN}
              disabled={loading || bvn.length < 11}
              className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold disabled:opacity-50 transition"
            >
              {loading ? <><Loader2 className="size-4 animate-spin" /> Verifying…</> : <>Verify BVN <ChevronRight className="size-5" /></>}
            </button>

            <p className="text-center text-[11px] text-muted-foreground">
              Your BVN is used for identity verification only.<br />We do not have access to your bank accounts.
            </p>
          </div>
        )}

        {/* ── BVN CONFIRM ────────────────────────────────────────────────────── */}
        {step === "bvn-confirm" && identity && (
          <div className="px-5 flex flex-col gap-5">
            <div className="flex items-center gap-3 bg-cyan/10 border border-cyan/30 rounded-2xl p-4">
              <CheckCircle2 className="size-5 text-cyan shrink-0" />
              <div>
                <p className="text-sm font-bold text-cyan">BVN Verified Successfully</p>
                <p className="text-xs text-muted-foreground">Please confirm these details are yours</p>
              </div>
            </div>

            {/* Identity card */}
            <div className="bg-card rounded-3xl border border-border overflow-hidden">
              {identity.photo && (
                <div className="bg-gradient-hero p-5 flex items-center gap-4">
                  <img
                    src={`data:image/jpeg;base64,${identity.photo}`}
                    alt="ID photo"
                    className="size-20 rounded-2xl object-cover ring-2 ring-gold/40"
                  />
                  <div>
                    <p className="text-base font-extrabold text-white">
                      {identity.firstName} {identity.middleName} {identity.lastName}
                    </p>
                    <p className="text-xs text-white/70 mt-0.5">{identity.gender}</p>
                    <span className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gold/20 text-gold text-[10px] font-bold">
                      <ShieldCheck className="size-3" /> Identity Confirmed
                    </span>
                  </div>
                </div>
              )}
              {!identity.photo && (
                <div className="bg-gradient-hero p-5 flex items-center gap-4">
                  <div className="size-20 rounded-2xl bg-gold/20 grid place-items-center">
                    <span className="text-3xl font-extrabold text-gold">{identity.firstName[0]}</span>
                  </div>
                  <div>
                    <p className="text-base font-extrabold text-white">
                      {identity.firstName} {identity.middleName} {identity.lastName}
                    </p>
                    <p className="text-xs text-white/70 mt-0.5">{identity.gender}</p>
                  </div>
                </div>
              )}
              <div className="p-5 grid grid-cols-2 gap-3">
                <IdentField label="Date of Birth" value={identity.dateOfBirth} />
                <IdentField label="Phone" value={identity.phoneNumber} />
                <IdentField label="Gender" value={identity.gender} />
              </div>
            </div>

            {/* Confirm checkbox */}
            <button
              onClick={() => setConfirmed((v) => !v)}
              className="flex items-center gap-3 bg-card rounded-2xl border border-border p-4"
            >
              <div className={`size-5 rounded-md border-2 flex-shrink-0 grid place-items-center transition ${confirmed ? "bg-gold border-gold" : "border-border"}`}>
                {confirmed && <CheckCircle2 className="size-3.5 text-jungle-deep" />}
              </div>
              <p className="text-xs text-left text-muted-foreground">
                I confirm these are my correct identity details
              </p>
            </button>

            {error && (
              <div className="flex items-start gap-2 bg-pink/10 border border-pink/30 rounded-2xl p-3">
                <AlertCircle className="size-4 text-pink shrink-0 mt-0.5" />
                <p className="text-xs font-semibold text-pink">{error}</p>
              </div>
            )}

            <button
              onClick={handleConfirmBVN}
              disabled={!confirmed || loading}
              className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold disabled:opacity-50 transition"
            >
              {loading ? <><Loader2 className="size-4 animate-spin" /> Saving…</> : <>Confirm & Continue <ChevronRight className="size-5" /></>}
            </button>

            <button
              onClick={() => { setStep("bvn"); setIdentity(null); setConfirmed(false); }}
              className="text-xs text-muted-foreground font-semibold text-center"
            >
              Not me — go back
            </button>
          </div>
        )}

        {/* ── NIN ENTRY (optional) ─────────────────────────────────────────── */}
        {step === "nin" && (
          <div className="px-5 flex flex-col gap-5">
            <div className="bg-gradient-hero rounded-3xl p-5 shadow-glow-jungle">
              <div className="flex items-center gap-3 mb-1">
                <div className="size-10 rounded-xl bg-white/10 grid place-items-center">
                  <User className="size-5 text-white" />
                </div>
                <div>
                  <p className="text-xs text-white/70 font-bold uppercase tracking-wide">Step 2 of 2 — Optional</p>
                  <p className="text-base font-extrabold text-white">National Identity Number</p>
                </div>
              </div>
              <p className="text-xs text-white/60 mt-2">
                Adding your NIN unlocks <span className="text-gold font-semibold">+10% higher payout limits</span> and priority support.
              </p>
            </div>

            <div>
              <p className="text-xs text-muted-foreground font-bold mb-2">Enter your 11-digit NIN (optional)</p>
              <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
                <User className="size-5 text-muted-foreground shrink-0" />
                <input
                  type={showNIN ? "text" : "password"}
                  inputMode="numeric"
                  maxLength={11}
                  value={nin}
                  onChange={(e) => setNIN(e.target.value.replace(/\D/g, "").slice(0, 11))}
                  placeholder="Your NIN (optional)"
                  className="bg-transparent outline-none text-xl font-mono font-bold flex-1 tracking-widest placeholder:text-muted-foreground/30 placeholder:text-base placeholder:font-sans placeholder:tracking-normal"
                />
                <button onClick={() => setShowNIN((v) => !v)} className="text-muted-foreground">
                  {showNIN ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
                Find your NIN by dialing <span className="font-semibold">*346#</span> on your registered SIM
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-2 bg-pink/10 border border-pink/30 rounded-2xl p-3">
                <AlertCircle className="size-4 text-pink shrink-0 mt-0.5" />
                <p className="text-xs font-semibold text-pink">{error}</p>
              </div>
            )}

            <button
              onClick={handleVerifyNIN}
              disabled={loading}
              className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold disabled:opacity-50 transition"
            >
              {loading ? <><Loader2 className="size-4 animate-spin" /> Verifying…</> : <>Complete KYC <ShieldCheck className="size-5" /></>}
            </button>

            <button
              onClick={handleVerifyNIN}
              disabled={loading}
              className="text-xs text-muted-foreground font-semibold text-center py-2"
            >
              Skip for now
            </button>
          </div>
        )}

        {/* ── SUBMITTED / VERIFIED ─────────────────────────────────────────── */}
        {step === "submitted" && (
          <div className="px-5 flex flex-col items-center gap-6 flex-1 justify-center text-center">
            <div className="size-24 rounded-3xl bg-cyan/15 grid place-items-center shadow-glow-jungle">
              {currentStatus === "verified"
                ? <ShieldCheck className="size-12 text-cyan" />
                : <Clock className="size-12 text-gold" />
              }
            </div>

            <div>
              <h2 className="text-2xl font-extrabold">
                {currentStatus === "verified" ? "Identity Verified! ✅" : "Verification Submitted"}
              </h2>
              <p className="text-sm text-muted-foreground mt-2 max-w-[280px]">
                {currentStatus === "verified"
                  ? "Your identity has been successfully verified. You now have access to higher limits and priority payouts."
                  : "Your details are under review. This usually takes less than 24 hours. We'll notify you when done."
                }
              </p>
            </div>

            <div className="w-full space-y-3">
              {[
                { icon: "💳", label: "BVN", done: hasBVN },
                { icon: "🪪", label: "NIN", done: hasNIN },
              ].map((i) => (
                <div key={i.label} className={`flex items-center gap-3 rounded-2xl p-4 border ${i.done ? "bg-cyan/5 border-cyan/30" : "bg-card border-border"}`}>
                  <span className="text-xl">{i.icon}</span>
                  <span className="text-sm font-semibold flex-1 text-left">{i.label} Verification</span>
                  {i.done
                    ? <CheckCircle2 className="size-4 text-cyan" />
                    : <span className="text-[10px] text-muted-foreground font-medium">Not added</span>
                  }
                </div>
              ))}
            </div>

            <button
              onClick={onBack}
              className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl shadow-glow-gold"
            >
              Back to Profile
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function KYCItem({
  icon, label, sub, done, required,
}: {
  icon: React.ReactNode; label: string; sub: string; done?: boolean; required?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 bg-card rounded-2xl border p-4 ${done ? "border-cyan/40" : "border-border"}`}>
      <div className="size-10 rounded-xl bg-secondary grid place-items-center flex-shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">{label}</p>
          {required && <span className="text-[10px] bg-pink/15 text-pink px-1.5 py-0.5 rounded-full font-bold">Required</span>}
        </div>
        <p className="text-[11px] text-muted-foreground">{sub}</p>
      </div>
      {done
        ? <CheckCircle2 className="size-4 text-cyan shrink-0" />
        : <ChevronRight className="size-4 text-muted-foreground shrink-0" />
      }
    </div>
  );
}

function IdentField({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-secondary/40 rounded-xl p-3">
      <p className="text-[10px] text-muted-foreground font-medium">{label}</p>
      <p className="text-sm font-bold mt-0.5">{value}</p>
    </div>
  );
}


