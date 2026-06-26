// ─────────────────────────────────────────────────────────────────────────────
// Support Server Functions — Telegram-based
//
// FreeScout has been replaced with a Telegram-based support system.
// Customer support staff / moderators operate entirely from Telegram.
//
// Flow:
//   1. User sends a message in-app → stored in support_messages DB table
//   2. Message is forwarded to the support Telegram group (SUPPORT_TELEGRAM_CHAT_ID)
//      with ticket context (category, user tier, masked user ID)
//   3. Support staff reply in Telegram using the admin bot command:
//      /reply <ticketId> <message>
//   4. The admin bot webhook stores the reply in support_messages (sender='agent')
//   5. The user's app polls and displays the reply
//
// Dispute communications: vendors are referred to by their moniker,
// not real names or contact details. The admin bot enforces this.
// ─────────────────────────────────────────────────────────────────────────────

import { createServerFn } from "@tanstack/react-start";
import { getServerSupabase } from "../lib/supabase.server";
import { getEnv } from "../lib/worker-env";
import { requireUser } from "../lib/auth-server";

type Message = {
  id: string;
  user_id: string;
  sender: "user" | "agent";
  body: string;
  read: boolean;
  created_at: string;
  ticket_id?: string | null;
  category?: string | null;
};

// ─── Forward message to Telegram support group ────────────────────────────────
async function forwardToTelegramSupport(opts: {
  ticketId: string;
  userId: string;
  userDisplayName: string;
  isPremium: boolean;
  category: string | null;
  body: string;
}): Promise<void> {
  const chatId = getEnv("SUPPORT_TELEGRAM_CHAT_ID");
  if (!chatId) return;

  const { isAdminBotConfigured, sendAdminBotMessage } = await import("../lib/telegram");
  if (!isAdminBotConfigured()) return;

  const priorityTag = opts.isPremium ? "⭐ PRO PRIORITY" : "Standard";
  const categoryLabel = opts.category ? ` · ${opts.category.toUpperCase()}` : "";
  const userTag = `${opts.userDisplayName} [${opts.userId.slice(0, 8)}]`;

  const text = [
    `🎫 <b>New Support Ticket</b> [${priorityTag}${categoryLabel}]`,
    ``,
    `<b>User:</b> ${userTag}`,
    `<b>Ticket:</b> <code>${opts.ticketId}</code>`,
    ``,
    opts.body,
    ``,
    `<i>Reply via admin bot: /reply ${opts.ticketId} your message here</i>`,
  ].join("\n");

  await sendAdminBotMessage(chatId, text).catch(e =>
    console.error("[Support] admin bot forward failed:", e instanceof Error ? e.message : e)
  );
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

// ─── Get user's support ticket info ───────────────────────────────────────────
export const getSupportTicket = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();
      const { data } = await db
        .from("support_tickets")
        .select("id, category, status, created_at")
        .eq("user_id", userId)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data ?? null;
    } catch {
      return null;
    }
  });

// ─── Send support message (Telegram-forwarded + email notification) ───────────
export const sendSupportMessage = createServerFn({ method: "POST" })
  .validator((d: { body: string; category?: string }) => d)
  .handler(async ({ data }) => {
    try {
      const userId = await requireUser();
      const db = getServerSupabase();

      const { data: profile } = await db
        .from("profiles")
        .select("full_name, phone, premium")
        .eq("id", userId)
        .single();

      const isPremium = profile?.premium ?? false;
      const fullName = profile?.full_name ?? "User";

      // Upsert open support ticket
      let ticketId: string | null = null;
      const { data: existingTicket } = await db
        .from("support_tickets")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingTicket) {
        ticketId = existingTicket.id;
      } else {
        const { data: newTicket } = await db
          .from("support_tickets")
          .insert({ user_id: userId, category: data.category ?? null, status: "open" })
          .select("id")
          .single();
        ticketId = newTicket?.id ?? null;
      }

      // Save message to DB
      await db.from("support_messages").insert({
        user_id: userId,
        sender: "user",
        body: data.body,
        category: data.category ?? null,
        ...(ticketId ? { ticket_id: ticketId } : {}),
      });

      if (ticketId) {
        // Forward to Telegram support group (fire-and-forget)
        forwardToTelegramSupport({
          ticketId,
          userId,
          userDisplayName: fullName,
          isPremium,
          category: data.category ?? null,
          body: data.body,
        }).catch(e =>
          console.error("[Support] forwardToTelegramSupport failed:", e instanceof Error ? e.message : e)
        );

        // Email fallback — fires alongside Telegram for redundancy
        const capturedTicketId = ticketId;
        import("../lib/email").then(async ({ sendAdminEmail, buildSupportTicketEmailHtml }) => {
          await sendAdminEmail({
            subject: `[7SEVEN CARDS] New Support Ticket${isPremium ? " ⭐ PRO" : ""} — ${data.category ?? "General"}`,
            html: buildSupportTicketEmailHtml({
              ticketId: capturedTicketId,
              userId,
              userName: fullName,
              category: data.category ?? null,
              body: data.body,
              isPremium,
            }),
          });
        }).catch(() => {});
      }

      // Immediate acknowledgment reply
      await db.from("support_messages").insert({
        user_id: userId,
        sender: "agent",
        body: isPremium
          ? `✅ Message received. As a PRO member you have priority status — our support team will reply within 1 hour via this chat.`
          : `✅ Message received. Our support team will reply within 24 hours. Upgrade to PRO for 1-hour responses.`,
        ...(ticketId ? { ticket_id: ticketId } : {}),
      });

      return { success: true, ticketId };
    } catch {
      return { success: false, ticketId: null };
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

// ─── Admin: reply to support ticket (called by admin-telegram-webhook.ts) ─────
export async function adminReplyToTicket(ticketId: string, replyBody: string, adminId: string): Promise<boolean> {
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(
      getEnv("VITE_SUPABASE_URL") ?? "",
      getEnv("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { data: ticket } = await db
      .from("support_tickets")
      .select("id, user_id")
      .eq("id", ticketId)
      .single();

    if (!ticket) return false;

    await db.from("support_messages").insert({
      user_id: ticket.user_id,
      sender: "agent",
      body: replyBody,
      ticket_id: ticketId,
    });

    await db.from("admin_audit_log").insert({
      admin_id: adminId,
      action: "support_reply",
      target_id: ticketId,
      meta: { via: "telegram", reply_length: replyBody.length },
    }).catch(e =>
      console.error("[Support] audit_log insert failed:", e instanceof Error ? e.message : e)
    );

    return true;
  } catch {
    return false;
  }
}

// ─── Admin: list open support tickets ─────────────────────────────────────────
export const adminGetSupportTickets = createServerFn({ method: "GET" })
  .validator((d: { limit?: number }) => d)
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("../lib/auth-server");
    await requireAdmin();
    const db = getServerSupabase();

    const { data: tickets, error } = await db
      .from("support_tickets")
      .select(`
        id, category, status, created_at,
        profiles!inner(id, full_name, premium)
      `)
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .limit(data.limit ?? 50);

    if (error) { console.error("[Support] getSupportTickets:", error.message); return []; }
    return tickets ?? [];
  });

// Keep legacy export name for any existing imports
export const getSupportThread = getSupportTicket;
export const syncFreeScoutReplies = createServerFn({ method: "GET" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    // FreeScout has been replaced with Telegram-based support.
    // Replies now arrive via the admin bot webhook — no polling needed.
    return { synced: 0 };
  });
