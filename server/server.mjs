import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, relative, isAbsolute } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { db, ensureAdmin, hashPassword, MAX_PASSWORD_BYTES, passwordError, publicUser, verifyPassword } from "./database.mjs";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const publicDir = normalize(join(import.meta.dirname, "..", "dist"));
const sessionDays = Math.min(90, Math.max(1, Number(process.env.SESSION_DAYS || 30)));
const sessionCookie = "bookvault_session";
const maxBodyBytes = 16_384;
const loginWindowMs = 15 * 60 * 1000;
const loginLimit = 5;
const loginAttempts = new Map();
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png" };
const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: https://images.unsplash.com; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

await ensureAdmin();
const dummyPasswordHash = await hashPassword(randomBytes(24).toString("hex"));
db.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();

function writeHead(res, status, headers = {}) {
  res.writeHead(status, { ...securityHeaders, ...headers });
}
function send(res, status, body, headers = {}) {
  writeHead(res, status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
async function jsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > maxBodyBytes) {
      const error = new Error("Request too large"); error.status = 413; throw error;
    }
  }
  try { return raw ? JSON.parse(raw) : {}; } catch {
    const error = new Error("Invalid JSON"); error.status = 400; throw error;
  }
}
function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(value => value.trim().split(/=(.*)/s)).filter(parts => parts[0]));
}
function currentUser(req) {
  const token = cookies(req)[sessionCookie];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const user = db.prepare(`SELECT u.*, s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP`).get(tokenHash(token));
  if (user) db.prepare("UPDATE sessions SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?").run(user.token_hash);
  return user;
}
function clientAddress(req) {
  return String(req.socket.remoteAddress || "unknown");
}
function rateKeys(req, email) {
  return [`ip:${clientAddress(req)}`, `account:${String(email || "").trim().toLowerCase().slice(0, 254)}`];
}
function blocked(keys) {
  const now = Date.now();
  return keys.some(key => {
    const entry = loginAttempts.get(key);
    if (!entry || entry.resetAt <= now) { loginAttempts.delete(key); return false; }
    return entry.count >= loginLimit;
  });
}
function failedLogin(keys) {
  const now = Date.now();
  for (const key of keys) {
    const entry = loginAttempts.get(key);
    loginAttempts.set(key, !entry || entry.resetAt <= now ? { count: 1, resetAt: now + loginWindowMs } : { ...entry, count: entry.count + 1 });
  }
}
function cookieHeader(req, token, maxAge) {
  const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
  return `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function audit(event, req, details = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, address: clientAddress(req), ...details }));
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { status: "ok" });
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const { email: inputEmail, password: inputPassword } = await jsonBody(req);
    const email = String(inputEmail || "").trim().toLowerCase();
    const password = String(inputPassword || "");
    const keys = rateKeys(req, email);
    if (blocked(keys)) {
      audit("login_rate_limited", req, { email });
      return send(res, 429, { error: "Too many login attempts. Try again later." }, { "Retry-After": "900" });
    }
    if (!validEmail(email) || Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
      failedLogin(keys); audit("login_failed", req, { email }); return send(res, 401, { error: "Invalid email or password" });
    }
    const user = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email);
    const validPassword = await verifyPassword(password, user?.password_hash || dummyPasswordHash);
    const valid = Boolean(user && validPassword);
    if (!valid) {
      failedLogin(keys); audit("login_failed", req, { email }); return send(res, 401, { error: "Invalid email or password" });
    }
    for (const key of keys) loginAttempts.delete(key);
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + sessionDays * 86400000).toISOString();
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash(token), user.id, expires);
    audit("login_succeeded", req, { userId: user.id });
    return send(res, 200, { user: publicUser(user) }, { "Set-Cookie": cookieHeader(req, token, sessionDays * 86400) });
  }
  const user = currentUser(req);
  if (!user) return send(res, 401, { error: "Authentication required" });
  if (req.method === "GET" && url.pathname === "/api/auth/me") return send(res, 200, { user: publicUser(user) });
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(user.token_hash);
    audit("logout", req, { userId: user.id });
    return send(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(req, "", 0) });
  }
  if (url.pathname === "/api/users") {
    if (user.role !== "admin") return send(res, 403, { error: "Administrator access required" });
    if (req.method === "GET") return send(res, 200, { users: db.prepare("SELECT * FROM users ORDER BY name").all().map(publicUser) });
    if (req.method === "POST") {
      const { name: inputName, email: inputEmail, password: inputPassword, role = "user" } = await jsonBody(req);
      const name = String(inputName || "").trim();
      const email = String(inputEmail || "").trim().toLowerCase();
      const password = String(inputPassword || "");
      const problem = passwordError(password);
      if (!name || name.length > 100 || !validEmail(email) || problem) return send(res, 400, { error: problem || "A valid name and email are required" });
      if (!["admin", "user"].includes(role)) return send(res, 400, { error: "Invalid role" });
      try {
        const result = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)")
          .run(name, email, await hashPassword(password), role);
        audit("user_created", req, { actorId: user.id, userId: Number(result.lastInsertRowid), role });
        return send(res, 201, { user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid)) });
      } catch (error) {
        if (String(error).includes("UNIQUE")) return send(res, 409, { error: "That email already exists" });
        throw error;
      }
    }
  }
  return send(res, 404, { error: "Not found" });
}
async function staticFile(req, res, pathname) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^[/\\]+/, "");
  let file = normalize(join(publicDir, requested));
  const rel = relative(publicDir, file);
  if (rel.startsWith("..") || isAbsolute(rel)) return send(res, 403, { error: "Forbidden" });
  try { if (!(await stat(file)).isFile()) throw new Error(); } catch { file = join(publicDir, "index.html"); }
  const cache = file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable";
  writeHead(res, 200, { "Content-Type": mime[extname(file)] || "application/octet-stream", "Cache-Control": cache });
  if (req.method === "HEAD") return res.end();
  res.end(await readFile(file));
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method || "");
    const origin = req.headers.origin;
    const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    if (unsafe && origin && origin !== `${protocol}://${req.headers.host}`) return send(res, 403, { error: "Cross-origin request rejected" });
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else if (req.method === "GET" || req.method === "HEAD") await staticFile(req, res, url.pathname);
    else send(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    send(res, error.status || 500, { error: error.status ? error.message : "Internal server error" });
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(port, host, () => console.log(`BookVault listening on http://${host}:${port}`));
