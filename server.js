const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const crypto = require('crypto');
const { google } = require('googleapis');
const { Readable } = require('stream');

const GOOGLE_DRIVE_PARTITIONS_FOLDER_ID = process.env.GOOGLE_DRIVE_PARTITIONS_FOLDER_ID || '';
const GOOGLE_DRIVE_META_FOLDER_ID = process.env.GOOGLE_DRIVE_META_FOLDER_ID || '';
const GOOGLE_DRIVE_HISTORY_FOLDER_ID = process.env.GOOGLE_DRIVE_HISTORY_FOLDER_ID || '';
const GOOGLE_DRIVE_SONG_SETTINGS_FOLDER_ID = process.env.GOOGLE_DRIVE_SONG_SETTINGS_FOLDER_ID || '';
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || '';
const GOOGLE_OAUTH_SCOPES = (process.env.GOOGLE_OAUTH_SCOPES || 'https://www.googleapis.com/auth/drive')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const LEADER_PIN = String(process.env.LEADER_PIN || '1991');
const OAUTH_TOKENS_FILE_NAME = 'oauth-tokens.json';

const auth = new google.auth.JWT(
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY,
  ['https://www.googleapis.com/auth/drive']
);

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URI
);

let oauthTokens = null;

function getDriveClient() {
  if (oauthTokens && oauthTokens.access_token) {
    oauth2Client.setCredentials(oauthTokens);
    console.log('🔐 Drive client = OAUTH USER');
    return google.drive({
      version: 'v3',
      auth: oauth2Client
    });
  }

  console.log('🔐 Drive client = SERVICE ACCOUNT');
  return google.drive({
    version: 'v3',
    auth
  });
}

const playedTonight = new Set();
const connectedUsers = new Map();

let leaderSocketId = null;
let leaderUserName = null;
let leaderDeviceId = null;

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static('public', { etag: false, maxAge: 0 }));

function pinOk(pin) {
  return String(pin || '') === LEADER_PIN;
}

function isValidSongName(name) {
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  if (!(lower.endsWith('.pro') || lower.endsWith('.cho'))) return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  if (name.length > 180) return false;
  return true;
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

function historyFileName(fileName) {
  const safe = Buffer.from(fileName, 'utf8').toString('base64url');
  return `${safe}.json`;
}

function settingsFileName(fileName) {
  const safe = Buffer.from(fileName, 'utf8').toString('base64url');
  return `${safe}.json`;
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

function escapeDriveQueryValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

async function findDriveFileByName(folderId, fileName) {
  const drive = getDriveClient();
  if (!folderId) return null;

  const q = [
    `'${folderId}' in parents`,
    `name = '${escapeDriveQueryValue(fileName)}'`,
    `trashed = false`
  ].join(' and ');

  const res = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType, createdTime, modifiedTime)',
    pageSize: 50,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  const files = res.data.files || [];
  if (!files.length) return null;

  if (files.length > 1) {
    console.warn(`⚠️ Doublons détectés pour ${fileName} : ${files.length} fichiers`);
    files.forEach(f => {
      console.warn(` - ${f.id} | ${f.name} | created=${f.createdTime} | modified=${f.modifiedTime}`);
    });
  }

  files.sort((a, b) => {
    const am = new Date(a.modifiedTime || 0).getTime();
    const bm = new Date(b.modifiedTime || 0).getTime();
    return bm - am;
  });

  return files[0];
}

async function findAllDriveFilesByName(folderId, fileName) {
  const drive = getDriveClient();
  if (!folderId) return [];

  const q = [
    `'${folderId}' in parents`,
    `name = '${escapeDriveQueryValue(fileName)}'`,
    `trashed = false`
  ].join(' and ');

  const res = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType, createdTime, modifiedTime)',
    pageSize: 50,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  return res.data.files || [];
}

async function listDriveFiles(folderId) {
	const drive = getDriveClient();
  if (!folderId) return [];

  const results = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: [
        `'${folderId}' in parents`,
        `trashed = false`
      ].join(' and '),
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    results.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);

  return results;
}

async function listDriveSongs() {
	const drive = getDriveClient();
  const files = await listDriveFiles(GOOGLE_DRIVE_PARTITIONS_FOLDER_ID);

  return files
    .map(f => f.name)
    .filter(name => {
      const lower = String(name || '').toLowerCase();
      return lower.endsWith('.pro') || lower.endsWith('.cho');
    })
    .sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
}

