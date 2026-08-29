const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const bcrypt = require('bcrypt');
const { WebSocketServer, WebSocket } = require('ws');
const {
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
  saveDialogMessage,
  deleteMessage,
  editMessage,
  getExpiredMessages,
  deleteExpiredMessages,
} = require('./database');

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 10 * 1024;
const sessions = new Map();
const activeConnections = new Map(); // login -> { ws, userId }
const allowedAvatars = new Set(['🙂', '😀', '😎', '🤩', '😇', '🥳', '🤔', '😴', '😡', '😭', '🐶', '🐱', '🦊', '🐼', '🐸', '🦁', '🐯', '🐨', '🐵', '🦄', '🐙', '🦋', '🌸', '🌈', '⭐', '🔥', '🍕', '🚀']);
const audioDirectory = path.join(__dirname, 'uploads', 'audio');
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MESSAGE_RETENTION_DAYS = Math.max(1, Number(process.env.MESSAGE_RETENTION_DAYS) || 90);
fs.mkdirSync(audioDirectory, { recursive: true });

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/dialogs/:dialogId/audio', express.raw({ type: /^audio\//, limit: MAX_AUDIO_BYTES }), async (req, res) => {
  const session = getSessionFromRequest(req);
  const dialogId = Number(req.params.dialogId);
  const mime = req.get('content-type')?.split(';')[0].toLowerCase() || '';
  const duration = Number(req.get('x-audio-duration'));
  if (!session) return res.status(401).json({ error: 'Требуется авторизация.' });
  if (!Number.isInteger(dialogId) || dialogId < 1 || !(await isDialogParticipant(dialogId, session.userId))) return res.status(403).json({ error: 'Диалог недоступен.' });
  if (!mime.startsWith('audio/') || !Buffer.isBuffer(req.body) || !req.body.length || req.body.length > MAX_AUDIO_BYTES) return res.status(400).json({ error: 'Некорректный аудиофайл.' });
  if (!Number.isFinite(duration) || duration <= 0 || duration > 30) return res.status(400).json({ error: 'Длительность записи не должна превышать 30 секунд.' });
  const extension = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'bin';
  const filename = `${crypto.randomBytes(16).toString('hex')}.${extension}`;
  const filePath = path.join(audioDirectory, filename);
  try {
    await fs.promises.writeFile(filePath, req.body, { flag: 'wx' });
    const saved = await saveDialogMessage(dialogId, session.userId, session.login, '', null, { url: `/audio/${filename}`, mime, duration: Math.round(duration) });
    const dialog = await getDialogForUser(dialogId, session.userId);
    sendToDialog(dialog, { type: 'message', message: saved });
    await sendDialogLists(dialog);
    return res.status(201).json({ message: saved });
  } catch (error) {
    await fs.promises.unlink(filePath).catch(() => {});
    console.error('Audio upload error:', error);
    return res.status(500).json({ error: 'Не удалось сохранить голосовое сообщение.' });
  }
});

app.get('/audio/:filename', async (req, res) => {
  const session = getSessionFromRequest(req);
  const filename = path.basename(req.params.filename);
  if (!session || filename !== req.params.filename) return res.status(403).end();
  const message = await getAudioMessage(`/audio/${filename}`, session.userId).catch(() => null);
  if (!message) return res.status(404).end();
  res.type(message.audioMime);
  return res.sendFile(path.join(audioDirectory, filename));
});

function cleanLogin(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getSessionFromRequest(req) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const session = sessions.get(token);
  return session && session.expiresAt >= Date.now() ? session : null;
}

