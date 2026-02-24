const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');

app.use(express.static('public'));
app.use(express.json());

// Lister les morceaux
app.get('/list-songs', (req, res) => {
    const dirPath = path.join(__dirname, 'public', 'partitions');
    try {
        const files = fs.readdirSync(dirPath);
        const songs = files.filter(f => f.toLowerCase().endsWith('.pro') || f.toLowerCase().endsWith('.cho'));
        res.json(songs);
    } catch (err) { res.status(500).json([]); }
});

// Sauvegarder les modifs (via éditeur)
app.post('/save-song', (req, res) => {
    const { fileName, content } = req.body;
    const filePath = path.join(__dirname, 'public', 'partitions', fileName);
    fs.writeFile(filePath, content, 'utf8', (err) => {
        if (err) return res.status(500).send("Erreur");
        res.send("OK");
    });
});

io.on('connection', (socket) => {
    console.log('📱 Appareil connecté');

    socket.on('change-song', (f) => io.emit('load-song', f));
    socket.on('scroll-sync', (p) => socket.broadcast.emit('apply-scroll', p));
    socket.on('sync-font', (s) => socket.broadcast.emit('apply-font', s));
    socket.on('sync-transpose', (v) => socket.broadcast.emit('apply-transpose', v));
    socket.on('sync-autoscroll', (d) => socket.broadcast.emit('apply-autoscroll', d));
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log("✅ Serveur en ligne sur le port " + PORT);
});