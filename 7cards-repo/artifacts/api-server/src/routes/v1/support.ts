import { Router } from "express";
import { requireApiKey } from "../../lib/api-auth.js";
import { rateLimitMiddleware } from "../../lib/rate-limit.js";
import { getDb, getGatewayUserId } from "../../lib/db.js";
import { fireWebhookEvent } from "../../lib/webhook-delivery.js";

const router = Router();
router.use(requireApiKey);
router.use(rateLimitMiddleware);

// ── POST /v1/support/tickets ──────────────────────────────────────────────────
// Open a support ticket on behalf of one of the TPO's customers.
router.post("/tickets", async (req, res) => {
  const tenant = req.tenant!;
  const { customer_ref, customer_name, subject, message, category, trade_id } =
    req.body as {
      customer_ref?: string;
      customer_name?: string;
      subject?: string;
      message?: string;
      category?: string;
      trade_id?: string;
    };

  if (!message || message.trim().length < 5) {
    res.status(400).json({ error: "message is required (min 5 chars)" });
    return;
  }

  const db = getDb();
  const gatewayUserId = getGatewayUserId();

  // Build subject from customer_ref / trade / fallback
  const ticketSubject =
    subject ??
    (trade_id
      ? `[${tenant.tenantName}] Trade enquiry — ${trade_id.slice(0, 8)}`
      : `[${tenant.tenantName}] Support request${customer_ref ? ` — ${customer_ref}` : ""}`);

  // Validate trade ownership (if provided)
  if (trade_id) {
    const { data: ownership } = await db
      .from("api_tenant_trades")
      .select("trade_id")
      .eq("tenant_id", tenant.tenantId)
      .eq("trade_id", trade_id)
      .single();

    if (!ownership) {
      res.status(403).json({ error: "trade_id does not belong to this tenant" });
      return;
    }
  }

  // Create ticket
  const { data: ticket, error: ticketErr } = await db
    .from("support_tickets")
    .insert({
      user_id: gatewayUserId,
      subject: ticketSubject,
      status: "open",
      priority: "normal",
      ...(category ? { category } : {}),
    })
    .select("id")
    .single();

  if (ticketErr || !ticket) {
    res.status(500).json({ error: "Failed to create support ticket" });
    return;
  }

  // Insert first message
  await db.from("support_messages").insert({
    user_id: gatewayUserId,
    sender: "user",
    body: message.trim(),
    ...(ticket.id ? { ticket_id: ticket.id } : {}),
  });

  // Tag to tenant
  await db.from("api_tenant_support_tickets").insert({
    tenant_id: tenant.tenantId,
    ticket_id: ticket.id,
    customer_ref: customer_ref ?? null,
    customer_name: customer_name ?? null,
  });

  fireWebhookEvent(tenant.tenantId, "support.ticket_created", {
    ticket_id: ticket.id,
    customer_ref,
    customer_name,
    subject: ticketSubject,
    trade_id: trade_id ?? null,
  }).catch(() => {});

  res.status(201).json({
    ticket_id: ticket.id,
    status: "open",
    subject: ticketSubject,
    customer_ref,
    customer_name,
  });
});

