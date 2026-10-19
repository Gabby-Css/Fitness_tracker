// db.js - opens the SQLite database and makes sure our tables exist.
const Database = require('better-sqlite3');
const path = require('path');

// On a host with a persistent disk, set DATA_DIR to that disk's path
// so the database file survives restarts. Locally it just sits next to the code.
const dataDir = process.env.DATA_DIR || __dirname;
const db = new Database(path.join(dataDir, 'fitness.db'));

db.pragma('journal_mode = WAL'); // faster writes, safer reads
db.pragma('foreign_keys = ON');  // SQLite ignores foreign keys unless we ask

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    value      REAL NOT NULL,
    date       TEXT NOT NULL,          -- YYYY-MM-DD, the day the activity happened
    note       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_logs_user_date ON logs (user_id, date);
`);

module.exports = db;