async function cleanupExpiredMessages() {
  try {
    const expired = await getExpiredMessages(MESSAGE_RETENTION_DAYS);
    const result = await deleteExpiredMessages(MESSAGE_RETENTION_DAYS);
    await Promise.all(expired.filter((item) => item.audioUrl).map((item) =>
      fs.promises.unlink(path.join(__dirname, item.audioUrl.replace(/^\/audio\//, ''))).catch(() => {})
    ));
    if (result.changes) console.log(`Очищено старых сообщений: ${result.changes}`);
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

function issueSession(user) {
  for (const [token, session] of sessions) {
    if (session.expiresAt < Date.now()) sessions.delete(token);
  }
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
    return res.status(201).json({ token: issueSession(user), login: user.login, avatar: user.avatar });
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
  if (!validateCredentials(login, password)) {
    return res.status(400).json({ error: 'Логин: 2–32 символа, пароль: 4–128 символов.' });
  }

  try {
    const user = await findUser(login);
    const valid = user && await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный логин или пароль.' });
    return res.json({ token: issueSession(user), login: user.login, avatar: user.avatar });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Ошибка сервера.' });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES });

wss.on('error', (error) => {
  console.error('WebSocket server error:', error.message);
});

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  for (const connection of activeConnections.values()) send(connection.ws, payload);
}

function broadcastExcept(loginToSkip, payload) {
  for (const [connectionLogin, connection] of activeConnections) {
    if (connectionLogin !== loginToSkip) send(connection.ws, payload);
  }
}

function sendToDialog(dialog, payload) {
  for (const connection of activeConnections.values()) {
    if (connection.userId === dialog.userOneId || connection.userId === dialog.userTwoId) {
      send(connection.ws, payload);
    }
  }
}

async function getDialogForUser(dialogId, userId) {
  if (!Number.isInteger(dialogId) || dialogId < 1) return null;
  const dialog = await getDialog(dialogId, userId);
  if (!dialog) return null;
  const listedDialog = (await getDialogsForUser(userId)).find((item) => item.id === dialog.id);
  return listedDialog || dialog;
}

async function sendDialogLists(dialog) {
  for (const connection of activeConnections.values()) {
    if (connection.userId === dialog.userOneId || connection.userId === dialog.userTwoId) {
      send(connection.ws, { type: 'dialogs', dialogs: await getDialogsForUser(connection.userId) });
    }
  }
}

async function relayCallSignal(message, session, ws) {
  const dialogId = Number(message.dialogId);
  if (!Number.isInteger(dialogId) || !(await isDialogParticipant(dialogId, session.userId))) {
    return send(ws, { type: 'error', error: 'Звонок недоступен.' });
  }
  const dialog = await getDialogForUser(dialogId, session.userId);
  if (!dialog) return send(ws, { type: 'error', error: 'Звонок недоступен.' });
  for (const connection of activeConnections.values()) {
    if (connection.userId !== session.userId && (connection.userId === dialog.userOneId || connection.userId === dialog.userTwoId)) {
      send(connection.ws, { ...message, fromUserId: session.userId });
    }
  }
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

  ws.on('message', async (raw, isBinary) => {
    let message;
    if (isBinary) return send(ws, { type: 'error', error: 'Поддерживаются только текстовые сообщения.' });
    try { message = JSON.parse(raw.toString()); } catch (_) { return send(ws, { type: 'error', error: 'Некорректный формат данных.' }); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return send(ws, { type: 'error', error: 'Некорректный формат данных.' });
    }

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
      send(ws, { type: 'dialogs', dialogs: await getDialogsForUser(session.userId) });
      send(ws, { type: 'profile', profile: await getUserProfile(session.userId) });
      await broadcastUsers();
      broadcast({ type: 'system', text: `Пользователь ${login} вошел в чат` });
      return;
    }

    if (message.type === 'open_dialog') {
      try {
        const otherUserId = Number(message.userId);
        const dialog = message.dialogId
          ? await getDialogForUser(Number(message.dialogId), session.userId)
          : await getOrCreateDialog(session.userId, otherUserId);
        if (!dialog) return send(ws, { type: 'error', error: 'Диалог недоступен.' });
        const fullDialog = await getDialogForUser(dialog.id, session.userId);
        send(ws, { type: 'dialog_opened', dialog: fullDialog, messages: await getDialogMessages(dialog.id, session.userId, 100) });
        await send(ws, { type: 'dialogs', dialogs: await getDialogsForUser(session.userId) });
      } catch (error) {
        send(ws, { type: 'error', error: error.message === 'USER_NOT_FOUND' ? 'Пользователь не найден.' : 'Не удалось открыть диалог.' });
      }
      return;
    }

    if (['call_offer', 'call_answer', 'call_ice', 'call_end', 'call_reject'].includes(message.type)) {
      await relayCallSignal(message, session, ws);
      return;
    }

    if (message.type === 'message' && typeof message.text === 'string') {
      const text = message.text.trim().slice(0, 2000);
      if (!text) return;
      const dialogId = Number(message.dialogId);
      if (!Number.isInteger(dialogId) || dialogId < 1) return send(ws, { type: 'error', error: 'Сначала откройте диалог.' });
      const replyToId = message.replyToId == null ? null : Number(message.replyToId);
      if (replyToId !== null && (!Number.isInteger(replyToId) || replyToId < 1)) {
        return send(ws, { type: 'error', error: 'Некорректное сообщение для ответа.' });
      }
      try {
        const saved = await saveDialogMessage(dialogId, session.userId, login, text, replyToId);
        const dialog = await getDialogForUser(dialogId, session.userId);
        sendToDialog(dialog, { type: 'message', message: saved });
        await sendDialogLists(dialog);
      } catch (error) {
        console.error('Message error:', error);
        send(ws, { type: 'error', error: error.message === 'REPLY_NOT_FOUND' ? 'Сообщение для ответа уже недоступно.' : error.message === 'DIALOG_FORBIDDEN' ? 'Диалог недоступен.' : 'Не удалось сохранить сообщение.' });
      }
    }

    if (message.type === 'typing_start' || message.type === 'typing_stop') {
      const dialogId = Number(message.dialogId);
      if (Number.isInteger(dialogId) && await isDialogParticipant(dialogId, session.userId)) {
        const dialog = await getDialogForUser(dialogId, session.userId);
        for (const connection of activeConnections.values()) {
          if (connection.userId !== session.userId && (connection.userId === dialog.userOneId || connection.userId === dialog.userTwoId)) {
            send(connection.ws, { type: message.type, username: login, dialogId });
          }
        }
      }
    }

    if (message.type === 'delete_message') {
      const messageId = Number(message.messageId);
      const dialogId = Number(message.dialogId);
      if (!Number.isInteger(messageId) || messageId < 1) {
        return send(ws, { type: 'error', error: 'Некорректный идентификатор сообщения.' });
      }
      try {
        const result = await deleteMessage(messageId, session.userId, dialogId);
        if (!result.changes) return send(ws, { type: 'error', error: 'Сообщение не найдено или принадлежит другому пользователю.' });
        const dialog = await getDialogForUser(dialogId, session.userId);
        sendToDialog(dialog, { type: 'message_deleted', messageId, dialogId });
      } catch (error) {
        console.error('Delete message error:', error);
        send(ws, { type: 'error', error: 'Не удалось удалить сообщение.' });
      }
    }

    if (message.type === 'edit_message') {
      const messageId = Number(message.messageId);
      const dialogId = Number(message.dialogId);
      const text = typeof message.text === 'string' ? message.text.trim().slice(0, 2000) : '';
      if (!Number.isInteger(messageId) || messageId < 1 || !text) {
        return send(ws, { type: 'error', error: 'Некорректные данные для редактирования.' });
      }
      try {
        const edited = await editMessage(messageId, session.userId, text, dialogId);
        if (!edited) return send(ws, { type: 'error', error: 'Сообщение не найдено или принадлежит другому пользователю.' });
        const dialog = await getDialogForUser(dialogId, session.userId);
        sendToDialog(dialog, { type: 'message_edited', message: edited });
      } catch (error) {
        console.error('Edit message error:', error);
        send(ws, { type: 'error', error: 'Не удалось изменить сообщение.' });
      }
    }

    if (message.type === 'update_avatar') {
      if (typeof message.avatar !== 'string' || !allowedAvatars.has(message.avatar)) {
        return send(ws, { type: 'error', error: 'Недопустимая аватарка.' });
      }
      try {
        await updateAvatar(session.userId, message.avatar);
        await broadcastUsers();
        broadcast({ type: 'avatar_updated', userId: session.userId, avatar: message.avatar });
      } catch (error) {
        console.error('Avatar update error:', error);
        send(ws, { type: 'error', error: 'Не удалось изменить аватарку.' });
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

  ws.on('error', (error) => {
    console.error('WebSocket connection error:', error.message);
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} уже занят. Остановите другой сервер или запустите приложение с PORT=3001 npm start.`);
  } else {
    console.error('Server error:', error);
  }
  process.exitCode = 1;
});

initDB()
  .then(async () => {
    await cleanupExpiredMessages();
    setInterval(cleanupExpiredMessages, 24 * 60 * 60 * 1000).unref();
    server.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
  })
  .catch((error) => { console.error('Database initialization error:', error); process.exit(1); });
