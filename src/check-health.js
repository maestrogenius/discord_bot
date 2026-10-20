// Discord Music Bot
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { Client, GatewayIntentBits } from 'discord.js';
import { config, assertBotConfig } from './config.js';
import { ensureYtdlp, getStreamUrl, resolveYoutubeItems } from './youtube.js';
import { spotifyToSearchQueries } from './spotify.js';

async function checkHealth() {
  console.log('=== Запуск праверкі працаздольнасці бота ===\n');
  let hasErrors = false;

  // 1. Конфигурация
  console.log('1. Праверка зменных асяроддзя (.env):');
  try {
    assertBotConfig({ requireToken: true });
    console.log('   [OK] DISCORD_TOKEN прысутнічае');
  } catch (error) {
    console.error('   [FAIL] Памылка канфігурацыі:', error.message);
    hasErrors = true;
  }

  // 2. Авторизация в Discord
  if (config.token) {
    console.log('\n2. Праверка падключэння да Discord Gateway:');
    const testClient = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
    });

    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          testClient.destroy().catch(() => {});
          reject(new Error('Час чакання адказу Discord Gateway перавышаны (10 сек)'));
        }, 10_000);

        testClient.once('clientReady', () => {
          clearTimeout(timeout);
          console.log(`   [OK] Паспяховы ўваход як: ${testClient.user?.tag} (ID: ${testClient.user?.id})`);
          testClient.destroy().then(resolve).catch(resolve);
        });

        testClient.login(config.token).catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    } catch (err) {
      console.error('   [FAIL] Не атрымалася аўтарызавацца ў Discord:', err.message);
      hasErrors = true;
    }
  }

  // 3. FFmpeg
  console.log('\n3. Праверка ffmpeg-static:');
  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    try {
      const ffmpegVersion = await new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, ['-version']);
        let output = '';
        const timeout = setTimeout(() => {
          proc.kill();
          reject(new Error('FFmpeg не адказаў своечасова'));
        }, 5_000);

        proc.stdout.on('data', (d) => { output += d.toString(); });
        proc.on('close', (code) => {
          clearTimeout(timeout);
          if (code === 0) resolve(output.split('\n')[0]);
          else reject(new Error(`Exit code ${code}`));
        });
        proc.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
      console.log(`   [OK] FFmpeg даступны: ${ffmpegVersion}`);
    } catch (err) {
      console.error('   [FAIL] Памылка запуску FFmpeg:', err.message);
      hasErrors = true;
    }
  } else {
    console.error(`   [FAIL] Шлях ffmpeg не знойдзены: ${ffmpegPath}`);
    hasErrors = true;
  }

  // 4. yt-dlp
  console.log('\n4. Праверка бінарніка yt-dlp:');
  try {
    const ytdlp = await ensureYtdlp();
    const version = await ytdlp.execPromise(['--version']);
    console.log(`   [OK] yt-dlp ініцыялізаваны. Версія: ${version.trim()}`);
  } catch (err) {
    console.error('   [FAIL] Не атрымалася ініцыялізаваць або запусціць yt-dlp:', err.message);
    hasErrors = true;
  }

  // 5. Поиск YouTube (InnerTube HTTP + resolveYoutubeItems)
  console.log('\n5. Тэст хуткага пошуку трэка (searchYoutubeHttp / resolveYoutubeItems):');
  const testQuery = 'Never Gonna Give You Up';
  let resolvedUrl = null;
  try {
    const t0 = Date.now();
    const tracks = await resolveYoutubeItems(testQuery, 'HealthCheck', { limit: 1, timeoutMs: 10_000 });
    const searchDuration = Date.now() - t0;
    if (tracks.length > 0 && tracks[0].url) {
      resolvedUrl = tracks[0].url;
      console.log(`   [OK] Знойдзены трэк за ${searchDuration}ms: "${tracks[0].title}" (${resolvedUrl})`);
    } else {
      console.error('   [FAIL] Пошук не вярнуў вынікаў.');
      hasErrors = true;
    }
  } catch (err) {
    console.error('   [FAIL] Памылка пошуку:', err.message);
    hasErrors = true;
  }

  // 6. Прямой аудиопоток
  if (resolvedUrl) {
    console.log('\n6. Тэст атрымання прамога аўдыяструменю (getStreamUrl):');
    try {
      const streamUrl = await getStreamUrl(resolvedUrl, { timeoutMs: 15_000 });
      if (streamUrl && streamUrl.startsWith('http')) {
        console.log('   [OK] Аўдыяструмень паспяхова атрыманы.');
      } else {
        console.error('   [FAIL] yt-dlp не вярнуў прыдатны URL струменю.');
        hasErrors = true;
      }
    } catch (err) {
      console.error('   [FAIL] Памылка атрымання струменю:', err.message);
      hasErrors = true;
    }
  }

  // 7. Spotify
  console.log('\n7. Тэст парсінгу спасылкі Spotify:');
  const testSpotifyUrl = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';
  try {
    const spotifyResults = await spotifyToSearchQueries(testSpotifyUrl);
    if (Array.isArray(spotifyResults) && spotifyResults.length > 0) {
      console.log(`   [OK] Spotify трэк распазнаны: "${spotifyResults[0].title}"`);
    } else {
      console.error('   [FAIL] Spotify не вярнуў інфармацыю пра трэк.');
      hasErrors = true;
    }
  } catch (err) {
    console.error('   [FAIL] Памылка парсінгу Spotify:', err.message);
    hasErrors = true;
  }

  console.log('\n===========================================');
  if (hasErrors) {
    console.log('Вынік: Знойдзены праблемы ў працы бота. Глядзіце дэталі вышэй.');
    process.exit(1);
  } else {
    console.log('Вынік: Усе асноўныя кампаненты працуюць спраўна!');
    process.exit(0);
  }
}

checkHealth().catch((err) => {
  console.error('Нечаканая памылка пры праверцы:', err);
  process.exit(1);
});