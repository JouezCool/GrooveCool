const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');

app.use(express.json());

// Anti-cache simple (évite index.html pas à jour)
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static('public', { etag: false, maxAge: 0 }));

const PARTITIONS_DIR = path.join(__dirname, 'public', 'partitions');
const LEADER_PIN = String(process.env.LEADER_PIN || '1234'); // <-- change si tu veux

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

// Sauvegarder (protégé PIN)
app.post('/save-song', (req, res) => {
  const { fileName, content, pin } = req.body;

  if (!pinOk(pin)) {
    return res.status(403).send("PIN invalide");
  }
  if (!isValidSongName(fileName)) {
    return res.status(400).send("Nom de fichier invalide");
  }

  const filePath = path.join(PARTITIONS_DIR, fileName);
  if (!filePath.startsWith(PARTITIONS_DIR + path.sep)) {
    return res.status(400).send("Chemin invalide");
  }

  fs.writeFile(filePath, String(content ?? ""), 'utf8', (err) => {
    if (err) return res.status(500).send("Erreur");

    io.emit('song-updated', { fileName, at: Date.now() });
    res.send("OK");
  });
});

io.on('connection', (socket) => {
  console.log('📱 Appareil connecté', socket.id, '| clients:', io.engine.clientsCount);

  socket.on('disconnect', () => {
    console.log('📴 Appareil déconnecté', socket.id, '| clients:', io.engine.clientsCount);
  });

  // helper : vérif PIN sur events sensibles
  function requirePin(payload, cb) {
    const pin = payload && payload.pin;
    const ok = pinOk(pin);
    if (!ok) {
      if (typeof cb === 'function') cb({ ok: false, error: 'PIN invalide' });
      return false;
    }
    return true;
  }

  socket.on('change-song', (payload, cb) => {
    // payload: { fileName, pin }
    if (!requirePin(payload, cb)) return;
    io.emit('load-song', payload.fileName);
    if (typeof cb === 'function') cb({ ok: true });
  });

  // scroll-sync (protégé + throttle)
  let lastScrollAt = 0;
  socket.on('scroll-sync', (payload, cb) => {
    // payload: { pos, pin }
    if (!requirePin(payload, cb)) return;

    const now = Date.now();
    if (now - lastScrollAt < 80) return;
    lastScrollAt = now;

    const pos = Math.max(0, Math.min(1, Number(payload.pos) || 0));
    socket.broadcast.emit('apply-scroll', pos);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('sync-font', (payload, cb) => {
    // payload: { fontSize, pin }
    if (!requirePin(payload, cb)) return;
    socket.broadcast.emit('apply-font', payload.fontSize);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('sync-transpose', (payload, cb) => {
    // payload: { transposeValue, pin }
    if (!requirePin(payload, cb)) return;
    socket.broadcast.emit('apply-transpose', payload.transposeValue);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('sync-autoscroll', (payload, cb) => {
    // payload: { active, speed, pin }
    if (!requirePin(payload, cb)) return;
    socket.broadcast.emit('apply-autoscroll', { active: !!payload.active, speed: payload.speed });
    if (typeof cb === 'function') cb({ ok: true });
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log("✅ Serveur en ligne sur le port " + PORT);
  console.log("🔐 PIN leader:", LEADER_PIN);
});
