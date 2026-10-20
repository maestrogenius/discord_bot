// Discord Music Bot
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getSpotifyCollectionTitle } from './spotify.js';
import { getYoutubePlaylistTitle, isUrl } from './youtube.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const historyPath = path.resolve(__dirname, '..', 'data', 'play-history.json');
const playedHistoryPath = path.resolve(__dirname, '..', 'data', 'played-history.json');
const playlistHistoryPath = path.resolve(__dirname, '..', 'data', 'playlist-history.json');
const maxEntriesPerGuild = 100;
const maxPlayedEntriesPerGuild = 100;
const maxPlaylistEntriesPerGuild = 50;
const maxAutocompleteChoices = 25;
const maxAutocompleteValueLength = 100;

let historyCache = null;
let playedHistoryCache = null;
let playlistHistoryCache = null;
let historyWritePromise = Promise.resolve();
let playedHistoryWritePromise = Promise.resolve();
let playlistHistoryWritePromise = Promise.resolve();

export async function recordPlayedTrack(guildId, track) {
  if (!track?.url) return;

  const history = await readPlayedHistory();
  const entry = {
    id: randomUUID(),
    title: track.title || track.url,
    url: track.url,
    duration: Number.isFinite(track.duration) ? track.duration : null,
    thumbnail: track.thumbnail || null,
    artist: track.artist || null,
    playedAt: new Date().toISOString()
  };

  history[guildId] = [entry, ...(history[guildId] ?? [])]
    .slice(0, maxPlayedEntriesPerGuild);
  void writePlayedHistory(history);
}

export async function getRecentPlayedTracks(guildId, limit = 10) {
  const history = await readPlayedHistory();
  return (history[guildId] ?? []).slice(0, limit);
}

export async function getPlayedTrack(guildId, entryId) {
  const history = await readPlayedHistory();
  return (history[guildId] ?? []).find((entry) => entry.id === entryId) ?? null;
}

export async function recordPlaylist(guildId, query, sourceType, playlistTitle = null) {
  const url = normalizePlaylistUrl(query);
  if (!url) return;

  const history = await readPlaylistHistory();
  await migrateLegacyPlaylists(guildId, history);
  const guildHistory = history[guildId] ?? [];
  const existingIndex = guildHistory.findIndex((entry) => entry.url === url);

  if (existingIndex >= 0) {
    guildHistory.splice(existingIndex, 1);
  }

  guildHistory.unshift({
    id: randomUUID(),
    url,
    sourceType,
    title: playlistTitle || getPlaylistTitle(url, sourceType),
    addedAt: new Date().toISOString()
  });
  history[guildId] = guildHistory.slice(0, maxPlaylistEntriesPerGuild);
  void writePlaylistHistory(history);
}

export async function getRecentPlaylists(guildId, limit = 50) {
  const history = await readPlaylistHistory();
  await migrateLegacyPlaylists(guildId, history);
  return (history[guildId] ?? []).slice(0, limit);
}

export async function getSavedPlaylist(guildId, entryId) {
  const history = await readPlaylistHistory();
  await migrateLegacyPlaylists(guildId, history);
  return (history[guildId] ?? []).find((entry) => entry.id === entryId) ?? null;
}

export async function refreshPlaylistTitles(guildId, entryIds) {
  const history = await readPlaylistHistory();
  await migrateLegacyPlaylists(guildId, history);
  const entries = (history[guildId] ?? [])
    .filter((entry) => entryIds.includes(entry.id))
    .filter((entry) => entry.title === getPlaylistTitle(entry.url, entry.sourceType));

  if (entries.length === 0) return;

  const titles = await mapWithConcurrency(entries, 2, async (entry) => {
    try {
      const title = entry.sourceType === 'spotify'
        ? await getSpotifyCollectionTitle(entry.url)
        : await getYoutubePlaylistTitle(entry.url, { timeoutMs: 25_000 });
      return { entry, title };
    } catch (error) {
      console.warn(`Could not refresh playlist title for ${entry.url}: ${error instanceof Error ? error.message : String(error)}`);
      return { entry, title: null };
    }
  });
  let changed = false;

  for (const { entry, title } of titles) {
    if (title && title !== entry.title) {
      entry.title = title;
      changed = true;
    }
  }

  if (changed) {
    void writePlaylistHistory(history);
  }
}

export async function recordPlayQuery(guildId, userId, query) {
  const history = await readHistory();
  const guildHistory = history[guildId] ?? [];
  const normalizedQuery = query.trim();

  if (!normalizedQuery) return;

  const existingIndex = guildHistory.findIndex((entry) => entry.query === normalizedQuery);
  if (existingIndex >= 0) {
    guildHistory.splice(existingIndex, 1);
  }

  guildHistory.unshift({
    query: normalizedQuery,
    userId,
    usedAt: new Date().toISOString()
  });

  history[guildId] = guildHistory.slice(0, maxEntriesPerGuild);
  void writeHistory(history);
}

