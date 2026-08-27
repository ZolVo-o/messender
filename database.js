const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(databasePath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

async function initDB() {
  await run('PRAGMA foreign_keys = ON');
  await run('PRAGMA journal_mode = WAL');
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      username TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
}

async function createUser(login, passwordHash) {
  const result = await run(
    'INSERT INTO users (login, password_hash) VALUES (?, ?)',
    [login, passwordHash]
  );
  return { id: result.id, login };
}

function findUser(login) {
  return get(
    'SELECT id, login, password_hash FROM users WHERE login = ? COLLATE NOCASE',
    [login]
  );
}

function getUsers() {
  return all(
    'SELECT id, login, created_at AS createdAt FROM users ORDER BY login COLLATE NOCASE'
  );
}

async function saveMessage(userId, username, text) {
  const result = await run(
    'INSERT INTO messages (user_id, username, text) VALUES (?, ?, ?)',
    [userId, username, text]
  );
  return get(
    'SELECT id, user_id AS userId, username, text, timestamp FROM messages WHERE id = ?',
    [result.id]
  );
}

function deleteMessage(messageId, userId) {
  return run(
    'DELETE FROM messages WHERE id = ? AND user_id = ?',
    [messageId, userId]
  );
}

function getLastMessages(limit = 50) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  return all(
    `SELECT id, user_id AS userId, username, text, timestamp
     FROM messages ORDER BY id DESC LIMIT ?`,
    [safeLimit]
  ).then((rows) => rows.reverse());
}

module.exports = {
  initDB,
  createUser,
  findUser,
  getUsers,
  saveMessage,
  deleteMessage,
  getLastMessages
};
