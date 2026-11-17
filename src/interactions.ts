import {
  AutocompleteInteraction, ButtonInteraction, ChannelSelectMenuInteraction,
  ChatInputCommandInteraction, MentionableSelectMenuInteraction, Message,
  MessageContextMenuCommandInteraction, ModalSubmitInteraction, RoleSelectMenuInteraction,
  StringSelectMenuInteraction, UserContextMenuCommandInteraction, UserSelectMenuInteraction,
  MessageFlags, MessageFlagsBitField, PermissionsBitField, type Client, type GuildMember, type Interaction
} from 'discord.js';
import type { InteractionInput } from './protocol.js';
import { modalComponents } from './components.js';

type Raw = Record<string, any>;

let increment = 0n;

export function nextId() {
  increment = (increment + 1n) % 4096n;
  return (((BigInt(Date.now()) - 1420070400000n) << 22n) | (31n << 17n) | increment).toString();
}

export function memberData(member: GuildMember) {
  return {
    user: userData(member.user), roles: [...member.roles.cache.keys()],
    joined_at: member.joinedAt?.toISOString() ?? new Date().toISOString(),
    deaf: member.voice.deaf ?? false, mute: member.voice.mute ?? false,
    nick: member.nickname, flags: member.flags.bitfield,
    premium_since: member.premiumSince?.toISOString() ?? null
  };
}

export function userData(user: { id: string; username: string; discriminator: string; avatar: string | null; bot?: boolean }) {
  return { id: user.id, username: user.username, discriminator: user.discriminator, avatar: user.avatar, bot: user.bot };
}

export function messageData(message: Message) {
  return {
    id: message.id, channel_id: message.channelId, guild_id: message.guildId,
    author: userData(message.author), content: message.content,
    timestamp: message.createdAt.toISOString(), edited_timestamp: message.editedAt?.toISOString() ?? null,
    tts: message.tts, mention_everyone: message.mentions.everyone,
    mentions: message.mentions.users.map(userData), mention_roles: [...message.mentions.roles.keys()],
    attachments: message.attachments.map(attachmentData), embeds: message.embeds.map(e => e.toJSON()),
    components: message.components.map(c => c.toJSON()), pinned: message.pinned, type: message.type,
    flags: message.flags.bitfield
  };
}

export function attachmentData(attachment: any) {
  return { id: attachment.id, filename: attachment.name, size: attachment.size, url: attachment.url, proxy_url: attachment.proxyURL, content_type: attachment.contentType, height: attachment.height, width: attachment.width, ephemeral: attachment.ephemeral };
}

export function constructInteraction(client: Client<true>, input: InteractionInput, context: {
  guildId: string; member: GuildMember; channel: any; resolved?: Raw; commandId?: string; message?: Message;
}) {
  const commandType = input.kind === 'user-context' ? 2 : input.kind === 'message-context' ? 3 : 1;
  const data: Raw = {
    id: nextId(), application_id: client.application.id, token: 'testbench-synthetic-token',
    version: 1, type: input.kind === 'autocomplete' ? 4 : ['button', 'select'].includes(input.kind) ? 3 : input.kind === 'modal' ? 5 : 2,
    guild_id: context.guildId, channel: { id: input.channelId, type: context.channel.type },
    member: { ...memberData(context.member), permissions: context.channel.permissionsFor(context.member)?.bitfield.toString() ?? '0' },
    app_permissions: context.channel.permissionsFor(client.user)?.bitfield.toString() ?? '0',
    locale: 'en-US', guild_locale: context.member.guild.preferredLocale, context: 0,
    entitlements: [], authorizing_integration_owners: { '0': context.guildId }, attachment_size_limit: 10485760,
    data: {
      id: context.commandId ?? nextId(), name: input.name, type: commandType, guild_id: context.guildId,
      options: input.options, custom_id: input.customId,
      component_type: input.kind === 'button' ? 2 : input.componentType,
      values: input.values, resolved: context.resolved ?? {}, target_id: input.targetId,
      components: modalComponents(input.fields, input.modalFields)
    }
  };
  if (context.message) data.message = messageData(context.message);
  if (input.kind === 'select' && input.componentType === 3) delete data.data.resolved;
  const constructors: Record<string, any> = {
    command: ChatInputCommandInteraction, autocomplete: AutocompleteInteraction,
    button: ButtonInteraction, modal: ModalSubmitInteraction,
    'user-context': UserContextMenuCommandInteraction, 'message-context': MessageContextMenuCommandInteraction,
    select: { 3: StringSelectMenuInteraction, 5: UserSelectMenuInteraction, 6: RoleSelectMenuInteraction, 7: MentionableSelectMenuInteraction, 8: ChannelSelectMenuInteraction }[input.componentType]
  };
  const interaction = new constructors[input.kind](client, data) as Interaction;
  if (context.message && 'message' in interaction) interaction.message = context.message;
  Object.defineProperty(interaction, 'testbench', { value: true, enumerable: false });
  Object.defineProperty(interaction, 'testbenchPayload', { value: data, enumerable: false });
  return interaction;
}

