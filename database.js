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
      dialog_id INTEGER,
      text TEXT NOT NULL,
      audio_url TEXT,
      audio_mime TEXT,
      audio_duration INTEGER,
      timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      username TEXT NOT NULL,
      reply_to_id INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (dialog_id) REFERENCES dialogs(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS dialogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_one_id INTEGER NOT NULL,
      user_two_id INTEGER NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (user_one_id < user_two_id),
      UNIQUE (user_one_id, user_two_id),
      FOREIGN KEY (user_one_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (user_two_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  const columns = await all('PRAGMA table_info(users)');
  if (!columns.some((column) => column.name === 'avatar')) {
    await run("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT '🙂'");
  }
  const messageColumns = await all('PRAGMA table_info(messages)');
  if (!messageColumns.some((column) => column.name === 'dialog_id')) {
    await run('ALTER TABLE messages ADD COLUMN dialog_id INTEGER');
  }
  if (!messageColumns.some((column) => column.name === 'audio_url')) await run('ALTER TABLE messages ADD COLUMN audio_url TEXT');
  if (!messageColumns.some((column) => column.name === 'audio_mime')) await run('ALTER TABLE messages ADD COLUMN audio_mime TEXT');
  if (!messageColumns.some((column) => column.name === 'audio_duration')) await run('ALTER TABLE messages ADD COLUMN audio_duration INTEGER');
  await run('CREATE INDEX IF NOT EXISTS messages_dialog_id_id ON messages(dialog_id, id)');
  await run('CREATE INDEX IF NOT EXISTS dialogs_user_one_id ON dialogs(user_one_id)');
  await run('CREATE INDEX IF NOT EXISTS dialogs_user_two_id ON dialogs(user_two_id)');
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
    'SELECT id, login, avatar, created_at AS createdAt, password_hash FROM users WHERE login = ? COLLATE NOCASE',
    [login]
  );
}

async function getUserProfile(userId) {
  return get(
    `SELECT users.id, users.login, users.avatar, users.created_at AS createdAt,
            COUNT(messages.id) AS messageCount
     FROM users LEFT JOIN messages ON messages.user_id = users.id
     WHERE users.id = ? GROUP BY users.id`,
    [userId]
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

async function getOrCreateDialog(userId, otherUserId) {
  const firstUserId = Number(userId);
  const secondUserId = Number(otherUserId);
  if (!Number.isInteger(firstUserId) || !Number.isInteger(secondUserId) ||
      firstUserId < 1 || secondUserId < 1 || firstUserId === secondUserId) {
    throw new Error('INVALID_DIALOG');
  }
  const firstExists = await get('SELECT id FROM users WHERE id = ?', [firstUserId]);
  const secondExists = await get('SELECT id FROM users WHERE id = ?', [secondUserId]);
  if (!firstExists || !secondExists) throw new Error('USER_NOT_FOUND');
  const userOneId = Math.min(firstUserId, secondUserId);
  const userTwoId = Math.max(firstUserId, secondUserId);
  await run(
    `INSERT OR IGNORE INTO dialogs (user_one_id, user_two_id)
     VALUES (?, ?)`,
    [userOneId, userTwoId]
  );
  return get(
    `SELECT id, user_one_id AS userOneId, user_two_id AS userTwoId,
            created_at AS createdAt, updated_at AS updatedAt
     FROM dialogs WHERE user_one_id = ? AND user_two_id = ?`,
    [userOneId, userTwoId]
  );
}

function isDialogParticipant(dialogId, userId) {
  return get(
    `SELECT id FROM dialogs
     WHERE id = ? AND (user_one_id = ? OR user_two_id = ?)`,
    [dialogId, userId, userId]
  ).then(Boolean);
}

function getDialog(dialogId, userId) {
  return get(
    `SELECT id, user_one_id AS userOneId, user_two_id AS userTwoId,
            created_at AS createdAt, updated_at AS updatedAt
     FROM dialogs
     WHERE id = ? AND (user_one_id = ? OR user_two_id = ?)`,
    [dialogId, userId, userId]
  );
}

function getDialogsForUser(userId) {
  return all(
    `SELECT dialogs.id, dialogs.user_one_id AS userOneId, dialogs.user_two_id AS userTwoId,
            dialogs.created_at AS createdAt, dialogs.updated_at AS updatedAt,
            other.id AS otherUserId, other.login AS otherLogin, other.avatar AS otherAvatar,
            last_message.text AS lastMessage, last_message.timestamp AS lastMessageAt,
            (SELECT COUNT(*) FROM messages unread
             WHERE unread.dialog_id = dialogs.id) AS messageCount
     FROM dialogs
     JOIN users other ON other.id = CASE
       WHEN dialogs.user_one_id = ? THEN dialogs.user_two_id
       ELSE dialogs.user_one_id END
     LEFT JOIN messages last_message ON last_message.id = (
       SELECT id FROM messages WHERE dialog_id = dialogs.id ORDER BY id DESC LIMIT 1
     )
     WHERE dialogs.user_one_id = ? OR dialogs.user_two_id = ?
     ORDER BY COALESCE(last_message.id, dialogs.id) DESC`,
    [userId, userId, userId]
  );
}

function getDialogMessages(dialogId, userId, limit = 50) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  return all(
    `SELECT messages.id, messages.dialog_id AS dialogId, messages.user_id AS userId,
            messages.username, messages.text, messages.timestamp, users.avatar,
            messages.audio_url AS audioUrl, messages.audio_mime AS audioMime,
            messages.audio_duration AS audioDuration,
            messages.reply_to_id AS replyToId, replied.username AS replyUsername,
            replied.text AS replyText
     FROM messages
     JOIN users ON users.id = messages.user_id
     LEFT JOIN messages AS replied ON replied.id = messages.reply_to_id
     WHERE messages.dialog_id = ?
       AND EXISTS (SELECT 1 FROM dialogs
                   WHERE dialogs.id = ? AND (dialogs.user_one_id = ? OR dialogs.user_two_id = ?))
     ORDER BY messages.id DESC LIMIT ?`,
    [dialogId, dialogId, userId, userId, safeLimit]
  ).then((rows) => rows.reverse());
}

function getAudioMessage(audioUrl, userId) {
  return get(
    `SELECT messages.audio_url AS audioUrl, messages.audio_mime AS audioMime
     FROM messages
     WHERE messages.audio_url = ?
       AND EXISTS (SELECT 1 FROM dialogs
                   WHERE dialogs.id = messages.dialog_id
                     AND (dialogs.user_one_id = ? OR dialogs.user_two_id = ?))`,
    [audioUrl, userId, userId]
  );
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

async function saveDialogMessage(dialogId, userId, username, text, replyToId = null, audio = null) {
  if (!(await isDialogParticipant(dialogId, userId))) throw new Error('DIALOG_FORBIDDEN');
  if (replyToId !== null && !(await get(
    'SELECT id FROM messages WHERE id = ? AND dialog_id = ?', [replyToId, dialogId]
  ))) throw new Error('REPLY_NOT_FOUND');
  const result = await run(
    `INSERT INTO messages (dialog_id, user_id, username, text, reply_to_id, audio_url, audio_mime, audio_duration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [dialogId, userId, username, text, replyToId, audio?.url || null, audio?.mime || null, audio?.duration || null]
  );
  await run('UPDATE dialogs SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [dialogId]);
  return get(
    `SELECT messages.id, messages.dialog_id AS dialogId, messages.user_id AS userId,
            messages.username, messages.text, messages.timestamp, users.avatar,
            messages.audio_url AS audioUrl, messages.audio_mime AS audioMime, messages.audio_duration AS audioDuration,
            messages.reply_to_id AS replyToId, replied.username AS replyUsername,
            replied.text AS replyText
     FROM messages JOIN users ON users.id = messages.user_id
     LEFT JOIN messages AS replied ON replied.id = messages.reply_to_id
     WHERE messages.id = ?`,
    [result.id]
  );
}

function deleteMessage(messageId, userId, dialogId) {
  return run(
    'DELETE FROM messages WHERE id = ? AND user_id = ? AND dialog_id = ?',
    [messageId, userId, dialogId]
  );
}

async function editMessage(messageId, userId, text, dialogId) {
  const result = await run(
    'UPDATE messages SET text = ? WHERE id = ? AND user_id = ? AND dialog_id = ?',
    [text, messageId, userId, dialogId]
  );
  if (!result.changes) return null;
  return get(
    `SELECT messages.id, messages.dialog_id AS dialogId, messages.user_id AS userId,
             messages.username, messages.text,
            messages.timestamp, users.avatar, messages.audio_url AS audioUrl,
            messages.audio_mime AS audioMime, messages.audio_duration AS audioDuration
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

function getExpiredMessages(maxAgeDays = 90) {
  const days = Math.max(1, Math.min(3650, Number(maxAgeDays) || 90));
  return all(
    `SELECT id, audio_url AS audioUrl FROM messages
     WHERE timestamp < datetime('now', '-' || ? || ' days')`,
    [days]
  );
}

function deleteExpiredMessages(maxAgeDays = 90) {
  const days = Math.max(1, Math.min(3650, Number(maxAgeDays) || 90));
  return run(
    `DELETE FROM messages WHERE timestamp < datetime('now', '-' || ? || ' days')`,
    [days]
  );
}

module.exports = {
  initDB,
  createUser,
  findUser,
  getUserProfile,
  getUsers,
  updateAvatar,
  getOrCreateDialog,
  getDialog,
  getDialogsForUser,
  isDialogParticipant,
  getDialogMessages,
  getAudioMessage,
  saveMessage,
  saveDialogMessage,
  deleteMessage,
  editMessage,
  getLastMessages,
  getExpiredMessages,
  deleteExpiredMessages
};