// ── GET /v1/support/tickets ───────────────────────────────────────────────────
router.get("/tickets", async (req, res) => {
  const tenant = req.tenant!;
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const offset = Number(req.query.offset ?? 0);
  const status = req.query.status as string | undefined;
  const customer_ref = req.query.customer_ref as string | undefined;
  const db = getDb();

  let q = db
    .from("api_tenant_support_tickets")
    .select("ticket_id, customer_ref, customer_name, created_at")
    .eq("tenant_id", tenant.tenantId);

  if (customer_ref) q = q.eq("customer_ref", customer_ref);

  const { data: tenantTickets, error } = await q
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    res.status(500).json({ error: "Failed to fetch tickets" });
    return;
  }

  if (!tenantTickets?.length) {
    res.json({ tickets: [], total: 0, limit, offset });
    return;
  }

  const ticketIds = tenantTickets.map((t) => t.ticket_id);
  let tq = db
    .from("support_tickets")
    .select("id, subject, status, priority, created_at, updated_at")
    .in("id", ticketIds);

  if (status) tq = tq.eq("status", status);
  const { data: tickets } = await tq;
  const ticketMap = new Map((tickets ?? []).map((t) => [t.id, t]));

  const result = tenantTickets
    .map((tt) => {
      const ticket = ticketMap.get(tt.ticket_id);
      if (!ticket) return null;
      return {
        ticket_id: ticket.id,
        customer_ref: tt.customer_ref,
        customer_name: tt.customer_name,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        created_at: ticket.created_at,
        updated_at: ticket.updated_at,
      };
    })
    .filter(Boolean);

  res.json({ tickets: result, total: result.length, limit, offset });
});

// ── GET /v1/support/tickets/:id ───────────────────────────────────────────────
router.get("/tickets/:id", async (req, res) => {
  const tenant = req.tenant!;
  const { id } = req.params;
  const db = getDb();

  const { data: tenantTicket } = await db
    .from("api_tenant_support_tickets")
    .select("customer_ref, customer_name")
    .eq("tenant_id", tenant.tenantId)
    .eq("ticket_id", id)
    .single();

  if (!tenantTicket) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }

  const { data: ticket } = await db
    .from("support_tickets")
    .select("id, subject, status, priority, created_at, updated_at")
    .eq("id", id)
    .single();

  if (!ticket) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }

  res.json({
    ticket_id: ticket.id,
    customer_ref: tenantTicket.customer_ref,
    customer_name: tenantTicket.customer_name,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
  });
});

// ── GET /v1/support/tickets/:id/messages ─────────────────────────────────────
router.get("/tickets/:id/messages", async (req, res) => {
  const tenant = req.tenant!;
  const { id } = req.params;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const db = getDb();

  const { data: ownership } = await db
    .from("api_tenant_support_tickets")
    .select("ticket_id")
    .eq("tenant_id", tenant.tenantId)
    .eq("ticket_id", id)
    .single();

  if (!ownership) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }

  const { data: messages } = await db
    .from("support_messages")
    .select("id, sender, body, read, created_at")
    .eq("ticket_id", id)
    .order("created_at", { ascending: true })
    .limit(limit);

  res.json({
    ticket_id: id,
    messages: (messages ?? []).map((m) => ({
      id: m.id,
      sender: m.sender === "user" ? "customer" : "support",
      body: m.body,
      read: m.read,
      sent_at: m.created_at,
    })),
  });
});

// ── POST /v1/support/tickets/:id/messages ─────────────────────────────────────
// TPO sends a follow-up message (from their customer) on an existing ticket.
router.post("/tickets/:id/messages", async (req, res) => {
  const tenant = req.tenant!;
  const { id } = req.params;
  const { message } = req.body as { message?: string };

  if (!message || message.trim().length < 2) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const db = getDb();
  const gatewayUserId = getGatewayUserId();

  const { data: ownership } = await db
    .from("api_tenant_support_tickets")
    .select("ticket_id, customer_ref")
    .eq("tenant_id", tenant.tenantId)
    .eq("ticket_id", id)
    .single();

  if (!ownership) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }

  // Re-open if resolved/closed
  await db
    .from("support_tickets")
    .update({ status: "in_progress", updated_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", ["resolved", "closed"]);

  const { data: msg, error } = await db
    .from("support_messages")
    .insert({
      user_id: gatewayUserId,
      sender: "user",
      body: message.trim(),
      ticket_id: id,
    })
    .select("id, created_at")
    .single();

  if (error || !msg) {
    res.status(500).json({ error: "Failed to send message" });
    return;
  }

  res.status(201).json({
    message_id: msg.id,
    ticket_id: id,
    sender: "customer",
    sent_at: msg.created_at,
  });
});

export default router;
