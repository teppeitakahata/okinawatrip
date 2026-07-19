import crypto from "crypto";
import { createSession, isSessionValid, touchSession } from "./db.js";

const COOKIE_NAME = "trip_auth";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30日。使うたびに末尾で更新(スライド)される。

function cookieOptions(req, maxAge) {
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  return { httpOnly: true, sameSite: "lax", secure: isHttps, maxAge, path: "/" };
}

function issueSession(req, res) {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
  createSession(token, expiresAt);
  res.cookie(COOKIE_NAME, token, cookieOptions(req, SESSION_MAX_AGE_MS));
  return token;
}

const LOGIN_PAGE = (error) => `<!doctype html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>沖縄旅のしおり - 合い言葉</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f5faff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .box { background: #fff; padding: 28px 24px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); max-width: 320px; width: 90%; }
  h1 { font-size: 1.1rem; margin: 0 0 16px; color: #16232e; }
  input { width: 100%; padding: 12px; border: 1px solid #d7e8f2; border-radius: 10px; font-size: 1rem; box-sizing: border-box; margin-bottom: 12px; }
  button { width: 100%; padding: 12px; border: none; border-radius: 10px; background: #06b6d4; color: #fff; font-size: 1rem; font-weight: 700; }
  .err { color: #d64545; font-size: 0.85rem; margin-bottom: 12px; }
</style></head>
<body>
  <div class="box">
    <h1>🌺 合い言葉を入力してください</h1>
    ${error ? `<p class="err">${error}</p>` : ""}
    <form method="POST" action="/login">
      <input type="text" name="key" placeholder="合い言葉" autofocus autocomplete="off">
      <button type="submit">入る</button>
    </form>
  </div>
</body></html>`;

export function createAuthMiddleware(passphrase) {
  return function requireAuth(req, res, next) {
    const token = req.cookies?.[COOKIE_NAME];
    if (token && isSessionValid(token)) {
      touchSession(token, Date.now() + SESSION_MAX_AGE_MS);
      res.cookie(COOKIE_NAME, token, cookieOptions(req, SESSION_MAX_AGE_MS));
      return next();
    }

    const keyParam = req.query.key;
    if (keyParam && keyParam === passphrase) {
      issueSession(req, res);
      const url = new URL(req.originalUrl, "http://x");
      url.searchParams.delete("key");
      return res.redirect(url.pathname + (url.search || ""));
    }

    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.status(401).send(LOGIN_PAGE(keyParam ? "合い言葉が違います" : null));
  };
}

export function handleLoginPost(passphrase) {
  return (req, res) => {
    const key = (req.body?.key || "").trim();
    if (key !== passphrase) {
      return res.status(401).send(LOGIN_PAGE("合い言葉が違います"));
    }
    issueSession(req, res);
    res.redirect("/");
  };
}
