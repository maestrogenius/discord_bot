// Discord Music Bot
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus
} from '@discordjs/voice';
import {
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder
} from 'discord.js';
import ffmpegPath from 'ffmpeg-static';
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import os from 'node:os';

function getFfmpegBinary() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  if (process.platform === 'linux') {
    if (fs.existsSync('/usr/bin/ffmpeg')) return '/usr/bin/ffmpeg';
    if (fs.existsSync('/usr/local/bin/ffmpeg')) return '/usr/local/bin/ffmpeg';
  }
  return ffmpegPath;
}

let hasAsoftclipCached = null;
function supportsAsoftclip() {
  if (hasAsoftclipCached !== null) return hasAsoftclipCached;
  try {
    const out = execSync(`"${getFfmpegBinary()}" -filters`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    hasAsoftclipCached = out.includes('asoftclip');
  } catch {
    hasAsoftclipCached = true;
  }
  return hasAsoftclipCached;
}
import { createPlayerControls, createFilterControls } from './player-controls.js';
import { recordPlayedTrack } from './play-history.js';
import { extractArtistFromTitle, getStreamUrl, invalidateStreamUrl, isUrl, isYoutubePlaylistUrl, resolveYoutubeItems } from './youtube.js';
import { isSpotifyPlaylistOrAlbumUrl, isSpotifyUrl, spotifyToSearchQueries } from './spotify.js';
import { getAverageColor } from 'fast-average-color-node';

const queues = new Map();
const maxQueueSize = 400;
const maxAutoplayMemorySize = 100;
const maxSessionContextSize = 10;
const maxPrefetchTracks = 3;
const maxFallbackCandidates = 3;
const searchResolveTimeoutMs = 12_000;
const autoplayResolveTimeoutMs = 15_000;
const playlistResolveTimeoutMs = 25_000;
const metadataResolveTimeoutMs = 8_000;
const playbackResolveTimeoutMs = 20_000;
const playbackStreamExtractTimeoutMs = 25_000;
const slowOperationThresholdMs = 1_000;

const trackStates = {
  queued: 'queued',
  resolving: 'resolving',
  ready: 'ready',
  failed: 'failed',
  fallbackReady: 'fallback_ready'
};

const weakMatchTerms = [
  'live',
  'karaoke',
  'instrumental',
  'slowed',
  'sped up',
  'speed up',
  'nightcore',
  '8d',
  'reaction',
  'cover',
  'tribute',
  'podcast',
  'interview',
  'comedy',
  'standup',
  'remix',
  'dj mix',
  'club mix',
  'edit',
  'version'
];

const CYRILLIC_TO_LATIN_MAP = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'y',
  'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
  'х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'
};

function toLatin(text) {
  return String(text || '')
    .toLowerCase()
    .split('')
    .map((char) => CYRILLIC_TO_LATIN_MAP[char] || char)
    .join('');
}

function normalizeMatchText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[\[\]\(\)\-_,.!?'"`~:;\\/|]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function hasCyrillic(text) {
  return /[а-яё]/i.test(String(text || ''));
}

function extractYoutubeVideoId(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('v')) return parsed.searchParams.get('v');
    if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1);
  } catch {
    const match = url.match(/(?:v=|\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  }
  return null;
}

function includesWholePhrase(text, phrase) {
  return Boolean(phrase) && text.includes(phrase);
}

function includesAnyWeakTerm(text) {
  return weakMatchTerms.some((term) => text.includes(term));
}

function cleanTokens(text) {
  return normalizeMatchText(text)
    .replace(/\b(feat|ft|featuring|official|audio|video|lyrics|remastered|remaster|topic)\b/gi, '')
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

function getCanonicalTitle(raw) {
  if (!raw) return '';
  return String(raw)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\s*-\s*topic/gi, '')
    .replace(/\s*\[[^\]]*\]/g, ' ')
    .replace(/\s*\([^)]*\)/g, ' ')
    .replace(/\b(feat|ft|featuring|official|audio|video|music video|lyric|lyrics|клип|премьера|remaster|remastered|hd|4k|slowed|speed up|sped up|remix|edit)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .trim();
}

function isSameSong(titleA, titleB) {
  const normA = getCanonicalTitle(titleA);
  const normB = getCanonicalTitle(titleB);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  if (normA.length >= 6 && normB.length >= 6) {
    if (normA.includes(normB) || normB.includes(normA)) return true;
  }
  return false;
}

const JUNK_TERMS = [
  'remix', 'rmx', 'ремикс',
  'hardstyle', 'хардстайл',
  'slowed', 'reverb', 'замедлен',
  'sped up', 'speed up', 'speedup', 'ускорен',
  'nightcore', 'найткор',
  'bass boosted', 'bassboost', 'басс',
  'phonk', 'фонк',
  'mashup', 'мэшап', 'мешап',
  '8d audio', '8d',
  'edit', 'эдит',
  'bootleg', 'flip', 'vip mix',
  'tiktok', 'тикток',
  'cover', 'кавер',
  'karaoke', 'караоке', 'instrumental', 'минус', 'минусовка',
  'reaction', 'реакция',
  '1 hour', '10 hours', '1 час', '10 часов', 'loop', 'зациклен',
  'soundtrack', 'ost',
  'live', 'лайв', 'концерт', 'авторадио',
  'radio edit',
  // Non-music YouTube content (guides, tutorials, vlogs, reviews, discord setups, etc.)
  'tutorial', 'guide', 'гайд', 'полный гайд', 'обзор', 'review',
  'how to', 'how to setup', 'как настроить', 'как добавить', 'как искать',
  'discord bot', 'дискорд бот', 'дискорд сервер', 'discord server', 'jockie music',
  'разбор', 'разбор клипа', 'разбор трека', 'подкаст', 'podcast', 'интервью', 'interview'
];

function isJunkOrRemixTrack(title) {
  if (!title) return false;
  const lower = String(title).toLowerCase();
  return JUNK_TERMS.some((term) => lower.includes(term));
}

function cleanChannelOrArtistName(name) {
  if (!name) return '';
  return String(name)
    .replace(/\s*-\s*topic$/i, '')
    .replace(/\s+(?:for\s+discord|official(?:\s+channel)?|music|vevo|records|beats|tv)\b/gi, '')
    .trim();
}

function scoreAutoplayCandidate(candidate, seedTrack, history, sessionArtists = []) {
  let score = 50;
  const candTitle = normalizeMatchText(candidate.title);
  const candArtist = normalizeMatchText(cleanChannelOrArtistName(candidate.artist || candidate.uploader || ''));
  const seedArtist = normalizeMatchText(cleanChannelOrArtistName(seedTrack.artist || ''));

  // 1. Official audio or studio release bonus
  if (candTitle.includes('official audio') || candTitle.includes('official music video') || candTitle.includes('премьера клипа')) {
    score += 20;
  }
  if (candArtist.includes('topic') || candidate.channel?.includes('Topic')) {
    score += 25;
  }

  // 2. Playlist / Session artist connection (huge bonus if candidate is from an artist that was part of this playlist/session)
  const isSessionArtist = sessionArtists.some((a) => a && (candArtist.includes(a) || a.includes(candArtist)));
  if (isSessionArtist) {
    score += 35;
  }

  // 3. Same artist vs Different artist balance
  const isSameArtist = seedArtist && (candArtist.includes(seedArtist) || seedArtist.includes(candArtist));
  const last3Artists = history.slice(-3).map((h) => normalizeMatchText(cleanChannelOrArtistName(h.artist || '')));
  const sameArtistInLast3 = last3Artists.filter((a) => a && (a.includes(seedArtist) || seedArtist.includes(a))).length;

  if (isSameArtist) {
    if (sameArtistInLast3 >= 2) {
      // Artist fatigue: artist played 2+ times in a row, prefer artist rotation
      score -= 30;
    } else if (sameArtistInLast3 === 1) {
      // Second song in a row by this artist: moderate bonus
      score += 25;
    } else {
      // First recommendation after seed: strongly encourage a 2nd hit by the same artist!
      score += 45;
    }
  } else {
    // Different similar artist from the same genre and language
    score += 25;
  }

  return score;
}

function extractCleanArtistAndSong(track) {
  let artist = track?.artist ? String(track.artist).trim() : '';
  let title = track?.title ? String(track.title).trim() : (track?.searchQuery ? String(track.searchQuery).trim() : '');

  artist = cleanChannelOrArtistName(artist);

  const titleArtist = extractArtistFromTitle(title);
  if (titleArtist) {
    const looksLikeUploader = !artist || /\b(records|music|vevo|channel|tv|beats|edits|sound|sounds|prod|label)\b/i.test(artist);
    if (looksLikeUploader || !artist || titleArtist.toLowerCase() === artist.toLowerCase() || (artist.length > 25 && titleArtist.length < 25)) {
      artist = titleArtist;
    }
  }

  if (!artist && track?.searchQuery) {
    const queryArtist = extractArtistFromTitle(track.searchQuery);
    if (queryArtist) {
      artist = queryArtist;
    }
  }

  artist = cleanChannelOrArtistName(artist);

  const cleanTitle = title
    .replace(/^([^\n]+?)\s+[\-\—\–\|]\s+/i, '')
    .replace(/\s*\[[^\]]*\]/g, ' ')
    .replace(/\s*\([^)]*\)/g, ' ')
    .replace(/\b(official|audio|video|music video|lyric|lyrics|клип|премьера|remaster|remastered|hd|4k)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { artist, cleanTitle };
}

