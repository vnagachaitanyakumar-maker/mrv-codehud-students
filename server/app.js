import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { authMiddleware, loadSecret, loginRateLimiter, signToken, verifyPassword } from "./auth.js";
import { backfillResults, HttpError } from "./contestService.js";
import { openDb } from "./db.js";
import { adminRouter } from "./routes/admin.js";
import { studentRouter } from "./routes/student.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ dbFile, dataDir } = {}) {
  const resolvedDataDir = dataDir || process.env.DATA_DIR || path.join(__dirname, "data");
  const db = openDb(dbFile || process.env.DB_FILE || path.join(resolvedDataDir, "codehub.db"));
  backfillResults(db);
  const secret = loadSecret(resolvedDataDir);
  const requireAuth = authMiddleware(db, secret);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  const origins = (process.env.CORS_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim());
  app.use(cors({ origin: origins }));
  app.use(express.json({ limit: "200kb" }));
  app.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "same-origin");
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.post("/api/auth/login", loginRateLimiter(), (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim());
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    res.json({
      token: signToken(secret, user),
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  });

  app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: req.user }));
  app.use("/api/student", requireAuth, studentRouter(db));
  app.use("/api/admin", requireAuth, adminRouter(db));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  const dist = path.join(__dirname, "..", "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON body" });
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "Request body too large" });
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return { app, db };
}
