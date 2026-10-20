// Discord Music Bot
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ytdlpWrapModule from 'yt-dlp-wrap';
import { config } from './config.js';

const YTDlpWrap = ytdlpWrapModule.default ?? ytdlpWrapModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const defaultYtdlpPath = path.join(projectRoot, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const defaultResolveTimeoutMs = 10_000;
const defaultStreamTimeoutMs = 15_000;
const slowOperationThresholdMs = 1_000;

const searchCache = new Map();
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1_000;

const streamUrlCache = new Map();
const STREAM_CACHE_TTL_MS = 3.5 * 60 * 60 * 1_000;
const MAX_STREAM_CACHE_SIZE = 500;

export function invalidateStreamUrl(url) {
  if (url) {
    streamUrlCache.delete(url);
  }
}

let ytdlp;

export async function ensureYtdlp() {
  const binaryPath = config.ytdlpPath || defaultYtdlpPath;

  if (!fs.existsSync(binaryPath)) {
    await YTDlpWrap.downloadFromGithub(binaryPath);
  }

  ytdlp = new YTDlpWrap(binaryPath);
  return ytdlp;
}

export function getYtdlp() {
  if (!ytdlp) {
    throw new Error('yt-dlp is not initialized');
  }

  return ytdlp;
}

function spawnYtdlp(args, signal = null) {
  return new Promise((resolve, reject) => {
    let stdoutData = '';
    let stderrData = '';
    const emitter = getYtdlp().exec(args, signal ? { signal } : undefined);

    if (emitter.ytDlpProcess?.pid) {
      try {
        os.setPriority(emitter.ytDlpProcess.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {}
    }

    emitter.ytDlpProcess?.stdout?.on('data', (chunk) => {
      stdoutData += chunk;
    });

    emitter.ytDlpProcess?.stderr?.on('data', (chunk) => {
      stderrData += chunk;
    });

    emitter.on('error', (err) => reject(err));

    emitter.on('close', (code) => {
      if (code === 0 || stdoutData.trim().length > 0) {
        resolve(stdoutData);
      } else {
        const err = new Error(stderrData.trim() || `yt-dlp exited with code ${code}`);
        reject(err);
      }
    });

    if (signal) {
      if (signal.aborted) {
        try { emitter.ytDlpProcess?.kill('SIGKILL'); } catch {}
        reject(new Error('Operation aborted'));
        return;
      }
      signal.addEventListener('abort', () => {
        try { emitter.ytDlpProcess?.kill('SIGKILL'); } catch {}
        reject(new Error('Operation aborted'));
      }, { once: true });
    }
  });
}

export function isUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function logSlowOperation(label, startedAt) {
  const durationMs = Date.now() - startedAt;

  if (durationMs >= slowOperationThresholdMs) {
    console.log(`[perf] ${label}: ${durationMs}ms`);
  }
}

function withTimeout(promiseFactory, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promiseFactory(null);
  }

  const controller = new AbortController();
  let timeoutId;

  const operationPromise = Promise.resolve().then(() => promiseFactory(controller.signal));
  operationPromise.catch(() => {});

  return Promise.race([
    operationPromise,
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs).unref();
    })
  ]).finally(() => clearTimeout(timeoutId));
}

let browserCookiesDisabled = false;

function hasCookieConfig() {
  return Boolean(config.ytdlpCookies || (!browserCookiesDisabled && config.ytdlpCookiesFromBrowser));
}

function isCookieReadError(error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);

  return message.includes('cookies database')
    || message.includes('Could not copy Chrome cookie database')
    || message.includes('could not find')
    || message.includes('cookie database');
}

function getCommonYtdlpArgs(includeCookies = true) {
  const args = [
    '--no-warnings',
    '--no-check-certificates',
    '--js-runtimes',
    'node'
  ];

  if (includeCookies) {
    if (config.ytdlpCookies) {
      args.push('--cookies', config.ytdlpCookies);
    } else if (config.ytdlpCookiesFromBrowser && !browserCookiesDisabled) {
      args.push('--cookies-from-browser', config.ytdlpCookiesFromBrowser);
    }
  }

  return args;
}

