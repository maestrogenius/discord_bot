// Discord Music Bot
import net from 'node:net';
import os from 'node:os';

function acquireSingleInstanceLock(port = 48291) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error('\n================================================================');
        console.error('[FATAL] ОШИБКА: Другой экземпляр бота уже запущен в фоновом режиме!');
        console.error('Несколько запущенных копий бота конфликтуют в Discord и блокируют воспроизведение.');
        console.error('Завершите старый процесс (или закройте старые терминалы) перед запуском нового.');
        console.error('================================================================\n');
        process.exit(1);
      }
      resolve(server);
    });
    server.once('listening', () => {
      resolve(server);
    });
    server.listen(port, '127.0.0.1');
  });
}

await acquireSingleInstanceLock();
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} from 'discord.js';
import { assertBotConfig, config } from './config.js';
import { ensureYtdlp } from './youtube.js';
import { getGuildQueue } from './music-queue.js';
import {
  createQueuePagerControls,
  getQueuePageFromCustomId,
  isPlayerControl,
  isQueuePagerControl,
  playerControlIds
} from './player-controls.js';
import {
  getHistoryChoices,
  getPlayedTrack,
  getRecentPlaylists,
  getRecentPlayedTracks,
  getSavedPlaylist,
  refreshPlaylistTitles,
  recordPlaylist,
  recordPlayQuery
} from './play-history.js';

try {
  os.setPriority(process.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
} catch {}

const temporaryReplyMs = 10_000;
const queuePageSize = 25;
const historyPageSize = 25;

assertBotConfig({ requireToken: true });
await ensureYtdlp();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

client.once('clientReady', () => {
  console.log('Bot is online.');
  void logStartupChecks();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.guild) return;

  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (interaction.isButton() && isQueuePagerControl(interaction.customId)) {
      await handleQueuePagerButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('history:')) {
      await handleHistoryButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('played-history:play:')) {
      await handlePlayedHistoryButton(interaction);
      return;
    }

    if (interaction.isButton() && isPlayerControl(interaction.customId)) {
      await handlePlayerButton(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'queue:select_track') {
        await handleQueueSelectMenu(interaction);
        return;
      }
      if (interaction.customId === 'history:select_replay') {
        await handleHistorySelectMenu(interaction);
        return;
      }
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName !== 'play') {
      console.log(`[Command] /${interaction.commandName} invoked by ${interaction.user.tag}`);
    }

    if (interaction.commandName === 'play') {
      await handlePlay(interaction);
      return;
    }

    const queue = getGuildQueue(interaction.guildId);

    if (interaction.commandName === 'skip') {
      queue.skip();
      await replyTemporary(interaction, 'Трек пропущен.');
      return;
    }

    if (interaction.commandName === 'shuffle' || interaction.commandName === 'shufle') {
      queue.shuffle();
      await replyTemporary(interaction, `Очередь перемешана. Треков в очереди: ${queue.items.length}.`);
      return;
    }

    if (interaction.commandName === 'stop') {
      queue.stop();
      await replyTemporary(interaction, 'Воспроизведение остановлено, очередь очищена.');
      return;
    }

    if (interaction.commandName === 'pause') {
      const paused = queue.pause();
      await replyTemporary(interaction, paused ? 'Пауза.' : 'Сейчас нечего ставить на паузу.');
      return;
    }

    if (interaction.commandName === 'resume') {
      const resumed = queue.resume();
      await replyTemporary(interaction, resumed ? 'Продолжаю.' : 'Сейчас нечего продолжать.');
      return;
    }

    if (interaction.commandName === 'loop') {
      const isLooping = queue.toggleLoop();
      await queue.updateNowPlayingControls();
      await replyTemporary(interaction, isLooping ? 'Повтор текущего трека включен.' : 'Повтор выключен.');
      return;
    }

    if (interaction.commandName === 'autoplay') {
      const isAutoplaying = queue.toggleAutoplay();
      await queue.updateNowPlayingControls();

      if (isAutoplaying && !queue.current && queue.items.length === 0) {
        void queue.playNext();
      }

      await replyTemporary(interaction, isAutoplaying ? 'Autoplay включен: бот будет подбирать похожие треки.' : 'Autoplay выключен.');
      return;
    }

    if (interaction.commandName === 'crossfade') {
      const durationOpt = interaction.options.getInteger('duration');
      let msg;
      if (durationOpt !== null) {
        if (durationOpt === 0) {
          queue.crossfadeEnabled = false;
          queue.clearCrossfadeTimer();
          msg = 'Smart Crossfade выключен.';
        } else {
          queue.crossfadeEnabled = true;
          queue.crossfadeDuration = durationOpt;
          msg = `Smart Crossfade включен (${durationOpt} сек).`;
        }
      } else {
        const active = queue.toggleCrossfade();
        msg = active
          ? `Smart Crossfade включен (${queue.crossfadeDuration} сек).`
          : 'Smart Crossfade выключен.';
      }
      await queue.updateNowPlayingControls();
      await replyTemporary(interaction, msg);
      return;
    }

    if (interaction.commandName === 'nowplaying') {
      const msg = queue.current ? `Сейчас играет: **${queue.current.title}**` : 'Сейчас ничего не играет.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg);
      } else {
        await interaction.reply(msg);
      }
      return;
    }

    if (interaction.commandName === 'queue') {
      const payload = buildQueuePagePayload(queue, 0);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply(payload);
      }
      return;
    }

    if (interaction.commandName === 'history') {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply();
      }
      await interaction.editReply(await buildHistoryPayload(interaction.guildId));
      return;
    }
  } catch (error) {
    if (error?.code === 10062 || error?.code === 40060) {
      console.warn(`[Interaction] ${interaction.commandName ? '/' + interaction.commandName : interaction.customId || 'interaction'} timed out (expired before receipt).`);
      return;
    }
    console.error('Interaction failed:', error);
    await safeInteractionResponse(interaction, getUserFacingError(error));
  }
});

