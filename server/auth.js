import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function loadSecret(dataDir) {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const file = path.join(dataDir, ".auth-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const secret = crypto.randomBytes(48).toString("hex");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function signToken(secret, user) {
  const payload = b64url(JSON.stringify({ sub: user.id, role: user.role, exp: Date.now() + TOKEN_TTL_MS }));
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToken(secret, token) {
  if (typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function authMiddleware(db, secret) {
  const findUser = db.prepare("SELECT id, name, email, role FROM users WHERE id = ?");
  return function requireAuth(req, res, next) {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const data = verifyToken(secret, token);
    const user = data ? findUser.get(data.sub) : null;
    if (!user) return res.status(401).json({ error: "Authentication required" });
    req.user = user;
    next();
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You do not have permission to perform this action" });
    }
    next();
  };
}

export function loginRateLimiter({ windowMs = 15 * 60 * 1000, max = 10 } = {}) {
  const attempts = new Map();
  return (req, res, next) => {
    const key = `${req.ip}:${String(req.body?.email || "").toLowerCase()}`;
    const now = Date.now();
    const entry = attempts.get(key);
    if (entry && now - entry.start < windowMs && entry.count >= max) {
      return res.status(429).json({ error: "Too many login attempts. Try again later." });
    }
    res.on("finish", () => {
      if (res.statusCode === 401) {
        const e = attempts.get(key);
        if (!e || now - e.start >= windowMs) attempts.set(key, { start: now, count: 1 });
        else e.count += 1;
      } else if (res.statusCode < 400) {
        attempts.delete(key);
      }
    });
    next();
  };
}