async function execYtdlp(args, options = {}, includeCookies = true) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : defaultStreamTimeoutMs;

  try {
    return await withTimeout(
      (signal) => spawnYtdlp([...args, ...getCommonYtdlpArgs(includeCookies)], signal),
      timeoutMs,
      'yt-dlp command'
    );
  } catch (error) {
    if (includeCookies && hasCookieConfig() && isCookieReadError(error)) {
      if (config.ytdlpCookiesFromBrowser && !browserCookiesDisabled) {
        browserCookiesDisabled = true;
        console.warn(`[yt-dlp] Browser cookies (${config.ytdlpCookiesFromBrowser}) failed (locked or unreadable). Disabled browser cookies to eliminate 3s delay.`);
      }
      return withTimeout(
        (signal) => spawnYtdlp([...args, ...getCommonYtdlpArgs(false)], signal),
        timeoutMs,
        'yt-dlp command'
      );
    }

    throw error;
  }
}

async function getVideoInfo(args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : defaultResolveTimeoutMs;
  const startedAt = Date.now();
  const isSearch = args.some((arg) => typeof arg === 'string' && arg.startsWith('ytsearch'));

  if (isSearch) {
    try {
      return await withTimeout(
        (signal) => getVideoInfoFromCommand([...args, ...getCommonYtdlpArgs(true)], signal),
        timeoutMs,
        'yt-dlp search lookup'
      );
    } catch (error) {
      if (hasCookieConfig()) {
        return await withTimeout(
          (signal) => getVideoInfoFromCommand([...args, ...getCommonYtdlpArgs(false)], signal),
          timeoutMs,
          'yt-dlp search lookup fallback'
        );
      }
      throw error;
    }
  }

  const clientProfiles = [
    [],
    ['--extractor-args', 'youtube:player_client=ios,web'],
    ['--extractor-args', 'youtube:player_client=android,web'],
    ['--extractor-args', 'youtube:player_client=mweb']
  ];

  let lastError = null;

  for (const clientArgs of clientProfiles) {
    try {
      return await withTimeout(
        (signal) => getVideoInfoFromCommand([...args, ...clientArgs, ...getCommonYtdlpArgs(true)], signal),
        timeoutMs,
        'yt-dlp metadata lookup'
      );
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('This playlist type is unviewable') || message.includes('Private video')) {
        break;
      }

      if (hasCookieConfig()) {
        try {
          return await withTimeout(
            (signal) => getVideoInfoFromCommand([...args, ...clientArgs, ...getCommonYtdlpArgs(false)], signal),
            timeoutMs,
            'yt-dlp metadata lookup'
          );
        } catch (cookieErr) {
          lastError = cookieErr;
        }
      }
    }
  }

  logSlowOperation('resolveYoutubeItems lookup failed', startedAt);
  console.error(`[getVideoInfo] Failed to fetch metadata for args:`, args, 'Last error:', lastError);
  throw lastError;
}

async function getVideoInfoFromCommand(args, signal = null) {
  const output = await spawnYtdlp(args, signal);
  const normalizedOutput = output.trim();

  if (!normalizedOutput) {
    throw new Error('yt-dlp did not return metadata');
  }

  try {
    return JSON.parse(normalizedOutput);
  } catch {
    const entries = normalizedOutput
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    if (entries.length === 0) {
      throw new Error('yt-dlp did not return metadata entries');
    }

    return entries;
  }
}

export async function resolveYoutubeRadio(videoId, requestedBy = 'Autoplay', options = {}) {
  // YouTube has discontinued RD mixes for unauthenticated yt-dlp (returns unviewable playlist type)
  return [];
}

