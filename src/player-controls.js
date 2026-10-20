// Discord Music Bot
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const playerControlIds = {
  previous: 'player:previous',
  pauseResume: 'player:pause_resume',
  skip: 'player:skip',
  stop: 'player:stop',
  shuffle: 'player:shuffle',
  queue: 'player:queue',
  loop: 'player:loop',
  clear: 'player:clear',
  autoplay: 'player:autoplay',
  replay: 'player:replay',
  filterSlowed: 'player:filter_slowed',
  filterBassboost: 'player:filter_bassboost',
  filterSpeedup: 'player:filter_speedup',
  filter8D: 'player:filter_8d'
};

const queuePagerPrefix = 'queue:page:';

export function createFilterControls(filters = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(playerControlIds.filterSlowed)
      .setLabel('Slowed + Reverb')
      .setStyle(filters.slowed ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(playerControlIds.filterBassboost)
      .setLabel('Bassboosted')
      .setStyle(filters.bassboost || filters.bassboostHard ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(playerControlIds.filterSpeedup)
      .setLabel('Speed UP')
      .setStyle(filters.speedup ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(playerControlIds.filter8D)
      .setLabel('8D Audio')
      .setStyle(filters.eightD ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );
}

export function createPlayerControls(isPaused = false, isLooping = false, isAutoplaying = false, filters = {}) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(playerControlIds.queue)
        .setLabel('QUEUE')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(playerControlIds.previous)
        .setLabel('BACK')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(playerControlIds.replay)
        .setLabel('REPLAY')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(playerControlIds.pauseResume)
        .setLabel(isPaused ? 'RESUME' : 'PAUSE')
        .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(playerControlIds.skip)
        .setLabel('SKIP')
        .setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(playerControlIds.autoplay)
        .setLabel('AUTOPLAY')
        .setStyle(isAutoplaying ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(playerControlIds.shuffle)
        .setLabel('SHUFFLE')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(playerControlIds.loop)
        .setLabel('LOOP')
        .setStyle(isLooping ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(playerControlIds.clear)
        .setLabel('CLEAR')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(playerControlIds.stop)
        .setLabel('STOP')
        .setStyle(ButtonStyle.Danger)
    ),
    createFilterControls(filters)
  ];
}

export function createQueuePagerControls(page, totalPages) {
  const previousPage = Math.max(0, page - 1);
  const nextPage = Math.min(totalPages - 1, page + 1);

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${queuePagerPrefix}prev:${previousPage}`)
        .setLabel('PREV')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`${queuePagerPrefix}next:${nextPage}`)
        .setLabel('NEXT')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1)
    )
  ];
}

export function isPlayerControl(customId) {
  return Object.values(playerControlIds).includes(customId);
}

export function isQueuePagerControl(customId) {
  return customId.startsWith(queuePagerPrefix);
}

export function getQueuePageFromCustomId(customId) {
  const value = Number.parseInt(customId.split(':').at(-1), 10);
  return Number.isFinite(value) ? value : 0;
}