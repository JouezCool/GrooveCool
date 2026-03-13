const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SONG_META_FILE = path.join(__dirname, 'public', 'song-meta.json');

const playedTonight = new Set();

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static('public', { etag: false, maxAge: 0 }));

const PARTITIONS_DIR = path.join(__dirname, 'public', 'partitions');
const HISTORY_DIR = path.join(__dirname, 'history');
const SONG_SETTINGS_DIR = path.join(__dirname, 'song-settings');
const LEADER_PIN = String(process.env.LEADER_PIN || '1991');

fs.mkdirSync(PARTITIONS_DIR, { recursive: true });
fs.mkdirSync(HISTORY_DIR, { recursive: true });
fs.mkdirSync(SONG_SETTINGS_DIR, { recursive: true });
if (!fs.existsSync(SONG_META_FILE)) {
  fs.writeFileSync(SONG_META_FILE, '{}', 'utf8');
}

let leaderSocketId = null;
let leaderUserName = null;
let leaderDeviceId = null;

const connectedUsers = new Map();

function isValidSongName(name) {
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  if (!(lower.endsWith('.pro') || lower.endsWith('.cho'))) return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  if (name.length > 120) return false;
  return true;
}

function pinOk(pin) {
  return String(pin || '') === LEADER_PIN;
}

function getSongPath(fileName) {
  const filePath = path.join(PARTITIONS_DIR, fileName);
  if (!filePath.startsWith(PARTITIONS_DIR + path.sep)) {
    throw new Error("Chemin invalide");
  }
  return filePath;
}

function historyFilePath(fileName) {
  const safe = Buffer.from(fileName, 'utf8').toString('base64url');
  return path.join(HISTORY_DIR, safe + '.json');
}

function settingsFilePath(fileName) {
  const safe = Buffer.from(fileName, 'utf8').toString('base64url');
  return path.join(SONG_SETTINGS_DIR, safe + '.json');
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
  writeHistory(fileName, items.slice(0, 50));
}

function createHistoryEntry({ fileName, previousContent, userName }) {
  return {
    id: crypto.randomUUID(),
    fileName,
    savedAt: new Date().toISOString(),
    savedBy: String(userName || 'Inconnu'),
    previousContent: String(previousContent ?? '')
  };
}

function readSongSettings(fileName) {
  const fp = settingsFilePath(fileName);
  if (!fs.existsSync(fp)) {
    return {
      fontSize: 26,
      speed: 50,
      transpose: 0
    };
  }

  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const data = JSON.parse(raw);

    return {
      fontSize: Number.isFinite(Number(data.fontSize)) ? Number(data.fontSize) : 26,
      speed: Number.isFinite(Number(data.speed)) ? Number(data.speed) : 50,
      transpose: Number.isFinite(Number(data.transpose)) ? Number(data.transpose) : 0
    };
  } catch {
    return {
      fontSize: 26,
      speed: 50,
      transpose: 0
    };
  }
}