function parseDurationToSeconds(durationStr) {
  if (!durationStr || typeof durationStr !== 'string') return null;
  const parts = durationStr.trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

export async function searchYoutubeHttp(query, limit = 1, requestedBy = null) {
  const startedAt = Date.now();
  const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    },
    body: JSON.stringify({
      query,
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20240701.01.00',
          hl: 'ru',
          gl: 'RU'
        }
      }
    }),
    signal: AbortSignal.timeout(6000)
  });

  if (!res.ok) {
    throw new Error(`InnerTube HTTP search returned status ${res.status}`);
  }

  const data = await res.json();
  const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

  const tracks = [];
  for (const item of contents) {
    const v = item.videoRenderer;
    if (!v?.videoId) continue;

    const videoId = v.videoId;
    const title = v.title?.runs?.[0]?.text || query;
    const duration = parseDurationToSeconds(v.lengthText?.simpleText);
    const uploader = v.ownerText?.runs?.[0]?.text || null;
    let artist = extractArtistFromTitle(title) || uploader;
    if (artist && artist.endsWith(' - Topic')) {
      artist = artist.replace(/ - Topic$/i, '').trim();
    }
    const thumbnail = v.thumbnail?.thumbnails?.at(-1)?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    tracks.push({
      title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      duration,
      thumbnail,
      artist,
      httpHeaders: null,
      sourcePlaylistTitle: null,
      requestedBy
    });

    if (tracks.length >= limit) break;
  }

  if (tracks.length === 0) {
    throw new Error(`InnerTube HTTP search returned no results for: ${query}`);
  }

  logSlowOperation(`searchYoutubeHttp ("${query}", limit: ${limit})`, startedAt);
  return tracks;
}

export async function resolveYoutubeItems(query, requestedBy, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 1;
  const normalizedQuery = normalizeYoutubeInput(query);
  const youtubePlaylist = isYoutubePlaylistUrl(normalizedQuery);
  const shouldReturnMultiple = !isUrl(normalizedQuery) && limit > 1;

  const cacheKey = `${normalizedQuery}_${limit}_${youtubePlaylist}`;
  const cachedEntry = searchCache.get(cacheKey);
  if (cachedEntry && Date.now() - cachedEntry.timestamp < SEARCH_CACHE_TTL_MS) {
    return cachedEntry.tracks.map((track) => ({ ...track, requestedBy }));
  }

  // 1. Ultra-fast direct HTTP InnerTube search for text queries (not URLs/playlists)
  if (!isUrl(normalizedQuery)) {
    try {
      const lowerQuery = normalizedQuery.toLowerCase();
      const hasMusicKeywords = lowerQuery.includes('audio')
        || lowerQuery.includes('official')
        || lowerQuery.includes('lyrics')
        || lowerQuery.includes('song')
        || lowerQuery.includes('mix')
        || lowerQuery.includes('радио')
        || lowerQuery.includes('radio')
        || lowerQuery.includes('песни')
        || lowerQuery.includes('topic');
      const effectiveSearchQuery = `${normalizedQuery}${hasMusicKeywords ? '' : ' official audio'}`;

      const httpTracks = await searchYoutubeHttp(effectiveSearchQuery, limit, requestedBy);
      if (httpTracks && httpTracks.length > 0) {
        searchCache.set(cacheKey, {
          timestamp: Date.now(),
          tracks: httpTracks.map((t) => ({ ...t, requestedBy: null }))
        });
        return httpTracks;
      }
    } catch (httpErr) {
      console.warn(`[resolveYoutubeItems] Fast HTTP search failed, falling back to yt-dlp: ${httpErr.message}`);
    }
  }

  let effectiveSearchQuery = normalizedQuery;
  if (!isUrl(normalizedQuery)) {
    const lowerQuery = normalizedQuery.toLowerCase();
    const hasMusicKeywords = lowerQuery.includes('audio')
      || lowerQuery.includes('official')
      || lowerQuery.includes('lyrics')
      || lowerQuery.includes('song')
      || lowerQuery.includes('mix')
      || lowerQuery.includes('радио')
      || lowerQuery.includes('radio')
      || lowerQuery.includes('песни')
      || lowerQuery.includes('topic');
    effectiveSearchQuery = `ytsearch${limit}:${normalizedQuery}${hasMusicKeywords ? '' : ' official audio'}`;
  }

  const info = await getVideoInfo(
    isUrl(normalizedQuery) && youtubePlaylist
      ? [
        normalizedQuery,
        '--dump-single-json',
        '--flat-playlist',
        ...(Number.isInteger(options.limit) && options.limit > 0 ? ['--playlist-end', String(limit)] : [])
      ]
      : isUrl(normalizedQuery)
        ? [normalizedQuery, '--dump-single-json', '--no-playlist']
        : [effectiveSearchQuery, '--dump-single-json', '--flat-playlist']
  , options);

  let tracks = [];
  if (Array.isArray(info)) {
    tracks = selectEntries(info, youtubePlaylist, shouldReturnMultiple ? limit : 1)
      .filter((entry) => entry && (entry.url || entry.webpage_url || entry.id))
      .map((entry) => toTrack(entry, normalizedQuery, requestedBy));
  } else if (Array.isArray(info?.entries)) {
    tracks = selectEntries(info.entries, youtubePlaylist, shouldReturnMultiple ? limit : 1)
      .filter((entry) => entry && (entry.url || entry.webpage_url || entry.id))
      .map((entry) => toTrack(entry, normalizedQuery, requestedBy, youtubePlaylist ? info.title : null));
  } else if (info && (info.url || info.webpage_url || info.id)) {
    tracks = [toTrack(info, normalizedQuery, requestedBy)];
  }

  searchCache.set(cacheKey, {
    timestamp: Date.now(),
    tracks: tracks.map((t) => ({ ...t, requestedBy: null }))
  });

  return tracks;
}

