// Discord Music Bot
import spotifyUrlInfo from 'spotify-url-info';

const { getData, getTracks } = spotifyUrlInfo(fetch);

export function isSpotifyUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'open.spotify.com' || url.hostname === 'spotify.link';
  } catch {
    return false;
  }
}

export function isSpotifyPlaylistOrAlbumUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'open.spotify.com' && /^\/(playlist|album)\//.test(url.pathname);
  } catch {
    return false;
  }
}

export async function getSpotifyCollectionTitle(url) {
  try {
    const data = await getData(url);
    return (data?.type === 'playlist' || data?.type === 'album') && data?.name
      ? String(data.name)
      : null;
  } catch {
    return null;
  }
}

function getArtistNames(artists) {
  if (!Array.isArray(artists)) return [];
  return artists
    .map((artist) => (typeof artist === 'string' ? artist.trim() : artist?.name?.trim()))
    .filter(Boolean);
}

export async function spotifyToSearchQueries(url) {
  const data = await getData(url);
  const type = data?.type;

  const buildTrack = (rawTrack, fallbackUrl) => {
    const track = rawTrack?.track || rawTrack;
    const title = track?.name;
    const rawArtists = track?.artists || (track?.artist ? [track.artist] : []);
    const artistNames = getArtistNames(rawArtists);
    const artistsString = artistNames.join(' ');
    const allArtistsDisplay = artistNames.join(', ');

    if (!title) return null;

    // Очищаем заголовок от суффиксов изданий и ремастеров
    const cleanTitle = title
      .replace(/\s*-\s*(Remastered|Remaster|Live|Radio Edit|Bonus Track).*$/i, '')
      .replace(/\s*\((Remastered|Remaster|Live|Radio Edit|Bonus Track).*\)/i, '')
      .trim();

    // Естественный поисковый запрос без кавычек и без минусов: "Баста GUF Only Today"
    const searchQuery = artistsString ? `${artistsString} ${cleanTitle}` : cleanTitle;

    const thumbnail = track?.album?.images?.[0]?.url
      || rawTrack?.album?.images?.[0]?.url
      || data?.coverArt?.sources?.[0]?.url
      || data?.images?.[0]?.url
      || null;

    return {
      title: allArtistsDisplay ? `${allArtistsDisplay} - ${title}` : title,
      query: searchQuery,
      searchQuery,
      url: track?.external_urls?.spotify || fallbackUrl,
      thumbnail,
      spotifyTitle: cleanTitle,
      spotifyArtists: artistNames,
      spotifyDurationMs: track?.duration || track?.duration_ms || null
    };
  };

  if (type === 'track') {
    const built = buildTrack(data, url);
    return built ? [built] : [];
  }

  if (type === 'playlist' || type === 'album') {
    const tracks = await getTracks(url);
    if (!Array.isArray(tracks)) return [];

    return tracks
      .map((track) => {
        const result = buildTrack(track, url);
        return result ? { ...result, sourcePlaylistTitle: data?.name || null } : null;
      })
      .filter(Boolean);
  }

  throw new Error(`Unsupported Spotify URL type: ${type || 'unknown'}`);
}