export type ResponseEvent = { method: string; at: string; data?: unknown; messageId?: string; visibility?: string };

export function captureResponses(interaction: Interaction, options: {
  mirror: boolean; events: ResponseEvent[]; pending: Set<Promise<unknown>>; startedAt: number; errors: string[];
}) {
  const target = interaction as any;
  let original: Message | undefined;
  let acknowledgedAt: number | undefined;
  let closed = false;
  const localMessages = new Map<string, Message>();

  function event(method: string, data?: unknown, message?: Message, ephemeral = false) {
    options.events.push({ method, at: new Date().toISOString(), data, messageId: message?.id, visibility: ephemeral ? 'captured-ephemeral' : options.mirror && message ? 'discord-channel' : 'captured-only' });
  }

  function normalize(payload: any): Raw {
    if (typeof payload === 'string') return { content: payload };
    if (payload?.toJSON) return payload.toJSON();
    return { ...payload };
  }

  function ephemeral(payload: Raw) {
    return Boolean(payload.ephemeral || new MessageFlagsBitField(payload.flags ?? 0).has(MessageFlags.Ephemeral));
  }

  function ack() {
    if (target.replied || target.deferred || target.responded) throw new Error('InteractionAlreadyReplied');
    acknowledgedAt = Date.now();
  }

  function local(payload: Raw): Message {
    const result = new (Message as any)(interaction.client, {
      id: nextId(), channel_id: interaction.channelId!, guild_id: interaction.guildId!,
      author: userData(interaction.client.user!), content: payload.content ?? '', timestamp: new Date().toISOString(),
      edited_timestamp: null, tts: false, mention_everyone: false, mentions: [], mention_roles: [],
      attachments: [], embeds: payload.embeds?.map((e: any) => e.toJSON?.() ?? e) ?? [],
      components: payload.components?.map((c: any) => c.toJSON?.() ?? c) ?? [],
      pinned: false, type: 0, flags: new MessageFlagsBitField(payload.flags ?? 0).bitfield | (ephemeral(payload) ? 64 : 0)
    }) as Message;
    localMessages.set(result.id, result);
    Object.assign(result, {
      edit: async (value: any) => { if (closed) throw new Error('Test run is closed'); const p = normalize(value); patchLocal(result, p); event('message.edit', p, result, result.flags.has(MessageFlags.Ephemeral)); return result; },
      delete: async () => { if (closed) throw new Error('Test run is closed'); localMessages.delete(result.id); event('message.delete', undefined, result, true); return result; },
      awaitMessageComponent: async () => { throw new Error('Collector waits need real Gateway events. Use routed interactionCreate handlers for synthetic tests.'); },
      createMessageComponentCollector: () => { throw new Error('Collector-based flows are not supported by the synthetic adapter.'); }
    });
    return result;
  }

  function patchLocal(message: Message, payload: Raw) {
    const patch: Raw = { ...payload, id: message.id };
    if (patch.flags !== undefined && message.flags.has(MessageFlags.Ephemeral)) patch.flags = new MessageFlagsBitField(patch.flags).bitfield | MessageFlags.Ephemeral;
    if (patch.embeds) patch.embeds = patch.embeds.map((e: any) => e.toJSON?.() ?? e);
    if (patch.components) patch.components = patch.components.map((c: any) => c.toJSON?.() ?? c);
    (message as any)._patch(patch);
  }

  async function send(payload: Raw, edit = false, source = original) {
    const hidden = edit ? Boolean(target.ephemeral) : ephemeral(payload);
    let message: Message;
    if (options.mirror && !hidden) {
      const { ephemeral: _ephemeral, fetchReply: _fetchReply, withResponse: _withResponse, deleteAfter: _deleteAfter, ...body } = payload;
      if (body.flags !== undefined) body.flags = new MessageFlagsBitField(body.flags).bitfield & ~MessageFlags.Ephemeral;
      body.allowedMentions = { parse: [], repliedUser: false };
      const channel = interaction.channel as any;
      message = edit && source && !localMessages.has(source.id) ? await source.edit(body) : await channel.send(body);
    } else {
      if (edit && source && localMessages.has(source.id)) { patchLocal(source, payload); message = source; }
      else message = local({ ...payload, flags: new MessageFlagsBitField(payload.flags ?? 0).bitfield | (hidden ? MessageFlags.Ephemeral : 0) });
    }
    if (payload.deleteAfter !== undefined) {
      const timer = setTimeout(() => { void message.delete().catch(() => {}); }, Math.max(0, payload.deleteAfter * 1000));
      timer.unref();
    }
    return message;
  }

  function wrap(name: string, handler: (...args: any[]) => Promise<any>) {
    if (typeof target[name] !== 'function') return;
    target[name] = (...args: any[]) => {
      if (closed) return Promise.reject(new Error('Test run is closed'));
      const promise = Promise.resolve().then(() => handler(...args));
      options.pending.add(promise);
      promise.then(() => options.pending.delete(promise), error => {
        options.errors.push(error instanceof Error ? error.message : String(error));
        options.pending.delete(promise);
      });
      return promise;
    };
  }

  wrap('reply', async value => {
    ack(); const payload = normalize(value); target.replied = true; target.ephemeral = ephemeral(payload);
    original = await send(payload); event('reply', payload, original, target.ephemeral);
    return payload.withResponse ? { resource: { message: original } } : payload.fetchReply ? original : undefined;
  });
  wrap('deferReply', async (value = {}) => {
    ack(); target.deferred = true; target.ephemeral = ephemeral(value); event('deferReply', value, undefined, target.ephemeral);
    return value.withResponse ? { resource: null } : undefined;
  });
  wrap('editReply', async value => {
    if (!target.replied && !target.deferred) throw new Error('InteractionNotReplied');
    const payload = normalize(value); original = await send(payload, true); target.replied = true;
    event('editReply', payload, original, target.ephemeral); return original;
  });
  wrap('followUp', async value => {
    if (!target.replied && !target.deferred) throw new Error('InteractionNotReplied');
    const payload = normalize(value); const message = await send(payload);
    event('followUp', payload, message, ephemeral(payload)); return message;
  });
  wrap('fetchReply', async (id = '@original') => {
    if (id === '@original' && original) return original;
    if (localMessages.has(id)) return localMessages.get(id);
    if (id !== '@original' && options.events.some(e => e.messageId === id)) return (interaction.channel as any).messages.fetch(id);
    throw new Error('No captured reply found');
  });
  wrap('deleteReply', async (id = '@original') => {
    const message = id === '@original' ? original : localMessages.get(id);
    if (!message) throw new Error('No captured reply found');
    await message.delete(); event('deleteReply', undefined, message, target.ephemeral);
    if (id === '@original') original = undefined;
  });
  wrap('showModal', async value => { ack(); target.replied = true; event('showModal', normalize(value)); });
  wrap('respond', async value => { ack(); target.responded = true; event('respond', value); });
  wrap('deferUpdate', async () => { ack(); target.deferred = true; original = target.message; event('deferUpdate'); });
  wrap('update', async value => {
    ack(); if (!target.message) throw new Error('No source message');
    target.replied = true; original = target.message; const payload = normalize(value);
    original = await send(payload, true, original); event('update', payload, original); return undefined;
  });
  wrap('awaitModalSubmit', async () => { throw new Error('Collector waits are not supported. Submit the captured modal as a separate test interaction.'); });
  if ('webhook' in target) target.webhook = {
    send: target.followUp, editMessage: async (id: string, payload: any) => {
      if (id !== '@original' && id !== original?.id) throw new Error('Only the original reply can be edited through the synthetic webhook');
      return target.editReply(payload);
    }, fetchMessage: target.fetchReply, deleteMessage: target.deleteReply
  };
  return {
    close: () => { closed = true; },
    acknowledgementMs: () => acknowledgedAt === undefined ? null : acknowledgedAt - options.startedAt,
    acknowledged: () => acknowledgedAt !== undefined,
    permissions: new PermissionsBitField(target.memberPermissions ?? 0n).toArray()
  };
}