async function fetchSearchSuggestions(query, timeoutMs = 400) {
  if (!query || query.length < 2) return [];

  const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  let timeoutId;

  try {
    const promise = fetch(url, { signal: controller.signal });
    const timer = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error('Timeout'));
      }, timeoutMs).unref();
    });

    const res = await Promise.race([promise, timer]);
    if (!res.ok) return [];
    const data = await res.json();
    if (Array.isArray(data?.[1])) {
      return data[1].filter((item) => typeof item === 'string' && item.trim());
    }
  } catch {
    // Fail silently, fallback to history
  } finally {
    clearTimeout(timeoutId);
  }

  return [];
}

const autocompleteCache = new Map();
const AUTOCOMPLETE_CACHE_TTL = 15 * 60 * 1000;

function formatDurationMs(ms) {
  if (!ms || ms <= 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

async function searchItunesTracks(query, limit = 15, timeoutMs = 1200, parentSignal = null) {
  if (parentSignal?.aborted) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (parentSignal) {
    parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=${limit}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: controller.signal
    });

    if (!res.ok) return [];

    const data = await res.json();
    const items = Array.isArray(data?.results) ? data.results : [];

    return items.map((item) => {
      const title = item.trackName || 'Трек';
      const artist = item.artistName || 'Исполнитель';
      const duration = formatDurationMs(item.trackTimeMillis);
      const label = `${title} - ${artist} (${duration})`;
      const playValue = `${title} - ${artist}`;

      return {
        name: label.slice(0, 100),
        value: playValue.slice(0, 100)
      };
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function formatArtistName(name) {
  if (!name) return 'Исполнитель';
  if (name === name.toLowerCase()) {
    return name.replace(/(?:^|\s)\p{L}/gu, (c) => c.toUpperCase());
  }
  return name;
}

async function searchDeezerTracks(query, limit = 15, timeoutMs = 2000, parentSignal = null) {
  if (parentSignal?.aborted) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (parentSignal) {
    parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const url = `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: controller.signal
    });

    if (!res.ok) return [];

    const data = await res.json();
    const items = Array.isArray(data?.data) ? data.data : [];

    return items.map((item) => {
      const title = item.title || item.title_short || 'Трек';
      const artist = formatArtistName(item.artist?.name);
      const duration = formatDurationMs((item.duration || 0) * 1000);
      const label = `${title} - ${artist} (${duration})`;
      const playValue = `${title} - ${artist}`;

      return {
        name: label.slice(0, 100),
        value: playValue.slice(0, 100)
      };
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function getHistoryChoices(guildId, focusedValue, parentSignal = null) {
  const trimmed = (focusedValue || '').trim();

  // 1. Если пользователь ввел поисковый запрос (например "дора")
  if (trimmed) {
    if (isUrl(trimmed)) {
      return [{ name: trimmed.slice(0, 100), value: trimmed.slice(0, 100) }];
    }

    if (parentSignal?.aborted) return [];

    const cacheKey = trimmed.toLowerCase();
    const cached = autocompleteCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < AUTOCOMPLETE_CACHE_TTL) {
      return cached.results;
    }

    // Первичный поиск: Deezer (дает точные совпадения и форматы как в стримингах)
    let tracks = await searchDeezerTracks(trimmed, 15, 2000, parentSignal);

    if (parentSignal?.aborted) return [];

    // Запасной поиск: iTunes (если Deezer недоступен)
    if (!tracks || tracks.length === 0) {
      tracks = await searchItunesTracks(trimmed, 15, 1200, parentSignal);
    }

    if (tracks && tracks.length > 0) {
      autocompleteCache.set(cacheKey, {
        timestamp: Date.now(),
        results: tracks.slice(0, maxAutocompleteChoices)
      });
      return tracks.slice(0, maxAutocompleteChoices);
    }

    // Поиск по локальной истории сыгранных треков
    try {
      const needle = trimmed.toLowerCase();
      const recentPlayed = await getRecentPlayedTracks(guildId, 50);
      const matched = recentPlayed.filter((t) =>
        (t.title && t.title.toLowerCase().includes(needle)) ||
        (t.artist && t.artist.toLowerCase().includes(needle))
      );
      if (matched.length > 0) {
        return matched.map((t) => {
          const duration = t.duration ? formatDurationMs(t.duration * 1000) : '';
          const durSuffix = duration ? ` (${duration})` : '';
          const label = t.artist ? `${t.title} - ${t.artist}${durSuffix}` : `${t.title}${durSuffix}`;
          return {
            name: label.slice(0, 100),
            value: (t.url || t.title).slice(0, 100)
          };
        }).slice(0, maxAutocompleteChoices);
      }
    } catch {}

    return [];
  }

  // 2. Если поле ввода пустое (показываем недавние сыгранные треки)
  try {
    const recentPlayed = await getRecentPlayedTracks(guildId, 15);
    if (Array.isArray(recentPlayed) && recentPlayed.length > 0) {
      return recentPlayed.map((track) => {
        const durationFormatted = track.duration ? formatDurationMs(track.duration * 1000) : '';
        const durSuffix = durationFormatted ? ` (${durationFormatted})` : '';
        const artist = track.artist ? formatArtistName(track.artist) : '';
        const label = artist ? `${track.title} - ${artist}${durSuffix}` : `${track.title}${durSuffix}`;
        return {
          name: label.slice(0, 100),
          value: (track.url || track.title).slice(0, 100)
        };
      }).slice(0, maxAutocompleteChoices);
    }
  } catch {}

  return [];
}

async function readHistory() {
  if (historyCache) return historyCache;

  try {
    const raw = await fs.readFile(historyPath, 'utf8');
    historyCache = JSON.parse(raw);
  } catch {
    historyCache = {};
  }

  return historyCache;
}

async function writeHistory(history) {
  historyCache = history;
  const serialized = `${JSON.stringify(history, null, 2)}\n`;

  historyWritePromise = historyWritePromise
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      await fs.writeFile(historyPath, serialized, 'utf8');
    });

  await historyWritePromise;
}

async function readPlayedHistory() {
  if (playedHistoryCache) return playedHistoryCache;

  try {
    const raw = await fs.readFile(playedHistoryPath, 'utf8');
    playedHistoryCache = JSON.parse(raw);
  } catch {
    playedHistoryCache = {};
  }

  return playedHistoryCache;
}

async function writePlayedHistory(history) {
  playedHistoryCache = history;
  const serializedHistory = `${JSON.stringify(history, null, 2)}\n`;

  playedHistoryWritePromise = playedHistoryWritePromise
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(playedHistoryPath), { recursive: true });
      await fs.writeFile(playedHistoryPath, serializedHistory, 'utf8');
    });

  await playedHistoryWritePromise;
}

async function readPlaylistHistory() {
  if (playlistHistoryCache) return playlistHistoryCache;

  try {
    const raw = await fs.readFile(playlistHistoryPath, 'utf8');
    playlistHistoryCache = JSON.parse(raw);
  } catch {
    playlistHistoryCache = {};
  }

  return playlistHistoryCache;
}

async function writePlaylistHistory(history) {
  playlistHistoryCache = history;
  const serializedHistory = `${JSON.stringify(history, null, 2)}\n`;

  playlistHistoryWritePromise = playlistHistoryWritePromise
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(playlistHistoryPath), { recursive: true });
      await fs.writeFile(playlistHistoryPath, serializedHistory, 'utf8');
    });

  await playlistHistoryWritePromise;
}

async function migrateLegacyPlaylists(guildId, playlistHistory) {
  if (Array.isArray(playlistHistory[guildId])) {
    return;
  }

  const queryHistory = await readHistory();
  const entries = (queryHistory[guildId] ?? [])
    .map((entry) => ({
      sourceType: getPlaylistSourceType(entry.query),
      url: normalizePlaylistUrl(entry.query),
      addedAt: entry.usedAt
    }))
    .filter((entry) => entry.sourceType && entry.url);
  const seenUrls = new Set();

  playlistHistory[guildId] = entries
    .filter((entry) => {
      if (seenUrls.has(entry.url)) return false;
      seenUrls.add(entry.url);
      return true;
    })
    .slice(0, maxPlaylistEntriesPerGuild)
    .map((entry) => ({
      id: randomUUID(),
      url: entry.url,
      sourceType: entry.sourceType,
      title: getPlaylistTitle(entry.url, entry.sourceType),
      addedAt: entry.addedAt || new Date().toISOString()
    }));
  void writePlaylistHistory(playlistHistory);
}

function normalizePlaylistUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '');

    if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host) && url.searchParams.has('list')) {
      return `https://www.youtube.com/playlist?list=${url.searchParams.get('list')}`;
    }

    if (host === 'open.spotify.com' && /\/(playlist|album)\//.test(url.pathname)) {
      return `${url.origin}${url.pathname}`;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function getPlaylistSourceType(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '');

    if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)
      && url.pathname === '/playlist' && url.searchParams.has('list')) {
      return 'playlist';
    }

    if (host === 'open.spotify.com' && /^\/(playlist|album)\//.test(url.pathname)) {
      return 'spotify';
    }
  } catch {
    // Invalid historical queries are ignored.
  }

  return null;
}

function getPlaylistTitle(url, sourceType) {
  try {
    const parsedUrl = new URL(url);
    const playlistId = parsedUrl.searchParams.get('list') || parsedUrl.pathname.split('/').filter(Boolean).at(-1);
    const source = sourceType === 'spotify' ? 'Spotify' : 'YouTube';
    return `${source} плейлист${playlistId ? ` · ${playlistId}` : ''}`;
  } catch {
    return 'Плейлист';
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = [];
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      results.push(await mapper(item));
    }
  }));

  return results;
}

function trimChoiceName(value) {
  return value.length > maxAutocompleteValueLength
    ? `${value.slice(0, maxAutocompleteValueLength - 1)}…`
    : value;
}