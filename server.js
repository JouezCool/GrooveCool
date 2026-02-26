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
const LEADER_PIN = String(process.env.LEADER_PIN || '1991'); // ton PIN

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

// Sauvegarder (PIN requis) + broadcast update
app.post('/save-song', (req, res) => {
  const { fileName, content, pin } = req.body;

  if (!pinOk(pin)) return res.status(403).send("PIN invalide");
  if (!isValidSongName(fileName)) return res.status(400).send("Nom de fichier invalide");

  const filePath = path.join(PARTITIONS_DIR, fileName);
  if (!filePath.startsWith(PARTITIONS_DIR + path.sep)) {
    return res.status(400).send("Chemin invalide");
  }

  fs.writeFile(filePath, String(content ?? ""), 'utf8', (err) => {
    if (err) return res.status(500).send("Erreur");

    // Prévenir tous les appareils qu’une nouvelle version existe
    io.emit('song-updated', { fileName, at: Date.now() });
    res.send("OK");
  });
});

io.on('connection', (socket) => {
  console.log('📱 connecté', socket.id);

  // Synchro sans PIN côté socket (comme ton code)
  socket.on('change-song', (fileName) => {
    io.emit('load-song', fileName);
  });

  let lastScrollAt = 0;
  socket.on('scroll-sync', (pos) => {
    const now = Date.now();
    if (now - lastScrollAt < 60) return;
    lastScrollAt = now;

    const p = Math.max(0, Math.min(1, Number(pos) || 0));
    socket.broadcast.emit('apply-scroll', p);
  });

  socket.on('sync-autoscroll', (d) => {
    socket.broadcast.emit('apply-autoscroll', { active: !!d.active, speed: d.speed });
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log("✅ Serveur en ligne sur le port " + PORT);
  console.log("🔐 PIN global:", LEADER_PIN);
});