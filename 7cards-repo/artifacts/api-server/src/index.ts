import express from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import healthRouter from "./routes/health.js";
import v1Router from "./routes/v1/index.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(pinoHttp({ autoLogging: { ignore: (req) => req.url === "/healthz" } }));

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-ID"],
  }),
);

app.use(express.json({ limit: "1mb" }));

app.use("/", healthRouter);
app.use("/v1", v1Router);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("[api-server] unhandled error", err);
    res.status(500).json({ error: "Internal server error" });
  },
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[api-server] listening on :${PORT}`);
});
