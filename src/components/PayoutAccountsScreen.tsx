import React, { useState } from "react";
import {
  ChevronLeft, Plus, Star, Trash2, Loader2, AlertCircle,
  CheckCircle2, Building2, Search, ChevronRight, X,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listPayoutAccounts,
  lookupAccount,
  addPayoutAccount,
  setDefaultAccount,
  deletePayoutAccount,
} from "../server-functions/payout-accounts";

// ─── Nigerian banks list ───────────────────────────────────────────────────────
const BANKS = [
  { name: "Access Bank",       code: "044" },
  { name: "Citibank",          code: "023" },
  { name: "EcoBank",           code: "050" },
  { name: "Fidelity Bank",     code: "070" },
  { name: "First Bank",        code: "011" },
  { name: "FCMB",              code: "214" },
  { name: "GTBank",            code: "058" },
  { name: "Heritage Bank",     code: "030" },
  { name: "Keystone Bank",     code: "082" },
  { name: "Kuda Bank",         code: "090267" },
  { name: "Opay",              code: "100004" },
  { name: "Palmpay",           code: "100033" },
  { name: "Polaris Bank",      code: "076" },
  { name: "Providus Bank",     code: "101" },
  { name: "Stanbic IBTC",      code: "039" },
  { name: "Standard Chartered",code: "068" },
  { name: "Sterling Bank",     code: "232" },
  { name: "UBA",               code: "033" },
  { name: "Union Bank",        code: "032" },
  { name: "Unity Bank",        code: "215" },
  { name: "VFD Microfinance",  code: "090110" },
  { name: "Wema Bank",         code: "035" },
  { name: "Zenith Bank",       code: "057" },
] as const;

type Account = {
  id: string;
  bank_code: string;
  account_number: string;
  account_name: string;
  is_default: boolean;
};

type AddStep = "bank" | "number" | "confirm";

interface PayoutAccountsScreenProps {
  userId: string;
  onBack: () => void;
}

