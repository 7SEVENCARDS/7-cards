import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { requireUser } from "../lib/auth-server";

type Message = {
  id: string;
  user_id: string;
  sender: "user" | "agent";
  body: string;
  read: boolean;
  created_at: string;
  freescout_thread_id?: number | null;
  category?: string | null;
};

// ─── FreeScout helpers ────────────────────────────────────────────────────────
function freescoutHeaders() {
  const key = process.env.FREESCOUT_API_KEY ?? "";
  return {
    "X-FreeScout-API-Key": key,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function isFreescoutConfigured() {
  return !!(process.env.FREESCOUT_URL && process.env.FREESCOUT_API_KEY);
}

async function createFreescoutConversation(opts: {
  email: string;
  firstName: string;
  lastName: string;
  subject: string;
  body: string;
  mailboxId: number;
}): Promise<{ conversationId: number | null; customerId: number | null }> {
  const base = process.env.FREESCOUT_URL!.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/conversations`, {
      method: "POST",
      headers: freescoutHeaders(),
      body: JSON.stringify({
        type: "email",
        mailboxId: opts.mailboxId,
        subject: opts.subject,
        status: "active",
        customer: {
          email: opts.email,
          firstName: opts.firstName,
          lastName: opts.lastName || "-",
        },
        threads: [{ type: "customer", text: opts.body, status: "active" }],
      }),
    });
    if (!res.ok) return { conversationId: null, customerId: null };
    const data = (await res.json()) as {
      id?: number;
      _embedded?: { customers?: Array<{ id?: number }> };
    };
    return {
      conversationId: data.id ?? null,
      customerId: data._embedded?.customers?.[0]?.id ?? null,
    };
  } catch {
    return { conversationId: null, customerId: null };
  }
}

async function addFreescoutThread(conversationId: number, body: string, customerId?: number | null) {
  const base = process.env.FREESCOUT_URL!.replace(/\/$/, "");
  try {
    await fetch(`${base}/api/conversations/${conversationId}/threads`, {
      method: "POST",
      headers: freescoutHeaders(),
      body: JSON.stringify({
        type: "customer",
        text: body,
        status: "active",
        ...(customerId ? { customer: { id: customerId } } : {}),
      }),
    });
  } catch { /* non-critical */ }
}

async function getFreescoutThreads(conversationId: number): Promise<
  Array<{ id: number; type: string; body?: string; text?: string; createdAt?: string }>
> {
  const base = process.env.FREESCOUT_URL!.replace(/\/$/, "");
  try {
    const res = await fetch(
      `${base}/api/conversations/${conversationId}/threads`,
      { headers: freescoutHeaders() }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      _embedded?: { threads?: Array<{ id: number; type: string; body?: string; text?: string; createdAt?: string }> };
    };
    return data._embedded?.threads ?? [];
  } catch {
    return [];
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ─── Get own conversation history ─────────────────────────────────────────────
export const getSupportMessages = createServerFn({ method: "GET" })
  .validator((d: { userId?: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { data: messages, error } = await db
        .from("support_messages")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: true })
        .limit(data.limit ?? 80);

      if (error) throw error;

      // Mark agent messages as read
      await db
        .from("support_messages")
        .update({ read: true })
        .eq("user_id", userId)
        .eq("sender", "agent")
        .eq("read", false);

      return (messages ?? []) as Message[];
    } catch {
      return [] as Message[];
    }
  });

// ─── Get user's FreeScout thread info ─────────────────────────────────────────
export const getSupportThread = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { data } = await db
        .from("support_threads")
        .select("conversation_id, category, created_at")
        .eq("user_id", userId)
        .single();
      return data ?? null;
    } catch {
      return null;
    }
  });

// ─── Send a user message (+ forward to FreeScout if configured) ───────────────
export const sendSupportMessage = createServerFn({ method: "POST" })
  .validator((d: { body: string; category?: string }) => d)
  .handler(async ({ data }) => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();

      // Get profile
      const { data: profile } = await db
        .from("profiles")
        .select("full_name, phone, premium")
        .eq("id", userId)
        .single();

      const isPremium = profile?.premium ?? false;
      const fullName = profile?.full_name ?? "User";
      const [firstName, ...rest] = fullName.split(" ");

      // Save user message to Supabase
      await db.from("support_messages").insert({
        user_id: userId,
        sender: "user",
        body: data.body,
        category: data.category ?? null,
      });

      if (isFreescoutConfigured()) {
        // ── FreeScout mode ──────────────────────────────────────────────────
        const mailboxId = parseInt(process.env.FREESCOUT_MAILBOX_ID ?? "1");

        // Check for existing conversation
        const { data: thread } = await db
          .from("support_threads")
          .select("conversation_id, customer_id")
          .eq("user_id", userId)
          .single();

        let conversationId = thread?.conversation_id ?? null;
        let customerId = thread?.customer_id ?? null;

        if (!conversationId) {
          // Get user's email from auth
          const { data: authData } = await db.auth.admin.getUserById(userId);
          const email = authData?.user?.email ?? `${userId.slice(0, 8)}@7sevencards.app`;

          const categoryLabel = data.category ? `[${data.category}] ` : "";
          const subject = `${categoryLabel}${fullName} — 7SEVEN Support`;

          const result = await createFreescoutConversation({
            email,
            firstName,
            lastName: rest.join(" "),
            subject,
            body: data.body,
            mailboxId,
          });

          conversationId = result.conversationId;
          customerId = result.customerId;

          if (conversationId) {
            await db.from("support_threads").upsert({
              user_id: userId,
              conversation_id: conversationId,
              customer_id: customerId,
              category: data.category ?? null,
            });
          }
        } else {
          // Add to existing conversation
          await addFreescoutThread(conversationId, data.body, customerId);
        }

        // Immediate acknowledgment
        const ticketRef = conversationId ? ` (Ticket #${conversationId})` : "";
        await db.from("support_messages").insert({
          user_id: userId,
          sender: "agent",
          body: isPremium
            ? `✅ Message received${ticketRef}. As a PRO member you have priority status — a human agent will reply within 1 hour.`
            : `✅ Message received${ticketRef}. Our support team will reply within 24 hours. Upgrade to PRO for 1-hour responses.`,
        });
      } else {
        // ── Fallback: smart auto-reply bot ──────────────────────────────────
        const lower = data.body.toLowerCase();
        let reply = "";

        if (lower.includes("payout") || lower.includes("payment") || lower.includes("paid")) {
          reply =
            "Your payout is processed via Squadco and typically arrives within 5–10 minutes. If it's been over 30 minutes, share your trade ID and we'll investigate immediately.";
        } else if (lower.includes("card") && (lower.includes("reject") || lower.includes("invalid") || lower.includes("fail"))) {
          reply =
            "Sorry to hear your card was rejected. This usually means the card has already been redeemed or the code was entered incorrectly. Double-check the code and PIN, then try again.";
        } else if (lower.includes("kyc") || lower.includes("verify") || lower.includes("bvn") || lower.includes("nin")) {
          reply =
            "KYC verification is handled by Dojah and usually completes in seconds. If yours is stuck, ensure your BVN/NIN matches your registered name exactly.";
        } else if (lower.includes("rate") || lower.includes("exchange")) {
          reply =
            "Our rates update in real time from the market. PRO members get an additional +2% on all rates. Check the current rates on the Home screen.";
        } else if (lower.includes("account") || lower.includes("bank")) {
          reply =
            "You can add and manage bank accounts under Profile → Payout Accounts. We support all Nigerian banks via Squadco.";
        } else if (lower.includes("premium") || lower.includes("upgrade")) {
          reply =
            "7SEVEN PRO costs ₦2,000/month — higher limits, +2% better rates, priority payouts, and 1-hour support. Upgrade from Profile → Get Premium.";
        } else if (lower.includes("referral") || lower.includes("bonus")) {
          reply =
            "You earn 5% commission on every trade your referrals complete. Check Profile → Referral Program for your unique code and earnings.";
        } else if (/^(hi|hello|hey|good\s+\w+)/i.test(data.body)) {
          reply = isPremium
            ? "Hello! 👋 Welcome back, PRO member. You have priority support — what can I help you with today?"
            : "Hello! 👋 Welcome to 7SEVEN support. How can I help you today?";
        } else {
          reply = isPremium
            ? "Thanks for reaching out. As a PRO member, your case is flagged as priority and a human agent will respond within 1 hour."
            : "Thanks for reaching out! Our team will review your message and respond within 24 hours. For faster support, upgrade to PRO under Profile → Get Premium.";
        }

        await db.from("support_messages").insert({
          user_id: userId,
          sender: "agent",
          body: reply,
        });
      }

      return { success: true };
    } catch {
      return { success: false };
    }
  });

