const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Rules
const SATS_PER_REWARD = 100;     // 1 reward = 100 sats
const DAILY_MAX_REWARDS = 3;
const MIN_WITHDRAW_SATS = 50000;

// Admin
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";

// Database
const db = new Database("satio.sqlite");

// --------------------
// Helpers / Migrations
// --------------------
function today() {
  const d = new Date(); // server local time
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

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

-- Persisted ad sessions (works on Render restarts / multi instances)
CREATE TABLE IF NOT EXISTS ad_sessions (
  session_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
`);

// Add columns if missing (safe)
if (!columnExists("rewards", "session_id")) {
  db.exec(`ALTER TABLE rewards ADD COLUMN session_id TEXT;`);
}
if (!columnExists("rewards", "source")) {
  db.exec(`ALTER TABLE rewards ADD COLUMN source TEXT;`);
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rewards_session_id ON rewards(session_id);`);

// --------------
// Core functions
// --------------
function getOrCreateUser(deviceId) {
  let user = db.prepare("SELECT * FROM users WHERE device_id = ?").get(deviceId);
  if (!user) {
    const info = db.prepare("INSERT INTO users (device_id) VALUES (?)").run(deviceId);
    user = { id: info.lastInsertRowid, device_id: deviceId };
  }
  return user;
}

// Single credit function used by BOTH SSV and client fallback.
// - validates session exists, matches device, not used
// - enforces daily limit
// - idempotent insert by UNIQUE session_id
// - marks session used
function creditReward({ deviceId, sessionId, source }) {
  if (!deviceId) return { status: 400, json: { error: "No deviceId" } };
  if (!sessionId) return { status: 400, json: { error: "No sessionId" } };

  const now = Date.now();
  const SESSION_TTL_MS = 5 * 60 * 1000;

  const tx = db.transaction(() => {
    // ensure session exists
    const sess = db.prepare("SELECT * FROM ad_sessions WHERE session_id = ?").get(sessionId);
    if (!sess) {
      return { status: 403, json: { error: "Invalid or expired session" } };
    }
    if (sess.used === 1) {
      // already used => idempotent OK
      return { status: 200, json: { ok: true, added: 0, duplicate: true } };
    }
    if (sess.device_id !== deviceId) {
      return { status: 403, json: { error: "Session/device mismatch" } };
    }
    if (now - sess.created_at > SESSION_TTL_MS) {
      // expire + mark used so it can’t be replayed
      db.prepare("UPDATE ad_sessions SET used = 1 WHERE session_id = ?").run(sessionId);
      return { status: 403, json: { error: "Invalid or expired session" } };
    }

    const user = getOrCreateUser(deviceId);

    const count = db
      .prepare("SELECT COUNT(*) as c FROM rewards WHERE user_id = ? AND day = ?")
      .get(user.id, today()).c;

    if (count >= DAILY_MAX_REWARDS) {
      // mark used anyway (they already watched)
      db.prepare("UPDATE ad_sessions SET used = 1 WHERE session_id = ?").run(sessionId);
      return { status: 429, json: { error: "Daily limit reached" } };
    }

    // mark used BEFORE insert (prevents race)
    db.prepare("UPDATE ad_sessions SET used = 1 WHERE session_id = ?").run(sessionId);

    // idempotent reward insert (unique session_id)
    const info = db.prepare(`
      INSERT OR IGNORE INTO rewards (user_id, sats, day, session_id, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(user.id, SATS_PER_REWARD, today(), sessionId, source);

    // if ignored => duplicate
    if (info.changes === 0) {
      return { status: 200, json: { ok: true, added: 0, duplicate: true } };
    }

    return { status: 200, json: { ok: true, added: SATS_PER_REWARD } };
  });

  return tx();
}

// --------------------
// Routes
// --------------------

// Health
app.get("/", (_req, res) => res.send("SATIO backend ✅"));

// Balance
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

// Create ad session (call BEFORE showing rewarded ad)
app.post("/ad/session", (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: "No deviceId" });

  // ensure user exists
  getOrCreateUser(deviceId);

  const sessionId = crypto.randomBytes(16).toString("hex");
  const createdAt = Date.now();

  db.prepare(`
    INSERT INTO ad_sessions (session_id, device_id, created_at, used)
    VALUES (?, ?, ?, 0)
  `).run(sessionId, deviceId, createdAt);

  res.json({
    sessionId,
    ttlSeconds: 300
  });
});

// Client fallback claim (useful when SSV does not fire in simulator/test)
app.post("/reward", (req, res) => {
  const { deviceId, sessionId } = req.body;
  const result = creditReward({ deviceId, sessionId, source: "client" });
  return res.status(result.status).json(result.json);
});

// SSV endpoint (AdMob will call this)
// We expect: user_id=<deviceId> and custom_data=<sessionId>
app.get("/admob/ssv", (req, res) => {
  const deviceId = req.query.user_id;        // AdMob userIdentifier
  const sessionId = req.query.custom_data;   // we send sessionId via customRewardText -> becomes custom_data

  const result = creditReward({ deviceId, sessionId, source: "ssv" });

  // AdMob expects 200 OK quickly.
  // If daily limit / invalid session, still reply 200 'ok' so AdMob doesn't retry forever,
  // but we keep your internal logic safe.
  if (result.status === 200) return res.status(200).send("ok");

  // For debugging you can return 200 too, but better to expose real status locally.
  // In production, returning 200 is usually fine.
  return res.status(200).send("ok");
});

// Stats (protected)
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