export async function getYoutubePlaylistTitle(query, options = {}) {
  const normalizedQuery = normalizeYoutubeInput(query);

  if (!isYoutubePlaylistUrl(normalizedQuery)) {
    return null;
  }

  const info = await getVideoInfo([
    normalizedQuery,
    '--dump-single-json',
    '--flat-playlist',
    '--playlist-end',
    '1'
  ], options);

  return typeof info?.title === 'string' && info.title.trim() ? info.title.trim() : null;
}

function selectEntries(entries, includeAll, limit = 1) {
  return includeAll ? entries : entries.slice(0, limit);
}

export function isYoutubePlaylistUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '');

    if (!['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      return false;
    }

    return url.pathname === '/playlist' && url.searchParams.has('list');
  } catch {
    return false;
  }
}

function normalizeYoutubeInput(value) {
  const trimmedValue = value.trim();

  try {
    const url = new URL(trimmedValue);
    const host = url.hostname.replace(/^www\./, '');

    if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
      return trimmedValue;
    }

    if (host === 'youtu.be') {
      const videoId = url.pathname.split('/').filter(Boolean)[0];
      return videoId ? `https://www.youtube.com/watch?v=${videoId}` : trimmedValue;
    }

    const videoId = url.searchParams.get('v');
    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    return trimmedValue;
  } catch {
    return trimmedValue;
  }
}

