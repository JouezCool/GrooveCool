const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');

app.use(express.static('public'));
app.use(express.json());

const PARTITIONS_DIR = path.join(__dirname, 'public', 'partitions');

// --- Helpers sécurité ---
function isValidSongName(name) {
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();

  // extensions autorisées
  if (!(lower.endsWith('.pro') || lower.endsWith('.cho'))) return false;

  // bloque tout chemin / traversal
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;

  // optionnel : limite la longueur
  if (name.length > 120) return false;

  return true;
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

// Sauvegarder les modifs (via éditeur)
app.post('/save-song', (req, res) => {
  const { fileName, content } = req.body;

  if (!isValidSongName(fileName)) {
    return res.status(400).send("Nom de fichier invalide");
  }

  const filePath = path.join(PARTITIONS_DIR, fileName);

  // sécurité supplémentaire : garantit que filePath reste bien dans PARTITIONS_DIR
  if (!filePath.startsWith(PARTITIONS_DIR + path.sep)) {
    return res.status(400).send("Chemin invalide");
  }

  fs.writeFile(filePath, String(content ?? ""), 'utf8', (err) => {
    if (err) return res.status(500).send("Erreur");
    res.send("OK");
  });
});

io.on('connection', (socket) => {
  console.log('📱 Appareil connecté');

  socket.on('change-song', (f) => io.emit('load-song', f));

  // Throttle serveur pour éviter le spam réseau
  let lastScrollAt = 0;
  socket.on('scroll-sync', (p) => {
    const now = Date.now();
    if (now - lastScrollAt < 80) return; // ~12.5/s max
    lastScrollAt = now;

    const pos = Math.max(0, Math.min(1, Number(p) || 0));
    socket.broadcast.emit('apply-scroll', pos);
  });

  socket.on('sync-font', (s) => socket.broadcast.emit('apply-font', s));
  socket.on('sync-transpose', (v) => socket.broadcast.emit('apply-transpose', v));
  socket.on('sync-autoscroll', (d) => socket.broadcast.emit('apply-autoscroll', d));
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log("✅ Serveur en ligne sur le port " + PORT);
});
