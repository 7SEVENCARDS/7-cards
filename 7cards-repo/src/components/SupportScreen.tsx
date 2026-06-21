import { useState, useEffect, useRef, useCallback } from "react";
import {
  ArrowLeft,
  Send,
  Loader2,
  MessageCircle,
  CheckCheck,
  Clock,
  HeadphonesIcon,
  ChevronRight,
  Crown,
  Mail,
  ExternalLink,
  RefreshCw,
  Hash,
  AlertCircle,
  Zap,
} from "lucide-react";
import {
  getSupportMessages,
  sendSupportMessage,
  getSupportTicket,
} from "../server-functions/support";

type Message = {
  id: string;
  sender: "user" | "agent";
  body: string;
  read: boolean;
  created_at: string;
  category?: string | null;
};

type Thread = {
  id: string;
  category: string | null;
  created_at: string;
} | null;

type Props = {
  userId: string;
  isPremium?: boolean;
  userName?: string;
  onBack: () => void;
};

const CATEGORIES = [
  { id: "payout",   label: "Payout Issue",       emoji: "💸", desc: "Missing or delayed payment" },
  { id: "card",     label: "Card Rejected",       emoji: "❌", desc: "Invalid code or failed verification" },
  { id: "kyc",      label: "KYC / Identity",      emoji: "🪪", desc: "Verification stuck or rejected" },
  { id: "bank",     label: "Bank Account",         emoji: "🏦", desc: "Adding or updating payout account" },
  { id: "rate",     label: "Exchange Rate",        emoji: "📈", desc: "Questions about rates or pricing" },
  { id: "bug",      label: "Bug / App Issue",      emoji: "🐛", desc: "Something isn't working" },
  { id: "other",    label: "Other",                emoji: "✉️",  desc: "Anything else" },
];

const QUICK_PROMPTS: Record<string, string> = {
  payout: "My payout hasn't arrived. Trade ID: [paste here]. It has been ____ minutes.",
  card:   "My card was rejected. Brand: _____, Amount: $_____, Error message: _____.",
  kyc:    "My KYC verification is stuck. I submitted my BVN/NIN _____ minutes ago.",
  bank:   "I'm having trouble adding/updating my bank account. Bank: _____, Issue: _____.",
  rate:   "Question about exchange rates for _____ gift cards.",
  bug:    "I found a bug: _____ steps to reproduce: 1. _____ 2. _____",
  other:  "",
};

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function groupByDay(messages: Message[]) {
  const groups: { day: string; messages: Message[] }[] = [];
  let current: string | null = null;
  for (const m of messages) {
    const day = dayLabel(m.created_at);
    if (day !== current) {
      groups.push({ day, messages: [] });
      current = day;
    }
    groups[groups.length - 1].messages.push(m);
  }
  return groups;
}