const autocompleteControllers = new Map();

async function handleAutocomplete(interaction) {
  if (interaction.commandName !== 'play') return;

  const guildId = interaction.guildId;
  const focusedValue = interaction.options.getFocused();

  // Cancel prior active search for this guild so typing fast doesn't pile up HTTP requests
  if (autocompleteControllers.has(guildId)) {
    try {
      autocompleteControllers.get(guildId).abort();
    } catch {}
    autocompleteControllers.delete(guildId);
  }

  const controller = new AbortController();
  autocompleteControllers.set(guildId, controller);

  try {
    const choices = await getHistoryChoices(guildId, focusedValue, controller.signal);
    if (!controller.signal.aborted && !interaction.responded) {
      await interaction.respond(choices);
      console.log(`[Autocomplete] Query: "${focusedValue}" -> responding with ${choices.length} choices`);
    }
  } catch (error) {
    if (error?.code !== 10062 && error?.code !== 40060 && error?.name !== 'AbortError') {
      console.warn('[Autocomplete] Warning:', error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (autocompleteControllers.get(guildId) === controller) {
      autocompleteControllers.delete(guildId);
    }
  }
}

async function safeButtonReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply({
        ...(typeof payload === 'string' ? { content: payload } : payload),
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    if (error?.code !== 10062 && error?.code !== 40060) {
      console.warn('[Button] Reply warning:', error instanceof Error ? error.message : String(error));
    }
  }
}

async function handlePlayerButton(interaction) {
  console.log(`[Button] ${interaction.customId} clicked by ${interaction.user.tag}`);
  const queue = getGuildQueue(interaction.guildId);

  if (interaction.customId === playerControlIds.queue) {
    await safeButtonReply(interaction, buildQueuePagePayload(queue, 0));
    return;
  }

  // STOP always works regardless of user's voice status so anyone can stop unwanted audio
  if (interaction.customId === playerControlIds.stop) {
    queue.stop();
    await safeButtonReply(interaction, 'Воспроизведение остановлено, очередь очищена.');
    return;
  }

  const userVoiceChannelId = interaction.member?.voice?.channelId;
  const userVoiceChannel = interaction.member?.voice?.channel;
  if (!userVoiceChannelId && !userVoiceChannel) {
    await safeButtonReply(interaction, 'Сначала зайдите в голосовой канал.');
    return;
  }

  if (interaction.customId === playerControlIds.previous) {
    const changed = queue.previous();
    await safeButtonReply(interaction, changed ? 'Возвращаю предыдущий трек.' : 'Предыдущего трека нет.');
    return;
  }

  if (interaction.customId === playerControlIds.pauseResume) {
    const changed = queue.isPaused() ? queue.resume() : queue.pause();
    await safeButtonReply(interaction, changed ? (queue.isPaused() ? 'Пауза.' : 'Продолжаю.') : 'Сейчас нечего переключать.');
    void queue.updateNowPlayingControls();
    return;
  }

  if (interaction.customId === playerControlIds.skip) {
    queue.skip();
    await safeButtonReply(interaction, 'Трек пропущен.');
    return;
  }

  if (interaction.customId === playerControlIds.shuffle) {
    queue.shuffle();
    await safeButtonReply(interaction, `Очередь перемешана. Треков в очереди: ${queue.items.length}.`);
    return;
  }

  if (interaction.customId === playerControlIds.loop) {
    const isLooping = queue.toggleLoop();
    await safeButtonReply(
      interaction,
      isLooping
        ? 'Loop включен: текущий трек будет повторяться.'
        : 'Loop выключен: текущий трек доиграет до конца, дальше пойдет очередь.'
    );
    void queue.updateNowPlayingControls();
    return;
  }

  if (interaction.customId === playerControlIds.autoplay) {
    const isAutoplaying = queue.toggleAutoplay();
    await safeButtonReply(
      interaction,
      isAutoplaying
        ? 'Autoplay включен: бот будет автоматически подбирать похожие треки.'
        : 'Autoplay выключен.'
    );
    void queue.updateNowPlayingControls();

    if (isAutoplaying && !queue.current && queue.items.length === 0) {
      void queue.playNext();
    }
    return;
  }

  if (interaction.customId === playerControlIds.replay) {
    const restarted = queue.replay();
    await safeButtonReply(interaction, restarted ? 'Текущий трек запускаю заново.' : 'Сейчас нечего запускать заново.');
    return;
  }

  if (interaction.customId === playerControlIds.clear) {
    const removedCount = queue.clear();
    await safeButtonReply(
      interaction,
      removedCount > 0
        ? `Очередь очищена. Удалено треков: ${removedCount}.`
        : 'Очередь уже пуста.'
    );
    void queue.updateNowPlayingControls();
    return;
  }

  if (interaction.customId === playerControlIds.filterSlowed) {
    const active = queue.toggleFilter('slowed');
    await safeButtonReply(
      interaction,
      active
        ? 'Эффект **Slowed + Reverb** включен.'
        : 'Эффект **Slowed + Reverb** выключен.'
    );
    return;
  }

  if (interaction.customId === playerControlIds.filterBassboost) {
    const active = queue.toggleFilter('bassboost');
    await safeButtonReply(
      interaction,
      active
        ? 'Эффект **Bassboosted (Hard)** включен.'
        : 'Эффект **Bassboosted** выключен.'
    );
    return;
  }

  if (interaction.customId === playerControlIds.filterSpeedup) {
    const active = queue.toggleFilter('speedup');
    await safeButtonReply(
      interaction,
      active
        ? 'Эффект **Speed UP** включен.'
        : 'Эффект **Speed UP** выключен.'
    );
    return;
  }

  if (interaction.customId === playerControlIds.filter8D) {
    const active = queue.toggleFilter('eightD');
    await safeButtonReply(
      interaction,
      active
        ? 'Эффект **8D Audio** включен (пространственный звук с вращением).'
        : 'Эффект **8D Audio** выключен.'
    );
    return;
  }
}

async function handleQueuePagerButton(interaction) {
  const queue = getGuildQueue(interaction.guildId);
  const page = getQueuePageFromCustomId(interaction.customId);
  await interaction.update(buildQueuePagePayload(queue, page));
}

async function handlePlayedHistoryButton(interaction) {
  const entryId = interaction.customId.slice('played-history:play:'.length);
  const track = await getPlayedTrack(interaction.guildId, entryId);

  if (!track) {
    await interaction.reply({ content: 'Эта запись истории больше недоступна.', flags: MessageFlags.Ephemeral });
    return;
  }

  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: 'Сначала зайдите в голосовой канал.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const queue = getGuildQueue(interaction.guildId);
  const [_, result] = await Promise.all([
    queue.connect(voiceChannel, interaction.channel),
    queue.add(track.url, {
      id: interaction.user.id,
      tag: interaction.user.tag
    })
  ]);
  await interaction.editReply(formatPlayResult(queue, result));
}

async function handleHistoryButton(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];

  if (action === 'view') {
    const value = parts[2];
    if (value === 'tracks' || value === 'playlists') {
      await interaction.deferUpdate();
      await interaction.editReply(await buildHistoryPayload(interaction.guildId, value));
    }
    return;
  }

  if (action === 'page') {
    const value = parts[2];
    const pageValue = parts[3];
    if (value === 'tracks' || value === 'playlists') {
      const page = Number.parseInt(pageValue, 10);
      await interaction.deferUpdate();
      await interaction.editReply(await buildHistoryPayload(interaction.guildId, value, page));
    }
    return;
  }

  if (action === 'track' || action === 'playlist') {
    const entryId = parts.slice(2).join(':');
    await handleHistoryReplay(interaction, action, entryId);
  }
}

async function handleHistoryReplay(interaction, type, entryId) {
  const entry = type === 'playlist'
    ? await getSavedPlaylist(interaction.guildId, entryId)
    : await getPlayedTrack(interaction.guildId, entryId);

  if (!entry) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({ content: 'Эта запись истории больше недоступна.', flags: MessageFlags.Ephemeral });
    }
    return;
  }

  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({ content: 'Сначала зайдите в голосовой канал.', flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  const queue = getGuildQueue(interaction.guildId);
  const [_, result] = await Promise.all([
    queue.connect(voiceChannel, interaction.channel),
    queue.add(entry.url, {
      id: interaction.user.id,
      tag: interaction.user.tag
    })
  ]);

  if (result.isPlaylist && result.acceptedCount > 0) {
    void recordPlaylist(interaction.guildId, entry.url, result.sourceType, result.playlistTitle).catch(() => {});
  }

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(formatPlayResult(queue, result));
  } else {
    await interaction.reply({ ...formatPlayResult(queue, result), flags: MessageFlags.Ephemeral });
  }
}

