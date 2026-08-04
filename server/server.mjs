import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { randomBytes } from "node:crypto";
import { db, ensureAdmin, hashPassword, publicUser, verifyPassword } from "./database.mjs";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const publicDir = normalize(join(import.meta.dirname, "..", "dist"));
const sessionDays = Math.max(1, Number(process.env.SESSION_DAYS || 30));
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png" };

ensureAdmin();
db.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();
function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
async function jsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("Request too large");
  }
  return raw ? JSON.parse(raw) : {};
}
function currentUser(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  return db.prepare(`SELECT u.*, s.token FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > CURRENT_TIMESTAMP`).get(token);
}
async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { status: "ok" });
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const { email, password } = await jsonBody(req);
    const user = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(String(email || ""));
    if (!user || !verifyPassword(String(password || ""), user.password_hash)) return send(res, 401, { error: "Invalid email or password" });
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
      .run(token, user.id, new Date(Date.now() + sessionDays * 86400000).toISOString());
    return send(res, 200, { token, user: publicUser(user) });
  }
  const user = currentUser(req);
  if (!user) return send(res, 401, { error: "Authentication required" });
  if (req.method === "GET" && url.pathname === "/api/auth/me") return send(res, 200, { user: publicUser(user) });
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(user.token);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/api/users") {
    if (user.role !== "admin") return send(res, 403, { error: "Administrator access required" });
    if (req.method === "GET") return send(res, 200, { users: db.prepare("SELECT * FROM users ORDER BY name").all().map(publicUser) });
    if (req.method === "POST") {
      const { name, email, password, role = "user" } = await jsonBody(req);
      if (!name || !email || String(password || "").length < 8) return send(res, 400, { error: "Name, email, and an 8+ character password are required" });
      if (!["admin", "user"].includes(role)) return send(res, 400, { error: "Invalid role" });
      try {
        const result = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)")
          .run(String(name).trim(), String(email).trim().toLowerCase(), hashPassword(String(password)), role);
        return send(res, 201, { user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid)) });
      } catch (error) {
        if (String(error).includes("UNIQUE")) return send(res, 409, { error: "That email already exists" });
        throw error;
      }
    }
  }
  return send(res, 404, { error: "Not found" });
}
async function staticFile(res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let file = normalize(join(publicDir, requested));
  if (!file.startsWith(publicDir)) return send(res, 403, { error: "Forbidden" });
  try { if (!(await stat(file)).isFile()) throw new Error(); } catch { file = join(publicDir, "index.html"); }
  res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" });
  res.end(await readFile(file));
}
createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else if (req.method === "GET" || req.method === "HEAD") await staticFile(res, url.pathname);
    else send(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    send(res, 500, { error: "Internal server error" });
  }
}).listen(port, host, () => console.log(`BookVault listening on http://${host}:${port}`));
