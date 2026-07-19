import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

export const db = new Database(path.join(dataDir, "trip.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS trip_data (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);

const DEFAULTS = {
  places: [],
  settings: {
    startDate: "",
    days: 5,
    base: { name: "", address: "", lat: null, lng: null },
    dayStart: "09:00",
    dayEnd: "19:00",
  },
  schedule: { days: [] },
};

const getStmt = db.prepare("SELECT value FROM trip_data WHERE key = ?");
const setStmt = db.prepare(
  "INSERT INTO trip_data (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
);

export function getData(key) {
  const row = getStmt.get(key);
  return row ? JSON.parse(row.value) : DEFAULTS[key];
}

export function setData(key, value) {
  setStmt.run(key, JSON.stringify(value), new Date().toISOString());
}

export function getAllData() {
  return { places: getData("places"), settings: getData("settings"), schedule: getData("schedule") };
}

// --- セッション(合い言葉URL通過後のクッキー)管理 ---
const insertSession = db.prepare("INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?, ?)");
const getSession = db.prepare("SELECT expires_at FROM sessions WHERE token = ?");
const deleteExpired = db.prepare("DELETE FROM sessions WHERE expires_at < ?");
const deleteSession = db.prepare("DELETE FROM sessions WHERE token = ?");

export function createSession(token, expiresAt) {
  insertSession.run(token, expiresAt);
}

export function touchSession(token, newExpiresAt) {
  insertSession.run(token, newExpiresAt);
}

export function isSessionValid(token) {
  deleteExpired.run(Date.now());
  const row = getSession.get(token);
  return !!row && row.expires_at >= Date.now();
}

export function revokeSession(token) {
  deleteSession.run(token);
}
