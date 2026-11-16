import { Client, ClientApplication, ClientUser, Collection, Message, PermissionsBitField } from 'discord.js';
import { nextId } from '../dist/interactions.js';

export const ids = {
  guild: '100000000000000001', channel: '100000000000000002',
  user: '100000000000000003', bot: '100000000000000004', outside: '100000000000000005'
};

export function harness() {
  const client = new Client({ intents: [] });
  client.token = 'test-secret-that-must-never-appear-in-reports';
  client.user = new ClientUser(client, { id: ids.bot, username: 'test-bot', discriminator: '0000', avatar: null, bot: true });
  client.users.cache.set(ids.bot, client.user);
  client.application = new ClientApplication(client, { id: ids.bot, name: 'test' });
  client.isReady = () => true;
  const guild = client.guilds._add({ id: ids.guild, name: 'Test guild', owner_id: ids.user, roles: [], emojis: [], features: [], preferred_locale: 'en-US' });
  guild.roles._add({ id: ids.guild, name: '@everyone', permissions: PermissionsBitField.All.toString(), position: 0, color: 0, hoist: false, managed: false, mentionable: false });
  for (const [id, username] of [[ids.user, 'tester'], [ids.bot, 'test-bot']]) {
    guild.members._add({ user: { id, username, discriminator: '0000', avatar: null, bot: id === ids.bot }, roles: [], joined_at: new Date().toISOString(), deaf: false, mute: false, flags: 0 });
  }
  const channel = client.channels._add({ id: ids.channel, guild_id: ids.guild, name: 'tests', type: 0, position: 0, permission_overwrites: [] }, guild);
  guild.channels.cache.set(channel.id, channel);
  const messages = new Map();
  const sent = [];
  const deleted = [];
  const create = body => {
    const raw = {
      id: nextId(), channel_id: channel.id, guild_id: guild.id,
      author: { id: ids.bot, username: 'test-bot', discriminator: '0000', avatar: null, bot: true },
      content: body.content ?? '', timestamp: new Date().toISOString(), edited_timestamp: null,
      tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [],
      embeds: body.embeds?.map(e => e.toJSON?.() ?? e) ?? [],
      components: body.components?.map(c => c.toJSON?.() ?? c) ?? [], pinned: false, type: 0, flags: 0
    };
    const message = new Message(client, raw);
    message.edit = async update => {
      if (update.content !== undefined) message.content = update.content;
      if (update.components) message._patch({ components: update.components.map(c => c.toJSON?.() ?? c) });
      return message;
    };
    message.delete = async () => { messages.delete(message.id); deleted.push(message.id); return message; };
    messages.set(message.id, message);
    return message;
  };
  channel.send = async body => { sent.push(body); return create(body); };
  channel.messages.fetch = async options => {
    if (typeof options === 'string') {
      const result = messages.get(options);
      if (!result) throw new Error('Unknown message');
      return result;
    }
    return new Collection([...messages].filter(([id]) => !options?.after || BigInt(id) > BigInt(options.after)).reverse().slice(0, options?.limit ?? 100));
  };
  const command = { id: '100000000000000020', name: 'ping', type: 1, defaultMemberPermissions: null, toJSON() { return { id: this.id, name: this.name, type: this.type }; } };
  const commands = new Collection([[command.id, command]]);
  guild.commands.fetch = async () => commands;
  client.application.commands.fetch = async () => new Collection();
  client.guilds.fetch = async id => { if (id !== guild.id) throw new Error('Outside guild'); return guild; };
  client.channels.fetch = async id => client.channels.cache.get(id) ?? null;
  guild.members.fetch = async options => {
    const id = typeof options === 'string' ? options : options.user;
    const result = guild.members.cache.get(id);
    if (!result) throw new Error('Unknown member');
    return result;
  };
  guild.members.fetchMe = async () => guild.members.cache.get(ids.bot);
  guild.channels.fetch = async id => id ? guild.channels.cache.get(id) ?? null : guild.channels.cache;
  guild.roles.fetch = async id => id ? guild.roles.cache.get(id) ?? null : guild.roles.cache;
  return {
    client, guild, channel, command, commands, messages, create, sent, deleted,
    config: { guildId: ids.guild, channelIds: [ids.channel], userIds: [ids.user], mirrorResponses: true, timeoutMs: 500 }
  };
}