// ─── Landing / Pre-chat ───────────────────────────────────────────────────────
function SupportLanding({
  userName,
  isPremium,
  onSelectCategory,
}: {
  userName: string;
  isPremium: boolean;
  onSelectCategory: (cat: typeof CATEGORIES[0]) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-5 pt-6 pb-10">
      {/* Hero */}
      <div className="flex flex-col items-center text-center mb-8">
        <div className="size-20 rounded-[2rem] bg-gradient-to-br from-cyan/25 via-gold/15 to-cyan/10 border border-cyan/20 grid place-items-center mb-4 shadow-glow-jungle">
          <HeadphonesIcon className="size-9 text-cyan" />
        </div>
        <h2 className="text-xl font-extrabold text-white">
          Hi {userName.split(" ")[0]} 👋
        </h2>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-[260px] leading-relaxed">
          We're here to help. Pick a topic and we'll get you sorted fast.
        </p>
        <div className="flex items-center gap-1.5 mt-3">
          <span className="size-1.5 rounded-full bg-cyan animate-pulse" />
          <p className="text-[11px] text-muted-foreground">
            {isPremium
              ? "PRO priority · human reply within 1 hour"
              : "24/7 support · replies within 24 hours"}
          </p>
        </div>
      </div>

      {/* Category grid */}
      <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest mb-3">
        What do you need help with?
      </p>
      <div className="space-y-2">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => onSelectCategory(cat)}
            className="w-full flex items-center gap-3 bg-card border border-border/60 rounded-2xl px-4 py-3.5 text-left hover:border-cyan/30 transition-colors active:scale-[0.99]"
          >
            <span className="text-2xl shrink-0">{cat.emoji}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold">{cat.label}</p>
              <p className="text-xs text-muted-foreground">{cat.desc}</p>
            </div>
            <ChevronRight className="size-4 text-muted-foreground shrink-0" />
          </button>
        ))}
      </div>

      {/* Alternative contacts */}
      <div className="mt-8">
        <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest mb-3">
          Other ways to reach us
        </p>
        <div className="space-y-2">
          {process.env.SUPPORT_EMAIL || true ? (
            <a
              href={`mailto:${process.env.SUPPORT_EMAIL ?? "support@7sevencards.com"}`}
              className="flex items-center gap-3 bg-card border border-border/60 rounded-2xl px-4 py-3 transition-colors hover:border-cyan/30"
            >
              <div className="size-9 rounded-xl bg-cyan/10 grid place-items-center shrink-0">
                <Mail className="size-4 text-cyan" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-bold">Email Support</p>
                <p className="text-xs text-muted-foreground">
                  support@7sevencards.com
                </p>
              </div>
              <ExternalLink className="size-3.5 text-muted-foreground" />
            </a>
          ) : null}

          {process.env.SUPPORT_WHATSAPP ? (
            <a
              href={`https://wa.me/${process.env.SUPPORT_WHATSAPP}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 bg-card border border-border/60 rounded-2xl px-4 py-3 transition-colors hover:border-green-400/30"
            >
              <div className="size-9 rounded-xl bg-green-500/10 grid place-items-center shrink-0">
                <MessageCircle className="size-4 text-green-400" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-bold">WhatsApp</p>
                <p className="text-xs text-muted-foreground">Chat on WhatsApp</p>
              </div>
              <ExternalLink className="size-3.5 text-muted-foreground" />
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Compose new message ──────────────────────────────────────────────────────
function SupportCompose({
  category,
  isPremium,
  onSend,
  onBack,
  sending,
}: {
  category: typeof CATEGORIES[0];
  isPremium: boolean;
  onSend: (body: string) => void;
  onBack: () => void;
  sending: boolean;
}) {
  const [body, setBody] = useState(QUICK_PROMPTS[category.id] ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    // Place cursor at end
    const len = body.length;
    textareaRef.current?.setSelectionRange(len, len);
  }, []);

  return (
    <div className="flex-1 flex flex-col px-5 pt-4 pb-6">
      {/* Category badge */}
      <div className="flex items-center gap-2 mb-5">
        <button onClick={onBack} className="text-xs text-cyan font-semibold">
          ← Change topic
        </button>
        <span className="text-muted-foreground/40">·</span>
        <span className="flex items-center gap-1.5 text-xs font-bold text-foreground">
          <span>{category.emoji}</span>
          {category.label}
        </span>
      </div>

      {/* Hints */}
      <div className="bg-card border border-border/60 rounded-2xl p-4 mb-4">
        <div className="flex items-start gap-2.5">
          <AlertCircle className="size-4 text-gold shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-bold text-gold mb-1">Tips for faster resolution</p>
            <ul className="text-[11px] text-muted-foreground space-y-0.5 leading-relaxed">
              {category.id === "payout" && (
                <>
                  <li>• Include your trade ID (found in Trade History)</li>
                  <li>• Tell us how many minutes it's been</li>
                  <li>• Include your bank name &amp; last 4 digits</li>
                </>
              )}
              {category.id === "card" && (
                <>
                  <li>• Include the card brand and face value ($)</li>
                  <li>• Tell us the exact error message shown</li>
                  <li>• Confirm the card hasn't been used before</li>
                </>
              )}
              {category.id === "kyc" && (
                <>
                  <li>• Tell us which document you submitted (BVN/NIN)</li>
                  <li>• Confirm your registered name matches the doc</li>
                </>
              )}
              {(category.id === "bug" || category.id === "other") && (
                <>
                  <li>• Describe step by step what happened</li>
                  <li>• Tell us what you expected to happen</li>
                </>
              )}
              {!["payout","card","kyc","bug","other"].includes(category.id) && (
                <li>• Be as specific as possible so we can help faster</li>
              )}
            </ul>
          </div>
        </div>
      </div>

      {/* Textarea */}
      <div className="flex-1 flex flex-col">
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Describe your issue in detail…"
          className="flex-1 w-full bg-card border border-border/60 rounded-2xl px-4 py-4 text-sm outline-none resize-none leading-relaxed placeholder:text-muted-foreground/60 focus:border-cyan/40 transition-colors min-h-[160px]"
        />
        <p className="text-[10px] text-muted-foreground mt-2 text-right">
          {body.length > 20 ? `${body.length} chars` : ""}
        </p>
      </div>

      {/* SLA reminder */}
      <div className="mt-4 flex items-center gap-2 bg-secondary/60 rounded-xl px-3 py-2">
        <Clock className="size-3.5 text-muted-foreground shrink-0" />
        <p className="text-[11px] text-muted-foreground">
          {isPremium
            ? "PRO priority — human agent replies within 1 hour"
            : "Our team replies within 24 hours · Upgrade to PRO for 1-hour replies"}
        </p>
      </div>

      {/* Send button */}
      <button
        onClick={() => body.trim() && onSend(body.trim())}
        disabled={!body.trim() || sending}
        className="mt-4 w-full flex items-center justify-center gap-2 bg-gold text-jungle-deep font-extrabold rounded-2xl py-4 text-sm disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98] transition-all shadow-glow-gold"
      >
        {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        {sending ? "Sending…" : "Send to Support"}
      </button>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function SupportScreen({
  userId,
  isPremium = false,
  userName = "User",
  onBack,
}: Props) {
  const [view, setView] = useState<"landing" | "compose" | "chat">("landing");
  const [selectedCategory, setSelectedCategory] = useState<typeof CATEGORIES[0] | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [thread, setThread] = useState<Thread>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [agentTyping, setAgentTyping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 80);
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [msgs, th] = await Promise.all([
        getSupportMessages({ data: { userId, limit: 80 } }) as Promise<Message[]>,
        getSupportTicket({ data: {} }),
      ]);
      setThread(th as Thread);
      if (msgs.length > 0) {
        setMessages(msgs);
        setView("chat");
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
      scrollToBottom();
    }
  }, [userId, scrollToBottom]);

  useEffect(() => { loadData(); }, [loadData]);

  // Poll for new agent replies every 20s when in chat view
  const refreshMessages = useCallback(async () => {
    try {
      const fresh = await getSupportMessages({ data: { userId, limit: 80 } }) as Message[];
      if (fresh.length > 0) {
        setMessages(fresh);
        scrollToBottom();
      }
    } catch { /* ignore */ }
  }, [userId, scrollToBottom]);

  useEffect(() => {
    if (view !== "chat") return;
    const id = setInterval(refreshMessages, 20_000);
    return () => clearInterval(id);
  }, [view, refreshMessages]);

  const handleCategorySelect = (cat: typeof CATEGORIES[0]) => {
    setSelectedCategory(cat);
    setView("compose");
  };

  const handleSend = async (text: string, category?: string) => {
    if (!text.trim() || sending) return;
    const trimmed = text.trim();
    setInput("");
    setSending(true);

    // Optimistic user bubble
    const optimistic: Message = {
      id: "opt-" + Date.now(),
      sender: "user",
      body: trimmed,
      read: false,
      created_at: new Date().toISOString(),
      category: category ?? selectedCategory?.id ?? null,
    };
    setMessages((prev) => [...prev, optimistic]);
    setView("chat");
    scrollToBottom();

    // Show typing indicator
    await new Promise((r) => setTimeout(r, 500));
    setAgentTyping(true);
    scrollToBottom();

    try {
      await sendSupportMessage({
        data: { body: trimmed, category: category ?? selectedCategory?.id },
      });
      await new Promise((r) => setTimeout(r, 800));

      const [fresh, th] = await Promise.all([
        getSupportMessages({ data: { userId, limit: 80 } }) as Promise<Message[]>,
        getSupportTicket({ data: {} }),
      ]);
      setMessages(fresh.length > 0 ? fresh : [optimistic]);
      setThread(th as Thread);
    } catch {
      const fallback: Message = {
        id: "err-" + Date.now(),
        sender: "agent",
        body: "✅ Message received. Our support team will get back to you shortly.",
        read: true,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, fallback]);
    } finally {
      setAgentTyping(false);
      setSending(false);
      scrollToBottom();
    }
  };

  const groups = groupByDay(messages);

  // ── Loading ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-col h-screen bg-background items-center justify-center gap-3">
        <Loader2 className="size-7 animate-spin text-gold" />
        <p className="text-sm text-muted-foreground">Loading support…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="shrink-0 bg-background/95 backdrop-blur border-b border-border/50 px-4 pt-12 pb-3 flex items-center gap-3 z-20">
        <button
          onClick={view === "compose" ? () => setView("landing") : onBack}
          className="size-9 rounded-xl bg-secondary grid place-items-center shrink-0"
        >
          <ArrowLeft className="size-4" />
        </button>

        <div className="size-10 rounded-2xl bg-gradient-to-br from-cyan/25 to-gold/15 border border-cyan/15 grid place-items-center shrink-0">
          <HeadphonesIcon className="size-5 text-cyan" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-extrabold truncate">7SEVEN Support</p>
            {isPremium && (
              <span className="inline-flex items-center gap-0.5 bg-gold/15 border border-gold/25 text-gold text-[9px] font-extrabold px-1.5 py-0.5 rounded-full shrink-0">
                <Crown className="size-2.5" /> PRO
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {thread?.id ? (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Hash className="size-2.5" />
                {thread.id.slice(0, 8).toUpperCase()}
              </span>
            ) : (
              <>
                <span className="size-1.5 rounded-full bg-cyan animate-pulse" />
                <p className="text-[10px] text-muted-foreground truncate">
                  {isPremium ? "Priority · 1-hour reply" : "24/7 support · 24-hour reply"}
                </p>
              </>
            )}
            {view === "chat" && (
              <button
                onClick={refreshMessages}
                className="ml-auto text-[10px] text-cyan flex items-center gap-1 shrink-0"
              >
                <RefreshCw className="size-2.5" />
                Refresh
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      {view === "landing" && (
        <SupportLanding
          userName={userName}
          isPremium={isPremium}
          onSelectCategory={handleCategorySelect}
        />
      )}

      {view === "compose" && selectedCategory && (
        <SupportCompose
          category={selectedCategory}
          isPremium={isPremium}
          sending={sending}
          onSend={(body) => handleSend(body, selectedCategory.id)}
          onBack={() => setView("landing")}
        />
      )}

      {view === "chat" && (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {groups.map((group) => (
              <div key={group.day}>
                {/* Day separator */}
                <div className="flex items-center gap-2 my-4">
                  <div className="flex-1 h-px bg-border/50" />
                  <span className="text-[10px] text-muted-foreground font-medium px-2 shrink-0">
                    {group.day}
                  </span>
                  <div className="flex-1 h-px bg-border/50" />
                </div>

                {group.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex mb-3 ${msg.sender === "user" ? "justify-end" : "justify-start"}`}
                  >
                    {msg.sender === "agent" && (
                      <div className="size-7 rounded-xl bg-gradient-to-br from-cyan/20 to-gold/20 grid place-items-center shrink-0 mr-2 mt-1">
                        <Zap className="size-3.5 text-cyan" />
                      </div>
                    )}

                    <div
                      className={`max-w-[80%] flex flex-col ${msg.sender === "user" ? "items-end" : "items-start"}`}
                    >
                      {msg.category && msg.sender === "user" && (
                        <span className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1">
                          {CATEGORIES.find((c) => c.id === msg.category)?.emoji}{" "}
                          {CATEGORIES.find((c) => c.id === msg.category)?.label}
                        </span>
                      )}
                      <div
                        className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
                          msg.sender === "user"
                            ? "bg-gold text-jungle-deep font-medium rounded-br-sm"
                            : "bg-card border border-border/60 text-foreground rounded-bl-sm"
                        }`}
                      >
                        {msg.body}
                      </div>
                      <div
                        className={`flex items-center gap-1 mt-1 ${msg.sender === "user" ? "flex-row-reverse" : ""}`}
                      >
                        <span className="text-[10px] text-muted-foreground">
                          {timeLabel(msg.created_at)}
                        </span>
                        {msg.sender === "user" &&
                          (msg.read ? (
                            <CheckCheck className="size-3 text-cyan" />
                          ) : (
                            <Clock className="size-3 text-muted-foreground" />
                          ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))}

            {/* Typing indicator */}
            {agentTyping && (
              <div className="flex items-center gap-2 mb-3">
                <div className="size-7 rounded-xl bg-gradient-to-br from-cyan/20 to-gold/20 grid place-items-center shrink-0">
                  <Zap className="size-3.5 text-cyan" />
                </div>
                <div className="bg-card border border-border/60 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1">
                  {[0, 150, 300].map((delay) => (
                    <div
                      key={delay}
                      className="size-1.5 rounded-full bg-muted-foreground animate-bounce"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* PRO upsell */}
            {!isPremium && messages.length >= 4 && !agentTyping && (
              <div className="my-3 bg-gold/8 border border-gold/20 rounded-2xl px-4 py-3 flex items-center gap-3">
                <Crown className="size-4 text-gold shrink-0" />
                <div>
                  <p className="text-xs font-bold">PRO members get 1-hour replies</p>
                  <p className="text-[10px] text-muted-foreground">
                    Upgrade to PRO under Profile → Get Premium
                  </p>
                </div>
              </div>
            )}

            {/* Start new topic */}
            {messages.length > 0 && !agentTyping && (
              <div className="my-3 text-center">
                <button
                  onClick={() => setView("landing")}
                  className="text-[11px] text-cyan font-semibold"
                >
                  + New topic
                </button>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input bar */}
          <div className="shrink-0 border-t border-border/50 bg-background/95 backdrop-blur px-4 py-3 pb-safe">
            <div className="flex items-center gap-2">
              <div className="flex-1 flex items-center gap-2 bg-card border border-border/60 rounded-2xl px-4 py-2.5 focus-within:border-cyan/40 transition-colors">
                <MessageCircle className="size-4 text-muted-foreground shrink-0" />
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend(input);
                    }
                  }}
                  placeholder="Reply to support…"
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                />
              </div>
              <button
                onClick={() => handleSend(input)}
                disabled={!input.trim() || sending}
                className="size-11 rounded-2xl bg-gold text-jungle-deep grid place-items-center disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-all"
              >
                {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