function writeSongSettings(fileName, settings) {
  const fp = settingsFilePath(fileName);

  const clean = {
    fontSize: Number.isFinite(Number(settings.fontSize)) ? Number(settings.fontSize) : 26,
    speed: Number.isFinite(Number(settings.speed)) ? Number(settings.speed) : 50,
    transpose: Number.isFinite(Number(settings.transpose)) ? Number(settings.transpose) : 0
  };

  fs.writeFileSync(fp, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

function readSongMeta() {
  try {
    if (!fs.existsSync(SONG_META_FILE)) return {};
    const raw = fs.readFileSync(SONG_META_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeSongMeta(meta) {
  fs.writeFileSync(SONG_META_FILE, JSON.stringify(meta, null, 2), 'utf8');
  console.log("✅ song-meta.json mis à jour :", SONG_META_FILE);
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map(v => String(v || '').trim())
      .filter(Boolean);
  }

  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function normalizeSongMetaEntry(payload) {
  return {
    title: String(payload?.title || '').trim(),
    artist: String(payload?.artist || '').trim(),
    category: String(payload?.category || 'Répertoire').trim() || 'Répertoire',
    style: normalizeStringArray(payload?.style),
    ambiance: String(payload?.ambiance || '').trim(),
    audience: normalizeStringArray(payload?.audience),
    chanteur: normalizeStringArray(payload?.chanteur)
  };
}

function broadcastConnectedUsers() {
  const uniqueUsers = [...new Set(
    [...connectedUsers.values()]
      .map(v => String(v?.userName || '').trim())
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

function broadcastPlayedTonight() {
  io.emit('played-tonight-state', {
    songs: [...playedTonight]
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
    console.error(err);
    res.status(500).json([]);
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
      savedBy: entry.savedBy
    }));

    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

app.get('/song-settings', (req, res) => {
  try {
    const fileName = String(req.query.fileName || '');
    if (!isValidSongName(fileName)) {
      return res.status(400).json({
        fontSize: 26,
        speed: 50,
        transpose: 0
      });
    }

    res.json(readSongSettings(fileName));
  } catch (err) {
    console.error(err);
    res.status(500).json({
      fontSize: 26,
      speed: 50,
      transpose: 0
    });
  }
});

app.get('/song-meta-entry', (req, res) => {
  try {
    const fileName = String(req.query.fileName || '');
    if (!isValidSongName(fileName)) {
      return res.status(400).json({});
    }

    const meta = readSongMeta();
    res.json(meta[fileName] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({});
  }
});

app.post('/song-settings', (req, res) => {
  try {
    const { fileName, pin, fontSize, speed, transpose } = req.body || {};

    if (!pinOk(pin)) return res.status(403).send("PIN invalide");
    if (!isValidSongName(fileName)) return res.status(400).send("Nom de fichier invalide");

    const saved = writeSongSettings(fileName, {
      fontSize,
      speed,
      transpose
    });

    io.emit('song-settings-updated', {
      fileName,
      settings: saved
    });

    res.json(saved);
  } catch (err) {
    console.error(err);
    res.status(500).send("Erreur");
  }
});

app.post('/restore-song', (req, res) => {
  try {
    const { fileName, historyId, pin, userName } = req.body || {};

    if (!pinOk(pin)) return res.status(403).send("PIN invalide");
    if (!isValidSongName(fileName)) return res.status(400).send("Nom de fichier invalide");
    if (!historyId) return res.status(400).send("Version invalide");

    const filePath = getSongPath(fileName);
    const history = readHistory(fileName);
    const entry = history.find(x => x.id === historyId);

    if (!entry) {
      return res.status(404).send("Version introuvable");
    }

    let currentContent = "";
    if (fs.existsSync(filePath)) {
      currentContent = fs.readFileSync(filePath, 'utf8');
    }

    appendHistory(fileName, createHistoryEntry({
      fileName,
      previousContent: currentContent,
      userName: userName || 'Restauration'
    }));

    fs.writeFileSync(filePath, String(entry.previousContent ?? ""), 'utf8');

    io.emit('song-updated', { fileName, at: Date.now() });
    res.send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send("Erreur");
  }
});

app.post('/save-song', (req, res) => {
  const { fileName, content, pin, userName } = req.body || {};

  if (!pinOk(pin)) return res.status(403).send("PIN invalide");
  if (!isValidSongName(fileName)) return res.status(400).send("Nom de fichier invalide");

  try {
    const filePath = getSongPath(fileName);

    let previousContent = "";
    if (fs.existsSync(filePath)) {
      previousContent = fs.readFileSync(filePath, 'utf8');
    }

    appendHistory(fileName, createHistoryEntry({
      fileName,
      previousContent,
      userName: userName || 'Inconnu'
    }));

    fs.writeFile(filePath, String(content ?? ""), 'utf8', (err) => {
      if (err) return res.status(500).send("Erreur");

      io.emit('song-updated', { fileName, at: Date.now() });
      res.send("OK");
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Erreur");
  }
});

app.post('/save-song-meta', (req, res) => {
  try {
    const { fileName, pin } = req.body || {};

    if (!pinOk(pin)) return res.status(403).send("PIN invalide");
    if (!isValidSongName(fileName)) return res.status(400).send("Nom de fichier invalide");

    const meta = readSongMeta();
    meta[fileName] = normalizeSongMetaEntry(req.body || {});
    writeSongMeta(meta);

    res.send("OK");
  } catch (err) {
    console.error("Erreur save-song-meta:", err);
    res.status(500).send("Erreur");
  }
});

app.post('/create-song', (req, res) => {
  try {
    const {
      fileName,
      pin,
      title,
      artist,
      category,
      style,
      ambiance,
      audience,
      chanteur
    } = req.body || {};

    if (!pinOk(pin)) return res.status(403).send("PIN invalide");

    const cleanTitle = String(title || '').trim();
    const cleanArtist = String(artist || '').trim();

    if (!cleanTitle) return res.status(400).send("Titre invalide");
    if (!cleanArtist) return res.status(400).send("Artiste invalide");

    const finalFileName = String(fileName || `${cleanTitle} - ${cleanArtist}.pro`).trim();

    if (!isValidSongName(finalFileName)) {
      return res.status(400).send("Nom de fichier invalide");
    }

    const filePath = getSongPath(finalFileName);

    if (fs.existsSync(filePath)) {
      return res.status(409).send("Le morceau existe déjà");
    }

    const defaultContent =
      `{t:${cleanTitle}}\n` +
      `{st:${cleanArtist}}\n\n`;

    fs.writeFileSync(filePath, defaultContent, 'utf8');

    const meta = readSongMeta();
    meta[finalFileName] = normalizeSongMetaEntry({
      title: cleanTitle,
      artist: cleanArtist,
      category,
      style,
      ambiance,
      audience,
      chanteur
    });
    writeSongMeta(meta);

    io.emit('song-created', { fileName: finalFileName, at: Date.now() });
    res.send("OK");
  } catch (err) {
    console.error("Erreur create-song:", err);
    res.status(500).send("Erreur");
  }
});

io.on('connection', (socket) => {
  console.log('📱 connecté', socket.id);

  broadcastLeaderState();
  broadcastConnectedUsers();
  broadcastPlayedTonight();

  socket.on('register-user', ({ userName, deviceId }) => {
    const cleanUser = String(userName || '').trim();
    const cleanDeviceId = String(deviceId || '').trim();

    if (!cleanUser || !cleanDeviceId) return;

    socket.data.userName = cleanUser;
    socket.data.deviceId = cleanDeviceId;

    connectedUsers.set(socket.id, {
      userName: cleanUser,
      deviceId: cleanDeviceId
    });

    if (leaderDeviceId && cleanDeviceId === leaderDeviceId) {
      leaderSocketId = socket.id;
      leaderUserName = cleanUser;
    }

    broadcastConnectedUsers();
    broadcastLeaderState();
  });

  socket.on('mark-played', ({ fileName, played }) => {
    const name = String(fileName || '').trim();
    if (!name) return;

    if (played) {
      playedTonight.add(name);
    } else {
      playedTonight.delete(name);
    }

    broadcastPlayedTonight();
  });

  socket.on('reset-played-tonight', () => {
    playedTonight.clear();
    broadcastPlayedTonight();
  });

  socket.on('request-leader', () => {
    const deviceId = String(socket.data.deviceId || '').trim();
    const userName = String(socket.data.userName || 'Leader').trim();

    if (!deviceId) return;

    if (!leaderDeviceId || leaderDeviceId === deviceId || !leaderSocketId) {
      leaderSocketId = socket.id;
      leaderDeviceId = deviceId;
      leaderUserName = userName;
      broadcastLeaderState();
    } else {
      socket.emit('leader-denied', { leaderUserName });
    }
  });

  socket.on('release-leader', () => {
    if (leaderSocketId === socket.id) {
      leaderSocketId = null;
      leaderDeviceId = null;
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