async function readDriveTextFile(fileId) {
	const drive = getDriveClient();
  const res = await drive.files.get(
    {
      fileId,
      alt: 'media',
      supportsAllDrives: true
    },
    {
      responseType: 'text'
    }
  );

  return typeof res.data === 'string' ? res.data : String(res.data || '');
}

async function createDriveTextFile(folderId, fileName, content, mimeType = 'text/plain') {
	const drive = getDriveClient();
  const buffer = Buffer.from(String(content || ''), 'utf8');

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      mimeType
    },
    media: {
      mimeType,
      body: Readable.from(buffer)
    },
    fields: 'id, name',
    supportsAllDrives: true
  });

  return res.data;
}

async function updateDriveTextFile(fileId, fileName, content, mimeType = 'text/plain') {
	const drive = getDriveClient();
  const buffer = Buffer.from(String(content || ''), 'utf8');

  const res = await drive.files.update({
    fileId,
    requestBody: {
      name: fileName
    },
    media: {
      mimeType,
      body: Readable.from(buffer)
    },
    fields: 'id, name',
    supportsAllDrives: true
  });

  return res.data;
}

async function upsertDriveTextFile(folderId, fileName, content, mimeType = 'text/plain') {
  const existingFiles = await findAllDriveFilesByName(folderId, fileName);

  if (existingFiles.length > 1) {
    console.warn(`⚠️ Plusieurs fichiers "${fileName}" trouvés. Mise à jour du plus récent.`);
    existingFiles.sort((a, b) => {
      const am = new Date(a.modifiedTime || 0).getTime();
      const bm = new Date(b.modifiedTime || 0).getTime();
      return bm - am;
    });
    return updateDriveTextFile(existingFiles[0].id, fileName, content, mimeType);
  }

  if (existingFiles.length === 1) {
    return updateDriveTextFile(existingFiles[0].id, fileName, content, mimeType);
  }

  return createDriveTextFile(folderId, fileName, content, mimeType);
}

async function readDriveJsonFileByName(folderId, fileName, fallbackValue) {
	const drive = getDriveClient();
  const file = await findDriveFileByName(folderId, fileName);
  if (!file) return fallbackValue;

  try {
    const raw = await readDriveTextFile(file.id);
    return JSON.parse(raw);
  } catch (err) {
    console.error(`❌ JSON invalide pour ${fileName}:`, err);
    return fallbackValue;
  }
}

async function writeDriveJsonFileByName(folderId, fileName, value) {
	const drive = getDriveClient();
  return upsertDriveTextFile(
    folderId,
    fileName,
    JSON.stringify(value, null, 2),
    'application/json'
  );
}

async function trashDriveFile(fileId) {
  const drive = getDriveClient();

  await drive.files.update({
    fileId,
    requestBody: {
      trashed: true
    },
    supportsAllDrives: true
  });
}

async function readOauthTokensFromDrive() {
  try {
    if (!GOOGLE_DRIVE_META_FOLDER_ID) return null;

    const data = await readDriveJsonFileByName(
      GOOGLE_DRIVE_META_FOLDER_ID,
      OAUTH_TOKENS_FILE_NAME,
      null
    );

    if (!data || typeof data !== 'object') return null;

    return data;
  } catch (err) {
    console.error('❌ Erreur lecture oauth-tokens.json:', err);
    return null;
  }
}

async function writeOauthTokensToDrive(tokens) {
  try {
    if (!GOOGLE_DRIVE_META_FOLDER_ID) {
      throw new Error('GOOGLE_DRIVE_META_FOLDER_ID manquant');
    }

    await writeDriveJsonFileByName(
      GOOGLE_DRIVE_META_FOLDER_ID,
      OAUTH_TOKENS_FILE_NAME,
      tokens
    );

    console.log('✅ oauth-tokens.json mis à jour sur Google Drive');
  } catch (err) {
    console.error('❌ Erreur écriture oauth-tokens.json:', err);
    throw err;
  }
}