async function handlePlay(interaction) {
  const query = interaction.options.getString('input') || interaction.options.getString('query');
  console.log(`[Command] /play query: "${query || '(empty/history)'}" invoked by ${interaction.user.tag}`);

  await interaction.deferReply();

  if (!query) {
    await interaction.editReply(await buildHistoryPayload(interaction.guildId));
    return;
  }

  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    await interaction.editReply('Сначала зайдите в голосовой канал.');
    return;
  }

  const queue = getGuildQueue(interaction.guildId);
  const requestedBy = {
    id: interaction.user.id,
    tag: interaction.user.tag
  };
  const startedAt = Date.now();

  await interaction.editReply(buildPendingPlayMessage(query));

  const [_, result] = await Promise.all([
    queue.connect(voiceChannel, interaction.channel),
    queue.add(query, requestedBy)
  ]);

  console.log(`[perf] /play completed in ${Date.now() - startedAt}ms (${result.sourceType})`);
  await interaction.editReply(formatPlayResult(queue, result));
  void recordPlayQuery(interaction.guildId, interaction.user.id, query).catch(() => {});
  if (result.isPlaylist && result.acceptedCount > 0) {
    void recordPlaylist(interaction.guildId, query, result.sourceType, result.playlistTitle).catch(() => {});
  }
}

