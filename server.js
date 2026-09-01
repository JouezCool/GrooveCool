const express = require('express');
const compression = require('compression');
const app = express();
// Compresse toutes les réponses (gzip/brotli selon ce que le navigateur
// accepte) : index.html (~180 Ko non compressé, ~40 Ko compressé) et les
// réponses JSON (morceaux, méta) sont retransmis en entier à chaque
// chargement (index.html est volontairement en no-cache, voir plus bas) —
// gain direct sur les connexions lentes de salle (wifi/4G), sans rien
// changer au comportement de l'app.
app.use(compression());
const http = require('http').Server(app);
const io = require('socket.io')(http, {
  // Tolère les micro-coupures réseau (WiFi de salle, 4G, verrouillage d'écran)
  // sans déclarer la connexion morte trop vite. Valeurs par défaut de Socket.IO :
  // pingTimeout 20000ms / pingInterval 25000ms — on augmente le timeout pour
  // absorber les brefs trous réseau observés en concert.
  pingTimeout: 60000,
  pingInterval: 25000
});
const crypto = require('crypto');
const { google } = require('googleapis');
const { Readable } = require('stream');
// File d'attente karaoke pour le public (voir guest-queue.js) : logique et
// routes isolees dans son propre fichier, server.js se contente de la
// brancher (voir AUTH_OPEN_PATHS et registerGuestQueue plus bas).
const { registerGuestQueue, GUEST_QUEUE_OPEN_PATHS } = require('./guest-queue');

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
const SONG_SETTINGS_META_KEY = '__songSettings';

// --- Mot de passe partagé pour accéder à l'app ---
// Par défaut, réutilise LEADER_PIN pour ne demander qu'un seul mot de passe aux membres,
// mais peut être défini séparément via la variable d'environnement SITE_PASSWORD sur Render.
const SITE_PASSWORD = String(process.env.SITE_PASSWORD || LEADER_PIN);
// Signe les cookies de session. Idéalement définie séparément via la variable d'environnement
// SESSION_SECRET sur Render ; à défaut, dérivée du mot de passe pour que les sessions restent
// valides après un redéploiement ou une mise en veille (plan gratuit Render).
const SESSION_SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update('groovecool-session-' + SITE_PASSWORD).digest('hex');
const SESSION_COOKIE_NAME = 'gc_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function parseCookieHeader(headerStr) {
	  const out = {};
	  if (!headerStr) return out;
	  headerStr.split(';').forEach(part => {
		      const idx = part.indexOf('=');
		      if (idx === -1) return;
		      const key = part.slice(0, idx).trim();
		      const val = part.slice(idx + 1).trim();
		      if (key) out[key] = decodeURIComponent(val);
	  });
	  return out;
}

function signSession(expiresAt) {
	  const payload = String(expiresAt);
	  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
	  return `${payload}.${sig}`;
}

