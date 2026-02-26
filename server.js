const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');

app.use(express.json());

// Anti-cache simple
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static('public', { etag: false, maxAge: 0 }));

const PARTITIONS_DIR = path.join(__dirname, 'public', 'partitions');
const LEADER_PIN = String(process.env.LEADER_PIN || '1991'); // <-- mets 1991 ici

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

function cleanSessionId(s) {
  const v = String(s || '').trim();
  if (!v) return 'default';
  return v.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'default';
}

// Lister les morceaux
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

// Sauvegarder (protégé PIN) + émission dans la room
app.post('/save-song', (req, res) => {
  const { fileName, content, pin, sessionId } = req.body;

  if (!pinOk(pin)) return res.status(403).send("PIN invalide");
  if (!isValidSongName(fileName)) return res.status(400).send("Nom de fichier invalide");

  const filePath = path.join(PARTITIONS_DIR, fileName);
  if (!filePath.startsWith(PARTITIONS_DIR + path.sep)) {
    return res.status(400).send("Chemin invalide");
  }

  const room = cleanSessionId(sessionId);

  fs.writeFile(filePath, String(content ?? ""), 'utf8', (err) => {
    if (err) return res.status(500).send("Erreur");

    io.to(room).emit('song-updated', { fileName, at: Date.now() });
    res.send("OK");
  });
});

io.on('connection', (socket) => {
  console.log('📱 connecté', socket.id);

  socket.data.room = 'default';

  socket.on('join-session', ({ sessionId }) => {
    const room = cleanSessionId(sessionId);
    socket.leave(socket.data.room);
    socket.join(room);
    socket.data.room = room;

    console.log('🔗', socket.id, '-> room', room);
    socket.emit('session-joined', { room });
  });

  function requirePin(payload, cb) {
    const ok = pinOk(payload && payload.pin);
    if (!ok) {
      if (typeof cb === 'function') cb({ ok: false, error: 'PIN invalide' });
      return false;
    }
    return true;
  }

  // Changement de morceau (dans la room)
  socket.on('change-song', (payload, cb) => {
    if (!requirePin(payload, cb)) return;
    io.to(socket.data.room).emit('load-song', payload.fileName);
    if (typeof cb === 'function') cb({ ok: true });
  });

  // Option A : synchro par position uniquement (throttle)
  let lastScrollAt = 0;
  socket.on('scroll-sync', (payload, cb) => {
    if (!requirePin(payload, cb)) return;

    const now = Date.now();
    if (now - lastScrollAt < 60) return; // un peu plus fluide
    lastScrollAt = now;

    const pos = Math.max(0, Math.min(1, Number(payload.pos) || 0));
    socket.to(socket.data.room).emit('apply-scroll', pos);
    if (typeof cb === 'function') cb({ ok: true });
  });

  // Etat play/pause du leader (Option A: les followers ne scrolleront pas seuls)
  socket.on('sync-autoscroll', (payload, cb) => {
    if (!requirePin(payload, cb)) return;
    socket.to(socket.data.room).emit('apply-autoscroll', { active: !!payload.active });
    if (typeof cb === 'function') cb({ ok: true });
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log("✅ Serveur en ligne sur le port " + PORT);
  console.log("🔐 PIN leader:", LEADER_PIN);
});
