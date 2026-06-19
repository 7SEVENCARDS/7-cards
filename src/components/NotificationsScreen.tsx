import React, { useState } from "react";
import {
  ChevronLeft, Bell, CheckCheck, Trash2, Loader2,
  ShieldCheck, Zap, Gift, AlertCircle, Info, Trophy,
  CheckCircle2, Sparkles,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  clearReadNotifications,
} from "../server-functions/wallet";

type Notif = {
  id: string;
  title: string;
  message: string;
  read: boolean;
  type: "info" | "success" | "warning" | "error";
  created_at: string;
};

interface NotificationsScreenProps {
  userId: string;
  notifications: Notif[];
  onBack: () => void;
}

const TYPE_CONFIG = {
  success: { icon: CheckCircle2, bg: "bg-cyan/15",   text: "text-cyan",  dot: "bg-cyan"  },
  error:   { icon: AlertCircle,  bg: "bg-pink/15",   text: "text-pink",  dot: "bg-pink"  },
  warning: { icon: AlertCircle,  bg: "bg-gold/15",   text: "text-gold",  dot: "bg-gold"  },
  info:    { icon: Info,         bg: "bg-white/10",  text: "text-white/60", dot: "bg-blue-400" },
};

// Map title keywords to richer icons
function NotifIcon({ title, type }: { title: string; type: string }) {
  const t = title.toLowerCase();
  const cfg = TYPE_CONFIG[type as keyof typeof TYPE_CONFIG] ?? TYPE_CONFIG.info;

  let Icon = cfg.icon;
  if (t.includes("kyc") || t.includes("verif"))  Icon = ShieldCheck;
  else if (t.includes("trade") || t.includes("sold")) Icon = Zap;
  else if (t.includes("refer") || t.includes("friend")) Icon = Gift;
  else if (t.includes("xp") || t.includes("badge") || t.includes("level")) Icon = Trophy;
  else if (t.includes("premium") || t.includes("upgrade")) Icon = Sparkles;
  else if (t.includes("payout") || t.includes("paid")) Icon = CheckCircle2;

  return (
    <div className={`size-10 rounded-xl ${cfg.bg} grid place-items-center flex-shrink-0`}>
      <Icon className={`size-5 ${cfg.text}`} />
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-NG", { day: "numeric", month: "short" });
}

export function NotificationsScreen({ userId, notifications, onBack }: NotificationsScreenProps) {
  const qc = useQueryClient();
  const [markingAll, setMarkingAll] = useState(false);
  const [clearing, setClearing]    = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [filter, setFilter]        = useState<"all" | "unread">("all");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["notifications", userId] });

  const unread = notifications.filter((n) => !n.read);
  const shown  = filter === "unread" ? unread : notifications;

  const handleTap = async (n: Notif) => {
    if (n.read) return;
    await markNotificationRead({ data: { notificationId: n.id } });
    invalidate();
  };

  const handleDelete = async (n: Notif) => {
    setDeletingId(n.id);
    try {
      await deleteNotification({ data: { notificationId: n.id, userId } });
      invalidate();
    } finally {
      setDeletingId(null);
    }
  };

  const handleMarkAll = async () => {
    if (!unread.length) return;
    setMarkingAll(true);
    try {
      await markAllNotificationsRead({ data: { userId } });
      invalidate();
    } finally {
      setMarkingAll(false);
    }
  };

  const handleClearRead = async () => {
    const readCount = notifications.filter((n) => n.read).length;
    if (!readCount) return;
    setClearing(true);
    try {
      await clearReadNotifications({ data: { userId } });
      invalidate();
    } finally {
      setClearing(false);
    }
  };

  const readCount = notifications.filter((n) => n.read).length;

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <div className="mx-auto w-full max-w-[480px] flex flex-col flex-1">

        {/* Header */}
        <header className="px-5 pt-12 pb-4">
          <div className="flex items-center gap-4 mb-4">
            <button onClick={onBack} className="size-10 rounded-full bg-card border border-border grid place-items-center">
              <ChevronLeft className="size-5" />
            </button>
            <div className="flex-1">
              <h1 className="text-xl font-extrabold">Notifications</h1>
              <p className="text-xs text-muted-foreground">
                {unread.length > 0 ? `${unread.length} unread` : "All caught up"}
              </p>
            </div>
            {unread.length > 0 && (
              <button
                onClick={handleMarkAll}
                disabled={markingAll}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gold/15 text-gold text-xs font-bold disabled:opacity-50"
              >
                {markingAll
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : <CheckCheck className="size-3.5" />}
                Mark all read
              </button>
            )}
          </div>

          {/* Filter pills */}
          <div className="flex gap-2">
            {(["all", "unread"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-2 rounded-full text-xs font-bold capitalize transition ${filter === f ? "bg-gold text-jungle-deep shadow-glow-gold" : "bg-card border border-border text-muted-foreground"}`}
              >
                {f === "all" ? `All (${notifications.length})` : `Unread (${unread.length})`}
              </button>
            ))}
          </div>
        </header>

        {/* Empty state */}
        {shown.length === 0 && (
          <div className="flex flex-col items-center gap-4 flex-1 justify-center text-center px-8">
            <div className="size-20 rounded-3xl bg-card border border-border grid place-items-center">
              <Bell className="size-10 text-muted-foreground" />
            </div>
            <div>
              <p className="text-base font-bold">
                {filter === "unread" ? "No unread notifications" : "No notifications yet"}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {filter === "unread"
                  ? "You're all caught up 🎉"
                  : "Trade, level up, or refer friends to get notified here"}
              </p>
            </div>
            {filter === "unread" && (
              <button onClick={() => setFilter("all")} className="text-xs text-gold font-semibold">
                View all notifications
              </button>
            )}
          </div>
        )}

        {/* Notification list */}
        {shown.length > 0 && (
          <div className="flex flex-col gap-2 px-5 pb-4">
            {shown.map((n) => (
              <div
                key={n.id}
                onClick={() => handleTap(n)}
                className={`relative flex items-start gap-3 rounded-2xl border p-4 transition cursor-pointer ${n.read ? "bg-card border-border/50 opacity-70" : "bg-card border-border shadow-sm"}`}
              >
                {/* Unread dot */}
                {!n.read && (
                  <span className={`absolute top-4 right-4 size-2 rounded-full ${TYPE_CONFIG[n.type]?.dot ?? "bg-gold"}`} />
                )}

                <NotifIcon title={n.title} type={n.type} />

                <div className="flex-1 min-w-0 pr-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className={`text-sm font-bold leading-snug ${n.read ? "text-foreground" : "text-foreground"}`}>
                      {n.title}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{n.message}</p>
                  <p className="text-[10px] text-muted-foreground/60 mt-2 font-medium">{timeAgo(n.created_at)}</p>
                </div>

                {/* Swipe-style delete button */}
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(n); }}
                  disabled={deletingId === n.id}
                  className="absolute right-4 bottom-4 text-muted-foreground hover:text-pink transition disabled:opacity-50"
                >
                  {deletingId === n.id
                    ? <Loader2 className="size-3.5 animate-spin" />
                    : <Trash2 className="size-3.5" />}
                </button>
              </div>
            ))}

            {/* Clear read */}
            {readCount > 0 && (
              <button
                onClick={handleClearRead}
                disabled={clearing}
                className="flex items-center justify-center gap-2 mt-2 text-xs text-muted-foreground font-semibold py-3 border border-dashed border-border rounded-2xl hover:border-pink/40 hover:text-pink transition disabled:opacity-50"
              >
                {clearing
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : <Trash2 className="size-3.5" />}
                Clear {readCount} read notification{readCount !== 1 ? "s" : ""}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
