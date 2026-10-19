// server.js - the Express API for the fitness tracker.
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_MS = 14 * 24 * 60 * 60 * 1000; // stay logged in for two weeks

// One place that describes every thing we can track. The frontend reads this
// from /api/config, so we never have to keep two copies in sync.
const METRICS = {
  steps:   { label: 'Steps',   icon: '👟', unit: 'steps', goal: 10000, max: 100000, quick: [1000, 2500, 5000] },
  water:   { label: 'Water',   icon: '💧', unit: 'ml',    goal: 2000,  max: 10000,  quick: [250, 500, 750] },
  sleep:   { label: 'Sleep',   icon: '😴', unit: 'hrs',   goal: 8,     max: 24,     quick: [6, 7, 8] },
  workout: { label: 'Workout', icon: '💪', unit: 'min',   goal: 30,    max: 600,    quick: [15, 30, 45] },
};
const TYPES = Object.keys(METRICS);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // we sit behind a proxy on Render/Vercel
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => { req.body ??= {}; next(); }); // Express 5 leaves body undefined when empty
app.use(cookieParser());

// ---------- small helpers ----------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(str) {
  if (typeof str !== 'string' || !ISO_DATE.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const round = (n, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

// Very small in-memory rate limiter, good enough to slow down password guessing.
function rateLimit(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt < now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const entry = hits.get(req.ip) || { count: 0, resetAt: now + windowMs };
    entry.count += 1;
    hits.set(req.ip, entry);
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
}
const authLimiter = rateLimit(15, 15 * 60 * 1000);

// ---------- sessions ----------

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now());
  res.cookie('sid', token, {
    httpOnly: true,       // JavaScript in the browser can't read it
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: SESSION_MS,
  });
}

// Looks up who the session cookie belongs to (or returns nothing).
function findUser(req) {
  const token = req.cookies.sid;
  if (!token) return null;
  return db.prepare(`
    SELECT users.id, users.name, users.email
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ? AND sessions.created_at > ?
  `).get(token, Date.now() - SESSION_MS) || null;
}

// Runs before any route that needs a logged-in user.
function requireUser(req, res, next) {
  const user = findUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in first.' });
  req.user = user;
  next();
}

// ---------- auth routes ----------

app.get('/api/config', (req, res) => res.json({ metrics: METRICS }));

app.post('/api/auth/signup', authLimiter, (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (name.length < 1 || name.length > 40) return res.status(400).json({ error: 'Please enter your name (up to 40 characters).' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'That email address does not look right.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password needs at least 8 characters.' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare('INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(name, email, hash, Date.now());
    startSession(res, info.lastInsertRowid);
    res.status(201).json({ user: { id: info.lastInsertRowid, name, email } });
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'An account with that email already exists. Try logging in.' });
    }
    throw err;
  }
});

// Hash used when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

app.post('/api/auth/login', authLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  const ok = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Wrong email or password.' });

  startSession(res, user.id);
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

// Not an error if nobody is logged in, the page just needs to know which screen to show.
app.get('/api/me', (req, res) => res.json({ user: findUser(req) }));

// ---------- log routes ----------

app.get('/api/logs', requireUser, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  const logs = db.prepare(`
    SELECT id, type, value, date, note FROM logs
    WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ?
  `).all(req.user.id, limit);
  res.json({ logs });
});

app.post('/api/logs', requireUser, (req, res) => {
  const { type, date } = req.body;
  const value = Number(req.body.value);
  const note = String(req.body.note || '').trim().slice(0, 100);

  if (!TYPES.includes(type)) return res.status(400).json({ error: 'Unknown activity type.' });
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'Enter an amount greater than zero.' });
  if (value > METRICS[type].max) return res.status(400).json({ error: `That looks too high for ${METRICS[type].label.toLowerCase()}.` });
  if (!isValidDate(date)) return res.status(400).json({ error: 'Pick a valid date.' });

  // allow "tomorrow" because the user's timezone may be ahead of the server's
  const tomorrow = addDays(new Date().toISOString().slice(0, 10), 1);
  if (date > tomorrow) return res.status(400).json({ error: "You can't log activity in the future." });

  const info = db.prepare('INSERT INTO logs (user_id, type, value, date, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, type, round(value, 2), date, note, Date.now());
  res.status(201).json({ id: info.lastInsertRowid });
});

app.delete('/api/logs/:id', requireUser, (req, res) => {
  const info = db.prepare('DELETE FROM logs WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Entry not found.' });
  res.json({ ok: true });
});

// ---------- dashboard summary ----------

app.get('/api/summary', requireUser, (req, res) => {
  const to = isValidDate(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
  const span = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
  const from = addDays(to, -(span - 1));

  const rows = db.prepare(`
    SELECT date, type, SUM(value) AS total FROM logs
    WHERE user_id = ? AND date BETWEEN ? AND ?
    GROUP BY date, type
  `).all(req.user.id, from, to);

  // start every day at zero so days with no logs still show up in the chart
  const days = [];
  const byDate = {};
  for (let i = 0; i < span; i++) {
    const date = addDays(from, i);
    byDate[date] = { date, ...Object.fromEntries(TYPES.map((t) => [t, 0])) };
    days.push(byDate[date]);
  }
  for (const r of rows) byDate[r.date][r.type] = round(r.total, 1);

  const metrics = {};
  for (const type of TYPES) {
    const total = days.reduce((sum, d) => sum + d[type], 0);
    const loggedDays = days.filter((d) => d[type] > 0).length;
    metrics[type] = {
      total: round(total, 1),
      // average over the days you actually logged, so one quiet day doesn't drag it down
      average: loggedDays ? round(total / loggedDays, 1) : 0,
      daysHitGoal: days.filter((d) => d[type] >= METRICS[type].goal).length,
    };
  }

  res.json({ from, to, span, days, metrics, today: byDate[to], streak: currentStreak(req.user.id, to) });
});

// How many days in a row has the user logged something?
// If nothing is logged yet today we start counting from yesterday, so the streak isn't lost mid-day.
function currentStreak(userId, today) {
  const dates = new Set(
    db.prepare('SELECT DISTINCT date FROM logs WHERE user_id = ? AND date <= ? ORDER BY date DESC LIMIT 400')
      .all(userId, today).map((r) => r.date)
  );
  let day = dates.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (dates.has(day)) {
    streak += 1;
    day = addDays(day, -1);
  }
  return streak;
}

// ---------- static files + error handling ----------

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

// Clean out expired sessions now and then.
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE created_at < ?').run(Date.now() - SESSION_MS);
}, 60 * 60 * 1000).unref();

app.listen(PORT, () => console.log(`Fitness tracker running at http://localhost:${PORT}`));