function verifySession(token) {
	  if (!token) return false;
	  const parts = String(token).split('.');
	  if (parts.length !== 2) return false;
	  const [payload, sig] = parts;
	  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
	  const sigBuf = Buffer.from(sig);
	  const expBuf = Buffer.from(expected);
	  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
	  const expiresAt = Number(payload);
	  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

function isAuthenticated(req) {
	  const cookies = parseCookieHeader(req.headers.cookie);
	  return verifySession(cookies[SESSION_COOKIE_NAME]);
}

function loginPageHtml(errorMessage) {
	  const errorHtml = errorMessage
	    ? `<p style="color:#ff6b6b;margin:0 0 16px;font-size:14px;">${errorMessage}</p>`
		      : '';
	  return `<!DOCTYPE html>
	  <html lang="fr">
	  <head>
	  <meta charset="UTF-8">
	  <meta name="viewport" content="width=device-width, initial-scale=1.0">
	  <title>GrooveCool - Connexion</title>
	  <style>
	    body{background:#000;color:#eee;font-family:-apple-system,Segoe UI,Roboto,sans-serif;
		    display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
			  form{background:#111;border:1px solid #2a2a2a;border-radius:12px;padding:32px;width:280px;}
			    h1{font-size:18px;margin:0 0 20px;text-align:center;color:#ff9800;}
				  input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #333;
				      background:#000;color:#eee;font-size:16px;margin-bottom:16px;}
					    button{width:100%;padding:12px;border-radius:8px;border:none;background:#ff9800;
						    color:#000;font-weight:600;font-size:15px;cursor:pointer;}
							</style>
							</head>
							<body>
							<form method="POST" action="/login">
							  <h1>🎵 GrooveCool</h1>
							    ${errorHtml}
								  <input type="password" name="password" placeholder="Mot de passe" autofocus required>
								    <button type="submit">Entrer</button>
									</form>
									</body>
									</html>`;
}

const AUTH_OPEN_PATHS = new Set(['/login', '/health', ...GUEST_QUEUE_OPEN_PATHS]);

function requireAuth(req, res, next) {
	  if (AUTH_OPEN_PATHS.has(req.path) || req.path.startsWith('/socket.io/')) {
		      return next();
	  }

	  if (isAuthenticated(req)) return next();

	  const wantsJson = req.method !== 'GET' || req.headers.accept?.includes('application/json');
	  if (wantsJson) {
		      return res.status(401).json({ error: 'unauthorized' });
	  }
	  res.redirect('/login');
}

const memoryCache = {
  songsList: null,
  songsListAt: 0,
  songMeta: null,
  songMetaAt: 0,
  userColors: null,
  userColorsAt: 0,
  songSettings: new Map(),
  partitions: new Map()
};

const CACHE_TTL = {
  songsList: 10000,     // 10 sec
  songMeta: 10000,      // 10 sec
  userColors: 10000,    // 10 sec
  songSettings: 10000,  // 10 sec
  partition: 10000      // 10 sec
};

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
  if (oauthTokens && (oauthTokens.access_token || oauthTokens.refresh_token)) {
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

let playedTonight = new Set();
let playedTonightSaveTimer = null;
const connectedUsers = new Map();
const MAX_LEADERS = 1;
// Turn était jusqu'ici illimité (n'importe qui pouvait devenir Turn en plus
// des autres). On le rend exclusif comme Leader : une seule personne à la
// fois, avec possibilité de "voler" la place via le code PIN (voir pinOk).
const MAX_TURNERS = 1;
const LEADER_RECONNECT_GRACE_MS = 5 * 60 * 1000;
// Si le leader actif se déconnecte brièvement (coupure réseau), on attend
// quelques secondes avant de couper le défilement de tout le monde — le temps
// qu'il se reconnecte tout seul. Ça évite qu'une micro-coupure du leader
// interrompe tout le monde pendant un concert.
const PLAYBACK_STOP_GRACE_MS = 8000;
const leadersByDeviceId = new Map();
const turnersByDeviceId = new Map();
// Appareils actuellement en mode karaoké (rôle purement client, pas de
// ressource exclusive comme leader/turn) : sert uniquement à informer le
// Leader si au moins un invité regarde en mode karaoké, pour qu'il sache
// s'il doit voir le surlignage de paragraphe.
const karaokeDeviceIds = new Set();
let currentSongFileName = '';
let currentAutoScrollState = {
  active: false,
  speed: 50
};
let activePlaybackDeviceId = '';
let currentPlaybackPosition = null;
let leaderCleanupTimer = null;
let pendingPlaybackStop = null;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/login', (req, res) => {
	  if (isAuthenticated(req)) return res.redirect('/');
	  res.type('html').send(loginPageHtml());
});