export function buildAudioFilterArgs(filters = {}) {
  const parts = [];

  // 1. СНАЧАЛА меняем скорость и питч (если включены вместе с другими эффектами)
  if (filters.slowed) {
    parts.push(
      'aresample=48000',
      'asetrate=48000*0.85',
      'aresample=48000',
      // Если 8D НЕ включен, добавляем обычный реверб для Slowed
      // (если 8D включен, он сам добавит свою пространственную акустику ниже)
      ...(!filters.eightD
        ? [
            'aecho=0.85:0.85:43|89|139|211:0.32|0.24|0.16|0.09',
            'treble=g=-3.5:f=4200',
            'extrastereo=m=1.4',
          ]
        : [])
    );
  } else if (filters.speedup) {
    parts.push(
      'aresample=48000',
      'asetrate=48000*1.16',
      'aresample=48000',
      'bass=g=3.5:f=65:w=0.5'
    );
  }

  // 2. ЭКВАЛИЗАЦИЯ БАСА («перегруженный» мемный/фонк Bassboost Hard/Extreme с мягким сатуратором)
  const hasBassboost = Boolean(filters.bassboost || filters.bassboostHard);
  if (hasBassboost) {
    if (supportsAsoftclip()) {
      parts.push(
        'bass=g=18:f=55:w=0.45',
        'asoftclip=type=tanh:param=2.2',
        'alimiter=limit=0.92:attack=3:release=40:level=0'
      );
    } else {
      parts.push(
        'bass=g=18:f=55:w=0.45',
        'volume=1.8',
        'alimiter=limit=0.92:attack=3:release=40:level=0'
      );
    }
  }

  // 3. СТУДИЙНЫЙ 8D AUDIO (Пресет в стиле 8D Tunes / 8D Era)
  if (filters.eightD) {
    parts.push(
      // Шаг А: Distance EQ — отодвигаем сцену от ушей на 2-3 метра
      'bass=g=4:f=60:w=0.5',                  // Теплый концертный фундамент
      'equalizer=f=3000:t=q:w=1.2:g=-2.5',    // Срезаем резкость (эффект удаленной сцены)
      'treble=g=-2:f=9000',                   // Убираем цифровой "песок" на верхах

      // Шаг Б: Плавное вращение по синусоиде (полный круг за ~11.7 сек)
      // amount=0.82 не дает противоположному уху глохнуть в ноль
      'apulsator=mode=sine:timing=hz:hz=0.085:amount=0.82:offset_l=0:offset_r=0.5',

      // Шаг В: Бинауральная задержка Хааса (18мс) — выносит звук из головы наружу
      'stereowiden=delay=18:feedback=0.25:crossfeed=0.35:drymix=0.85',

      // Шаг Г: Акустика зала ПОВЕРХ вращения (хвост эха остается позади движения звука)
      'aecho=0.85:0.80:47|97|163|251:0.26|0.19|0.12|0.07'
    );
  }

  // 4. ФИНАЛЬНЫЙ ЛИМИТЕР (для защиты от перегруза при пространственных эффектах Slowed/SpeedUP/8D, если не активен bassboost)
  if (!hasBassboost && (filters.slowed || filters.speedup || filters.eightD)) {
    parts.push('alimiter=level_in=1:level_out=0.95:limit=0.95:attack=5:release=50:level=0');
  }

  if (parts.length === 0) {
    return [];
  }

  return ['-af', parts.join(',')];
}

function scoreSpotifyCandidate(candidate, sourceTrack) {
  const candidateTitle = normalizeMatchText(candidate.title);
  const candidateArtist = normalizeMatchText(candidate.artist || candidate.uploader || '');
  const candidateChannel = normalizeMatchText(candidate.channel || '');
  const combinedCandidate = `${candidateTitle} ${candidateArtist} ${candidateChannel}`.trim();
  const combinedCandidateLatin = toLatin(combinedCandidate);

  const spotifyTitle = normalizeMatchText(sourceTrack.spotifyTitle || sourceTrack.title);
  const spotifyArtists = Array.isArray(sourceTrack.spotifyArtists)
    ? sourceTrack.spotifyArtists.map((artist) => normalizeMatchText(artist)).filter(Boolean)
    : [];

  let artistMatched = false;
  if (spotifyArtists.length > 0) {
    for (const artist of spotifyArtists) {
      const normArtist = normalizeMatchText(artist);
      const latinArtist = toLatin(normArtist);

      if (
        combinedCandidate.includes(normArtist) ||
        combinedCandidateLatin.includes(latinArtist)
      ) {
        artistMatched = true;
        break;
      }
    }

    if (!artistMatched) {
      return -100;
    }
  }

  let score = 20;

  const titleTokens = cleanTokens(spotifyTitle);
  let matchedTitleTokens = 0;
  for (const token of titleTokens) {
    const latinToken = toLatin(token);
    if (combinedCandidate.includes(token) || combinedCandidateLatin.includes(latinToken)) {
      matchedTitleTokens += 1;
    }
  }

  if (titleTokens.length > 0) {
    const ratio = matchedTitleTokens / titleTokens.length;
    score += Math.round(ratio * 30);
  }

  if (candidateArtist.includes('topic') || candidateTitle.includes('topic') || candidateChannel.includes('topic')) {
    score += 15;
  }

  const spotifyDuration = Number(sourceTrack.spotifyDurationMs) / 1000;
  const candidateDuration = Number(candidate.duration);

  if (Number.isFinite(spotifyDuration) && Number.isFinite(candidateDuration)) {
    const delta = Math.abs(candidateDuration - spotifyDuration);

    if (delta <= 3) {
      score += 35;
    } else if (delta <= 8) {
      score += 15;
    } else if (delta <= 20) {
      score += 5;
    } else if (delta >= 30) {
      score -= 25;
    }
  }

  if (includesAnyWeakTerm(candidateTitle) && !includesAnyWeakTerm(spotifyTitle)) {
    score -= 15;
  }

  return score;
}