export function PayoutAccountsScreen({ userId, onBack }: PayoutAccountsScreenProps) {
  const qc = useQueryClient();

  const { data: accounts = [], isLoading } = useQuery<Account[]>({
    queryKey: ["payout-accounts-screen", userId],
    queryFn: () => listPayoutAccounts({ data: { userId } }) as Promise<Account[]>,
    staleTime: 30_000,
  });

  const [showAdd, setShowAdd]           = useState(false);
  const [addStep, setAddStep]           = useState<AddStep>("bank");
  const [bankSearch, setBankSearch]     = useState("");
  const [selectedBank, setSelectedBank] = useState<{ name: string; code: string } | null>(null);
  const [accountNum, setAccountNum]     = useState("");
  const [resolvedName, setResolvedName] = useState("");
  const [makeDefault, setMakeDefault]   = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [saving, setSaving]             = useState(false);
  const [deletingId, setDeletingId]     = useState<string | null>(null);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
  const [error, setError]               = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Account | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["payout-accounts-screen", userId] });
    qc.invalidateQueries({ queryKey: ["payout-accounts", userId] });
  };

  const filteredBanks = BANKS.filter((b) =>
    b.name.toLowerCase().includes(bankSearch.toLowerCase())
  );

  const handleSelectBank = (bank: { name: string; code: string }) => {
    setSelectedBank(bank);
    setAccountNum("");
    setResolvedName("");
    setError("");
    setAddStep("number");
  };

  const handleLookup = async () => {
    setError("");
    if (accountNum.length < 10) { setError("Account number must be at least 10 digits"); return; }
    setLookupLoading(true);
    try {
      const res = await lookupAccount({ data: { bankCode: selectedBank!.code, accountNumber: accountNum } });
      if ((res as { success: boolean }).success) {
        setResolvedName((res as { accountName: string }).accountName);
        setAddStep("confirm");
      } else {
        setError((res as { error?: string }).error ?? "Could not find account");
      }
    } catch {
      setError("Network error — please try again");
    } finally {
      setLookupLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await addPayoutAccount({
        data: {
          userId,
          bankCode: selectedBank!.code,
          bankName: selectedBank!.name,
          accountNumber: accountNum,
          accountName: resolvedName,
          makeDefault: makeDefault || accounts.length === 0,
        },
      });
      if ((res as { success: boolean }).success) {
        invalidate();
        resetAdd();
      } else {
        setError((res as { error?: string }).error ?? "Failed to save");
      }
    } catch {
      setError("Failed to save account");
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (acc: Account) => {
    setSettingDefaultId(acc.id);
    try {
      await setDefaultAccount({ data: { accountId: acc.id } });
      invalidate();
    } finally {
      setSettingDefaultId(null);
    }
  };

  const handleDelete = async (acc: Account) => {
    setDeletingId(acc.id);
    try {
      const delResult = await deletePayoutAccount({ data: { accountId: acc.id } }) as { success?: boolean; error?: string };
      if (delResult && delResult.success === false) throw new Error(delResult.error ?? "Delete failed");
      invalidate();
      setConfirmDelete(null);
    } finally {
      setDeletingId(null);
    }
  };

  const resetAdd = () => {
    setShowAdd(false);
    setAddStep("bank");
    setSelectedBank(null);
    setAccountNum("");
    setResolvedName("");
    setMakeDefault(false);
    setBankSearch("");
    setError("");
  };

  const bankName = (code: string) =>
    BANKS.find((b) => b.code === code)?.name ?? code;

  return (
    <div className="flex flex-col min-h-dvh bg-background">
      <div className="mx-auto w-full max-w-[480px] flex flex-col flex-1">

        {/* Header */}
        <header className="px-5 pt-safe-top pb-4 flex items-center gap-4">
          <button onClick={onBack} className="size-10 rounded-full bg-card border border-border grid place-items-center">
            <ChevronLeft className="size-5" />
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-extrabold">Payout Accounts</h1>
            <p className="text-xs text-muted-foreground">Where your NGN lands after every trade</p>
          </div>
          {!showAdd && (
            <button
              onClick={() => setShowAdd(true)}
              className="size-10 rounded-full bg-gold/20 grid place-items-center"
            >
              <Plus className="size-5 text-gold" />
            </button>
          )}
        </header>

        {/* ── ADD FLOW ──────────────────────────────────────────────────────── */}
        {showAdd && (
          <div className="px-5 flex flex-col gap-4">
            {/* Step indicator */}
            <div className="flex items-center gap-2">
              {(["bank", "number", "confirm"] as AddStep[]).map((s, i) => (
                <React.Fragment key={s}>
                  <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold transition ${addStep === s ? "bg-gold text-jungle-deep" : i < ["bank","number","confirm"].indexOf(addStep) ? "bg-cyan/20 text-cyan" : "bg-card text-muted-foreground border border-border"}`}>
                    {i < ["bank","number","confirm"].indexOf(addStep) ? <CheckCircle2 className="size-3" /> : null}
                    {s === "bank" ? "Bank" : s === "number" ? "Account" : "Confirm"}
                  </div>
                  {i < 2 && <div className="flex-1 h-px bg-border" />}
                </React.Fragment>
              ))}
              <button onClick={resetAdd} className="ml-2 text-muted-foreground">
                <X className="size-4" />
              </button>
            </div>

            {/* ── Step 1: Choose Bank ── */}
            {addStep === "bank" && (
              <div className="flex flex-col gap-3">
                <div className="bg-card rounded-2xl border border-border p-3 flex items-center gap-2">
                  <Search className="size-4 text-muted-foreground" />
                  <input
                    autoFocus
                    value={bankSearch}
                    onChange={(e) => setBankSearch(e.target.value)}
                    placeholder="Search bank…"
                    className="bg-transparent outline-none text-sm flex-1"
                  />
                </div>
                <div className="space-y-1.5 max-h-[400px] overflow-y-auto pb-4">
                  {filteredBanks.map((bank) => (
                    <button
                      key={bank.code}
                      onClick={() => handleSelectBank(bank)}
                      className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 hover:border-gold/40 transition"
                    >
                      <div className="size-10 rounded-xl bg-secondary grid place-items-center flex-shrink-0">
                        <Building2 className="size-5 text-muted-foreground" />
                      </div>
                      <span className="text-sm font-semibold flex-1 text-left">{bank.name}</span>
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </button>
                  ))}
                  {filteredBanks.length === 0 && (
                    <p className="text-center text-sm text-muted-foreground py-8">No banks match "{bankSearch}"</p>
                  )}
                </div>
              </div>
            )}

            {/* ── Step 2: Account Number ── */}
            {addStep === "number" && selectedBank && (
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3 bg-gold/10 border border-gold/30 rounded-2xl p-4">
                  <Building2 className="size-5 text-gold" />
                  <div>
                    <p className="text-xs text-muted-foreground">Selected bank</p>
                    <p className="text-sm font-bold">{selectedBank.name}</p>
                  </div>
                  <button onClick={() => setAddStep("bank")} className="ml-auto text-muted-foreground text-xs">Change</button>
                </div>

                <div>
                  <p className="text-xs text-muted-foreground font-bold mb-2">Account Number (NUBAN)</p>
                  <div className="bg-card rounded-2xl border border-border p-4 flex items-center gap-3">
                    <input
                      autoFocus
                      type="tel"
                      inputMode="numeric"
                      maxLength={10}
                      value={accountNum}
                      onChange={(e) => setAccountNum(e.target.value.replace(/\D/g, "").slice(0, 10))}
                      placeholder="0123456789"
                      className="bg-transparent outline-none text-xl font-mono font-bold flex-1 tracking-widest"
                    />
                    <span className="text-xs text-muted-foreground">{accountNum.length}/10</span>
                  </div>
                </div>

                {error && (
                  <div className="flex items-start gap-2 bg-pink/10 border border-pink/30 rounded-2xl p-3">
                    <AlertCircle className="size-4 text-pink shrink-0 mt-0.5" />
                    <p className="text-xs font-semibold text-pink">{error}</p>
                  </div>
                )}

                <button
                  onClick={handleLookup}
                  disabled={lookupLoading || accountNum.length < 10}
                  className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold disabled:opacity-50 transition"
                >
                  {lookupLoading
                    ? <><Loader2 className="size-4 animate-spin" /> Verifying…</>
                    : <>Verify Account <ChevronRight className="size-5" /></>}
                </button>
              </div>
            )}

            {/* ── Step 3: Confirm & Save ── */}
            {addStep === "confirm" && selectedBank && (
              <div className="flex flex-col gap-4">
                <div className="bg-gradient-hero rounded-3xl p-5 shadow-glow-jungle">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="size-12 rounded-2xl bg-white/10 grid place-items-center">
                      <CheckCircle2 className="size-6 text-gold" />
                    </div>
                    <div>
                      <p className="text-xs text-white/70">Account Verified</p>
                      <p className="text-base font-extrabold text-white">{resolvedName}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div className="bg-white/10 rounded-xl p-3">
                      <p className="text-[10px] text-white/60">Bank</p>
                      <p className="text-sm font-bold text-white">{selectedBank.name}</p>
                    </div>
                    <div className="bg-white/10 rounded-xl p-3">
                      <p className="text-[10px] text-white/60">Account No.</p>
                      <p className="text-sm font-bold text-white font-mono">{accountNum}</p>
                    </div>
                  </div>
                </div>

                {accounts.length > 0 && (
                  <button
                    onClick={() => setMakeDefault((v) => !v)}
                    className="flex items-center gap-3 bg-card rounded-2xl border border-border p-4"
                  >
                    <div className={`size-5 rounded-md border-2 flex-shrink-0 grid place-items-center transition ${makeDefault ? "bg-gold border-gold" : "border-border"}`}>
                      {makeDefault && <CheckCircle2 className="size-3.5 text-jungle-deep" />}
                    </div>
                    <div className="text-left">
                      <p className="text-sm font-semibold">Set as default payout account</p>
                      <p className="text-[11px] text-muted-foreground">This account receives all trade payouts</p>
                    </div>
                  </button>
                )}

                {error && (
                  <div className="flex items-start gap-2 bg-pink/10 border border-pink/30 rounded-2xl p-3">
                    <AlertCircle className="size-4 text-pink shrink-0 mt-0.5" />
                    <p className="text-xs font-semibold text-pink">{error}</p>
                  </div>
                )}

                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="w-full bg-gradient-gold text-jungle-deep font-extrabold py-4 rounded-2xl flex items-center justify-center gap-2 shadow-glow-gold disabled:opacity-50 transition"
                >
                  {saving
                    ? <><Loader2 className="size-4 animate-spin" /> Saving…</>
                    : <><CheckCircle2 className="size-5" /> Save Account</>}
                </button>

                <button
                  onClick={() => setAddStep("number")}
                  className="text-xs text-muted-foreground font-semibold text-center"
                >
                  Go back
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── ACCOUNTS LIST ─────────────────────────────────────────────────── */}
        {!showAdd && (
          <div className="px-5 flex flex-col gap-3 pb-8">
            {isLoading && (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            )}

            {!isLoading && accounts.length === 0 && (
              <div className="flex flex-col items-center gap-5 py-10 text-center">
                <div className="relative">
                  <img
                    src="/mascot.png"
                    alt="Seven the mascot"
                    className="size-32 object-contain drop-shadow-xl"
                  />
                  <div className="absolute -bottom-1 -right-1 size-9 rounded-full bg-jungle border-2 border-background grid place-items-center shadow-glow-jungle">
                    <Building2 className="size-4 text-cyan" />
                  </div>
                </div>
                <div>
                  <p className="text-lg font-extrabold">No bank accounts yet</p>
                  <p className="text-sm text-muted-foreground mt-1.5 max-w-[230px] mx-auto leading-relaxed">
                    Add your Nigerian bank account once — we'll send every payout straight to it
                  </p>
                </div>
                <div className="flex flex-col gap-2 w-full max-w-[280px]">
                  {[
                    { icon: "🏦", text: "GTBank, Zenith, OPay, PalmPay + 20 more" },
                    { icon: "⚡", text: "Payouts hit your account in under 5 min" },
                    { icon: "🔒", text: "Verified via Squadco — 100% secure" },
                  ].map((f) => (
                    <div key={f.text} className="flex items-center gap-3 bg-card border border-border rounded-xl px-4 py-3 text-left">
                      <span className="text-sm shrink-0">{f.icon}</span>
                      <p className="text-xs text-muted-foreground">{f.text}</p>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => setShowAdd(true)}
                  className="bg-gradient-gold text-jungle-deep font-extrabold px-7 py-4 rounded-2xl shadow-glow-gold flex items-center gap-2 active:scale-[0.98] transition"
                >
                  <Plus className="size-5" /> Add Bank Account
                </button>
              </div>
            )}

            {!isLoading && accounts.length > 0 && (
              <>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs text-muted-foreground font-bold uppercase tracking-wider">
                    {accounts.length} account{accounts.length !== 1 ? "s" : ""} · max 5
                  </p>
                  <div className="h-1.5 w-24 bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gold rounded-full transition-all"
                      style={{ width: `${(accounts.length / 5) * 100}%` }}
                    />
                  </div>
                </div>

                {accounts.map((acc) => (
                  <div
                    key={acc.id}
                    className={`bg-card rounded-2xl border p-4 transition ${acc.is_default ? "border-gold/50" : "border-border/60"}`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`size-11 rounded-xl grid place-items-center flex-shrink-0 ${acc.is_default ? "bg-gold/15" : "bg-secondary"}`}>
                        <Building2 className={`size-5 ${acc.is_default ? "text-gold" : "text-muted-foreground"}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-bold">{acc.account_name}</p>
                          {acc.is_default && (
                            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-gold/15 text-gold text-[10px] font-bold">
                              <Star className="size-2.5 fill-gold" /> Default
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{bankName(acc.bank_code)}</p>
                        <p className="text-sm font-mono text-muted-foreground mt-0.5">
                          {acc.account_number.slice(0, 3)}***{acc.account_number.slice(-4)}
                        </p>
                      </div>
                    </div>

                    <div className="flex gap-2 mt-3 pt-3 border-t border-border/40">
                      {!acc.is_default && (
                        <button
                          onClick={() => handleSetDefault(acc)}
                          disabled={settingDefaultId === acc.id}
                          className="flex-1 bg-gold/10 text-gold font-semibold text-xs py-2.5 rounded-xl flex items-center justify-center gap-1.5 transition hover:bg-gold/20 disabled:opacity-50"
                        >
                          {settingDefaultId === acc.id
                            ? <Loader2 className="size-3.5 animate-spin" />
                            : <Star className="size-3.5" />}
                          Set as Default
                        </button>
                      )}
                      <button
                        onClick={() => setConfirmDelete(acc)}
                        className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-semibold text-pink bg-pink/10 hover:bg-pink/20 transition"
                      >
                        <Trash2 className="size-3.5" /> Remove
                      </button>
                    </div>
                  </div>
                ))}

                {accounts.length < 5 && (
                  <button
                    onClick={() => setShowAdd(true)}
                    className="w-full border-2 border-dashed border-border rounded-2xl p-4 flex items-center justify-center gap-2 text-sm text-muted-foreground font-semibold hover:border-gold/40 hover:text-gold transition"
                  >
                    <Plus className="size-4" /> Add another account
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── DELETE CONFIRM SHEET ────────────────────────────────────────────── */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end">
          <div className="w-full max-w-[480px] mx-auto bg-card rounded-t-3xl p-6 pb-8 flex flex-col gap-4">
            <div className="w-10 h-1 rounded-full bg-border mx-auto" />
            <div className="flex items-center gap-3">
              <div className="size-12 rounded-2xl bg-pink/15 grid place-items-center">
                <Trash2 className="size-6 text-pink" />
              </div>
              <div>
                <p className="text-base font-extrabold">Remove Account?</p>
                <p className="text-xs text-muted-foreground">{confirmDelete.account_name} · {bankName(confirmDelete.bank_code)}</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              This won't affect pending payouts. You can always re-add this account later.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDelete(null)}
                className="flex-1 bg-secondary text-foreground font-bold py-3.5 rounded-2xl text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDelete)}
                disabled={deletingId === confirmDelete.id}
                className="flex-1 bg-pink text-white font-bold py-3.5 rounded-2xl text-sm flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {deletingId === confirmDelete.id
                  ? <Loader2 className="size-4 animate-spin" />
                  : <Trash2 className="size-4" />}
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
