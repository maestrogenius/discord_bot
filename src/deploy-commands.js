// Discord Music Bot
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import { assertBotConfig, config } from './config.js';

assertBotConfig({ requireToken: true, requireClientId: true });

const rest = new REST({ version: '10' }).setToken(config.token);

if (config.guildId) {
  console.log('Clearing global commands to prevent conflicts...');
  await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
  console.log('Global commands successfully cleared.');

  console.log(`Registering ${commands.length} guild commands for guild ${config.guildId}...`);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
  console.log(`Successfully registered ${commands.length} guild commands.`);
} else {
  console.log(`Registering ${commands.length} global commands...`);
  await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
  console.log(`Successfully registered ${commands.length} global commands.`);
}