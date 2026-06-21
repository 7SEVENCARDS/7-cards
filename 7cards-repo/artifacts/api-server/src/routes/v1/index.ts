import { Router } from "express";
import ratesRouter from "./rates.js";
import tradesRouter from "./trades.js";
import supportRouter from "./support.js";
import webhooksRouter from "./webhooks.js";
import accountRouter from "./account.js";

const router = Router();

// ── API info (unauthenticated) ─────────────────────────────────────────────
router.get("/", (_req, res) => {
  res.json({
    api: "7SEVEN Cards",
    version: "1.0.0",
    description:
      "Infrastructure API for gift card trading companies. Use our verified vendor network and support staff to power your own trading platform.",
    docs: "https://docs.7sevencards.com/api",
    endpoints: {
      rates:    "GET  /v1/rates",
      account:  "GET  /v1/account",
      trades: [
        "POST /v1/trades",
        "POST /v1/trades/batch",
        "GET  /v1/trades",
        "GET  /v1/trades/:id",
      ],
      support: [
        "POST /v1/support/tickets",
        "GET  /v1/support/tickets",
        "GET  /v1/support/tickets/:id",
        "GET  /v1/support/tickets/:id/messages",
        "POST /v1/support/tickets/:id/messages",
      ],
      webhooks: [
        "POST   /v1/webhooks",
        "GET    /v1/webhooks",
        "DELETE /v1/webhooks/:id",
        "GET    /v1/webhooks/deliveries",
      ],
    },
    auth: "Authorization: Bearer sk_live_<your-key>",
    rate_limits: "60 requests/minute (default). Contact us to increase.",
    webhook_events: [
      "trade.verified",
      "trade.pending_review",
      "trade.failed",
      "trade.dispatched",
      "trade.paid",
      "support.ticket_created",
      "support.replied",
      "support.ticket_closed",
    ],
  });
});

router.use("/rates", ratesRouter);
router.use("/trades", tradesRouter);
router.use("/support", supportRouter);
router.use("/webhooks", webhooksRouter);
router.use("/account", accountRouter);

export default router;