async function readSongMeta() {
  const data = await readDriveJsonFileByName(
    GOOGLE_DRIVE_META_FOLDER_ID,
    'song-meta.json',
    {}
  );

  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

async function writeSongMeta(meta) {
  await writeDriveJsonFileByName(
    GOOGLE_DRIVE_META_FOLDER_ID,
    'song-meta.json',
    meta
  );

  console.log('✅ song-meta.json mis à jour sur Google Drive');
  console.log('✅ Nombre d’entrées meta :', Object.keys(meta).length);
}

async function readSongSettings(fileName) {
  const data = await readDriveJsonFileByName(
    GOOGLE_DRIVE_SONG_SETTINGS_FOLDER_ID,
    settingsFileName(fileName),
    {
      fontSize: 26,
      speed: 50,
      transpose: 0
    }
  );

  return {
    fontSize: Number.isFinite(Number(data?.fontSize)) ? Number(data.fontSize) : 26,
    speed: Number.isFinite(Number(data?.speed)) ? Number(data.speed) : 50,
    transpose: Number.isFinite(Number(data?.transpose)) ? Number(data.transpose) : 0
  };
}

async function writeSongSettings(fileName, settings) {
  const clean = {
    fontSize: Number.isFinite(Number(settings?.fontSize)) ? Number(settings.fontSize) : 26,
    speed: Number.isFinite(Number(settings?.speed)) ? Number(settings.speed) : 50,
    transpose: Number.isFinite(Number(settings?.transpose)) ? Number(settings.transpose) : 0
  };

  await writeDriveJsonFileByName(
    GOOGLE_DRIVE_SONG_SETTINGS_FOLDER_ID,
    settingsFileName(fileName),
    clean
  );

  return clean;
}

async function readHistory(fileName) {
  const data = await readDriveJsonFileByName(
    GOOGLE_DRIVE_HISTORY_FOLDER_ID,
    historyFileName(fileName),
    []
  );

  return Array.isArray(data) ? data : [];
}

async function writeHistory(fileName, entries) {
  await writeDriveJsonFileByName(
    GOOGLE_DRIVE_HISTORY_FOLDER_ID,
    historyFileName(fileName),
    entries
  );
}

async function appendHistory(fileName, entry) {
  const items = await readHistory(fileName);
  items.unshift(entry);
  await writeHistory(fileName, items.slice(0, 50));
}

async function readPartition(fileName) {
  const file = await findDriveFileByName(GOOGLE_DRIVE_PARTITIONS_FOLDER_ID, fileName);
  if (!file) return null;
  return readDriveTextFile(file.id);
}

async function writePartition(fileName, content) {
  return upsertDriveTextFile(
    GOOGLE_DRIVE_PARTITIONS_FOLDER_ID,
    fileName,
    content,
    'text/plain'
  );
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

app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    partitionsFolder: !!GOOGLE_DRIVE_PARTITIONS_FOLDER_ID,
    metaFolder: !!GOOGLE_DRIVE_META_FOLDER_ID,
    historyFolder: !!GOOGLE_DRIVE_HISTORY_FOLDER_ID,
    settingsFolder: !!GOOGLE_DRIVE_SONG_SETTINGS_FOLDER_ID,
    serviceAccount: !!GOOGLE_SERVICE_ACCOUNT_EMAIL
  });
});

app.get('/auth/google', (req, res) => {
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REDIRECT_URI) {
    return res.status(500).send('OAuth Google non configuré');
  }

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_OAUTH_SCOPES
  });

  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    if (!code) {
      return res.status(400).send('Code OAuth manquant');
    }

const { tokens } = await oauth2Client.getToken(code);
oauthTokens = tokens;
oauth2Client.setCredentials(tokens);

await writeOauthTokensToDrive(tokens);