async function safeInteractionResponse(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content);
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch {
    // Интеракция уже завершена
  }
}

function getUserFacingError(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('У бота нет прав в голосовом канале')) {
    return message;
  }

  if (message.includes('Не удалось подключиться к голосовому каналу')) {
    return 'Не получилось подключиться к голосовому каналу. Попробуйте еще раз через пару секунд.';
  }

  if (message.includes('timed out')) {
    return 'Источник отвечает слишком долго. Попробуйте еще раз или укажите другой трек.';
  }

  if (message.includes('No matching track found') || message.includes('No playable source found')) {
    return 'Не удалось найти playable-версию трека. Попробуйте более точный запрос или другую ссылку.';
  }

  if (message.includes('Sign in to confirm') || message.includes('not a bot')) {
    return [
      'YouTube просит подтвердить вход и блокирует yt-dlp.',
      'Войдите в YouTube в Edge/Chrome и укажите в `.env`: `YTDLP_COOKIES_FROM_BROWSER=edge` или `chrome`, затем закройте браузер и перезапустите бота.'
    ].join('\n');
  }

  return 'Не удалось выполнить команду.';
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Network check timeout')), timeoutMs).unref();
    })
  ]);
}

async function replyTemporary(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content);
    } else {
      await interaction.reply(content);
    }

    setTimeout(() => {
      interaction.deleteReply().catch(() => {});
    }, temporaryReplyMs).unref();
  } catch (error) {
    if (error?.code !== 10062 && error?.code !== 40060) {
      console.warn('[replyTemporary] Warning:', error instanceof Error ? error.message : String(error));
    }
  }
}

