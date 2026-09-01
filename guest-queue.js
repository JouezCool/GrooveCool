// Fonctionnalite "file d'attente karaoke" pour le public : les invites
// scannent un QR code, arrivent sur /guest.html (page publique, sans mot de
// passe), choisissent un morceau tague "Karaoke" et donnent leur prenom.
// Leur demande atterrit dans une file en memoire, visible et geree par le
// Leader/Turn dans l'appli principale (panneau "File d'attente karaoke").
//
// Volontairement isole dans ce fichier a part : aucune des routes ou
// fonctions existantes de server.js n'est modifiee, seules quelques lignes
// de branchement sont ajoutees dans server.js (voir registerGuestQueue).
//
// Etat 100% en memoire (comme le reste de la synchro temps reel de l'appli,
// ex. connectedUsers/leadersByDeviceId) : pas d'ecriture sur Google Drive,
// la file est perdue si le serveur redemarre ou se met en veille (Render
// gratuit), ce qui est un choix assume pour une fonctionnalite de soiree.

const crypto = require('crypto');

const KARAOKE_TAG = 'Karaoké';
const MAX_NAME_LENGTH = 40;
// Garde-fou anti-abus, tres largement au-dessus d'un usage normal de
// soiree (pas une vraie limite fonctionnelle).
const MAX_QUEUE_SIZE = 200;

// Chemins publics (sans mot de passe) que server.js doit ajouter a
// AUTH_OPEN_PATHS pour que requireAuth les laisse passer.
const GUEST_QUEUE_OPEN_PATHS = ['/guest.html', '/guest/songs', '/guest/join'];

function registerGuestQueue(app, io, { isValidSongName, listDriveSongs, readSongMeta }) {
  let queue = [];

  function isKaraokeAudience(audience) {
    return Array.isArray(audience) && audience.some(
      v => String(v || '').trim().toLowerCase() === KARAOKE_TAG.toLowerCase()
    );
  }

  function songDisplayInfo(fileName, meta) {
    const entry = meta?.[fileName];
    const title = String(entry?.title || '').trim();
    const artist = String(entry?.artist || '').trim();
    if (title) return { title, artist };

    // Repli simple si le morceau n'a pas encore de titre/artiste curated
    // dans song-meta.json (meme limite connue que cote client pour les
    // noms de fichiers avec un prefixe de code de set-list).
    const base = fileName.replace(/\.(pro|cho)$/i, '');
    const parts = base.split(' - ');
    return { title: parts[0] || base, artist: parts.slice(1).join(' - ') };
  }

  function publicQueueEntry(entry) {
    return {
      id: entry.id,
      name: entry.name,
      songFileName: entry.songFileName,
      songTitle: entry.songTitle,
      songArtist: entry.songArtist,
      at: entry.at
    };
  }

  function broadcastQueue() {
    io.emit('guest-queue-updated', queue.map(publicQueueEntry));
  }

  // Liste des morceaux proposes aux invites (page publique /guest.html) :
  // uniquement ceux tagues Audience "Karaoke" dans l'editeur d'infos.
  app.get('/guest/songs', async (req, res) => {
    try {
      const [songs, meta] = await Promise.all([listDriveSongs(), readSongMeta()]);

      const karaokeSongs = songs
        .filter(fileName => isKaraokeAudience(meta?.[fileName]?.audience))
        .map(fileName => {
          const { title, artist } = songDisplayInfo(fileName, meta);
          return { fileName, title, artist };
        })
        .sort((a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }));

      res.json(karaokeSongs);
    } catch (err) {
      console.error('❌ Erreur /guest/songs:', err);
      res.status(500).json([]);
    }
  });

  // Inscription d'un invite dans la file. Route publique : on ne fait
  // confiance a rien de ce qu'envoie le client, tout est revalide ici.
  app.post('/guest/join', async (req, res) => {
    try {
      const deviceId = String(req.body?.deviceId || '').trim();
      const name = String(req.body?.name || '').trim().slice(0, MAX_NAME_LENGTH);
      const songFileName = String(req.body?.songFileName || '').trim();

      if (!deviceId) return res.status(400).json({ error: 'device_manquant' });
      if (!name) return res.status(400).json({ error: 'nom_manquant' });
      if (!isValidSongName(songFileName)) return res.status(400).json({ error: 'morceau_invalide' });

      const meta = await readSongMeta();
      if (!isKaraokeAudience(meta?.[songFileName]?.audience)) {
        return res.status(400).json({ error: 'morceau_non_karaoke' });
      }

      // Une seule demande active a la fois par appareil (voir deviceId
      // cote guest.html) : evite qu'une meme personne monopolise la file.
      if (queue.some(e => e.deviceId === deviceId)) {
        return res.status(409).json({ error: 'deja_en_attente' });
      }

      if (queue.length >= MAX_QUEUE_SIZE) {
        return res.status(429).json({ error: 'file_pleine' });
      }

      const { title, artist } = songDisplayInfo(songFileName, meta);

      queue.push({
        id: crypto.randomUUID(),
        deviceId,
        name,
        songFileName,
        songTitle: title,
        songArtist: artist,
        at: Date.now()
      });

      broadcastQueue();
      res.json({ ok: true });
    } catch (err) {
      console.error('❌ Erreur /guest/join:', err);
      res.status(500).json({ error: 'erreur_serveur' });
    }
  });

  // Etat actuel de la file, consulte par l'appli principale (Leader/Turn)
  // au chargement. Route deja protegee par requireAuth (comme le reste de
  // l'appli) puisqu'elle n'est pas dans GUEST_QUEUE_OPEN_PATHS.
  app.get('/guest-queue', (req, res) => {
    res.json(queue.map(publicQueueEntry));
  });

  // Retrait d'une demande (ex: une fois la personne appelee sur scene).
  // Reservee de fait au Leader/Turn cote UI, mais accessible a tout membre
  // connecte a l'appli (comme les autres actions courantes non sensibles) ;
  // pas de PIN requis.
  app.post('/guest-queue/remove', (req, res) => {
    const id = String(req.body?.id || '');
    const before = queue.length;
    queue = queue.filter(e => e.id !== id);
    if (queue.length !== before) broadcastQueue();
    res.json({ ok: true });
  });
}

module.exports = { registerGuestQueue, GUEST_QUEUE_OPEN_PATHS };