console.log('✅ OAuth Google connecté');
console.log('✅ Refresh token présent :', !!tokens.refresh_token);

    res.send(`
      <html>
        <body style="font-family:sans-serif;background:#111;color:#eee;padding:30px">
          <h2>Connexion Google réussie ✅</h2>
          <p>Tu peux fermer cette fenêtre et revenir dans BandApp.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ Erreur OAuth callback:', err);
    res.status(500).send('Erreur OAuth');
  }
});

app.get('/auth/status', (req, res) => {
  res.json({
    oauthConfigured: !!(GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && GOOGLE_OAUTH_REDIRECT_URI),
    oauthConnected: !!(oauthTokens && (oauthTokens.access_token || oauthTokens.refresh_token)),
    hasAccessToken: !!(oauthTokens && oauthTokens.access_token),
    hasRefreshToken: !!(oauthTokens && oauthTokens.refresh_token)
  });
});

app.get('/list-songs', async (req, res) => {
  try {
    const songs = await listDriveSongs();
    console.log('🎵 /list-songs ->', songs.length, 'morceaux');
    res.json(songs);
  } catch (err) {
    console.error('❌ Erreur /list-songs :', err);
    res.status(500).json([]);
  }
});

app.get('/partitions/:fileName', async (req, res) => {
  try {
    const fileName = String(req.params.fileName || '');
    if (!isValidSongName(fileName)) {
      return res.status(400).send('Nom de fichier invalide');
    }

    const file = await findDriveFileByName(GOOGLE_DRIVE_PARTITIONS_FOLDER_ID, fileName);
    if (!file) {
      return res.status(404).send('Fichier introuvable');
    }

    const content = await readDriveTextFile(file.id);
    res.type('text/plain').send(content);
  } catch (err) {
    console.error('❌ Erreur lecture partition Drive :', err);
    res.status(500).send('Erreur');
  }
});

app.get('/song-meta.json', async (req, res) => {
  try {
    const meta = await readSongMeta();
    res.json(meta);
  } catch (err) {
    console.error('❌ Erreur /song-meta.json:', err);
    res.status(500).json({});
  }
});

app.get('/song-history', async (req, res) => {
  try {
    const fileName = String(req.query.fileName || '');
    if (!isValidSongName(fileName)) {
      return res.status(400).json([]);
    }

    const items = await readHistory(fileName);
    res.json(items.map(entry => ({
      id: entry.id,
      savedAt: entry.savedAt,
      savedBy: entry.savedBy
    })));
  } catch (err) {
    console.error('❌ Erreur /song-history:', err);
    res.status(500).json([]);
  }
});

app.get('/song-settings', async (req, res) => {
  try {
    const fileName = String(req.query.fileName || '');
    if (!isValidSongName(fileName)) {
      return res.status(400).json({
        fontSize: 26,
        speed: 50,
        transpose: 0
      });
    }

    const settings = await readSongSettings(fileName);
    res.json(settings);
  } catch (err) {
    console.error('❌ Erreur /song-settings:', err);
    res.status(500).json({
      fontSize: 26,
      speed: 50,
      transpose: 0
    });
  }
});

app.get('/song-meta-entry', async (req, res) => {
  try {
    const fileName = String(req.query.fileName || '');
    if (!isValidSongName(fileName)) {
      return res.status(400).json({});
    }

    const meta = await readSongMeta();
    res.json(meta[fileName] || {});
  } catch (err) {
    console.error('❌ Erreur /song-meta-entry:', err);
    res.status(500).json({});
  }
});

app.get('/debug/drive', async (req, res) => {
  try {
    const [partitionFiles, metaFiles, historyFiles, settingsFiles] = await Promise.all([
      listDriveFiles(GOOGLE_DRIVE_PARTITIONS_FOLDER_ID),
      listDriveFiles(GOOGLE_DRIVE_META_FOLDER_ID),
      listDriveFiles(GOOGLE_DRIVE_HISTORY_FOLDER_ID),
      listDriveFiles(GOOGLE_DRIVE_SONG_SETTINGS_FOLDER_ID)
    ]);

    res.json({
      folders: {
        partitions: GOOGLE_DRIVE_PARTITIONS_FOLDER_ID || null,
        meta: GOOGLE_DRIVE_META_FOLDER_ID || null,
        history: GOOGLE_DRIVE_HISTORY_FOLDER_ID || null,
        settings: GOOGLE_DRIVE_SONG_SETTINGS_FOLDER_ID || null
      },
      counts: {
        partitions: partitionFiles.length,
        meta: metaFiles.length,
        history: historyFiles.length,
        settings: settingsFiles.length
      },
      partitions: partitionFiles.map(f => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType
      })),
      meta: metaFiles.map(f => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType
      })),
      history: historyFiles.map(f => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType
      })),
      settings: settingsFiles.map(f => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType
      }))
    });
  } catch (err) {
    console.error('❌ Erreur /debug/drive:', err);
    res.status(500).json({
      error: err.message,
      details: String(err)
    });
  }
});

app.post('/song-settings', async (req, res) => {
  try {
    const { fileName, pin, fontSize, speed, transpose } = req.body || {};

    if (!pinOk(pin)) return res.status(403).send('PIN invalide');
    if (!isValidSongName(fileName)) return res.status(400).send('Nom de fichier invalide');

    const saved = await writeSongSettings(fileName, { fontSize, speed, transpose });

    io.emit('song-settings-updated', {
      fileName,
      settings: saved
    });

    res.json(saved);
  } catch (err) {
    console.error('❌ Erreur POST /song-settings:', err);
    res.status(500).send('Erreur');
  }
});

app.post('/restore-song', async (req, res) => {
  try {
    const { fileName, historyId, pin, userName } = req.body || {};

    if (!pinOk(pin)) return res.status(403).send('PIN invalide');
    if (!isValidSongName(fileName)) return res.status(400).send('Nom de fichier invalide');
    if (!historyId) return res.status(400).send('Version invalide');

    const history = await readHistory(fileName);
    const entry = history.find(x => x.id === historyId);

    if (!entry) {
      return res.status(404).send('Version introuvable');
    }

    const currentContent = await readPartition(fileName);

    try {
      await appendHistory(fileName, createHistoryEntry({
        fileName,
        previousContent: currentContent || '',
        userName: userName || 'Restauration'
      }));
    } catch (historyErr) {
      console.error('⚠️ Historique non enregistré avant restauration :', historyErr?.errors || historyErr?.message || historyErr);
    }

    await writePartition(fileName, String(entry.previousContent ?? ''));

    io.emit('song-updated', { fileName, at: Date.now() });
    res.send('OK');
  } catch (err) {
    console.error('❌ Erreur POST /restore-song:', err);
    res.status(500).send('Erreur');
  }
});

app.post('/save-song', async (req, res) => {
  try {
    const { fileName, content, pin, userName } = req.body || {};

    if (!pinOk(pin)) return res.status(403).send('PIN invalide');
    if (!isValidSongName(fileName)) return res.status(400).send('Nom de fichier invalide');

    const previousContent = await readPartition(fileName);

    try {
      await appendHistory(fileName, createHistoryEntry({
        fileName,
        previousContent: previousContent || '',
        userName: userName || 'Inconnu'
      }));
    } catch (historyErr) {
      console.error('⚠️ Historique non enregistré :', historyErr?.errors || historyErr?.message || historyErr);
    }

    await writePartition(fileName, String(content ?? ''));

    io.emit('song-updated', { fileName, at: Date.now() });
    res.send('OK');
  } catch (err) {
    console.error('❌ Erreur POST /save-song:', err);
    res.status(500).send('Erreur');
  }
});

app.post('/save-song-meta', async (req, res) => {
  try {
    const { fileName, pin } = req.body || {};

    if (!pinOk(pin)) return res.status(403).send('PIN invalide');
    if (!isValidSongName(fileName)) return res.status(400).send('Nom de fichier invalide');

    const meta = await readSongMeta();
    meta[fileName] = normalizeSongMetaEntry(req.body || {});

    await writeSongMeta(meta);

    io.emit('song-meta-updated', { fileName, at: Date.now() });
    res.send('OK');
  } catch (err) {
    console.error('❌ Erreur POST /save-song-meta:', err);
    res.status(500).send('Erreur');
  }
});

app.post('/create-song', async (req, res) => {
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

    if (!pinOk(pin)) return res.status(403).send('PIN invalide');

    const cleanTitle = String(title || '').trim();
    const cleanArtist = String(artist || '').trim();

    if (!cleanTitle) return res.status(400).send('Titre invalide');
    if (!cleanArtist) return res.status(400).send('Artiste invalide');

    const finalFileName = String(fileName || `${cleanTitle} - ${cleanArtist}.pro`).trim();

    if (!isValidSongName(finalFileName)) {
      return res.status(400).send('Nom de fichier invalide');
    }

    const existingPartition = await findDriveFileByName(
      GOOGLE_DRIVE_PARTITIONS_FOLDER_ID,
      finalFileName
    );

    if (existingPartition) {
      return res.status(409).send('Le morceau existe déjà');
    }

    const defaultContent =
      `{t:${cleanTitle}}\n` +
      `{st:${cleanArtist}}\n\n`;

    await createDriveTextFile(
      GOOGLE_DRIVE_PARTITIONS_FOLDER_ID,
      finalFileName,
      defaultContent,
      'text/plain'
    );

    const meta = await readSongMeta();

    meta[finalFileName] = normalizeSongMetaEntry({
      title: cleanTitle,
      artist: cleanArtist,
      category,
      style,
      ambiance,
      audience,
      chanteur
    });

    await writeSongMeta(meta);

    io.emit('song-created', { fileName: finalFileName, at: Date.now() });
    res.send('OK');
  } catch (err) {
    console.error('❌ Erreur POST /create-song:', err);

    if (err?.errors?.[0]?.reason === 'storageQuotaExceeded') {
      return res.status(500).send(
        "Création impossible : l'application utilise encore le service account au lieu de la connexion Google OAuth."
      );
    }

    res.status(500).send('Erreur');
  }
});

app.post('/delete-song', async (req, res) => {
  try {
    const { fileName, pin, confirmText } = req.body || {};

    if (!pinOk(pin)) return res.status(403).send('PIN invalide');
    if (!isValidSongName(fileName)) return res.status(400).send('Nom de fichier invalide');

    if (String(confirmText || '').trim().toUpperCase() !== 'SUPPRIMER') {
      return res.status(400).send('Confirmation invalide');
    }

    const file = await findDriveFileByName(GOOGLE_DRIVE_PARTITIONS_FOLDER_ID, fileName);
    if (!file) {
      return res.status(404).send('Fichier introuvable');
    }

    await trashDriveFile(file.id);

    const meta = await readSongMeta();
    if (meta[fileName]) {
      delete meta[fileName];
      await writeSongMeta(meta);
    }

    io.emit('song-deleted', { fileName, at: Date.now() });
    res.send('OK');
  } catch (err) {
    console.error('❌ Erreur POST /delete-song:', err);
    res.status(500).send('Erreur');
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

    if (played) playedTonight.add(name);
    else playedTonight.delete(name);

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
      leaderUserName = '';
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

    const anchor = String(payload?.anchor || '');
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
      leaderDeviceId = null;
      leaderUserName = '';
      broadcastLeaderState();
      io.emit('apply-autoscroll', { active: false, speed: 50 });
    }
  });
});

console.log('📁 GOOGLE_DRIVE_PARTITIONS_FOLDER_ID =', GOOGLE_DRIVE_PARTITIONS_FOLDER_ID ? 'OK' : 'MANQUANT');
console.log('📁 GOOGLE_DRIVE_META_FOLDER_ID =', GOOGLE_DRIVE_META_FOLDER_ID ? 'OK' : 'MANQUANT');
console.log('📁 GOOGLE_DRIVE_HISTORY_FOLDER_ID =', GOOGLE_DRIVE_HISTORY_FOLDER_ID ? 'OK' : 'MANQUANT');
console.log('📁 GOOGLE_DRIVE_SONG_SETTINGS_FOLDER_ID =', GOOGLE_DRIVE_SONG_SETTINGS_FOLDER_ID ? 'OK' : 'MANQUANT');
console.log('📧 GOOGLE_SERVICE_ACCOUNT_EMAIL =', GOOGLE_SERVICE_ACCOUNT_EMAIL || 'MANQUANT');

async function bootstrapOauthTokens() {
  try {
    const storedTokens = await readOauthTokensFromDrive();

    if (storedTokens && storedTokens.refresh_token) {
      oauthTokens = storedTokens;
      oauth2Client.setCredentials(storedTokens);
      console.log('✅ Tokens OAuth rechargés depuis Google Drive');
    } else {
      console.log('ℹ️ Aucun token OAuth sauvegardé trouvé');
    }
  } catch (err) {
    console.error('❌ Erreur bootstrap OAuth:', err);
  }
}

const PORT = process.env.PORT || 3000;

(async () => {
  await bootstrapOauthTokens();

  http.listen(PORT, '0.0.0.0', () => {
    console.log('✅ Serveur en ligne sur le port ' + PORT);
    console.log('🔐 PIN global:', LEADER_PIN);
  });
})();
