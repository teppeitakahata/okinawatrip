import express from "express";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAllData, getData, setData } from "./db.js";
import { createAuthMiddleware, handleLoginPost } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3002;

const CONFIG_PATH = path.join(__dirname, "config.local.json");
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`config.local.json が見つかりません。次の内容で作成してください:\n{"passphrase": "好きな合い言葉"}`);
  process.exit(1);
}
const { passphrase } = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
if (!passphrase) {
  console.error("config.local.json に passphrase を設定してください");
  process.exit(1);
}

const app = express();
app.set("trust proxy", true); // Cloudflare Tunnel経由のX-Forwarded-Protoを信頼する
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ログイン(合い言葉フォーム送信)だけは認証ミドルウェアの手前で受ける
app.post("/login", handleLoginPost(passphrase));

app.use(createAuthMiddleware(passphrase));

// --- API ---
app.get("/api/data", (req, res) => {
  res.json(getAllData());
});
app.put("/api/places", (req, res) => {
  setData("places", req.body);
  res.json({ ok: true });
});
app.put("/api/settings", (req, res) => {
  setData("settings", req.body);
  res.json({ ok: true });
});
app.put("/api/schedule", (req, res) => {
  setData("schedule", req.body);
  res.json({ ok: true });
});

// --- 静的ファイル配信(公開してよいものだけを明示的に許可) ---
app.use("/js", express.static(path.join(__dirname, "js")));
app.use("/icons", express.static(path.join(__dirname, "icons")));
["index.html", "manifest.json", "style.css", "sw.js", "robots.txt"].forEach(file => {
  app.get(`/${file}`, (req, res) => res.sendFile(path.join(__dirname, file)));
});
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => {
  console.log(`okinawa-trip server listening on http://localhost:${PORT}`);
});