app.post('/login', (req, res) => {
	  const password = String(req.body?.password || '');
	  if (password !== SITE_PASSWORD) {
		      return res.status(401).type('html').send(loginPageHtml('Mot de passe incorrect'));
	  }

	  const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
	  const token = signSession(expiresAt);
	  res.setHeader(
		      'Set-Cookie',
		      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`
		    );
	  res.redirect('/');
});

app.get('/logout', (req, res) => {
	  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
	  res.redirect('/login');
});

app.use(requireAuth);

app.use(express.static('public', {
  etag: true,
  maxAge: '1d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

async function readPlayedTonight() {
  const data = await readDriveJsonFileByName(
    GOOGLE_DRIVE_META_FOLDER_ID,
    'played-tonight.json',
    []
  );

  return new Set(Array.isArray(data) ? data : []);
}

async function writePlayedTonight(setValue) {
  await writeDriveJsonFileByName(
    GOOGLE_DRIVE_META_FOLDER_ID,
    'played-tonight.json',
    [...setValue]
  );
}

function schedulePlayedTonightSave() {
  if (playedTonightSaveTimer) clearTimeout(playedTonightSaveTimer);

  playedTonightSaveTimer = setTimeout(async () => {
    try {
      await writePlayedTonight(playedTonight);
      console.log('✅ played-tonight.json sauvegardé');
    } catch (err) {
      console.error('❌ Erreur sauvegarde played-tonight.json:', err);
    }
  }, 2000);
}

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

function getSongSettingsFolderId() {
  return GOOGLE_DRIVE_SONG_SETTINGS_FOLDER_ID || GOOGLE_DRIVE_META_FOLDER_ID;
}

function getSongSettingsFallbackFolderId() {
  if (
    GOOGLE_DRIVE_META_FOLDER_ID &&
    GOOGLE_DRIVE_META_FOLDER_ID !== GOOGLE_DRIVE_SONG_SETTINGS_FOLDER_ID
  ) {
    return GOOGLE_DRIVE_META_FOLDER_ID;
  }

  return '';
}

function normalizeSongSettings(settings) {
  return {
    fontSize: Number.isFinite(Number(settings?.fontSize)) ? Number(settings.fontSize) : 26,
    speed: Number.isFinite(Number(settings?.speed)) ? Number(settings.speed) : 50,
    transpose: Number.isFinite(Number(settings?.transpose)) ? Number(settings.transpose) : 0
  };
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
  const now = Date.now();

  if (
    memoryCache.songsList &&
    (now - memoryCache.songsListAt) < CACHE_TTL.songsList
  ) {
    return memoryCache.songsList;
  }

  const files = await listDriveFiles(GOOGLE_DRIVE_PARTITIONS_FOLDER_ID);

  const songs = files
    .map(f => f.name)
    .filter(name => {
      const lower = String(name || '').toLowerCase();
      return lower.endsWith('.pro') || lower.endsWith('.cho');
    })
    .sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));

  memoryCache.songsList = songs;
  memoryCache.songsListAt = now;

  return songs;
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
  if (!folderId) {
    throw new Error(`Dossier Google Drive manquant pour ${fileName}`);
  }

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
  const now = Date.now();

  if (
    memoryCache.songMeta &&
    (now - memoryCache.songMetaAt) < CACHE_TTL.songMeta
  ) {
    return memoryCache.songMeta;
  }

  const data = await readDriveJsonFileByName(
    GOOGLE_DRIVE_META_FOLDER_ID,
    'song-meta.json',
    {}
  );

  const meta = data && typeof data === 'object' && !Array.isArray(data) ? data : {};

  memoryCache.songMeta = meta;
  memoryCache.songMetaAt = now;

  return meta;
}

async function writeSongMeta(meta) {
  await writeDriveJsonFileByName(
    GOOGLE_DRIVE_META_FOLDER_ID,
    'song-meta.json',
    meta
  );

  memoryCache.songMeta = meta;
  memoryCache.songMetaAt = Date.now();

  console.log('✅ song-meta.json mis à jour sur Google Drive');
  console.log('✅ Nombre d’entrées meta :', Object.keys(meta).length);
}

function publicSongMeta(meta) {
  const copy = { ...meta };
  delete copy[SONG_SETTINGS_META_KEY];
  return copy;
}

async function readUserColors() {
  const now = Date.now();

  if (
    memoryCache.userColors &&
    (now - memoryCache.userColorsAt) < CACHE_TTL.userColors
  ) {
    return memoryCache.userColors;
  }

  const data = await readDriveJsonFileByName(
    GOOGLE_DRIVE_META_FOLDER_ID,
    'user-colors.json',
    {}
  );

  const colors = data && typeof data === 'object' && !Array.isArray(data) ? data : {};

  memoryCache.userColors = colors;
  memoryCache.userColorsAt = now;

  return colors;
}

async function writeUserColors(colors) {
  await writeDriveJsonFileByName(
    GOOGLE_DRIVE_META_FOLDER_ID,
    'user-colors.json',
    colors
  );

  memoryCache.userColors = colors;
  memoryCache.userColorsAt = Date.now();
}

async function readSongSettings(fileName) {
  const now = Date.now();
  const cached = memoryCache.songSettings.get(fileName);

  if (cached && (now - cached.at) < CACHE_TTL.songSettings) {
    return cached.value;
  }

  let data = null;

  try {
    data = await readDriveJsonFileByName(
      getSongSettingsFolderId(),
      settingsFileName(fileName),
      null
    );
  } catch (err) {
    console.warn('⚠️ Lecture réglages fichier individuel impossible:', err?.message || err);
  }

  if (!data) {
    const meta = await readSongMeta();
    data = meta?.[SONG_SETTINGS_META_KEY]?.[fileName] || null;
  }

  const settings = normalizeSongSettings(data);

  memoryCache.songSettings.set(fileName, {
    value: settings,
    at: now
  });

  return settings;
}

async function writeSongSettings(fileName, settings) {
  const clean = normalizeSongSettings(settings);

  try {
    await writeDriveJsonFileByName(
      getSongSettingsFolderId(),
      settingsFileName(fileName),
      clean
    );
  } catch (err) {
    const fallbackFolderId = getSongSettingsFallbackFolderId();
    if (!fallbackFolderId) {
      await writeSongSettingsToMeta(fileName, clean, err);
      memoryCache.songSettings.set(fileName, {
        value: clean,
        at: Date.now()
      });

      return clean;
    }

    try {
      console.warn('⚠️ Écriture réglages impossible dans le dossier settings, tentative dans meta:', err?.message || err);
      await writeDriveJsonFileByName(
        fallbackFolderId,
        settingsFileName(fileName),
        clean
      );
    } catch (fallbackErr) {
      await writeSongSettingsToMeta(fileName, clean, fallbackErr);
    }
  }

  memoryCache.songSettings.set(fileName, {
    value: clean,
    at: Date.now()
  });

  return clean;
}

async function writeSongSettingsToMeta(fileName, clean, cause) {
  console.warn('⚠️ Écriture réglages fichier impossible, sauvegarde dans song-meta:', cause?.message || cause);
  const meta = await readSongMeta();
  const allSettings =
    meta[SONG_SETTINGS_META_KEY] &&
    typeof meta[SONG_SETTINGS_META_KEY] === 'object' &&
    !Array.isArray(meta[SONG_SETTINGS_META_KEY])
      ? meta[SONG_SETTINGS_META_KEY]
      : {};

  allSettings[fileName] = clean;
  meta[SONG_SETTINGS_META_KEY] = allSettings;
  await writeSongMeta(meta);
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
  const now = Date.now();
  const cached = memoryCache.partitions.get(fileName);

  if (cached && (now - cached.at) < CACHE_TTL.partition) {
    return cached.value;
  }

  const file = await findDriveFileByName(GOOGLE_DRIVE_PARTITIONS_FOLDER_ID, fileName);
  if (!file) return null;

  const content = await readDriveTextFile(file.id);

  memoryCache.partitions.set(fileName, {
    value: content,
    at: now
  });

  return content;
}

async function writePartition(fileName, content) {
  const result = await upsertDriveTextFile(
    GOOGLE_DRIVE_PARTITIONS_FOLDER_ID,
    fileName,
    content,
    'text/plain'
  );

  memoryCache.partitions.set(fileName, {
    value: content,
    at: Date.now()
  });

  return result;
}

function broadcastConnectedUsers() {
  const uniqueUsers = [...new Set(
    [...connectedUsers.values()]
      .map(v => String(v?.userName || '').trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));

  io.emit('connected-users', { users: uniqueUsers });
}

// Informe tout le monde du nombre d'appareils actuellement en mode karaoké
// (voir karaokeDeviceIds) : le Leader s'en sert pour savoir s'il doit
// afficher le surlignage de paragraphe.
function broadcastKaraokeGuests() {
  io.emit('karaoke-guests', { count: karaokeDeviceIds.size });
}

function broadcastLeaderState() {
  const leaders = [...leadersByDeviceId.values()];
  const leaderSocketIds = leaders.map(leader => leader.socketId).filter(Boolean);
  const leaderUserNames = leaders.map(leader => leader.userName).filter(Boolean);
  const leaderDeviceIds = leaders.map(leader => leader.deviceId).filter(Boolean);
  const turners = [...turnersByDeviceId.values()];
  const turnSocketIds = turners.map(turner => turner.socketId).filter(Boolean);
  const turnUserNames = turners.map(turner => turner.userName).filter(Boolean);
  const turnDeviceIds = turners.map(turner => turner.deviceId).filter(Boolean);

  io.emit('leader-state', {
    leaderSocketId: leaderSocketIds[0] || null,
    leaderSocketIds,
    leaderDeviceIds,
    leaderUserName: leaderUserNames[0] || '',
    leaderUserNames,
    turnSocketIds,
    turnDeviceIds,
    turnUserNames,
    leaderCount: leaderDeviceIds.length,
    maxLeaders: MAX_LEADERS,
    hasLeader: leaderDeviceIds.length > 0
  });
}

function isLeaderSocket(socket) {
  const deviceId = String(socket.data.deviceId || '').trim();
  if (!deviceId) return false;

  const leader = leadersByDeviceId.get(deviceId);
  return !!leader && leader.socketId === socket.id;
}

function isTurnSocket(socket) {
  const deviceId = String(socket.data.deviceId || '').trim();
  if (!deviceId) return false;

  const turner = turnersByDeviceId.get(deviceId);
  return !!turner && turner.socketId === socket.id;
}

function canChangeSong(socket) {
  return isLeaderSocket(socket) || isTurnSocket(socket);
}

function getSocketDeviceId(socket) {
  return String(socket.data.deviceId || '').trim();
}

function isActivePlaybackSocket(socket) {
  const deviceId = getSocketDeviceId(socket);
  return !!deviceId && !!activePlaybackDeviceId && deviceId === activePlaybackDeviceId;
}

function canControlPlayback(socket) {
  if (!isLeaderSocket(socket)) return false;
  if (!currentAutoScrollState.active || !activePlaybackDeviceId) return true;
  return isActivePlaybackSocket(socket);
}

function pruneDisconnectedLeaders() {
  const now = Date.now();
  let changed = false;

  for (const [deviceId, leader] of leadersByDeviceId.entries()) {
    if (leader.socketId) continue;

    const disconnectedAt = Number(leader.disconnectedAt || 0);
    if (disconnectedAt && now - disconnectedAt > LEADER_RECONNECT_GRACE_MS) {
      leadersByDeviceId.delete(deviceId);
      changed = true;
    }
  }

  if (changed) {
    broadcastLeaderState();
    if (leadersByDeviceId.size === 0) {
      activePlaybackDeviceId = '';
      currentPlaybackPosition = null;
      currentAutoScrollState = { active: false, speed: 50 };
      io.emit('apply-autoscroll', {
        ...currentAutoScrollState,
        controllerDeviceId: ''
      });
    }
  }
}

function scheduleLeaderCleanup() {
  if (leaderCleanupTimer) clearTimeout(leaderCleanupTimer);

  leaderCleanupTimer = setTimeout(() => {
    leaderCleanupTimer = null;
    pruneDisconnectedLeaders();
  }, LEADER_RECONNECT_GRACE_MS + 1000);
}

function broadcastPlayedTonight() {
  io.emit('played-tonight-state', {
    songs: [...playedTonight]
  });
}

function sanitizeFilePart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

app.get('/user-colors.json', async (req, res) => {
  try {
    const colors = await readUserColors();
    res.json(colors);
  } catch (err) {
    console.error('❌ Erreur /user-colors.json:', err);
    res.status(500).json({});
  }
});

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

// Branche les routes /guest/*, /guest-queue et /guest-queue/remove (voir
// guest-queue.js). /guest/songs et /guest/join sont publiques (voir
// GUEST_QUEUE_OPEN_PATHS ci-dessus) ; /guest-queue et /guest-queue/remove
// restent derriere requireAuth comme le reste de l'appli.
registerGuestQueue(app, io, { isValidSongName, listDriveSongs, readSongMeta });

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

app.get('/song-bundle', async (req, res) => {
  try {
    const fileName = String(req.query.fileName || '');
    if (!isValidSongName(fileName)) {
      return res.status(400).json({
        fileName,
        content: '',
        settings: {
          fontSize: 26,
          speed: 50,
          transpose: 0
        }
      });
    }

    const [content, settings] = await Promise.all([
      readPartition(fileName),
      readSongSettings(fileName)
    ]);

    if (content === null) {
      return res.status(404).json({
        error: 'Fichier introuvable'
      });
    }

    res.json({
      fileName,
      content,
      settings
    });
  } catch (err) {
    console.error('❌ Erreur /song-bundle:', err);
    res.status(500).json({
      error: 'Erreur',
      content: '',
      settings: {
        fontSize: 26,
        speed: 50,
        transpose: 0
      }
    });
  }
});

app.get('/song-meta.json', async (req, res) => {
  try {
    const meta = await readSongMeta();
    res.json(publicSongMeta(meta));
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

app.post('/save-user-color', async (req, res) => {
  try {
    const { userName, color } = req.body || {};

    const cleanUser = String(userName || '').trim();
    const cleanColor = String(color || '').trim();

    if (!cleanUser) return res.status(400).send('Utilisateur invalide');
    if (!/^#[0-9A-Fa-f]{6}$/.test(cleanColor)) {
      return res.status(400).send('Couleur invalide');
    }

    const colors = await readUserColors();
    colors[cleanUser] = cleanColor;

    await writeUserColors(colors);

    io.emit('user-colors-updated', {
      userName: cleanUser,
      color: cleanColor
    });

    res.send('OK');
  } catch (err) {
    console.error('❌ Erreur POST /save-user-color:', err);
    res.status(500).send('Erreur');
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

    const safeTitle = sanitizeFilePart(cleanTitle);
const safeArtist = sanitizeFilePart(cleanArtist);
const finalFileName = String(fileName || `${safeTitle} - ${safeArtist}.pro`).trim();

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
	const historyFile = await findDriveFileByName(
  GOOGLE_DRIVE_HISTORY_FOLDER_ID,
  historyFileName(fileName)
);
if (historyFile) {
  await trashDriveFile(historyFile.id);
}

const settingsFile = await findDriveFileByName(
  getSongSettingsFolderId(),
  settingsFileName(fileName)
);
if (settingsFile) {
  await trashDriveFile(settingsFile.id);
}

    io.emit('song-deleted', { fileName, at: Date.now() });
    res.send('OK');
  } catch (err) {
    console.error('❌ Erreur POST /delete-song:', err);
    res.status(500).send('Erreur');
  }
});

io.use((socket, next) => {
	  const cookies = parseCookieHeader(socket.handshake.headers?.cookie || '');
	  if (verifySession(cookies[SESSION_COOKIE_NAME])) return next();
	  next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  console.log('📱 connecté', socket.id);

  broadcastLeaderState();
  broadcastConnectedUsers();
  broadcastPlayedTonight();
  socket.emit('karaoke-guests', { count: karaokeDeviceIds.size });

  // Rôle purement client (voir syncKaraokeModeToServer côté front) : on ne
  // fait que compter combien d'appareils sont en mode karaoké, pour que le
  // Leader sache s'il doit afficher le surlignage de paragraphe.
  socket.on('karaoke-mode', ({ deviceId, active } = {}) => {
    const cleanDeviceId = String(deviceId || '').trim();
    if (!cleanDeviceId) return;

    const before = karaokeDeviceIds.size;
    if (active) {
      karaokeDeviceIds.add(cleanDeviceId);
    } else {
      karaokeDeviceIds.delete(cleanDeviceId);
    }
    socket.data.karaokeDeviceId = active ? cleanDeviceId : '';

    if (karaokeDeviceIds.size !== before) broadcastKaraokeGuests();
  });

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

    if (leadersByDeviceId.has(cleanDeviceId)) {
      leadersByDeviceId.set(cleanDeviceId, {
        socketId: socket.id,
        userName: cleanUser,
        deviceId: cleanDeviceId,
        disconnectedAt: 0
      });

      // Le leader revient avant la fin de la fenêtre de grâce : on annule
      // l'arrêt du défilement, le concert continue sans interruption.
      if (pendingPlaybackStop && pendingPlaybackStop.deviceId === cleanDeviceId) {
        clearTimeout(pendingPlaybackStop.timer);
        pendingPlaybackStop = null;
      }
    }

    if (turnersByDeviceId.has(cleanDeviceId)) {
      turnersByDeviceId.set(cleanDeviceId, {
        socketId: socket.id,
        userName: cleanUser,
        deviceId: cleanDeviceId
      });
    }

    broadcastConnectedUsers();
    broadcastLeaderState();

    if (currentSongFileName) {
      socket.emit('load-song', {
        fileName: currentSongFileName,
        replay: true
      });
    }

    socket.emit('apply-autoscroll', {
      ...currentAutoScrollState,
      controllerDeviceId: currentAutoScrollState.active ? activePlaybackDeviceId : '',
      replay: true
    });

    if (currentPlaybackPosition) {
      socket.emit('apply-scroll', {
        ...currentPlaybackPosition,
        official: true,
        replay: true
      });
    }
  });

socket.on('mark-played', ({ fileName, played }) => {
  const name = String(fileName || '').trim();
  if (!name) return;

  if (played) playedTonight.add(name);
  else playedTonight.delete(name);

  schedulePlayedTonightSave();
  broadcastPlayedTonight();
});

socket.on('reset-played-tonight', () => {
  playedTonight.clear();
  schedulePlayedTonightSave();
  broadcastPlayedTonight();
});

  socket.on('request-leader', (payload) => {
    pruneDisconnectedLeaders();

    const deviceId = String(socket.data.deviceId || '').trim();
    const userName = String(socket.data.userName || 'Leader').trim();
    const pin = String(payload?.pin || '');

    if (!deviceId) return;

    const alreadyMine = leadersByDeviceId.has(deviceId);
    const isFree = leadersByDeviceId.size < MAX_LEADERS;

    // Place déjà prise par quelqu'un d'autre : il faut le bon code PIN pour
    // la lui voler (menu de rôle côté client). Sans code, on refuse comme
    // avant.
    if (!alreadyMine && !isFree && !pinOk(pin)) {
      socket.emit('leader-denied', {
        leaderUserName: [...leadersByDeviceId.values()].map(leader => leader.userName).filter(Boolean).join(', '),
        maxLeaders: MAX_LEADERS
      });
      return;
    }

    if (!alreadyMine && !isFree) {
      // Code correct : on prévient la personne évincée pour qu'elle ne
      // reste pas sur une UI "leader" qui ne l'est plus.
      for (const leader of leadersByDeviceId.values()) {
        if (leader.socketId) {
          io.to(leader.socketId).emit('role-taken-over', { role: 'leader', byUserName: userName });
        }
      }
      leadersByDeviceId.clear();
    }

    turnersByDeviceId.delete(deviceId);
    leadersByDeviceId.set(deviceId, {
      socketId: socket.id,
      userName,
      deviceId,
      disconnectedAt: 0
    });
    broadcastLeaderState();
  });

  socket.on('request-turn', (payload) => {
    const deviceId = String(socket.data.deviceId || '').trim();
    const userName = String(socket.data.userName || 'Turn').trim();
    const pin = String(payload?.pin || '');
    if (!deviceId) return;

    const alreadyMine = turnersByDeviceId.has(deviceId);
    const isFree = turnersByDeviceId.size < MAX_TURNERS;

    if (!alreadyMine && !isFree && !pinOk(pin)) {
      socket.emit('turn-denied', {
        turnUserName: [...turnersByDeviceId.values()].map(turner => turner.userName).filter(Boolean).join(', '),
        maxTurners: MAX_TURNERS
      });
      return;
    }

    if (!alreadyMine && !isFree) {
      for (const turner of turnersByDeviceId.values()) {
        if (turner.socketId) {
          io.to(turner.socketId).emit('role-taken-over', { role: 'turn', byUserName: userName });
        }
      }
      turnersByDeviceId.clear();
    }

    leadersByDeviceId.delete(deviceId);
    if (activePlaybackDeviceId === deviceId) {
      activePlaybackDeviceId = '';
      currentAutoScrollState = {
        active: false,
        speed: currentAutoScrollState.speed || 50
      };
      io.emit('apply-autoscroll', {
        ...currentAutoScrollState,
        controllerDeviceId: ''
      });
    }

    turnersByDeviceId.set(deviceId, {
      socketId: socket.id,
      userName,
      deviceId
    });

    broadcastLeaderState();
  });

  socket.on('release-turn', () => {
    const deviceId = String(socket.data.deviceId || '').trim();
    if (deviceId && turnersByDeviceId.has(deviceId)) {
      turnersByDeviceId.delete(deviceId);
      broadcastLeaderState();
    }
  });

  socket.on('release-leader', () => {
    const deviceId = String(socket.data.deviceId || '').trim();

    if (deviceId && leadersByDeviceId.has(deviceId)) {
      leadersByDeviceId.delete(deviceId);
      broadcastLeaderState();
      if (leadersByDeviceId.size === 0) {
        activePlaybackDeviceId = '';
        currentPlaybackPosition = null;
        currentAutoScrollState = { active: false, speed: 50 };
        io.emit('apply-autoscroll', {
          ...currentAutoScrollState,
          controllerDeviceId: ''
        });
      }
    }
  });

  socket.on('change-song', (fileName) => {
    if (!canChangeSong(socket)) return;

    const cleanFileName = String(fileName || '').trim();
    if (!isValidSongName(cleanFileName)) return;

    currentSongFileName = cleanFileName;
    activePlaybackDeviceId = '';
    currentPlaybackPosition = null;
    currentAutoScrollState = {
      active: false,
      speed: currentAutoScrollState.speed || 50
    };

    io.emit('apply-autoscroll', {
      ...currentAutoScrollState,
      controllerDeviceId: '',
      sourceSocketId: socket.id
    });

    io.emit('load-song', {
      fileName: cleanFileName,
      sourceSocketId: socket.id
    });
  });

  let lastScrollAt = 0;
  socket.on('scroll-sync', (payload) => {
    if (!canControlPlayback(socket)) return;

    const now = Date.now();
    if (now - lastScrollAt < 60) return;
    lastScrollAt = now;

    const anchor = String(payload?.anchor || '');
    const progress = Math.max(0, Math.min(1, Number(payload?.progress) || 0));
    const top = Number.isFinite(Number(payload?.top)) ? Math.max(0, Number(payload.top)) : null;
    const scrollRatio = Number.isFinite(Number(payload?.scrollRatio))
      ? Math.max(0, Math.min(1, Number(payload.scrollRatio)))
      : null;
    const manual = !!payload?.manual;
    const official = !!payload?.official;
    // Identifiant du paragraphe repéré côté Leader pour la scène karaoké
    // (voir getKaraokeGroupAnchor() côté client) : simplement relayé tel
    // quel, jamais interprété côté serveur.
    const karaokeAnchor = String(payload?.karaokeAnchor || '');

    currentPlaybackPosition = {
      anchor,
      progress,
      top,
      scrollRatio,
      manual,
      official,
      karaokeAnchor,
      updatedAt: Date.now()
    };

    socket.broadcast.emit('apply-scroll', { anchor, progress, top, scrollRatio, manual, official, karaokeAnchor });
  });

  socket.on('request-sync-position', () => {
    // Resync complet (morceau + défilement), pas juste la position : si un
    // appareil a raté le changement de morceau du Turn/Leader (socket
    // momentanément coupé), il se rattrape ici tout seul au prochain tick,
    // au lieu d'attendre une reconnexion complète. openRemoteSong() ignore
    // ce message côté client si le morceau est déjà le bon, donc ça ne
    // provoque aucun à-coup visible quand tout est déjà synchronisé.
    if (currentSongFileName) {
      socket.emit('load-song', {
        fileName: currentSongFileName,
        replay: true
      });
    }

    if (currentPlaybackPosition) {
      socket.emit('apply-scroll', {
        ...currentPlaybackPosition,
        official: true,
        replay: true
      });
    }

    socket.emit('apply-autoscroll', {
      ...currentAutoScrollState,
      controllerDeviceId: currentAutoScrollState.active ? activePlaybackDeviceId : '',
      replay: true
    });
  });

  socket.on('sync-autoscroll', (d) => {
    if (!isLeaderSocket(socket)) return;

    const deviceId = getSocketDeviceId(socket);
    const nextActive = !!d.active;

    if (currentAutoScrollState.active && activePlaybackDeviceId && activePlaybackDeviceId !== deviceId) {
      return;
    }

    if (nextActive) {
      activePlaybackDeviceId = deviceId;
    } else if (!activePlaybackDeviceId || activePlaybackDeviceId === deviceId) {
      activePlaybackDeviceId = '';
    } else {
      return;
    }

    currentAutoScrollState = {
      active: nextActive,
      speed: Number(d.speed) || 50
    };

    socket.broadcast.emit('apply-autoscroll', {
      ...currentAutoScrollState,
      controllerDeviceId: currentAutoScrollState.active ? activePlaybackDeviceId : '',
      sourceSocketId: socket.id
    });
  });

  socket.on('leader-fontsize', (value) => {
    if (!isLeaderSocket(socket)) return;
    socket.broadcast.emit('apply-fontsize', value);
  });

  socket.on('leader-transpose', (value) => {
    if (!isLeaderSocket(socket)) return;
    socket.broadcast.emit('apply-transpose', value);
  });

  socket.on('leader-speed', (value) => {
    if (!canControlPlayback(socket)) return;
    socket.broadcast.emit('apply-speed', value);
  });

  socket.on('disconnect', () => {
    console.log('❌ déconnecté', socket.id);

    const deviceId = String(socket.data.deviceId || '').trim();
    const wasLeader = deviceId && leadersByDeviceId.has(deviceId);

    connectedUsers.delete(socket.id);
    broadcastConnectedUsers();

    if (wasLeader) {
      if (activePlaybackDeviceId === deviceId) {
        // On ne coupe pas le défilement de tout le monde immédiatement :
        // ça laisse une courte fenêtre de grâce pour absorber une micro-coupure
        // réseau du leader (WiFi de salle, 4G, écran verrouillé) sans arrêter
        // le concert pour tout le monde. Les autres continuent de défiler
        // localement en attendant.
        if (pendingPlaybackStop) clearTimeout(pendingPlaybackStop.timer);
        pendingPlaybackStop = {
          deviceId,
          timer: setTimeout(() => {
            pendingPlaybackStop = null;
            if (activePlaybackDeviceId !== deviceId) return;

            activePlaybackDeviceId = '';
            currentAutoScrollState = {
              active: false,
              speed: currentAutoScrollState.speed || 50
            };
            io.emit('apply-autoscroll', {
              ...currentAutoScrollState,
              controllerDeviceId: ''
            });
          }, PLAYBACK_STOP_GRACE_MS)
        };
      }

      const leader = leadersByDeviceId.get(deviceId);
      leadersByDeviceId.set(deviceId, {
        ...(leader || {}),
        socketId: null,
        deviceId,
        disconnectedAt: Date.now()
      });
      broadcastLeaderState();
      scheduleLeaderCleanup();
    }

    if (deviceId && turnersByDeviceId.has(deviceId)) {
      turnersByDeviceId.delete(deviceId);
      broadcastLeaderState();
    }

    // Contrairement au leader (fenêtre de grâce), le mode karaoké n'a pas
    // besoin d'attendre une reconnexion : le client renvoie son état dès
    // qu'il se reconnecte (voir socket.on('connect', ...) côté front).
    if (deviceId && karaokeDeviceIds.delete(deviceId)) {
      broadcastKaraokeGuests();
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

    if (!storedTokens || !storedTokens.refresh_token) {
      console.log('ℹ️ Aucun token OAuth sauvegardé trouvé');
      oauthTokens = null;
      return;
    }

    try {
      oauth2Client.setCredentials(storedTokens);

      const tokenResponse = await oauth2Client.getAccessToken();
      if (!tokenResponse || !tokenResponse.token) {
        throw new Error('Impossible de rafraîchir le token OAuth');
      }

      oauthTokens = {
        ...storedTokens,
        access_token: tokenResponse.token
      };

      console.log('✅ Tokens OAuth rechargés depuis Google Drive');
    } catch (oauthErr) {
      console.warn('⚠️ Token OAuth invalide, retour sur service account');
      console.warn(oauthErr?.message || oauthErr);
      oauthTokens = null;
    }
  } catch (err) {
    console.error('❌ Erreur bootstrap OAuth:', err);
    oauthTokens = null;
  }
}

const PORT = process.env.PORT || 3000;

(async () => {
  await bootstrapOauthTokens();

  try {
    playedTonight = await readPlayedTonight();
  } catch (err) {
    console.error('⚠️ Impossible de lire played-tonight.json au démarrage :', err?.message || err);
    playedTonight = new Set();
  }

  http.listen(PORT, '0.0.0.0', () => {
    console.log('✅ Serveur en ligne sur le port ' + PORT);
    console.log('🔐 Mot de passe app configuré :', SITE_PASSWORD ? 'OK' : 'MANQUANT');
  });
})();
