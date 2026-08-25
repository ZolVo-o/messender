const crypto = require('crypto');
const path = require('path');
const http = require('http');
const express = require('express');
const bcrypt = require('bcrypt');
const { WebSocketServer, WebSocket } = require('ws');
const {
  initDB,
  createUser,
  findUser,
  getUsers,
  saveMessage,
  deleteMessage,
  getLastMessages
} = require('./database');

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map();
const activeConnections = new Map(); // login -> { ws, userId }

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function cleanLogin(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function issueSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    userId: user.id,
    login: user.login,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function validateCredentials(login, password) {
  return login.length >= 2 && login.length <= 32 &&
    typeof password === 'string' && password.length >= 4 && password.length <= 128;
}

app.post('/register', async (req, res) => {
  const login = cleanLogin(req.body.login);
  const password = req.body.password;
  if (!validateCredentials(login, password)) {
    return res.status(400).json({ error: 'Логин: 2–32 символа, пароль: 4–128 символов.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await createUser(login, passwordHash);
    return res.status(201).json({ token: issueSession(user), login: user.login });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: 'Такой логин уже зарегистрирован.' });
    }
    console.error('Registration error:', error);
    return res.status(500).json({ error: 'Ошибка сервера.' });
  }
});

app.post('/login', async (req, res) => {
  const login = cleanLogin(req.body.login);
  const password = req.body.password;
  if (!login || typeof password !== 'string') {
    return res.status(400).json({ error: 'Введите логин и пароль.' });
  }

  try {
    const user = await findUser(login);
    const valid = user && await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный логин или пароль.' });
    return res.json({ token: issueSession(user), login: user.login });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Ошибка сервера.' });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  for (const connection of activeConnections.values()) send(connection.ws, payload);
}

async function broadcastUsers() {
  const users = await getUsers();
  const online = new Set(activeConnections.keys());
  broadcast({
    type: 'users',
    users: users.map((user) => ({ ...user, online: online.has(user.login) }))
  });
}

wss.on('connection', (ws) => {
  let session = null;
  let login = null;

  send(ws, { type: 'connected' });

  ws.on('message', async (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch (_) { return send(ws, { type: 'error', error: 'Некорректный формат данных.' }); }

    if (!session) {
      if (message.type !== 'auth' || typeof message.token !== 'string') {
        return send(ws, { type: 'error', error: 'Требуется авторизация.' });
      }
      session = sessions.get(message.token);
      if (!session || session.expiresAt < Date.now()) {
        return send(ws, { type: 'auth_error', error: 'Сессия истекла. Войдите снова.' });
      }
      login = session.login;
      const oldConnection = activeConnections.get(login);
      if (oldConnection && oldConnection.ws !== ws) oldConnection.ws.close(4001, 'Новое подключение');
      activeConnections.set(login, { ws, userId: session.userId });
      send(ws, { type: 'history', messages: await getLastMessages(50) });
      await broadcastUsers();
      broadcast({ type: 'system', text: `Пользователь ${login} вошел в чат` });
      return;
    }

    if (message.type === 'message' && typeof message.text === 'string') {
      const text = message.text.trim().slice(0, 2000);
      if (!text) return;
      try {
        const saved = await saveMessage(session.userId, login, text);
        broadcast({ type: 'message', message: saved });
      } catch (error) {
        console.error('Message error:', error);
        send(ws, { type: 'error', error: 'Не удалось сохранить сообщение.' });
      }
    }

    if (message.type === 'delete_message') {
      const messageId = Number(message.messageId);
      if (!Number.isInteger(messageId) || messageId < 1) {
        return send(ws, { type: 'error', error: 'Некорректный идентификатор сообщения.' });
      }
      try {
        const result = await deleteMessage(messageId, session.userId);
        if (!result.changes) return send(ws, { type: 'error', error: 'Сообщение не найдено или принадлежит другому пользователю.' });
        broadcast({ type: 'message_deleted', messageId });
      } catch (error) {
        console.error('Delete message error:', error);
        send(ws, { type: 'error', error: 'Не удалось удалить сообщение.' });
      }
    }
  });

  ws.on('close', () => {
    if (login && activeConnections.get(login)?.ws === ws) {
      activeConnections.delete(login);
      broadcastUsers().catch((error) => console.error('Presence error:', error));
      broadcast({ type: 'system', text: `Пользователь ${login} покинул чат` });
    }
  });
});

initDB()
  .then(() => server.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`)))
  .catch((error) => { console.error('Database initialization error:', error); process.exit(1); });
