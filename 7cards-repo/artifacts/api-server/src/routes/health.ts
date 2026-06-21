import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { createClient } from "@supabase/supabase-js";

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  let dbOk = false;
  let dbError: string | undefined;

  if (supabaseUrl && supabaseKey) {
    try {
      const client = createClient(supabaseUrl, supabaseKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error } = await client.from("profiles").select("id").limit(1);
      dbOk = !error;
      if (error) dbError = error.message;
    } catch (e) {
      dbError = e instanceof Error ? e.message : String(e);
    }
  } else {
    dbError = "SUPABASE credentials not configured";
  }

  const data = HealthCheckResponse.parse({ status: dbOk ? "ok" : "degraded" });
  res
    .status(dbOk ? 200 : 503)
    .json({ ...data, db: dbOk ? "supabase:ok" : `supabase:error:${dbError}` });
});

export default router;