// ─── Sync FreeScout agent replies into Supabase ───────────────────────────────
export const syncFreeScoutReplies = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    if (!isFreescoutConfigured()) return { synced: 0 };
    try {
      const userId = await requireUser();
      const db = getServerSupabase();

      const { data: thread } = await db
        .from("support_threads")
        .select("conversation_id")
        .eq("user_id", userId)
        .single();

      if (!thread?.conversation_id) return { synced: 0 };

      const threads = await getFreescoutThreads(thread.conversation_id);

      // Get already-synced FreeScout thread IDs
      const { data: existing } = await db
        .from("support_messages")
        .select("freescout_thread_id")
        .eq("user_id", userId)
        .not("freescout_thread_id", "is", null);

      const syncedIds = new Set((existing ?? []).map((m) => m.freescout_thread_id));

      let synced = 0;
      for (const t of threads) {
        if (t.type !== "lineitem" && t.type === "agent" && t.id && !syncedIds.has(t.id)) {
          const body = stripHtml(t.body ?? t.text ?? "").trim();
          if (!body) continue;
          await db.from("support_messages").insert({
            user_id: userId,
            sender: "agent",
            body,
            freescout_thread_id: t.id,
            created_at: t.createdAt ?? new Date().toISOString(),
          });
          synced++;
        }
      }

      if (synced > 0) {
        await db
          .from("support_messages")
          .update({ read: false })
          .eq("user_id", userId)
          .eq("sender", "agent")
          .not("freescout_thread_id", "is", null)
          .eq("read", true);
      }

      return { synced };
    } catch {
      return { synced: 0 };
    }
  });

// ─── Get unread agent message count ───────────────────────────────────────────
export const getUnreadSupportCount = createServerFn({ method: "GET" })
  .validator((d: { userId?: string }) => d)
  .handler(async () => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { count } = await db
        .from("support_messages")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("sender", "agent")
        .eq("read", false);
      return { count: count ?? 0 };
    } catch {
      return { count: 0 };
    }
  });