function buildPendingPlayMessage(query) {
  const shortQuery = shortenText(query, 80);
  return `Добавляю в очередь: **${shortQuery}**\nГотовлю воспроизведение...`;
}

function formatPlayResult(queue, result) {
  if (!result || result.acceptedCount === 0) {
    if (result?.requestedCount > 0 && result.skippedCount >= result.requestedCount) {
      return 'Очередь уже заполнена. Новые треки не добавлены.';
    }

    return 'Не удалось добавить трек в очередь.';
  }

  const firstTrack = result.acceptedTracks[0];
  const addedLine = result.acceptedCount === 1
    ? `Добавил в очередь: **${getTrackDisplayName(firstTrack)}**`
    : result.sourceType === 'playlist'
      ? `Добавил в очередь ${result.acceptedCount} треков из плейлиста.`
      : `Добавил в очередь ${result.acceptedCount} треков.`;
  const partialLine = result.skippedCount > 0
    ? `Пропущено: ${result.skippedCount} из-за лимита очереди.`
    : null;
  const statusLine = queue.current && !queue.isStarting
    ? `Сейчас играет: **${getTrackDisplayName(queue.current)}**`
    : queue.isPreparingPlayback()
      ? 'Первый трек еще подготавливается.'
      : `Треков в очереди: ${queue.items.length}.`;

  return [addedLine, partialLine, statusLine].filter(Boolean).join('\n');
}