function rankTrackCandidates(candidates, sourceTrack) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }

  if (!sourceTrack.spotifyTitle && !sourceTrack.spotifyArtists?.length) {
    return candidates;
  }

  return candidates
    .map((candidate) => ({
      candidate,
      score: scoreSpotifyCandidate(candidate, sourceTrack)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.candidate);
}

function isRecoverableTrackError(error) {
  const message = error instanceof Error ? error.message : String(error);

  return message.includes('Video unavailable')
    || message.includes('This video is not available')
    || message.includes('copyright claim')
    || message.includes('Sign in to confirm')
    || message.includes('confirm your age')
    || message.includes('inappropriate for some users')
    || message.includes('No matching track found')
    || message.includes('No playable source found')
    || message.includes('403 Forbidden')
    || message.includes('Server returned 403');
}

function needsTrackMetadata(item) {
  if (!item) return false;

  return Boolean(item.url) && (!item.thumbnail || !item.artist || !item.duration);
}

function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;

  const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
  const minutes = Math.floor((totalSeconds / 60) % 60).toString().padStart(2, '0');
  const hours = Math.floor(totalSeconds / 3600);

  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${Number(minutes)}:${seconds}`;
}

function formatRequester(requestedBy) {
  if (!requestedBy) return 'Unknown';

  if (typeof requestedBy === 'object' && requestedBy.id) {
    return `<@${requestedBy.id}>`;
  }

  return String(requestedBy);
}

function formatTrackTitle(item) {
  return String(item.title || 'Unknown track')
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '[')
    .replaceAll(']', ']');
}

function formatDiscordTimestamp(date = new Date()) {
  return `<t:${Math.floor(date.getTime() / 1000)}:t>`;
}

const accentColorCache = new Map();
const MAX_COLOR_CACHE_SIZE = 500;

async function getTrackAccentColor(item) {
  if (item?.accentColor) return item.accentColor;
  const thumbnailUrl = typeof item === 'string' ? item : item?.thumbnail;
  if (!thumbnailUrl) return 0x2b9ab3;

  if (accentColorCache.has(thumbnailUrl)) {
    const cached = accentColorCache.get(thumbnailUrl);
    if (item && typeof item === 'object') item.accentColor = cached;
    return cached;
  }

  try {
    const color = await getAverageColor(thumbnailUrl);
    const parsed = Number.parseInt(color.hex.replace('#', ''), 16) || 0x2b9ab3;
    if (accentColorCache.size >= MAX_COLOR_CACHE_SIZE) {
      const firstKey = accentColorCache.keys().next().value;
      accentColorCache.delete(firstKey);
    }
    accentColorCache.set(thumbnailUrl, parsed);
    if (item && typeof item === 'object') item.accentColor = parsed;
    return parsed;
  } catch {
    return 0x2b9ab3;
  }
}

function logSlowOperation(label, startedAt, context) {
  const durationMs = Date.now() - startedAt;

  if (durationMs >= slowOperationThresholdMs) {
    console.log(`[perf] ${label}: ${durationMs}ms${context ? ` (${context})` : ''}`);
  }
}

function isTimeoutError(value) {
  return String(value || '').includes('timed out');
}

function isNetworkAccessError(error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);

  return message.includes('EACCES')
    || message.includes('WinError 10013')
    || message.includes('fetch failed')
    || message.includes('Unable to download API page')
    || message.includes('Failed to establish a new connection');
}

function createQueueItem(track) {
  const item = {
    ...track,
    state: track.state || trackStates.queued,
    candidates: Array.isArray(track.candidates) ? [...track.candidates] : [],
    failedCandidates: Array.isArray(track.failedCandidates) ? [...track.failedCandidates] : [],
    lastError: track.lastError || null,
    resolvePromise: null,
    metadataPromise: null,
    streamPrefetchPromise: track.streamPrefetchPromise || null,
    prefetchedStreamUrl: track.prefetchedStreamUrl || null
  };

  if (!item.thumbnail && item.url) {
    const videoId = extractYoutubeVideoId(item.url);
    if (videoId) {
      item.thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }
  }

  return item;
}

function toTrackCandidate(track) {
  if (!track?.url || !isUrl(track.url)) {
    return null;
  }

  let thumbnail = track.thumbnail;
  if (!thumbnail) {
    const videoId = extractYoutubeVideoId(track.url);
    if (videoId) {
      thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }
  }

  return {
    title: track.title,
    url: track.url,
    duration: track.duration,
    thumbnail,
    artist: track.artist,
    httpHeaders: track.httpHeaders || null
  };
}

function mergeTrackData(target, source) {
  if (!target || !source) {
    return target;
  }

  target.url = source.url || target.url;
  target.title = source.title || target.title;
  target.duration = source.duration || target.duration;
  target.thumbnail = source.thumbnail || target.thumbnail;
  if (!target.thumbnail && target.url) {
    const videoId = extractYoutubeVideoId(target.url);
    if (videoId) {
      target.thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }
  }
  target.artist = source.artist || target.artist;
  target.httpHeaders = source.httpHeaders || null;
  return target;
}

function dedupeTrackCandidates(candidates) {
  const seenUrls = new Set();
  const dedupedCandidates = [];

  for (const candidate of candidates) {
    if (!candidate?.url || seenUrls.has(candidate.url)) {
      continue;
    }

    seenUrls.add(candidate.url);
    dedupedCandidates.push(candidate);
  }

  return dedupedCandidates;
}

export function getGuildQueue(guildId) {
  let queue = queues.get(guildId);

  if (!queue) {
    queue = new MusicQueue(guildId);
    queues.set(guildId, queue);
  }

  return queue;
}

export class MusicQueue {
  constructor(guildId) {
    this.guildId = guildId;
    this.connection = null;
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    });
    this.textChannel = null;
    this.items = [];
    this.history = [];
    this.current = null;
    this.ffmpeg = null;
    this.nowPlayingMessage = null;
    this.destroyed = false;
    this.isStarting = false;
    this.loopCurrent = false;
    this.autoplayEnabled = false;
    this.autoplayHistory = [];
    this.sessionContext = [];
    this.sessionArtists = new Set();
    this.activePlaylistTitle = null;
    this.skipRequested = false;
    this.disconnectTimer = null;
    this.backgroundPreparationPromise = null;
    this.prefetchGeneration = 0;
    this.prefetchDebounceTimer = null;
    this.playRequestId = 0;
    this.filters = {
      slowed: false,
      bassboost: false,
      speedup: false,
      eightD: false
    };
    this.isApplyingFilter = false;
    this.nowPlayingItem = null;
    this.hasPlaybackError = false;
    this.crossfadeEnabled = true;
    this.crossfadeDuration = 3;
    this.crossfadeTimer = null;
    this.isCrossfading = false;

    this.player.on(AudioPlayerStatus.Idle, (oldState, newState) => {
      console.log(`[AudioPlayer] Transition from ${oldState.status} to Idle (Guild: ${this.guildId}, Track: ${this.current?.title || 'none'})`);
      if (this.isCrossfading || this.isApplyingFilter) {
        console.log(`[AudioPlayer] Ignoring Idle transition during active transition (crossfade: ${this.isCrossfading}, filter: ${this.isApplyingFilter})`);
        return;
      }
      this.clearCrossfadeTimer();
      this.cleanupFfmpeg();
      if (this.loopCurrent && this.current && !this.skipRequested) {
        console.log(`[MusicQueue] Loop active: repeating "${this.current.title}"`);
        const repeatItem = {
          ...this.current,
          playbackPositionSec: 0,
          startedAt: null
        };
        this.items.unshift(repeatItem);
        this.current = null;
      }
      this.skipRequested = false;
      this.hasPlaybackError = false;
      this.isStarting = false;
      void this.playNext();
    });

    this.player.on(AudioPlayerStatus.Playing, () => {
      console.log(`[AudioPlayer] Now Playing: ${this.current?.title || 'unknown'} (Guild: ${this.guildId})`);
    });

    this.player.on('error', (error) => {
      console.error(`[AudioPlayer] Error event (Guild: ${this.guildId}, Track: ${this.current?.title || 'none'}):`, error);
      this.hasPlaybackError = true;
      this.cleanupFfmpeg();
      if (this.current?.isAutoplay && this.autoplayEnabled) {
        this.autoplayEnabled = false;
        this.textChannel?.send('Autoplay не смог продолжить воспроизведение и был выключен.').catch(() => {});
      }
      this.textChannel?.send('Ошибка воспроизведения.').catch(() => {});
    });
  }

  async connect(voiceChannel, textChannel) {
    this.clearDisconnectTimer();
    this.textChannel = textChannel;

    // 1. If already connected to this channel and ready, keep using the existing active connection
    if (
      this.connection &&
      this.connection.state.status === VoiceConnectionStatus.Ready &&
      this.connection.joinConfig?.channelId === voiceChannel.id
    ) {
      return;
    }

    const existingConnection = getVoiceConnection(this.guildId);
    if (
      existingConnection &&
      existingConnection.state.status === VoiceConnectionStatus.Ready &&
      existingConnection.joinConfig?.channelId === voiceChannel.id
    ) {
      this.connection = existingConnection;
      this.connection.subscribe(this.player);
      return;
    }

    const permissions = voiceChannel.permissionsFor(voiceChannel.client.user);
    const missingPermissions = permissions?.missing(['ViewChannel', 'Connect', 'Speak']) ?? [];

    if (missingPermissions.length > 0) {
      throw new Error(`У бота нет прав в голосовом канале: ${missingPermissions.join(', ')}`);
    }

    const createConnection = () => {
      const conn = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: this.guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true
      });

      conn.on('error', (err) => {
        console.error(`[VoiceConnection] Connection error (${this.guildId}):`, err);
      });

      conn.on('stateChange', (oldState, newState) => {
        console.log(`[VoiceConnection] State change: ${oldState.status} -> ${newState.status} (Guild: ${this.guildId})`);
      });

      return conn;
    };

    if (existingConnection && existingConnection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection = existingConnection;
    } else {
      this.connection = createConnection();
    }
    this.connection.subscribe(this.player);

    try {
      if (this.connection.state.status !== VoiceConnectionStatus.Ready) {
        await entersState(this.connection, VoiceConnectionStatus.Ready, 45_000);
      }
    } catch {
      try {
        this.connection?.destroy();
      } catch {}

      try {
        this.connection = createConnection();
        this.connection.subscribe(this.player);
        await entersState(this.connection, VoiceConnectionStatus.Ready, 45_000);
      } catch {
        try {
          this.connection?.destroy();
        } catch {}
        this.connection = null;
        throw new Error('Не удалось подключиться к голосовому каналу.');
      }
    }
  }

  async add(query, requestedBy, options = {}) {
    this.clearDisconnectTimer();
    const startedAt = Date.now();
    const tracks = [];
    const availableSlots = Math.max(0, maxQueueSize - this.items.length);
    const sourceType = isSpotifyUrl(query)
      ? 'spotify'
      : isUrl(query)
        ? (isYoutubePlaylistUrl(query) ? 'playlist' : 'url')
        : 'search';
    const isPlaylist = sourceType === 'playlist' || isSpotifyPlaylistOrAlbumUrl(query);

    if (options.manual !== false) {
      this.items = this.items.filter((item) => !item.isAutoplay);
    }

    if (sourceType === 'spotify') {
      const spotifyTracks = await spotifyToSearchQueries(query);

      for (const track of spotifyTracks) {
        tracks.push(createQueueItem({
          title: track.title,
          searchQuery: track.query,
          sourceUrl: track.url,
          spotifyTitle: track.spotifyTitle,
          spotifyArtists: track.spotifyArtists,
          spotifyDurationMs: track.spotifyDurationMs,
          requestedBy
        }));
      }
    } else if (sourceType === 'playlist') {
      if (availableSlots > 0) {
        const playlistTracks = await resolveYoutubeItems(query, requestedBy, {
          limit: availableSlots,
          timeoutMs: playlistResolveTimeoutMs
        });
        tracks.push(...playlistTracks.map((track) => createQueueItem(track)));
      }
    } else if (sourceType === 'url') {
      const streamPrefetchPromise = this.shouldStartPlayback()
        ? getStreamUrl(query, { timeoutMs: playbackStreamExtractTimeoutMs })
          .then((streamUrl) => ({ streamUrl }))
          .catch((error) => ({ error }))
        : null;
      const [track] = await resolveYoutubeItems(query, requestedBy, {
        timeoutMs: playbackResolveTimeoutMs
      });

      if (track) {
        tracks.push(createQueueItem({ ...track, streamPrefetchPromise }));
      }
    } else {
      if (this.shouldStartPlayback()) {
        const [resolvedTrack] = await resolveYoutubeItems(query, requestedBy, {
          timeoutMs: playbackResolveTimeoutMs
        });
        if (resolvedTrack) {
          const streamPrefetchPromise = getStreamUrl(resolvedTrack.url, { timeoutMs: playbackStreamExtractTimeoutMs })
            .then((streamUrl) => ({ streamUrl }))
            .catch((error) => ({ error }));
          tracks.push(createQueueItem({ ...resolvedTrack, streamPrefetchPromise }));
        } else {
          tracks.push(createQueueItem({
            title: query,
            searchQuery: query,
            requestedBy
          }));
        }
      } else {
        tracks.push(createQueueItem({
          title: query,
          searchQuery: query,
          requestedBy
        }));
      }
    }

    const acceptedTracks = availableSlots > 0 ? tracks.slice(0, availableSlots) : [];

    if (isPlaylist) {
      const detectedPlaylistTitle = tracks.find((track) => track.sourcePlaylistTitle)?.sourcePlaylistTitle || null;
      if (detectedPlaylistTitle) {
        this.activePlaylistTitle = detectedPlaylistTitle;
      }
    }

    for (const t of acceptedTracks) {
      if (t.artist) {
        const cleanA = extractArtistFromTitle(t.title) || t.artist;
        if (cleanA) this.sessionArtists.add(cleanA.toLowerCase().trim());
      }
    }

    this.items.push(...acceptedTracks);
    console.log(`[MusicQueue] Added ${acceptedTracks.length} track(s) to queue (Guild: ${this.guildId}, Total in queue: ${this.items.length})`);
    void this.primeUpcomingTracks();

    if (this.shouldStartPlayback()) {
      void this.playNext();
    }

    logSlowOperation('queue.add', startedAt, sourceType);

    return {
      sourceType,
      isPlaylist,
      playlistTitle: isPlaylist ? tracks.find((track) => track.sourcePlaylistTitle)?.sourcePlaylistTitle || null : null,
      requestedCount: tracks.length,
      acceptedCount: acceptedTracks.length,
      skippedCount: Math.max(0, tracks.length - acceptedTracks.length),
      acceptedTracks
    };
  }

  async playNext() {
    if (this.destroyed) return;

    const currentRequestId = ++this.playRequestId;
    this.clearDisconnectTimer();
    this.isStarting = true;
    const startedAt = Date.now();

    try {
      if (this.current) {
        this.history.push(this.current);
        this.rememberAutoplayTrack(this.current);
        this.updateSessionContext(this.current);
      }

      let item = this.items.shift();

      if (!item && this.autoplayEnabled) {
        const autoplayItem = await this.getAutoplayTrack();
        if (this.playRequestId !== currentRequestId || this.destroyed) return;

        if (this.autoplayEnabled && this.items.length === 0) {
          item = autoplayItem;

          if (!item) {
            this.autoplayEnabled = false;
            this.textChannel?.send('Autoplay не смог подобрать доступный похожий трек и был выключен.').catch(() => {});
          }
        } else {
          item = this.items.shift();
        }
      }

      this.current = item || null;
      if (item) {
        this.nowPlayingItem = item;
      }

      if (!item) {
        this.scheduleDisconnect();
        return;
      }

      if (this.playRequestId !== currentRequestId || this.destroyed) return;

      console.log(`[MusicQueue] Preparing track: ${item.title || item.searchQuery || item.url}`);
      await this.prepareTrack(item);
      if (this.playRequestId !== currentRequestId || this.destroyed) return;

      const streamUrl = await this.prepareStream(item);
      if (this.playRequestId !== currentRequestId || this.destroyed) return;
      console.log(`[MusicQueue] Stream URL obtained for: ${item.title}`);
      item.streamUrl = streamUrl;

      if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Ready && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        try {
          await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
        } catch {}
      }

      if (this.playRequestId !== currentRequestId || this.destroyed) {
        this.cleanupFfmpeg();
        return;
      }

      this.spawnFfmpegAndPlay(item, 0);
      this.isStarting = false;
      void recordPlayedTrack(this.guildId, item).catch(() => {});
      void this.primeUpcomingTracks();
      logSlowOperation('playNext preparation', startedAt, item.title || item.searchQuery || item.url);
      await this.sendNowPlaying(item);
    } catch (error) {
      if (this.playRequestId !== currentRequestId || this.destroyed) {
        return;
      }
      const failedAutoplayTrack = this.current?.isAutoplay && this.autoplayEnabled;

      if (isRecoverableTrackError(error)) {
        console.warn(`Skipping unavailable track: ${this.current?.title || 'unknown track'}`, error);
      } else {
        console.error('Playback failed:', error);
      }
      if (this.current) {
        this.textChannel?.send(this.describeTrackFailure(this.current, error)).catch(() => {});
        this.history.push(this.current);
        this.current = null;
      }
      if (failedAutoplayTrack) {
        this.autoplayEnabled = false;
        this.textChannel?.send('Autoplay не смог запустить подходящий трек и был выключен.').catch(() => {});
      }
      this.isStarting = false;
      await this.playNext();
      return;
    } finally {
      if (this.playRequestId === currentRequestId) {
        this.isStarting = false;
      }
    }
  }

  spawnFfmpegAndPlay(item, seekSeconds = 0) {
    this.cleanupFfmpeg();

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-user_agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_on_network_error',
      '1',
      '-reconnect_on_http_error',
      '4xx,5xx',
      '-reconnect_delay_max',
      '5'
    ];

    if (seekSeconds > 0) {
      ffmpegArgs.push('-ss', String(seekSeconds), '-accurate_seek');
    } else {
      ffmpegArgs.push('-analyzeduration', '0');
    }

    if (item.httpHeaders) {
      const headersString = Object.entries(item.httpHeaders)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n');
      ffmpegArgs.push('-headers', `${headersString}\r\n`);
    }

    ffmpegArgs.push(
      '-rw_timeout',
      '15000000',
      '-i',
      item.streamUrl
    );

    const filterArgs = buildAudioFilterArgs(this.filters);
    if (filterArgs.length > 0) {
      ffmpegArgs.push(...filterArgs);
    }

    ffmpegArgs.push(
      '-vn',
      '-c:a',
      'libopus',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-f',
      'ogg',
      'pipe:1'
    );

    this.ffmpeg = spawn(getFfmpegBinary(), ffmpegArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    if (this.ffmpeg?.pid) {
      try {
        os.setPriority(this.ffmpeg.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
      } catch {}
    }

    this.nowPlayingItem = item;

    this.ffmpeg.stderr.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        console.warn(`[FFmpeg stderr] ${message}`);
        if (message.includes('403 Forbidden') || message.includes('Server returned 403')) {
          if (item.url) {
            invalidateStreamUrl(item.url);
          }
        }
      }
    });

    this.ffmpeg.once('error', (error) => {
      console.error('[FFmpeg] Process error event:', error);
      this.player.stop(true);
    });

    this.ffmpeg.once('close', (code, signal) => {
      console.log(`[FFmpeg] Process closed with code ${code}, signal ${signal} (Track: ${item.title})`);
      if (
        code !== 0 &&
        code !== null &&
        signal !== 'SIGKILL' &&
        !this.destroyed &&
        !this.isCrossfading &&
        !this.skipRequested
      ) {
        this.isApplyingFilter = false;
        const playedMs = Date.now() - (item.startedAt || Date.now());
        if (playedMs < 6000 && !item._streamRetryCount) {
          item._streamRetryCount = 1;
          if (item.url) {
            invalidateStreamUrl(item.url);
          }
          item.prefetchedStreamUrl = null;
          console.log(`[MusicQueue] FFmpeg stream closed early (code ${code}) for "${item.title}". Fetching fresh stream and retrying...`);
          void this.prepareStream(item, { timeoutMs: 10_000 })
            .then((freshUrl) => {
              if (freshUrl && !this.destroyed && this.current === item) {
                item.streamUrl = freshUrl;
                this.spawnFfmpegAndPlay(item, seekSeconds);
              }
            })
            .catch((err) => {
              console.warn(`[MusicQueue] Auto-recovery stream fetch failed for "${item.title}":`, err);
            });
        }
      }
    });

    const resource = createAudioResource(this.ffmpeg.stdout, {
      inputType: StreamType.OggOpus
    });

    item.startedAt = Date.now();
    item.playbackPositionSec = seekSeconds;
    this.player.play(resource);
    this.scheduleCrossfade(item, seekSeconds);
  }

  scheduleCrossfade(item, seekSeconds = 0) {
    this.clearCrossfadeTimer();
    if (!this.crossfadeEnabled || this.destroyed) return;
    if (!item?.duration || typeof item.duration !== 'number') return;
    if (item.duration < 20) return;

    const remainingSec = item.duration - seekSeconds;
    const preLeadSec = this.crossfadeDuration + 2.0;
    if (remainingSec <= preLeadSec + 2) return;

    const delayMs = Math.max(1000, Math.floor((remainingSec - preLeadSec) * 1000));
    console.log(`[Crossfade] Smart Crossfade scheduled in ${Math.round(delayMs / 1000)}s for "${item.title}"`);

    this.crossfadeTimer = setTimeout(() => {
      this.crossfadeTimer = null;
      void this.triggerCrossfade();
    }, delayMs);
    this.crossfadeTimer.unref();
  }

  clearCrossfadeTimer() {
    if (this.crossfadeTimer) {
      clearTimeout(this.crossfadeTimer);
      this.crossfadeTimer = null;
    }
  }

  async triggerCrossfade() {
    if (!this.crossfadeEnabled || this.destroyed || this.isCrossfading) return;
    if (!this.current) return;
    if (this.player.state.status !== AudioPlayerStatus.Playing) return;

    if (!this.loopCurrent && this.items.length === 0 && !this.autoplayEnabled) {
      return;
    }

    this.isCrossfading = true;
    let crossfadeSuccess = false;
    let shiftedTrack = null;

    try {
      const currentTrack = this.current;
      if (!currentTrack || !currentTrack.streamUrl) return;

      let nextTrack = null;
      if (this.loopCurrent) {
        nextTrack = {
          ...currentTrack,
          playbackPositionSec: 0,
          startedAt: null
        };
      } else {
        if (this.items.length === 0 && this.autoplayEnabled) {
          nextTrack = await this.getAutoplayTrack();
        } else {
          nextTrack = this.items.shift();
          shiftedTrack = nextTrack;
        }
      }

      if (!nextTrack) return;

      console.log(`[Crossfade] Starting Smart Crossfade: "${currentTrack.title}" -> "${nextTrack.title}"`);
      await this.prepareTrack(nextTrack);
      const nextStreamUrl = await this.prepareStream(nextTrack);
      nextTrack.streamUrl = nextStreamUrl;

      if (!nextTrack.streamUrl || this.destroyed) {
        throw new Error('Next track stream URL unavailable for crossfade');
      }

      const elapsed = Math.max(0, (Date.now() - (currentTrack.startedAt || Date.now())) / 1000);
      const currentPosSec = Math.max(0, Math.floor((currentTrack.playbackPositionSec || 0) + elapsed));
      const remainingSec = (currentTrack.duration || 0) - currentPosSec;
      const xfadeDuration = this.crossfadeDuration || 3;

      if (currentTrack.duration && remainingSec < xfadeDuration + 0.5) {
        console.log(`[Crossfade] Remaining track time (${remainingSec.toFixed(1)}s) too short for crossfade, falling back to natural transition`);
        throw new Error('Remaining track time too short for crossfade');
      }

      await this.spawnCrossfadeAndPlay(currentTrack, nextTrack, currentPosSec, xfadeDuration);
      crossfadeSuccess = true;
    } catch (error) {
      console.warn('[Crossfade] Crossfade transition encountered error, falling back to natural transition:', error?.message || error);
      if (shiftedTrack && !crossfadeSuccess) {
        this.items.unshift(shiftedTrack);
      }
    } finally {
      this.isCrossfading = false;
      if (!crossfadeSuccess && this.player.state.status === AudioPlayerStatus.Idle && !this.destroyed) {
        console.log('[Crossfade] AudioPlayer became Idle during crossfade transition, triggering playNext naturally');
        void this.playNext();
      }
    }
  }

  spawnCrossfadeAndPlay(currentTrack, nextTrack, currentPosSec, xfadeDuration) {
    return new Promise((resolve, reject) => {
      const ffmpegArgs = [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-user_agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '-ss',
        String(currentPosSec),
        '-accurate_seek',
        '-t',
        String(xfadeDuration + 2),
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_on_network_error',
        '1',
        '-reconnect_on_http_error',
        '4xx,5xx',
        '-reconnect_delay_max',
        '5',
        '-rw_timeout',
        '15000000'
      ];

      if (currentTrack.httpHeaders) {
        const headersString = Object.entries(currentTrack.httpHeaders)
          .map(([key, value]) => `${key}: ${value}`)
          .join('\r\n');
        ffmpegArgs.push('-headers', `${headersString}\r\n`);
      }
      ffmpegArgs.push('-i', currentTrack.streamUrl);

      ffmpegArgs.push(
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_on_network_error',
        '1',
        '-reconnect_on_http_error',
        '4xx,5xx',
        '-reconnect_delay_max',
        '5',
        '-analyzeduration',
        '0',
        '-rw_timeout',
        '15000000'
      );

      if (nextTrack.httpHeaders) {
        const headersString = Object.entries(nextTrack.httpHeaders)
          .map(([key, value]) => `${key}: ${value}`)
          .join('\r\n');
        ffmpegArgs.push('-headers', `${headersString}\r\n`);
      }
      ffmpegArgs.push('-i', nextTrack.streamUrl);

      const filterArgs = buildAudioFilterArgs(this.filters);
      let filterComplex = `[0:a][1:a]acrossfade=d=${xfadeDuration}:c1=qsin:c2=qsin[xfaded]`;
      if (filterArgs.length > 0) {
        filterComplex += `;[xfaded]${filterArgs[1]}[out]`;
        ffmpegArgs.push('-filter_complex', filterComplex, '-map', '[out]');
      } else {
        ffmpegArgs.push('-filter_complex', filterComplex, '-map', '[xfaded]');
      }

      ffmpegArgs.push(
        '-vn',
        '-c:a',
        'libopus',
        '-b:a',
        '128k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-f',
        'ogg',
        'pipe:1'
      );

      const crossFfmpeg = spawn(getFfmpegBinary(), ffmpegArgs, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      if (crossFfmpeg?.pid) {
        try {
          os.setPriority(crossFfmpeg.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
        } catch {}
      }

      let started = false;
      const timeoutId = setTimeout(() => {
        if (!started) {
          try {
            crossFfmpeg.kill('SIGKILL');
          } catch {}
          reject(new Error('Crossfade startup timed out'));
        }
      }, 8000);

      crossFfmpeg.stderr.on('data', (data) => {
        const message = data.toString().trim();
        if (message) {
          console.warn(`[Crossfade FFmpeg stderr] ${message}`);
        }
      });

      crossFfmpeg.once('error', (err) => {
        clearTimeout(timeoutId);
        if (!started) {
          reject(err);
        } else {
          console.error('[Crossfade FFmpeg] Process error event:', err);
          this.player.stop(true);
        }
      });

      crossFfmpeg.once('close', (code, signal) => {
        console.log(`[Crossfade FFmpeg] Process closed with code ${code}, signal ${signal} (Track: ${nextTrack.title})`);
      });

      crossFfmpeg.stdout.once('data', (firstChunk) => {
        clearTimeout(timeoutId);
        started = true;

        this.cleanupFfmpeg();
        this.ffmpeg = crossFfmpeg;

        const bridge = new PassThrough();
        bridge.write(firstChunk);
        crossFfmpeg.stdout.pipe(bridge);

        const resource = createAudioResource(bridge, {
          inputType: StreamType.OggOpus
        });

        if (this.current) {
          this.history.push(this.current);
          this.rememberAutoplayTrack(this.current);
          this.updateSessionContext(this.current);
        }

        this.current = nextTrack;
        nextTrack.startedAt = Date.now();
        nextTrack.playbackPositionSec = 0;

        this.player.play(resource);
        void recordPlayedTrack(this.guildId, nextTrack).catch(() => {});
        void this.primeUpcomingTracks();
        void this.sendNowPlaying(nextTrack);
        this.scheduleCrossfade(nextTrack, 0);
        resolve();
      });
    });
  }

  toggleFilter(filterName) {
    if (filterName === 'slowed') {
      this.filters.slowed = !this.filters.slowed;
      if (this.filters.slowed) {
        this.filters.speedup = false;
      }
    } else if (filterName === 'speedup') {
      this.filters.speedup = !this.filters.speedup;
      if (this.filters.speedup) {
        this.filters.slowed = false;
      }
    } else if (filterName === 'bassboost') {
      this.filters.bassboost = !this.filters.bassboost;
    } else if (filterName === 'eightD') {
      this.filters.eightD = !this.filters.eightD;
    }

    console.log(`[MusicQueue] Filter toggled: ${filterName} = ${this.filters[filterName]} (Guild: ${this.guildId})`);
    void this.applyCurrentFiltersLive();
    return this.filters[filterName];
  }

  toggleCrossfade() {
    this.crossfadeEnabled = !this.crossfadeEnabled;
    if (!this.crossfadeEnabled) {
      this.clearCrossfadeTimer();
    } else if (this.current) {
      const elapsed = Math.max(0, (Date.now() - (this.current.startedAt || Date.now())) / 1000);
      const currentPosSec = Math.max(0, Math.floor((this.current.playbackPositionSec || 0) + elapsed));
      this.scheduleCrossfade(this.current, currentPosSec);
    }
    return this.crossfadeEnabled;
  }

  async applyCurrentFiltersLive() {
    console.log(`[MusicQueue] Applying filters live (Guild: ${this.guildId}, PlayerStatus: ${this.player.state.status}, HasCurrent: ${Boolean(this.current)})`);
    if (!this.current || this.player.state.status === AudioPlayerStatus.Idle) {
      void this.updateNowPlayingControls();
      return;
    }

    const item = this.current;
    if (!item.streamUrl) {
      try {
        item.streamUrl = await this.prepareStream(item);
      } catch (err) {
        console.error('[MusicQueue] Failed to prepare stream for live filter:', err);
        void this.updateNowPlayingControls();
        return;
      }
    }

    const elapsedSinceStart = Math.max(0, (Date.now() - (item.startedAt || Date.now())) / 1000);
    const currentPositionSec = Math.max(0, Math.floor((item.playbackPositionSec || 0) + elapsedSinceStart));
    const wasPaused = this.isPaused();

    this.isApplyingFilter = true;
    try {
      this.spawnFfmpegAndPlay(item, currentPositionSec);
      if (wasPaused) {
        this.player.pause();
      }
    } catch (err) {
      console.error('[MusicQueue] Failed to apply filter live:', err);
    } finally {
      setTimeout(() => {
        this.isApplyingFilter = false;
      }, 1500).unref();
    }

    void this.updateNowPlayingControls();
  }

  shouldStartPlayback() {
    return !this.current && !this.isStarting && this.player.state.status !== AudioPlayerStatus.Playing;
  }

  isPreparingPlayback() {
    return this.isStarting || (!this.current && this.items.some((item) => (
      item?.state === trackStates.queued || item?.state === trackStates.resolving
    )));
  }

  skip() {
    console.log(`[MusicQueue] Skip invoked (Guild: ${this.guildId}, PlayerStatus: ${this.player.state.status}, Items: ${this.items.length})`);
    this.skipRequested = true;
    this.cleanupFfmpeg();
    this.playRequestId = (this.playRequestId || 0) + 1;

    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.player.stop(true);
    } else {
      if (this.loopCurrent && this.current) {
        this.current = null;
      }
      this.skipRequested = false;
      this.isStarting = false;
      void this.playNext();
    }
  }

  previous() {
    const previousItem = this.history.pop();

    if (!previousItem) {
      return false;
    }

    if (this.current) {
      this.items.unshift(this.current);
    }

    this.items.unshift({ ...previousItem, playbackPositionSec: 0, startedAt: null });
    this.current = null;
    this.skipRequested = true;
    this.cleanupFfmpeg();
    this.playRequestId = (this.playRequestId || 0) + 1;

    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.player.stop(true);
    } else {
      this.skipRequested = false;
      this.isStarting = false;
      void this.playNext();
    }
    return true;
  }

  stop() {
    console.log(`[MusicQueue] Stop invoked (Guild: ${this.guildId})`);
    if (this.prefetchDebounceTimer) {
      clearTimeout(this.prefetchDebounceTimer);
      this.prefetchDebounceTimer = null;
    }
    this.prefetchGeneration = (this.prefetchGeneration || 0) + 1;
    this.playRequestId = (this.playRequestId || 0) + 1;
    this.clearDisconnectTimer();
    this.items = [];
    this.history = [];
    this.current = null;
    this.loopCurrent = false;
    this.autoplayEnabled = false;
    this.hasPlaybackError = false;
    this.autoplayHistory = [];
    this.sessionContext = [];
    this.sessionArtists.clear();
    this.activePlaylistTitle = null;
    this.skipRequested = true;
    this.isStarting = false;
    this.cleanupFfmpeg();
    void this.deleteNowPlayingMessage();
    try {
      this.player.stop(true);
    } catch {}
    try {
      this.connection?.destroy();
    } catch {}
    this.connection = null;
    queues.delete(this.guildId);
  }

  pause() {
    return this.player.pause();
  }

  resume() {
    return this.player.unpause();
  }

  isPaused() {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  toggleLoop() {
    this.loopCurrent = !this.loopCurrent;
    return this.loopCurrent;
  }

  toggleAutoplay() {
    this.autoplayEnabled = !this.autoplayEnabled;
    if (this.autoplayEnabled && this.items.length === 0 && this.current) {
      void this.primeUpcomingTracks();
    } else if (!this.autoplayEnabled) {
      this.items = this.items.filter((item) => !item.isAutoplay);
    }
    return this.autoplayEnabled;
  }

  replay() {
    if (!this.current) {
      return false;
    }

    this.items.unshift({ ...this.current, playbackPositionSec: 0, startedAt: null });
    this.current = null;
    this.skipRequested = true;
    this.cleanupFfmpeg();
    this.playRequestId = (this.playRequestId || 0) + 1;

    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.player.stop(true);
    } else {
      this.skipRequested = false;
      this.isStarting = false;
      void this.playNext();
    }
    return true;
  }

  clear() {
    if (this.prefetchDebounceTimer) {
      clearTimeout(this.prefetchDebounceTimer);
      this.prefetchDebounceTimer = null;
    }
    this.prefetchGeneration = (this.prefetchGeneration || 0) + 1;
    const removedCount = this.items.length;
    this.items = [];
    return removedCount;
  }

  shuffle() {
    for (let index = this.items.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [this.items[index], this.items[randomIndex]] = [this.items[randomIndex], this.items[index]];
    }
    void this.primeUpcomingTracks(true);
  }

  cleanupFfmpeg() {
    this.clearCrossfadeTimer();
    if (this.ffmpeg) {
      try {
        this.ffmpeg.stdout?.destroy();
        this.ffmpeg.stderr?.destroy();
        this.ffmpeg.stdin?.destroy();
        if (!this.ffmpeg.killed) {
          this.ffmpeg.kill('SIGKILL');
        }
      } catch {
        // Игнорируем ошибки при закрытии процесса
      }
      this.ffmpeg = null;
    }
  }

  ensureTrackCandidates(item) {
    const candidates = [];
    const primaryCandidate = toTrackCandidate(item);

    if (primaryCandidate) {
      candidates.push(primaryCandidate);
    }

    if (Array.isArray(item.candidates)) {
      candidates.push(...item.candidates.filter((c) => Boolean(c?.url && isUrl(c.url))));
    }

    item.candidates = dedupeTrackCandidates(candidates).slice(0, maxFallbackCandidates);
    return item.candidates;
  }

  async hydrateTrackMetadata(item) {
    if (!item?.url || item.metadataPromise || !needsTrackMetadata(item)) {
      return item;
    }

    item.metadataPromise = (async () => {
      try {
        const [hydrated] = await resolveYoutubeItems(item.url, item.requestedBy, {
          timeoutMs: metadataResolveTimeoutMs
        });

        if (hydrated?.url) {
          mergeTrackData(item, hydrated);
          this.ensureTrackCandidates(item);
        }
      } catch (error) {
        if (!isRecoverableTrackError(error) && !isTimeoutError(error) && !isNetworkAccessError(error)) {
          console.warn(`Metadata hydration failed for ${item.url}: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        item.metadataPromise = null;
      }

      return item;
    })();

    return item.metadataPromise;
  }

  async resolveTrack(item, options = {}) {
    if (!item) {
      return item;
    }

    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : searchResolveTimeoutMs;
    const background = options.background === true;

    if (item.state === trackStates.failed) {
      if (!background && (isTimeoutError(item.lastError) || !item.url)) {
        item.state = trackStates.queued;
        item.lastError = null;
      } else {
        throw new Error(item.lastError || 'Track is marked as failed');
      }
    }

    if (!item.resolvePromise && item.state !== trackStates.ready && item.state !== trackStates.fallbackReady) {
      item.state = trackStates.resolving;
      item.resolvePromise = (async () => {
        const startedAt = Date.now();

        if (item.searchQuery && !item.url && (!Array.isArray(item.candidates) || item.candidates.length === 0)) {
          const candidateLimit = item.spotifyTitle ? 5 : Math.min(3, maxFallbackCandidates);
          const candidates = await resolveYoutubeItems(item.searchQuery, item.requestedBy, {
            limit: candidateLimit,
            timeoutMs
          });

          let rankedCandidates = rankTrackCandidates(candidates, item)
            .filter((candidate) => candidate?.url && isUrl(candidate.url))
            .slice(0, maxFallbackCandidates);

          if (rankedCandidates.length === 0 && candidates.length > 0) {
            rankedCandidates = candidates.filter((candidate) => candidate?.url && isUrl(candidate.url)).slice(0, 1);
          }

          if (rankedCandidates.length === 0) {
            throw new Error(`No matching track found for: ${item.spotifyArtists?.join(', ') || item.title}`);
          }

          item.candidates = rankedCandidates.map((candidate) => ({
            title: candidate.title,
            url: candidate.url,
            duration: candidate.duration,
            thumbnail: candidate.thumbnail,
            artist: candidate.artist,
            httpHeaders: candidate.httpHeaders
          }));
          mergeTrackData(item, item.candidates[0]);
        } else {
          this.ensureTrackCandidates(item);
        }

        if (!item.url) {
          throw new Error('No matching track found for queued item');
        }

        item.state = item.candidates.length > 1 ? trackStates.fallbackReady : trackStates.ready;
        logSlowOperation('queue.resolveTrack', startedAt, item.title || item.searchQuery || item.url);
        void this.hydrateTrackMetadata(item);
        return item;
      })().catch((error) => {
        item.lastError = error instanceof Error ? error.message : String(error);

        if (background) {
          item.state = trackStates.queued;
          return item;
        }

        item.state = trackStates.failed;
        throw error;
      }).finally(() => {
        item.resolvePromise = null;
      });
    }

    if (item.resolvePromise) {
      await item.resolvePromise;
    }

    if (!background && !item.url && (!Array.isArray(item.candidates) || item.candidates.length === 0)) {
      item.resolvePromise = null;
      item.state = trackStates.queued;
      return this.resolveTrack(item, options);
    }

    return item;
  }

  async prepareTrack(item) {
    await this.resolveTrack(item, { timeoutMs: playbackResolveTimeoutMs, background: false });
    return item;
  }

  getPlaybackCandidates(item) {
    this.ensureTrackCandidates(item);

    return item.candidates
      .filter((candidate) => candidate?.url && isUrl(candidate.url) && !item.failedCandidates.includes(candidate.url))
      .slice(0, maxFallbackCandidates);
  }

  async prepareStream(item, options = {}) {
    if (item.prefetchedStreamUrl) {
      console.log(`[MusicQueue] Instant start: using pre-extracted stream URL for "${item.title}"`);
      return item.prefetchedStreamUrl;
    }

    const candidates = this.getPlaybackCandidates(item);
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : playbackStreamExtractTimeoutMs;
    let lastError = null;
    let lastNetworkError = null;

    if (item.streamPrefetchPromise) {
      const prefetchedStream = await item.streamPrefetchPromise;
      item.streamPrefetchPromise = null;

      if (prefetchedStream?.streamUrl) {
        console.log(`[MusicQueue] Instant start: awaited pre-extracted stream URL for "${item.title}"`);
        item.prefetchedStreamUrl = prefetchedStream.streamUrl;
        return prefetchedStream.streamUrl;
      }

      lastError = prefetchedStream?.error;
      if (isNetworkAccessError(prefetchedStream?.error)) {
        lastNetworkError = prefetchedStream.error;
      }
    }

    for (const candidate of candidates) {
      try {
        const streamUrl = await getStreamUrl(candidate.url, { timeoutMs });

        if (!streamUrl) {
          throw new Error('yt-dlp did not return a stream URL');
        }

        mergeTrackData(item, candidate);
        item.failedCandidates = item.failedCandidates.filter((url) => url !== candidate.url);
        void this.hydrateTrackMetadata(item);
        return streamUrl;
      } catch (error) {
        lastError = error;
        item.failedCandidates = [...new Set([...item.failedCandidates, candidate.url])];
        if (isNetworkAccessError(error)) {
          lastNetworkError = error;
        }
      }
    }

    item.state = trackStates.failed;
    item.lastError = lastError instanceof Error ? lastError.message : String(lastError || item.lastError || '');
    const finalError = lastNetworkError
      ?? lastError
      ?? (item.lastError ? new Error(item.lastError) : new Error('No playable source found'));
    throw finalError;
  }

  describeTrackFailure(item, error) {
    const title = item?.title || item?.searchQuery || item?.url || 'этот трек';
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('timed out')) {
      return `Не удалось быстро подготовить **${title}**. Пробую следующий трек.`;
    }

    if (message.includes('No matching track found') || message.includes('No playable source found')) {
      return `Не удалось найти воспроизводимый источник для **${title}**. Пробую следующий трек.`;
    }

    if (message.includes('EACCES') || message.includes('WinError 10013') || message.includes('Unable to download API page')) {
      return `YouTube недоступен для процесса бота (блокировка сети/фаервол). Проверьте доступ для **${title}**.`;
    }

    return `Не удалось запустить **${title}**. Пробую следующий трек.`;
  }

  primeUpcomingTracks(force = false) {
    if (force) {
      this.prefetchGeneration = (this.prefetchGeneration || 0) + 1;
    }

    if (this.prefetchDebounceTimer) {
      clearTimeout(this.prefetchDebounceTimer);
      this.prefetchDebounceTimer = null;
    }

    if (this.backgroundPreparationPromise) {
      return;
    }

    const run = () => {
      if (this.backgroundPreparationPromise) return;
      const currentGen = this.prefetchGeneration || 0;
      this.backgroundPreparationPromise = (async () => {
        try {
          await this.runPrefetchPipeline(currentGen);
        } catch (error) {
          console.warn('[Prefetch] Pipeline encountered unexpected error:', error);
        } finally {
          this.backgroundPreparationPromise = null;
          if (this.prefetchGeneration !== currentGen && (this.items.length > 0 || (this.autoplayEnabled && this.current))) {
            void this.primeUpcomingTracks();
          }
        }
      })();
    };

    if (force) {
      run();
    } else {
      this.prefetchDebounceTimer = setTimeout(() => {
        this.prefetchDebounceTimer = null;
        run();
      }, 1500);
      this.prefetchDebounceTimer.unref();
    }
  }

  async runPrefetchPipeline(gen) {
    const targetBuffer = maxPrefetchTracks;

    // 1. Последовательно предзагружаем треки, которые уже находятся в очереди (до targetBuffer треков)
    for (let i = 0; i < Math.min(this.items.length, targetBuffer); i++) {
      if (this.prefetchGeneration !== gen) return;

      const item = this.items[i];
      if (!item) continue;

      // Если трек уже полностью готов (есть ссылка и поток извлечен), пропускаем его
      if (item.url && item.prefetchedStreamUrl) {
        continue;
      }

      // Шаг A: Разрешение метаданных / кандидатов YouTube для трека
      if (item.state === trackStates.queued || item.state === trackStates.resolving || !item.url) {
        console.log(`[Prefetch] Resolving track [${i + 1}/${targetBuffer}] in queue: "${item.title || item.searchQuery}"`);
        try {
          await this.resolveTrack(item, {
            timeoutMs: searchResolveTimeoutMs,
            background: true
          });
        } catch {
          // Ошибка фона будет обработана во время воспроизведения
        }
      }

      if (this.prefetchGeneration !== gen) return;

      // Шаг B: Предварительное извлечение ссылки аудиопотока
      if (item.url && !item.prefetchedStreamUrl) {
        if (!item.streamPrefetchPromise) {
          console.log(`[Prefetch] Pre-extracting stream URL for [${i + 1}/${targetBuffer}]: "${item.title}"`);
          item.streamPrefetchPromise = getStreamUrl(item.url, { timeoutMs: playbackStreamExtractTimeoutMs })
            .then((streamUrl) => {
              item.prefetchedStreamUrl = streamUrl;
              console.log(`[Prefetch] Stream URL ready for [${i + 1}/${targetBuffer}]: "${item.title}"`);
              return { streamUrl };
            })
            .catch((error) => {
              console.warn(`[Prefetch] Stream prefetch failed for "${item.title}":`, error instanceof Error ? error.message : String(error));
              return { error };
            });
        }

        try {
          await item.streamPrefetchPromise;
        } catch {}
      }

      if (this.prefetchGeneration !== gen) return;
    }

    // 2. Если включен Autoplay и в очереди меньше targetBuffer треков — подбираем и предзагружаем цепочку рекомендаций
    while (this.autoplayEnabled && this.items.length < targetBuffer && (this.current || this.items.length > 0)) {
      if (this.prefetchGeneration !== gen || !this.autoplayEnabled) return;

      const seedTrack = this.items[this.items.length - 1] || this.current;
      console.log(`[Autoplay] Queue has ${this.items.length}/${targetBuffer} tracks. Selecting and prefetching next recommendation...`);

      try {
        const autoplayItem = await this.getAutoplayTrack(seedTrack);
        if (this.prefetchGeneration !== gen || !this.autoplayEnabled) return;

        if (autoplayItem) {
          if (autoplayItem.url && !autoplayItem.prefetchedStreamUrl && !autoplayItem.streamPrefetchPromise) {
            console.log(`[Autoplay] Pre-extracting stream URL for [${this.items.length + 1}/${targetBuffer}]: "${autoplayItem.title}"`);
            autoplayItem.streamPrefetchPromise = getStreamUrl(autoplayItem.url, { timeoutMs: playbackStreamExtractTimeoutMs })
              .then((streamUrl) => {
                autoplayItem.prefetchedStreamUrl = streamUrl;
                console.log(`[Autoplay] Stream URL ready for autoplay track [${this.items.length + 1}/${targetBuffer}]: "${autoplayItem.title}"`);
                return { streamUrl };
              })
              .catch((error) => {
                console.warn(`[Autoplay] Stream prefetch failed for "${autoplayItem.title}":`, error instanceof Error ? error.message : String(error));
                return { error };
              });

            await autoplayItem.streamPrefetchPromise;
          }

          if (this.prefetchGeneration === gen && this.autoplayEnabled && this.items.length < targetBuffer) {
            this.items.push(autoplayItem);
            console.log(`[Autoplay] Preloaded into queue (${this.items.length}/${targetBuffer}): "${autoplayItem.title}"`);
          } else {
            break;
          }
        } else {
          break;
        }
      } catch (error) {
        console.warn('[Autoplay] Warmup failed:', error);
        break;
      }
    }
  }

  rememberAutoplayTrack(track) {
    if (!track) return;
    const url = track.url || null;
    const title = track.title || track.searchQuery || '';
    const canon = getCanonicalTitle(title);
    const artist = track.artist ? track.artist.toLowerCase().trim() : '';

    this.autoplayHistory = [
      { url, canon, artist, title },
      ...this.autoplayHistory.filter((entry) => {
        if (typeof entry === 'string') return entry !== url;
        return entry.url !== url && (!canon || entry.canon !== canon);
      })
    ].slice(0, maxAutoplayMemorySize);
  }

  isRecentlyPlayed(track) {
    if (!track) return false;
    const url = track.url;
    const title = track.title || track.searchQuery || '';
    const canon = getCanonicalTitle(title);

    for (const entry of this.autoplayHistory) {
      if (typeof entry === 'string') {
        if (url && entry === url) return true;
        continue;
      }
      if (url && entry.url && entry.url === url) return true;
      if (canon && entry.canon && isSameSong(canon, entry.canon)) return true;
    }
    return false;
  }

  isSameAsCurrentOrRecent(candidate, seedTrack) {
    if (!candidate) return true;
    if (candidate.url && seedTrack?.url && candidate.url === seedTrack.url) return true;
    if (this.current?.url && candidate.url && this.current.url === candidate.url) return true;

    const candTitle = candidate.title || '';
    const seedTitle = seedTrack?.title || seedTrack?.searchQuery || '';
    const currentTitle = this.current?.title || this.current?.searchQuery || '';

    if (isSameSong(candTitle, seedTitle)) return true;
    if (currentTitle && isSameSong(candTitle, currentTitle)) return true;

    for (const item of this.items) {
      if (item.url && candidate.url && item.url === candidate.url) return true;
      if (isSameSong(candTitle, item.title || item.searchQuery || '')) return true;
    }

    for (const recent of this.sessionContext) {
      const recentTitle = recent?.title || recent?.searchQuery || '';
      if (isSameSong(candTitle, recentTitle)) {
        return true;
      }
    }

    return false;
  }

  updateSessionContext(track) {
    if (!track) return;
    this.sessionContext = [track, ...this.sessionContext.filter((t) => t.url !== track.url)]
      .slice(0, maxSessionContextSize);

    const { artist } = extractCleanArtistAndSong(track);
    if (artist) {
      this.sessionArtists.add(artist.toLowerCase().trim());
    }
    if (track.sourcePlaylistTitle) {
      this.activePlaylistTitle = track.sourcePlaylistTitle;
    }
  }

  async getAutoplayTrack(customSeed = null) {
    const seedTrack = customSeed || this.sessionContext[0] || this.history[this.history.length - 1] || this.current;
    if (!seedTrack) return null;

    const { artist: primaryArtist, cleanTitle: primaryTitle } = extractCleanArtistAndSong(seedTrack);
    const recentSessionArtists = Array.from(this.sessionArtists).filter(Boolean);
    const seedIsCyrillic = hasCyrillic(seedTrack.title)
      || hasCyrillic(primaryArtist)
      || hasCyrillic(seedTrack.searchQuery || '')
      || (seedTrack.artist && hasCyrillic(seedTrack.artist));

    const playlistContextNotice = this.activePlaylistTitle ? `Playlist: "${this.activePlaylistTitle}"` : 'Single track context';
    console.log(`[Autoplay] Analyzing seed: "${seedTrack.title}" (Artist: "${primaryArtist || 'Unknown'}", ${playlistContextNotice}, Session artists: ${recentSessionArtists.length})`);

    const queries = [];
    if (primaryArtist) {
      queries.push(`${primaryArtist} official audio`);
      queries.push(`${primaryArtist} популярные песни`);
      if (seedIsCyrillic) {
        queries.push(`${primaryArtist} похожие исполнители`);
        queries.push(`${primaryArtist} радио`);
      } else {
        queries.push(`${primaryArtist} popular tracks`);
        queries.push(`${primaryArtist} radio`);
      }
    } else if (primaryTitle) {
      queries.push(`${primaryTitle} official audio`);
      queries.push(`${primaryTitle} радио`);
    }

    // If playing in the context of a playlist with multiple artists, also draw from other artists in the playlist
    if (recentSessionArtists.length > 1) {
      const otherArtists = recentSessionArtists
        .filter((a) => a !== primaryArtist.toLowerCase())
        .slice(0, 2);

      for (const other of otherArtists) {
        queries.push(`${other} official audio`);
      }
    }

    if (this.activePlaylistTitle && queries.length < 5) {
      queries.push(`${this.activePlaylistTitle} плейлист`);
    }

    let relatedNames = [];

    if (primaryArtist) {
      try {
        const deezerUrl = `https://api.deezer.com/search/artist?q=${encodeURIComponent(primaryArtist)}&limit=1`;
        const artistRes = await fetch(deezerUrl, { signal: AbortSignal.timeout(1500) }).catch(() => null);
        if (artistRes?.ok) {
          const artistData = await artistRes.json().catch(() => null);
          const artistId = artistData?.data?.[0]?.id;
          if (artistId) {
            const [topRes, relRes] = await Promise.allSettled([
              fetch(`https://api.deezer.com/artist/${artistId}/top?limit=8`, { signal: AbortSignal.timeout(1500) }),
              fetch(`https://api.deezer.com/artist/${artistId}/related?limit=5`, { signal: AbortSignal.timeout(1500) })
            ]);

            if (topRes.status === 'fulfilled' && topRes.value?.ok) {
              const topData = await topRes.value.json().catch(() => null);
              const topTracks = (topData?.data || []).map((t) => t.title).filter(Boolean);
              if (topTracks.length > 0) {
                console.log(`[Autoplay] Discovered top tracks for "${primaryArtist}":`, topTracks.slice(0, 4));
                for (const trackTitle of topTracks.slice(0, 3)) {
                  queries.push(`${primaryArtist} ${trackTitle} official audio`);
                }
              }
            }

            if (relRes.status === 'fulfilled' && relRes.value?.ok) {
              const relData = await relRes.value.json().catch(() => null);
              relatedNames = (relData?.data || []).map((a) => a.name).filter(Boolean);
              if (relatedNames.length > 0) {
                console.log(`[Autoplay] Discovered related artists via streaming API for "${primaryArtist}":`, relatedNames);
                for (const relName of relatedNames.slice(0, 3)) {
                  queries.push(`${relName} official audio`);
                }
              }
            }
          }
        }
      } catch {
        // Silently continue if external API is unreachable
      }
    }

    const isCyrillicContext = seedIsCyrillic
      || recentSessionArtists.some((a) => hasCyrillic(a))
      || relatedNames.some((n) => hasCyrillic(n));

    let allCandidates = [];

    for (const query of queries) {
      try {
        const results = await resolveYoutubeItems(query, 'Autoplay', {
          limit: 10,
          timeoutMs: 6_000
        });

        if (Array.isArray(results) && results.length > 0) {
          allCandidates.push(...results);
        }
      } catch (err) {
        // Query fallback
      }
    }

    allCandidates = dedupeTrackCandidates(allCandidates);

    const validCandidates = allCandidates.filter((candidate) => {
      if (!candidate?.url || !isUrl(candidate.url)) return false;

      // 1. Duration filter: standard songs (between 50s and 600s)
      const duration = Number(candidate.duration);
      if (Number.isFinite(duration) && (duration < 50 || duration > 600)) {
        console.log(`[Autoplay] Filtered out candidate by duration (${duration}s): "${candidate.title}"`);
        return false;
      }

      // 2. Filter out remixes, slowed, sped up, live/concerts, phonk, radio edit, etc.
      if (isJunkOrRemixTrack(candidate.title)) {
        console.log(`[Autoplay] Filtered out remix/junk/live: "${candidate.title}"`);
        return false;
      }

      // 3. Language/Script match: prevent foreign name collisions
      const candIsCyrillic = hasCyrillic(candidate.title) || hasCyrillic(candidate.artist);
      const candArtistNorm = normalizeMatchText(cleanChannelOrArtistName(candidate.artist || candidate.uploader || ''));
      const seedArtistNorm = normalizeMatchText(cleanChannelOrArtistName(primaryArtist || ''));
      const isSameOrKnownArtist = Boolean((seedArtistNorm && (candArtistNorm.includes(seedArtistNorm) || seedArtistNorm.includes(candArtistNorm)))
        || recentSessionArtists.some((a) => a && (candArtistNorm.includes(a) || a.includes(candArtistNorm)))
        || relatedNames.some((r) => candArtistNorm.includes(normalizeMatchText(r)) || normalizeMatchText(r).includes(candArtistNorm)));

      if (isCyrillicContext) {
        if (!candIsCyrillic) {
          if (!isSameOrKnownArtist && queries.length > 2) {
            console.log(`[Autoplay] Filtered out unrelated foreign Latin track in Cyrillic context: "${candidate.title}"`);
            return false;
          }
        }
      } else {
        if (candIsCyrillic) {
          if (!isSameOrKnownArtist) {
            console.log(`[Autoplay] Filtered out Cyrillic track in Western context: "${candidate.title}"`);
            return false;
          }
        }
      }

      // 4. Substring collision filter: if candidate artist contains seed artist name but has extra words without collaboration separators
      if (seedArtistNorm && candArtistNorm.length > seedArtistNorm.length + 3) {
        if (candArtistNorm.includes(seedArtistNorm)) {
          const isCollab = candArtistNorm.includes('feat') || candArtistNorm.includes('ft') || candArtistNorm.includes('&') || candArtistNorm.includes(' и ') || candArtistNorm.includes(',');
          if (!isCollab) {
            console.log(`[Autoplay] Filtered out name collision: "${candidate.title}" (${candArtistNorm} vs ${seedArtistNorm})`);
            return false;
          }
        }
      }

      // 5. Deduplicate against current and recent songs
      if (this.isSameAsCurrentOrRecent(candidate, seedTrack)) {
        console.log(`[Autoplay] Filtered out duplicate/same song: "${candidate.title}"`);
        return false;
      }

      // 6. Recent session history
      if (this.isRecentlyPlayed(candidate)) {
        console.log(`[Autoplay] Filtered out recently played track: "${candidate.title}"`);
        return false;
      }

      return true;
    });

    if (validCandidates.length === 0) {
      console.warn('[Autoplay] No clean candidates found matching seed criteria.');
      return null;
    }

    // Rank candidates using smart scoring (balancing same artist hits, playlist artists, and related artists)
    const scoredCandidates = validCandidates.map((candidate) => {
      const score = scoreAutoplayCandidate(candidate, seedTrack, this.history, recentSessionArtists);
      return { candidate, score };
    });

    scoredCandidates.sort((a, b) => b.score - a.score);

    console.log(`[Autoplay] Candidates found: ${validCandidates.length} clean tracks (Top score: ${scoredCandidates[0].score})`);

    const [bestEntry, ...fallbackEntries] = scoredCandidates;
    const bestMatch = bestEntry.candidate;

    bestMatch.candidates = fallbackEntries.map((e) => e.candidate);
    bestMatch.isAutoplay = true;
    bestMatch.autoplaySeedTitle = seedTrack.title || seedTrack.searchQuery;

    console.log(`[Autoplay] Selected recommendation: "${bestMatch.title}" (Artist: ${bestMatch.artist || 'Unknown'}, Score: ${bestEntry.score})`);
    this.rememberAutoplayTrack(bestMatch);
    return createQueueItem(bestMatch);
  }

  async sendNowPlaying(item) {
    if (!this.textChannel) return;
    this.nowPlayingItem = item;

    const componentsV2 = await this.createNowPlayingComponents(item);

    // Если сообщение уже существует в канале — обновляем (редактируем) его на месте
    if (this.nowPlayingMessage) {
      try {
        if (componentsV2) {
          await this.nowPlayingMessage.edit({
            flags: MessageFlags.IsComponentsV2,
            components: componentsV2,
            content: null,
            allowedMentions: { users: [] }
          });
          return;
        }

        const duration = formatDuration(item.duration);
        const requester = formatRequester(item.requestedBy);
        const artist = item.artist || 'Unknown';
        const lines = [
          `Сейчас играет: **${item.title}**`,
          duration ? `Длительность: ${duration}` : null,
          requester ? `Поставил: ${requester}` : null,
          artist ? `Song By: ${artist}` : null
        ].filter(Boolean);

        await this.nowPlayingMessage.edit({
          content: lines.join('\n'),
          components: createPlayerControls(this.isPaused(), this.loopCurrent, this.autoplayEnabled, this.filters),
          allowedMentions: { users: [] }
        });
        return;
      } catch (error) {
        // Если сообщение было удалено пользователем в чате, сбрасываем ссылку и отправляем новое ниже
        this.nowPlayingMessage = null;
      }
    }

    if (componentsV2) {
      try {
        this.nowPlayingMessage = await this.textChannel.send({
          flags: MessageFlags.IsComponentsV2,
          components: componentsV2,
          allowedMentions: { users: [] }
        });
        return;
      } catch {
        // Fallback на стандартные сообщения
      }
    }

    const duration = formatDuration(item.duration);
    const requester = formatRequester(item.requestedBy);
    const artist = item.artist || 'Unknown';
    const lines = [
      `Сейчас играет: **${item.title}**`,
      duration ? `Длительность: ${duration}` : null,
      requester ? `Поставил: ${requester}` : null,
      artist ? `Song By: ${artist}` : null
    ].filter(Boolean);

    this.nowPlayingMessage = await this.textChannel.send({
      content: lines.join('\n'),
      components: createPlayerControls(this.isPaused(), this.loopCurrent, this.autoplayEnabled, this.filters),
      allowedMentions: { users: [] }
    }).catch(() => null);
  }

  async updateNowPlayingControls() {
    if (!this.nowPlayingMessage) return;

    const displayTrack = this.current || this.nowPlayingItem;

    if (displayTrack) {
      const componentsV2 = await this.createNowPlayingComponents(displayTrack);
      if (componentsV2) {
        try {
          await this.nowPlayingMessage.edit({
            flags: MessageFlags.IsComponentsV2,
            components: componentsV2,
            allowedMentions: { users: [] }
          });
          return;
        } catch {
          // Fallback
        }
      }
    }

    const duration = displayTrack ? formatDuration(displayTrack.duration) : null;
    const requester = displayTrack ? formatRequester(displayTrack.requestedBy) : null;
    const artist = displayTrack?.artist || 'Unknown';
    const lines = displayTrack ? [
      `Сейчас играет: **${displayTrack.title}**`,
      duration ? `Длительность: ${duration}` : null,
      requester ? `Поставил: ${requester}` : null,
      artist ? `Song By: ${artist}` : null
    ].filter(Boolean) : [];

    await this.nowPlayingMessage.edit({
      content: lines.length > 0 ? lines.join('\n') : null,
      components: createPlayerControls(this.isPaused(), this.loopCurrent, this.autoplayEnabled, this.filters),
      allowedMentions: { users: [] }
    }).catch(() => {});
  }

  async createNowPlayingComponents(item) {
    try {
      const duration = formatDuration(item.duration) || '?:??';
      const requester = formatRequester(item.requestedBy);
      const artist = item.artist || 'Unknown';
      const status = this.isPaused() ? 'Paused' : 'Playing';
      const loopStatus = this.loopCurrent ? 'Loop on' : 'Loop off';
      const autoplayStatus = this.autoplayEnabled ? 'Autoplay on' : 'Autoplay off';

      const eqIcon = this.isPaused() ? '<:Kach:1172572415239401542>' : '<:Varvar:1172573027217702974>';
      const header = this.isPaused() ? `# ${eqIcon} Сейчас на паузе` : `# ${eqIcon} Сейчас играет`;

      const sourceBadge = item.spotifyTitle ? '**Spotify**' : '**YouTube Music**';
      const audioBadge = '`4K ultraHD`';

      const autoplayNote = item.isAutoplay
        ? `\n> *Рекомендация Autoplay • Похоже на «${item.autoplaySeedTitle || 'предыдущий трек'}»*`
        : '';

      const body = [
        header,
        '',
        `### ${formatTrackTitle(item)}`,
        `**${artist}** • \`${duration}\` • ${sourceBadge} • ${audioBadge}`,
        `Заказал: ${requester}${autoplayNote}`
      ].join('\n');

      const filterLabels = [];
      if (this.filters.bassboost || this.filters.bassboostHard) filterLabels.push('Bassboost Hard');
      if (this.filters.slowed) filterLabels.push('Slowed + Reverb');
      if (this.filters.speedup) filterLabels.push('Speed UP');
      if (this.filters.eightD) filterLabels.push('8D Audio');
      const filterText = filterLabels.length > 0 ? ` • Filters: ${filterLabels.join(', ')}` : '';
      const crossfadeText = this.crossfadeEnabled ? ` • Crossfade: ${this.crossfadeDuration}s` : '';

      const footer = `${status} • Queue: ${this.items.length} • ${loopStatus} • ${autoplayStatus}${crossfadeText}${filterText} • ${formatDiscordTimestamp()}`;

      const accentColor = await getTrackAccentColor(item);
      const container = new ContainerBuilder().setAccentColor(accentColor);

      if (item.thumbnail) {
        container.addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
            .setThumbnailAccessory(
              new ThumbnailBuilder()
                .setURL(item.thumbnail)
                .setDescription(item.title || 'Track cover')
            )
        );
      } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
      }

      const controls = createPlayerControls(this.isPaused(), this.loopCurrent, this.autoplayEnabled, this.filters);

      container
        .addSeparatorComponents(
          new SeparatorBuilder()
            .setDivider(true)
            .setSpacing(SeparatorSpacingSize.Small)
        )
        .addActionRowComponents(controls[0], controls[1])
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(footer))
        .addSeparatorComponents(
          new SeparatorBuilder()
            .setDivider(false)
            .setSpacing(SeparatorSpacingSize.Small)
        )
        .addActionRowComponents(controls[2]);

      return [container];
    } catch {
      return null;
    }
  }

  async deleteNowPlayingMessage() {
    if (!this.nowPlayingMessage) return;

    const message = this.nowPlayingMessage;
    this.nowPlayingMessage = null;
    await message.delete().catch(() => {});
  }

  scheduleDisconnect() {
    this.clearDisconnectTimer();
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      if (!this.current && this.items.length === 0) {
        void this.deleteNowPlayingMessage();
        this.connection?.destroy();
        this.connection = null;
        queues.delete(this.guildId);
      }
    }, 120_000);
  }

  clearDisconnectTimer() {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }
}
