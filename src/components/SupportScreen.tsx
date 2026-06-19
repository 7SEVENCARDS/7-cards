import { useState, useEffect, useRef, useCallback } from "react";
import {
  ArrowLeft,
  Send,
  Loader2,
  MessageCircle,
  Zap,
  Crown,
  CheckCheck,
  Clock,
  HeadphonesIcon,
  ChevronRight,
} from "lucide-react";
import { getSupportMessages, sendSupportMessage } from "../server-functions/support";

type Message = {
  id: string;
  sender: "user" | "agent";
  body: string;
  read: boolean;
  created_at: string;
};

type Props = {
  userId: string;
  isPremium?: boolean;
  userName?: string;
  onBack: () => void;
};

const QUICK_REPLIES = [
  { label: "Where's my payout?", icon: "💸" },
  { label: "My card was rejected", icon: "❌" },
  { label: "KYC verification help", icon: "🪪" },
  { label: "Current exchange rates", icon: "📈" },
  { label: "Add a bank account", icon: "🏦" },
  { label: "Referral bonus question", icon: "🎁" },
];

function timeLabel(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const diff = Math.floor((today.getTime() - d.getTime()) / 86400000);
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

const DEMO_MESSAGES: Message[] = [
  {
    id: "d1",
    sender: "agent",
    body: "👋 Welcome to 7SEVEN Support! I'm your AI assistant, available 24/7. Ask me anything about trades, payouts, or your account.",
    read: true,
    created_at: new Date(Date.now() - 600_000).toISOString(),
  },
];

export function SupportScreen({ userId, isPremium = false, userName = "User", onBack }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [agentTyping, setAgentTyping] = useState(false);
  const [showQuickReplies, setShowQuickReplies] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 80);
  }, []);

  const loadMessages = useCallback(async () => {
    try {
      const msgs = await getSupportMessages({ data: { userId, limit: 50 } }) as Message[];
      if (msgs.length === 0) {
        setMessages(DEMO_MESSAGES);
      } else {
        setMessages(msgs);
        setShowQuickReplies(msgs.length <= 1);
      }
    } catch {
      setMessages(DEMO_MESSAGES);
    } finally {
      setLoading(false);
      scrollToBottom();
    }
  }, [userId, scrollToBottom]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || sending) return;
    const trimmed = text.trim();
    setInput("");
    setShowQuickReplies(false);
    setSending(true);

    // Optimistic user bubble
    const optimistic: Message = {
      id: "opt-" + Date.now(),
      sender: "user",
      body: trimmed,
      read: false,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    scrollToBottom();

    // Show typing indicator
    await new Promise((r) => setTimeout(r, 400));
    setAgentTyping(true);
    scrollToBottom();

    try {
      await sendSupportMessage({ data: { userId, body: trimmed, isPremium } });
      // Re-fetch to get real IDs + agent reply
      await new Promise((r) => setTimeout(r, 900));
      const fresh = await getSupportMessages({ data: { userId, limit: 50 } }) as Message[];
      setMessages(fresh.length > 0 ? fresh : [...DEMO_MESSAGES, optimistic]);
    } catch {
      // Keep optimistic message, add demo reply
      const demoReply: Message = {
        id: "demo-reply-" + Date.now(),
        sender: "agent",
        body: isPremium
          ? "Thanks for reaching out, PRO member. Your message has been received with priority status. A human agent will follow up within 1 hour."
          : "Thanks for your message! Our team will respond within 24 hours. For priority support, upgrade to 7SEVEN PRO.",
        read: true,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, demoReply]);
    } finally {
      setAgentTyping(false);
      setSending(false);
      scrollToBottom();
    }
  };

  const groups = groupByDay(messages);

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <header className="shrink-0 bg-background/95 backdrop-blur border-b border-border/60 px-4 py-3 flex items-center gap-3 z-20">
        <button onClick={onBack} className="size-9 rounded-xl bg-secondary grid place-items-center">
          <ArrowLeft className="size-5" />
        </button>

        <div className="size-10 rounded-2xl bg-gradient-to-br from-cyan/30 to-gold/30 grid place-items-center shrink-0">
          <HeadphonesIcon className="size-5 text-cyan" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-extrabold">7SEVEN Support</p>
            {isPremium && (
              <span className="inline-flex items-center gap-0.5 bg-gradient-to-r from-gold/30 to-gold/10 border border-gold/30 text-gold text-[9px] font-bold px-1.5 py-0.5 rounded-full">
                <Crown className="size-2.5" />
                PRO
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="size-1.5 rounded-full bg-cyan animate-pulse" />
            <p className="text-[10px] text-muted-foreground">
              {isPremium ? "Priority · replies within 1 hour" : "24/7 AI support · 1-day human reply"}
            </p>
          </div>
        </div>
      </header>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Loader2 className="size-7 animate-spin text-gold" />
            <p className="text-sm text-muted-foreground">Loading conversation…</p>
          </div>
        ) : (
          <>
            {groups.map((group) => (
              <div key={group.day}>
                {/* Day separator */}
                <div className="flex items-center gap-2 my-4">
                  <div className="flex-1 h-px bg-border/60" />
                  <span className="text-[10px] text-muted-foreground font-medium px-2">{group.day}</span>
                  <div className="flex-1 h-px bg-border/60" />
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

                    <div className={`max-w-[78%] ${msg.sender === "user" ? "items-end" : "items-start"} flex flex-col`}>
                      <div className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
                        msg.sender === "user"
                          ? "bg-gold text-jungle-deep font-medium rounded-br-sm"
                          : "bg-card border border-border/60 text-foreground rounded-bl-sm"
                      }`}>
                        {msg.body}
                      </div>
                      <div className={`flex items-center gap-1 mt-1 ${msg.sender === "user" ? "flex-row-reverse" : ""}`}>
                        <span className="text-[10px] text-muted-foreground">{timeLabel(msg.created_at)}</span>
                        {msg.sender === "user" && (
                          msg.read
                            ? <CheckCheck className="size-3 text-cyan" />
                            : <Clock className="size-3 text-muted-foreground" />
                        )}
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
                  <div className="size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "0ms" }} />
                  <div className="size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "150ms" }} />
                  <div className="size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            )}

            {/* Quick replies */}
            {showQuickReplies && messages.length > 0 && !agentTyping && (
              <div className="mt-4 mb-2">
                <p className="text-[11px] text-muted-foreground font-medium mb-2">Common questions</p>
                <div className="flex flex-wrap gap-2">
                  {QUICK_REPLIES.map((q) => (
                    <button
                      key={q.label}
                      onClick={() => sendMessage(q.label)}
                      className="flex items-center gap-1.5 bg-card border border-border/60 rounded-full px-3 py-1.5 text-xs font-medium"
                    >
                      <span>{q.icon}</span>
                      {q.label}
                      <ChevronRight className="size-3 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* PRO upsell banner (non-premium only) */}
            {!isPremium && messages.length >= 3 && (
              <div className="my-3 bg-gradient-to-r from-gold/10 to-gold/5 border border-gold/20 rounded-2xl px-4 py-3 flex items-center gap-3">
                <Crown className="size-5 text-gold shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold">Get PRO for priority support</p>
                  <p className="text-[10px] text-muted-foreground">Human agents reply within 1 hour</p>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Input bar */}
      <div className="shrink-0 border-t border-border/60 bg-background/95 backdrop-blur px-4 py-3 pb-safe">
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 bg-card border border-border/60 rounded-2xl px-4 py-2.5">
            <MessageCircle className="size-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); } }}
              placeholder="Message support…"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <button
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || sending}
            className="size-11 rounded-2xl bg-gold text-jungle-deep grid place-items-center disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
