// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare Worker entry — api.7evencards.xyz
// Native CF Worker handler (no Express). Mirrors the routes in src/app.ts.
// ─────────────────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/healthz") {
      return json({ status: "ok", ts: Date.now() });
    }

    return json({ error: "Not Found" }, 404);
  },
};
