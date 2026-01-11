const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

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

// Database (local dev). OJO: en Render el filesystem puede ser efímero si no usas disk persistente.
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
  source TEXT DEFAULT 'manual',
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

// ---- Reward (client-based fallback) ----
// Esto sigue existiendo por si quieres acreditar desde la app al terminar el video.
// En producción ideal: solo SSV, pero por ahora lo dejamos.
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

  db.prepare("INSERT INTO rewards (user_id, sats, day, source) VALUES (?, ?, ?, ?)")
    .run(user.id, SATS_PER_REWARD, today(), "client");

  res.json({ ok: true, added: SATS_PER_REWARD });
});

// ---- AdMob SSV (server-to-server callback) ----
// AdMob manda parámetros como: user_id, custom_data, reward_amount, ad_unit, timestamp, signature...
// Para MVP: validamos user_id + custom_data(sessionId) y acreditamos.
app.get("/admob/ssv", (req, res) => {
  const userId = req.query.user_id;       // tu deviceId
  const sessionId = req.query.custom_data; // tu sessionId
  const rewardAmount = req.query.reward_amount; // opcional (normalmente 1)

  // AdMob recomienda siempre responder 200 OK rápido.
  // Si falta info, respondemos 200 pero NO acreditamos, y logueamos.
  if (!userId || !sessionId) {
    console.log("[SSV] Missing params", { userId, sessionId });
    return res.status(200).send("ok");
  }

  const s = adSessions.get(sessionId);
  if (!s) {
    console.log("[SSV] Invalid/expired session", { userId, sessionId });
    return res.status(200).send("ok");
  }

  if (s.used) {
    console.log("[SSV] Session already used", { userId, sessionId });
    return res.status(200).send("ok");
  }

  if (s.deviceId !== userId) {
    console.log("[SSV] Session/device mismatch", { userId, sessionId, expected: s.deviceId });
    return res.status(200).send("ok");
  }

  // mark used BEFORE crediting
  s.used = true;
  adSessions.set(sessionId, s);

  const user = getOrCreateUser(userId);

  const count = db
    .prepare("SELECT COUNT(*) as c FROM rewards WHERE user_id = ? AND day = ?")
    .get(user.id, today()).c;

  if (count >= DAILY_MAX_REWARDS) {
    console.log("[SSV] Daily limit reached", { userId, day: today() });
    return res.status(200).send("ok");
  }

  // MVP: ignoramos reward_amount y siempre damos SATS_PER_REWARD.
  db.prepare("INSERT INTO rewards (user_id, sats, day, source) VALUES (?, ?, ?, ?)")
    .run(user.id, SATS_PER_REWARD, today(), "ssv");

  console.log("[SSV] Reward granted", { userId, sessionId, rewardAmount, sats: SATS_PER_REWARD });
  return res.status(200).send("ok");
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
  console.log(`SSV verify: GET /admob/ssv`);
});