function buildQueuePagePayload(queue, page) {
  const totalPages = Math.max(1, Math.ceil(queue.items.length / queuePageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const content = formatQueuePage(queue, safePage, totalPages);
  const components = [...createQueuePagerControls(safePage, totalPages)];

  // Пункт 3: Добавляем выпадающее меню со списком треков текущей страницы для мгновенного перехода
  const start = safePage * queuePageSize;
  const pageItems = queue.items.slice(start, start + queuePageSize);

  if (pageItems.length > 0) {
    const selectOptions = pageItems.map((track, idx) => {
      const realIndex = start + idx;
      const label = `${realIndex + 1}. ${track.title || track.spotifyTitle || 'Трек'}`;
      const desc = track.artist ? `Автор: ${track.artist}` : 'Нажмите для перехода к треку';

      return new StringSelectMenuOptionBuilder()
        .setLabel(label.slice(0, 100))
        .setDescription(desc.slice(0, 100))
        .setValue(String(realIndex));
    });

    components.unshift(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('queue:select_track')
          .setPlaceholder('⏩ Переключиться сразу на трек...')
          .addOptions(selectOptions)
      )
    );
  }

  return { content, components };
}

async function handleQueueSelectMenu(interaction) {
  console.log(`[SelectMenu] queue:select_track invoked by ${interaction.user.tag}`);
  const queue = getGuildQueue(interaction.guildId);
  const targetIndex = Number.parseInt(interaction.values[0], 10);

  if (!Number.isFinite(targetIndex) || targetIndex < 0 || targetIndex >= queue.items.length) {
    await interaction.reply({ content: 'Этот трек уже не в очереди.', flags: MessageFlags.Ephemeral });
    return;
  }

  // 1. Извлекаем только выбранный трек (все остальные треки остаются нетронутыми)
  const [selectedTrack] = queue.items.splice(targetIndex, 1);

  // 2. Ставим его на первое место очереди
  queue.items.unshift(selectedTrack);

  // 3. Переключаем плеер на него
  queue.skip();

  // 4. Обновляем отображение очереди
  await interaction.update(buildQueuePagePayload(queue, 0));
}

function formatQueuePage(queue, page, totalPages) {
  const current = queue.current
    ? `${queue.isStarting ? 'Готовится' : 'Сейчас играет'}: **${getTrackDisplayName(queue.current)}**`
    : 'Сейчас ничего не играет.';

  if (queue.items.length === 0) {
    return `${current}\n\nОчередь пуста.`;
  }

  const start = page * queuePageSize;
  const pageItems = queue.items
    .slice(start, start + queuePageSize)
    .map((track, index) => {
      const name = shortenText(track?.title || track?.spotifyTitle || track?.searchQuery || 'Трек', 60);
      return `${start + index + 1}. ${name}${formatQueueStateSuffix(track)}`;
    });

  return [
    current,
    '',
    `Очередь — страница ${page + 1}/${totalPages}:`,
    pageItems.join('\n')
  ].join('\n');
}

async function buildHistoryPayload(guildId, view = 'tracks') {
  const isPlaylistView = view === 'playlists';
  const entries = isPlaylistView
    ? await getRecentPlaylists(guildId, historyPageSize)
    : await getRecentPlayedTracks(guildId, historyPageSize);

  if (isPlaylistView && entries.length > 0) {
    await refreshPlaylistTitles(guildId, entries.map((entry) => entry.id));
  }

  const heading = isPlaylistView ? 'История плейлистов' : 'История воспроизведения';

  return {
    content: entries.length > 0
      ? `## ${heading}\nВыберите запись из выпадающего меню ниже:`
      : `## ${heading}\nИстория пока пуста.`,
    components: buildHistoryControls(entries, view)
  };
}

function buildHistoryControls(entries, view) {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('history:view:tracks')
        .setLabel('ТРЕКИ')
        .setStyle(view === 'tracks' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('history:view:playlists')
        .setLabel('ПЛЕЙЛИСТЫ')
        .setStyle(view === 'playlists' ? ButtonStyle.Primary : ButtonStyle.Secondary)
    )
  ];

  if (entries.length > 0) {
    const type = view === 'playlists' ? 'playlist' : 'track';
    const selectOptions = entries.slice(0, 25).map((entry, idx) => {
      const position = idx + 1;
      const label = `${position}. ${entry.title || 'Без названия'}`;
      const desc = entry.artist ? `Автор: ${entry.artist}` : (view === 'playlists' ? 'Плейлист' : 'Трек');

      return new StringSelectMenuOptionBuilder()
        .setLabel(label.slice(0, 100))
        .setDescription(desc.slice(0, 100))
        .setValue(`${type}:${entry.id}`);
    });

    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('history:select_replay')
          .setPlaceholder('▶ Выберите трек или плейлист для запуска...')
          .addOptions(selectOptions)
      )
    );
  }

  return rows;
}

async function handleHistorySelectMenu(interaction) {
  console.log(`[SelectMenu] history:select_replay invoked by ${interaction.user.tag}`);
  const [type, entryId] = interaction.values[0].split(':');
  await handleHistoryReplay(interaction, type, entryId);
}

function escapeMarkdown(value) {
  return String(value || 'Неизвестный трек').replaceAll(/[\\`*_{}\[\]()<>#+\-.!|]/g, '\\$&');
}

function formatQueueStateSuffix(track) {
  if (track?.isAutoplay) {
    return track.prefetchedStreamUrl ? ' [Autoplay • готов]' : ' [Autoplay]';
  }
  if (track?.prefetchedStreamUrl) {
    return ' [готов]';
  }
  switch (track?.state) {
    case 'resolving':
      return ' [подготовка]';
    case 'fallback_ready':
      return ' [есть запасной источник]';
    case 'failed':
      return ' [ошибка]';
    default:
      return '';
  }
}

function getTrackDisplayName(track) {
  const value = track?.title || track?.spotifyTitle || track?.searchQuery || track?.url || 'Трек';
  return shortenText(value, 80);
}

function shortenText(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

await client.login(config.token);

async function logStartupChecks() {
  const checks = [
    ['Discord API', 'https://discord.com/api/v10/gateway'],
    ['YouTube', 'https://www.youtube.com']
  ];

  for (const [label, url] of checks) {
    try {
      await withTimeout(fetch(url, { method: 'HEAD' }), 4_000);
      console.log(`${label}: OK`);
    } catch (error) {
      console.warn(`${label}: unavailable`);
      console.warn(error instanceof Error ? error.message : String(error));
    }
  }
}