export function extractYoutubeVideoId(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('v')) return parsed.searchParams.get('v');
    if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1);
  } catch {
    const match = String(url).match(/(?:v=|\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  }
  return null;
}

export function extractArtistFromTitle(title) {
  if (!title) return null;
  const match = String(title).match(/^([^\n]+?)\s+[\-\—\–\|]\s+([^\n]+)$/);
  if (match) {
    const candidateArtist = match[1].trim();
    if (candidateArtist.length >= 2 && candidateArtist.length <= 40 && !/^\d+$/.test(candidateArtist)) {
      return candidateArtist;
    }
  }
  return null;
}

function toTrack(entry, fallbackQuery, requestedBy, sourcePlaylistTitle = null) {
  const rawUrl = entry.webpage_url || entry.original_url || entry.url || (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : null);
  const validUrl = rawUrl ? normalizeYoutubeUrl(rawUrl) : (isUrl(fallbackQuery) ? fallbackQuery : null);
  const videoId = entry.id || extractYoutubeVideoId(validUrl);

  let thumbnail = entry.thumbnail;
  if (!thumbnail && Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0) {
    thumbnail = entry.thumbnails[entry.thumbnails.length - 1]?.url || null;
  }
  if (!thumbnail && videoId) {
    thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }

  let artist = entry.artist;
  if (!artist && entry.title) {
    artist = extractArtistFromTitle(entry.title);
  }
  if (!artist) {
    artist = entry.uploader || entry.channel || null;
  }
  if (artist && artist.endsWith(' - Topic')) {
    artist = artist.replace(/ - Topic$/i, '').trim();
  }

  return {
    title: entry.title || fallbackQuery,
    url: validUrl,
    duration: entry.duration,
    thumbnail: thumbnail || null,
    artist: artist || null,
    httpHeaders: entry.http_headers || entry.httpHeaders || null,
    sourcePlaylistTitle,
    requestedBy
  };
}

function normalizeYoutubeUrl(value) {
  if (isUrl(value)) return value;

  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return `https://www.youtube.com/watch?v=${value}`;
  }

  return value;
}

export async function getStreamUrl(url, options = {}) {
  const cached = streamUrlCache.get(url);
  if (cached && Date.now() - cached.timestamp < STREAM_CACHE_TTL_MS) {
    return cached.streamUrl;
  }

  const startedAt = Date.now();
  const formatArgs = ['-f', 'ba/ba*/b/bestaudio/best', '-g', '--no-playlist'];

  const clientProfiles = [
    [url, ...formatArgs, '--extractor-args', 'youtube:player_client=android'],
    [url, ...formatArgs, '--extractor-args', 'youtube:player_client=android,web'],
    [url, ...formatArgs, '--extractor-args', 'youtube:player_client=ios,web'],
    [url, ...formatArgs, '--extractor-args', 'youtube:player_client=visionos'],
    [url, ...formatArgs]
  ];

  let lastError = null;

  for (const args of clientProfiles) {
    try {
      const output = await execYtdlp(args, options, true);
      const streamUrl = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (streamUrl) {
        if (streamUrlCache.size >= MAX_STREAM_CACHE_SIZE) {
          const firstKey = streamUrlCache.keys().next().value;
          streamUrlCache.delete(firstKey);
        }
        streamUrlCache.set(url, { streamUrl, timestamp: Date.now() });
        logSlowOperation('getStreamUrl extraction', startedAt);
        return streamUrl;
      }
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('confirm your age') || message.includes('Sign in to confirm') || message.includes('Private video')) {
        break;
      }
    }
  }

  if (hasCookieConfig()) {
    for (const args of clientProfiles) {
      try {
        const output = await execYtdlp(args, options, false);
        const streamUrl = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        if (streamUrl) {
          if (streamUrlCache.size >= MAX_STREAM_CACHE_SIZE) {
            const firstKey = streamUrlCache.keys().next().value;
            streamUrlCache.delete(firstKey);
          }
          streamUrlCache.set(url, { streamUrl, timestamp: Date.now() });
          logSlowOperation('getStreamUrl extraction (fallback without cookies)', startedAt);
          return streamUrl;
        }
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('confirm your age') || message.includes('Sign in to confirm') || message.includes('Private video')) {
          break;
        }
      }
    }
  }

  logSlowOperation('getStreamUrl extraction failed', startedAt);
  console.error(`[getStreamUrl] Failed to extract stream URL for ${url}. Last error:`, lastError);
  throw lastError;
}
