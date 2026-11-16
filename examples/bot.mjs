import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events,
  GatewayIntentBits, MessageFlags, ModalBuilder, SlashCommandBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle
} from 'discord.js';
import { startTestbench } from '../dist/index.js';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('testbench.config.json', 'utf8'));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check the bot response'),
  new SlashCommandBuilder().setName('echo').setDescription('Repeat a message').addStringOption(o => o.setName('text').setDescription('Text to repeat').setRequired(true)),
  new SlashCommandBuilder().setName('ticket').setDescription('Open the ticket form'),
  new SlashCommandBuilder().setName('choose').setDescription('Choose a color'),
  new SlashCommandBuilder().setName('search').setDescription('Search example choices').addStringOption(o => o.setName('query').setDescription('Search query').setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName('private').setDescription('Return a private response'),
  { name: 'Inspect user', type: 2 },
  { name: 'Quote message', type: 3 }
];

async function route(interaction) {
  if (interaction.isAutocomplete()) {
    const query = interaction.options.getFocused().toLowerCase();
    await interaction.respond(['Apple', 'Banana', 'Cherry'].filter(name => name.toLowerCase().includes(query)).map(name => ({ name, value: name })));
    return;
  }
  if (interaction.isUserContextMenuCommand()) {
    await interaction.reply(`User: ${interaction.targetUser.tag}`);
    return;
  }
  if (interaction.isMessageContextMenuCommand()) {
    await interaction.reply(`Quoted: ${interaction.targetMessage.content}`);
    return;
  }
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'ping') await interaction.reply('Pong!');
    if (interaction.commandName === 'echo') await interaction.reply(interaction.options.getString('text', true));
    if (interaction.commandName === 'private') await interaction.reply({ content: 'Only the test identity should see this.', flags: MessageFlags.Ephemeral });
    if (interaction.commandName === 'search') await interaction.reply(`Selected: ${interaction.options.getString('query', true)}`);
    if (interaction.commandName === 'ticket') {
      await interaction.reply({ content: 'Tell us what you need.', components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:open').setLabel('Open ticket').setStyle(ButtonStyle.Primary))] });
    }
    if (interaction.commandName === 'choose') {
      await interaction.reply({ content: 'Choose a color.', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('color:choose').setPlaceholder('Color').addOptions({ label: 'Blue', value: 'blue' }, { label: 'Green', value: 'green' }))] });
    }
    return;
  }
  if (interaction.isButton() && interaction.customId === 'ticket:open') {
    const modal = new ModalBuilder().setCustomId('ticket:submit').setTitle('New ticket').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject').setLabel('Subject').setStyle(TextInputStyle.Short).setRequired(true)));
    await interaction.showModal(modal);
  }
  if (interaction.isModalSubmit() && interaction.customId === 'ticket:submit') {
    await interaction.deferReply();
    await interaction.editReply(`Ticket received: ${interaction.fields.getTextInputValue('subject')}`);
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'color:choose') await interaction.update({ content: `Selected: ${interaction.values[0]}`, components: [] });
}

client.on(Events.InteractionCreate, route);
let testbench;

client.once(Events.ClientReady, async () => {
  try {
    const guild = await client.guilds.fetch(config.guildId);
    for (const command of commands) await guild.commands.create(command.toJSON?.() ?? command);
    testbench = await startTestbench(client, { dispatch: route });
    console.error(`Example bot ready as ${client.user.tag}`);
  } catch (error) {
    console.error(error.message);
    client.destroy();
    process.exitCode = 1;
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await testbench?.close();
  client.destroy();
});

await client.login(process.env.DISCORD_BOT_TOKEN);
