const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;

// Rules
const SATS_PER_REWARD = 100;
const DAILY_MAX_REWARDS = 3;
const MIN_WITHDRAW_SATS = 50000;

// Admin
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";

// ---- Ad sessions (MVP anti-abuse) ----
const adSessions = new Map(); // sessionId -> { deviceId, createdAt, used }
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cleanupAdSessions() {
  const now = Date.now();
  for (const [sessionId, s] of adSessions.entries()) {
    if (now - s.createdAt > SESSION_TTL_MS) adSessions.delete(sessionId);
  }
}
setInterval(cleanupAdSessions, 60 * 1000);

// Database
const db = new Database("satio.sqlite");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  sats INTEGER,
  day TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

function today() {
  // Día local del servidor (reset a medianoche local)
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getOrCreateUser(deviceId) {
  let user = db.prepare("SELECT * FROM users WHERE device_id = ?").get(deviceId);
  if (!user) {
    const info = db.prepare("INSERT INTO users (device_id) VALUES (?)").run(deviceId);
    user = { id: info.lastInsertRowid, device_id: deviceId };
  }
  return user;
}

// ---- Balance ----
app.post("/balance", (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: "No deviceId" });

  const user = getOrCreateUser(deviceId);

  const total = db
    .prepare("SELECT COALESCE(SUM(sats),0) as t FROM rewards WHERE user_id = ?")
    .get(user.id).t;

  const todayCount = db
    .prepare("SELECT COUNT(*) as c FROM rewards WHERE user_id = ? AND day = ?")
    .get(user.id, today()).c;

  res.json({
    sats: total,
    todayRewards: todayCount,
    dailyMax: DAILY_MAX_REWARDS,
    satsPerReward: SATS_PER_REWARD,
    minWithdraw: MIN_WITHDRAW_SATS
  });
});

// ---- Create ad session (call before showing rewarded ad) ----
app.post("/ad/session", (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: "No deviceId" });

  // ensure user exists
  getOrCreateUser(deviceId);

  const sessionId = crypto.randomBytes(16).toString("hex");
  adSessions.set(sessionId, {
    deviceId,
    createdAt: Date.now(),
    used: false
  });

  res.json({
    sessionId,
    ttlSeconds: Math.floor(SESSION_TTL_MS / 1000)
  });
});

// ---- Reward (requires sessionId) ----
app.post("/reward", (req, res) => {
  const { deviceId, sessionId } = req.body;
  if (!deviceId) return res.status(400).json({ error: "No deviceId" });
  if (!sessionId) return res.status(400).json({ error: "No sessionId" });

  const s = adSessions.get(sessionId);
  if (!s) return res.status(403).json({ error: "Invalid or expired session" });
  if (s.used) return res.status(403).json({ error: "Session already used" });
  if (s.deviceId !== deviceId) return res.status(403).json({ error: "Session/device mismatch" });

  // mark as used BEFORE crediting
  s.used = true;
  adSessions.set(sessionId, s);

  const user = getOrCreateUser(deviceId);

  const count = db
    .prepare("SELECT COUNT(*) as c FROM rewards WHERE user_id = ? AND day = ?")
    .get(user.id, today()).c;

  if (count >= DAILY_MAX_REWARDS) {
    return res.status(429).json({ error: "Daily limit reached" });
  }

  db.prepare("INSERT INTO rewards (user_id, sats, day) VALUES (?, ?, ?)")
    .run(user.id, SATS_PER_REWARD, today());

  res.json({ ok: true, added: SATS_PER_REWARD });
});

// ---- Stats (protected with x-admin-key) ----
app.get("/stats", (req, res) => {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const usersTotal = db.prepare("SELECT COUNT(*) as c FROM users").get().c;

  const rewardsToday = db
    .prepare("SELECT COUNT(*) as c FROM rewards WHERE day = ?")
    .get(today()).c;

  const satsIssuedToday = db
    .prepare("SELECT COALESCE(SUM(sats),0) as t FROM rewards WHERE day = ?")
    .get(today()).t;

  const rewardsTotal = db.prepare("SELECT COUNT(*) as c FROM rewards").get().c;

  const satsIssuedTotal = db.prepare("SELECT COALESCE(SUM(sats),0) as t FROM rewards").get().t;

  res.json({
    day: today(),
    usersTotal,
    rewardsToday,
    satsIssuedToday,
    rewardsTotal,
    satsIssuedTotal
  });
});

app.listen(PORT, () => {
  console.log(`SATIO backend running on http://localhost:${PORT}`);
});
