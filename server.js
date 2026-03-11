const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static('public', { etag: false, maxAge: 0 }));

const PARTITIONS_DIR = path.join(__dirname, 'public', 'partitions');
const HISTORY_DIR = path.join(__dirname, 'history');
const LEADER_PIN = String(process.env.LEADER_PIN || '1991');

fs.mkdirSync(PARTITIONS_DIR, { recursive: true });
fs.mkdirSync(HISTORY_DIR, { recursive: true });

let leaderSocketId = null;
let leaderUserName = null;
const connectedUsers = new Map();

function isValidSongName(name) {
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  if (!(lower.endsWith('.pro') || lower.endsWith('.cho'))) return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  if (name.length > 120) return false;
  return true;
}

function isValidUserName(name) {
  if (typeof name !== 'string') return false;
  const clean = String(name).trim();
  if (!clean) return false;
  if (clean.length > 50) return false;
  return true;
}

function pinOk(pin) {
  return String(pin || '') === LEADER_PIN;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSongPath(fileName) {
  const filePath = path.join(PARTITIONS_DIR, fileName);
  if (!filePath.startsWith(PARTITIONS_DIR + path.sep)) {
    throw new Error('Chemin invalide');
  }
  return filePath;
}

function readSong(fileName) {
  const filePath = getSongPath(fileName);
  return fs.readFileSync(filePath, 'utf8');
}

function writeSong(fileName, content) {
  const filePath = getSongPath(fileName);
  fs.writeFileSync(filePath, String(content ?? ''), 'utf8');
}

function historyFilePath(fileName) {
  const safe = Buffer.from(fileName, 'utf8').toString('base64url');
  return path.join(HISTORY_DIR, safe + '.json');
}

function readHistory(fileName) {
  const hp = historyFilePath(fileName);
  if (!fs.existsSync(hp)) return [];
  try {
    const raw = fs.readFileSync(hp, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeHistory(fileName, entries) {
  const hp = historyFilePath(fileName);
  fs.writeFileSync(hp, JSON.stringify(entries, null, 2), 'utf8');
}

function appendHistory(fileName, entry) {
  const items = readHistory(fileName);
  items.unshift(entry);
  writeHistory(fileName, items.slice(0, 200));
}

function createHistoryEntry({ fileName, previousContent, userName, mode }) {
  return {
    id: crypto.randomUUID(),
    fileName,
    savedAt: new Date().toISOString(),
    savedBy: String(userName || 'Inconnu'),
    mode: String(mode || 'unknown'),
    previousContent: String(previousContent ?? '')
  };
}

function upsertPersonalBlock(rawContent, userName, personalContent) {
  const raw = String(rawContent ?? '').replace(/\r/g, '');
  const user = String(userName).trim();
  const inner = String(personalContent ?? '').replace(/\r/g, '').trimEnd();

  const block = `{pu:${user}}\n${inner}\n{/pu}`;
  const re = new RegExp(`\\{pu\\s*:\\s*${escapeRegExp(user)}\\s*\\}([\\s\\S]*?)\\{\\/pu\\s*\\}`, 'i');

  if (re.test(raw)) {
    return raw.replace(re, block);
  }

  const trimmed = raw.trimEnd();
  return `${trimmed}\n\n${block}\n`;
}

function extractPersonalBlock(rawContent, userName) {
  const raw = String(rawContent ?? '').replace(/\r/g, '');
  const user = String(userName).trim();
  const re = new RegExp(`\\{pu\\s*:\\s*${escapeRegExp(user)}\\s*\\}([\\s\\S]*?)\\{\\/pu\\s*\\}`, 'i');
  const m = raw.match(re);
  return m ? String(m[1] || '').replace(/^\n/, '').replace(/\n$/, '') : '';
}

function broadcastConnectedUsers() {
  const uniqueUsers = [...new Set(
    [...connectedUsers.values()]
      .map(v => String(v || '').trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));

  io.emit('connected-users', { users: uniqueUsers });
}

function broadcastLeaderState() {
  io.emit('leader-state', {
    leaderSocketId,
    leaderUserName,
    hasLeader: !!leaderSocketId
  });
}

app.get('/list-songs', (req, res) => {
  try {
    const files = fs.readdirSync(PARTITIONS_DIR);
    const songs = files.filter(f => {
      const lf = f.toLowerCase();
      return lf.endsWith('.pro') || lf.endsWith('.cho');
    });
    res.json(songs);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.get('/song-personal-block', (req, res) => {
  try {
    const fileName = String(req.query.fileName || '');
    const userName = String(req.query.userName || '');

    if (!isValidSongName(fileName)) {
      return res.status(400).json({ error: 'Nom de fichier invalide' });
    }

    if (!isValidUserName(userName)) {
      return res.status(400).json({ error: 'Utilisateur invalide' });
    }

    const raw = readSong(fileName);
    const personalContent = extractPersonalBlock(raw, userName);
    res.json({ personalContent });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

app.get('/song-history', (req, res) => {
  try {
    const fileName = String(req.query.fileName || '');
    if (!isValidSongName(fileName)) {
      return res.status(400).json([]);
    }

    const items = readHistory(fileName).map(entry => ({
      id: entry.id,
      savedAt: entry.savedAt,
      savedBy: entry.savedBy,
      mode: entry.mode
    }));

    res.json(items);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.post('/restore-song', (req, res) => {
  try {
    const { fileName, historyId, pin, userName } = req.body || {};

    if (!pinOk(pin)) return res.status(403).send("PIN invalide");
    if (!isValidSongName(fileName)) return res.status(400).send("Nom de fichier invalide");
    if (!historyId) return res.status(400).send("Historique invalide");

    const history = readHistory(fileName);
    const entry = history.find(x => x.id === historyId);
    if (!entry) return res.status(404).send("Version introuvable");

    const currentContent = readSong(fileName);

    appendHistory(fileName, createHistoryEntry({
      fileName,
      previousContent: currentContent,
      userName: userName || 'Leader',
      mode: `restore:${entry.savedAt}`
    }));

    writeSong(fileName, entry.previousContent);

    io.emit('song-updated', { fileName, at: Date.now() });
    res.send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send("Erreur");
  }
});

app.post('/save-song', (req, res) => {
  try {
    const { fileName, content, pin, mode, userName } = req.body || {};

    if (!isValidSongName(fileName)) {
      return res.status(400).send("Nom de fichier invalide");
    }

    const currentContent = readSong(fileName);

    if (mode === 'full') {
      if (!pinOk(pin)) return res.status(403).send("PIN invalide");
      if (typeof content !== 'string') return res.status(400).send("Contenu invalide");

      appendHistory(fileName, createHistoryEntry({
        fileName,
        previousContent: currentContent,
        userName: userName || 'Leader',
        mode: 'full'
      }));

      writeSong(fileName, content);
      io.emit('song-updated', { fileName, at: Date.now() });
      return res.send("OK");
    }

    if (mode === 'personal') {
      if (!isValidUserName(userName)) {
        return res.status(400).send("Utilisateur invalide");
      }
      if (typeof content !== 'string') {
        return res.status(400).send("Contenu invalide");
      }

      const updatedContent = upsertPersonalBlock(currentContent, userName, content);

      appendHistory(fileName, createHistoryEntry({
        fileName,
        previousContent: currentContent,
        userName,
        mode: `personal:${userName}`
      }));

      writeSong(fileName, updatedContent);
      io.emit('song-updated', { fileName, at: Date.now() });
      return res.send("OK");
    }

    return res.status(400).send("Mode invalide");
  } catch (err) {
    console.error(err);
    res.status(500).send("Erreur");
  }
});

io.on('connection', (socket) => {
  console.log('📱 connecté', socket.id);

  broadcastLeaderState();
  broadcastConnectedUsers();

  socket.on('register-user', (userName) => {
    const clean = String(userName || '').trim();
    if (!clean) return;

    socket.data.userName = clean;
    connectedUsers.set(socket.id, clean);

    if (leaderSocketId === socket.id) {
      leaderUserName = clean;
    }

    broadcastConnectedUsers();
    broadcastLeaderState();
  });

  socket.on('request-leader', () => {
    if (!leaderSocketId || leaderSocketId === socket.id) {
      leaderSocketId = socket.id;
      leaderUserName = socket.data.userName || "Leader";
      broadcastLeaderState();
    } else {
      socket.emit('leader-denied', { leaderUserName });
    }
  });

  socket.on('release-leader', () => {
    if (leaderSocketId === socket.id) {
      leaderSocketId = null;
      leaderUserName = "";
      broadcastLeaderState();
      io.emit('apply-autoscroll', { active: false, speed: 50 });
    }
  });

  socket.on('change-song', (fileName) => {
    io.emit('load-song', fileName);
  });

  let lastScrollAt = 0;
  socket.on('scroll-sync', (payload) => {
    const now = Date.now();
    if (now - lastScrollAt < 60) return;
    lastScrollAt = now;

    const anchor = String(payload?.anchor || "");
    const progress = Math.max(0, Math.min(1, Number(payload?.progress) || 0));

    socket.broadcast.emit('apply-scroll', { anchor, progress });
  });

  socket.on('sync-autoscroll', (d) => {
    socket.broadcast.emit('apply-autoscroll', {
      active: !!d.active,
      speed: d.speed
    });
  });

  socket.on('leader-fontsize', (value) => {
    socket.broadcast.emit('apply-fontsize', value);
  });

  socket.on('leader-transpose', (value) => {
    socket.broadcast.emit('apply-transpose', value);
  });

  socket.on('leader-speed', (value) => {
    socket.broadcast.emit('apply-speed', value);
  });

  socket.on('disconnect', () => {
    console.log('❌ déconnecté', socket.id);

    const wasLeader = leaderSocketId === socket.id;

    connectedUsers.delete(socket.id);
    broadcastConnectedUsers();

    if (wasLeader) {
      leaderSocketId = null;
      leaderUserName = "";
      broadcastLeaderState();
      io.emit('apply-autoscroll', { active: false, speed: 50 });
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log("✅ Serveur en ligne sur le port " + PORT);
  console.log("🔐 PIN global:", LEADER_PIN);
});
