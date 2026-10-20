// Discord Music Bot
import 'dotenv/config';

export const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID || null,
  ytdlpPath: process.env.YTDLP_PATH || null,
  ytdlpCookies: process.env.YTDLP_COOKIES || null,
  ytdlpCookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || null
};

export function assertBotConfig({ requireToken = true, requireClientId = false } = {}) {
  const missing = [];

  if (requireToken && !config.token) missing.push('DISCORD_TOKEN');
  if (requireClientId && !config.clientId) missing.push('DISCORD_CLIENT_ID');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}