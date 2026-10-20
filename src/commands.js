// Discord Music Bot
import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Добавить трек, YouTube-плейлист или Spotify-плейлист в очередь')
    .addStringOption((option) =>
      option
        .setName('input')
        .setDescription('A search term or a link')
        .setRequired(false)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Пропустить текущий трек'),
  new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Перемешать очередь'),
  new SlashCommandBuilder()
    .setName('shufle')
    .setDescription('Перемешать очередь'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Остановить музыку и очистить очередь'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Показать очередь'),
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Поставить текущий трек на паузу'),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Продолжить воспроизведение'),
  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Показать текущий трек'),
  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Включить или выключить повтор текущего трека'),
  new SlashCommandBuilder()
    .setName('autoplay')
    .setDescription('Включить или выключить автоподбор похожих треков'),
  new SlashCommandBuilder()
    .setName('crossfade')
    .setDescription('Включить/выключить Smart Crossfade или настроить длительность')
    .addIntegerOption((option) =>
      option
        .setName('duration')
        .setDescription('Длительность перехода в секундах (0 - выключить, 1-8 сек)')
        .setMinValue(0)
        .setMaxValue(8)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('История треков и плейлистов с повторным запуском')
].map((command) => command.toJSON());