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
      reply_to_id INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  const columns = await all('PRAGMA table_info(users)');
  if (!columns.some((column) => column.name === 'avatar')) {
    await run("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT '🙂'");
  }
  const messageColumns = await all('PRAGMA table_info(messages)');
  if (!messageColumns.some((column) => column.name === 'reply_to_id')) {
    await run('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER');
  }
}

async function createUser(login, passwordHash) {
  const result = await run(
    'INSERT INTO users (login, password_hash) VALUES (?, ?)',
    [login, passwordHash]
  );
  return { id: result.id, login, avatar: '🙂' };
}

function findUser(login) {
  return get(
    'SELECT id, login, avatar, password_hash FROM users WHERE login = ? COLLATE NOCASE',
    [login]
  );
}

function getUsers() {
  return all(
    'SELECT id, login, avatar, created_at AS createdAt FROM users ORDER BY login COLLATE NOCASE'
  );
}

function updateAvatar(userId, avatar) {
  return run('UPDATE users SET avatar = ? WHERE id = ?', [avatar, userId]);
}

async function saveMessage(userId, username, text, replyToId = null) {
  if (replyToId !== null && !(await get('SELECT id FROM messages WHERE id = ?', [replyToId]))) {
    throw new Error('REPLY_NOT_FOUND');
  }
  const result = await run(
    'INSERT INTO messages (user_id, username, text, reply_to_id) VALUES (?, ?, ?, ?)',
    [userId, username, text, replyToId]
  );
  return get(
    `SELECT messages.id, messages.user_id AS userId, messages.username, messages.text,
            messages.timestamp, users.avatar, messages.reply_to_id AS replyToId,
            replied.username AS replyUsername, replied.text AS replyText
     FROM messages JOIN users ON users.id = messages.user_id
     LEFT JOIN messages AS replied ON replied.id = messages.reply_to_id
     WHERE messages.id = ?`,
    [result.id]
  );
}

function deleteMessage(messageId, userId) {
  return run(
    'DELETE FROM messages WHERE id = ? AND user_id = ?',
    [messageId, userId]
  );
}

async function editMessage(messageId, userId, text) {
  const result = await run(
    'UPDATE messages SET text = ? WHERE id = ? AND user_id = ?',
    [text, messageId, userId]
  );
  if (!result.changes) return null;
  return get(
    `SELECT messages.id, messages.user_id AS userId, messages.username, messages.text,
            messages.timestamp, users.avatar
     FROM messages JOIN users ON users.id = messages.user_id WHERE messages.id = ?`,
    [messageId]
  );
}

function getLastMessages(limit = 50) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  return all(
    `SELECT messages.id, messages.user_id AS userId, messages.username, messages.text,
            messages.timestamp, users.avatar, messages.reply_to_id AS replyToId,
            replied.username AS replyUsername, replied.text AS replyText
     FROM messages JOIN users ON users.id = messages.user_id
     LEFT JOIN messages AS replied ON replied.id = messages.reply_to_id
     ORDER BY messages.id DESC LIMIT ?`,
    [safeLimit]
  ).then((rows) => rows.reverse());
}

module.exports = {
  initDB,
  createUser,
  findUser,
  getUsers,
  updateAvatar,
  saveMessage,
  deleteMessage,
  editMessage,
  getLastMessages
};
