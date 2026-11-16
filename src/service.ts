import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ChannelType, PermissionFlagsBits, type Client, type Interaction, type Message, type MessageCreateOptions } from 'discord.js';
import { type TestbenchConfig, writeJson } from './config.js';
import { constructInteraction, captureResponses, memberData, messageData, userData, attachmentData, type ResponseEvent } from './interactions.js';
import { errorMessage, serialize, type InteractionInput, type Operation } from './protocol.js';
import { componentTree, componentText, modalComponents, validateModal } from './components.js';

export type Dispatcher = (interaction: Interaction) => unknown | Promise<unknown>;

export class TestbenchService {
  private busy = false;
  private activeHandlers = 0;
  private fixtures = new Map<string, 'channel' | 'role'>();
  private modals = new Map<string, Record<string, any>>();

  constructor(
    private client: Client<true>,
    readonly config: TestbenchConfig,
    private directory: string,
    private dispatch?: Dispatcher
  ) {}

  private redact(value: unknown) {
    const secrets = [this.client.token].filter((v): v is string => Boolean(v));
    let result = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
    for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
    return JSON.parse(result);
  }

  private async guild() {
    return this.client.guilds.fetch(this.config.guildId);
  }

  private async channel(id: string) {
    if (!this.config.channelIds.includes(id) && this.fixtures.get(id) !== 'channel') throw new Error('Channel is outside the configured testbench');
    const channel = await this.client.channels.fetch(id);
    if (!channel || !('guildId' in channel) || channel.guildId !== this.config.guildId || !channel.isTextBased() || !('send' in channel)) {
      throw new Error('Expected a text channel in the configured guild');
    }
    return channel;
  }

  async execute(input: Operation): Promise<unknown> {
    return this.redact(await this.perform(input));
  }

  private async perform(input: Operation): Promise<unknown> {
    if (input.op === 'status') return {
      ready: this.client.isReady(), adapter: this.config.adapter, bot: { id: this.client.user.id, tag: this.client.user.tag },
      guildId: this.config.guildId, channelIds: this.config.channelIds, userIds: this.config.userIds,
      busy: this.busy || this.activeHandlers > 0, mirrorResponses: this.config.mirrorResponses,
      interactionMode: 'synthetic-dispatch-with-live-discord-effects', fixtures: [...this.fixtures].map(([id, kind]) => ({ id, kind }))
    };
    if (input.op === 'commands') {
      const guild = await this.guild();
      const [global, local] = await Promise.all([this.client.application.commands.fetch(), guild.commands.fetch()]);
      return { global: global.map(c => c.toJSON()), guild: local.map(c => c.toJSON()) };
    }
    if (input.op === 'inspect') {
      const guild = await this.guild();
      const [channels, roles, me] = await Promise.all([guild.channels.fetch(), guild.roles.fetch(), guild.members.fetchMe()]);
      const channel = input.channelId ? await this.channel(input.channelId) : undefined;
      return {
        guild: { id: guild.id, name: guild.name },
        channels: channels.filter(c => c !== null).map(c => ({ id: c!.id, name: c!.name, type: c!.type, parentId: c!.parentId, permissionOverwrites: c!.isThread() ? [] : c!.permissionOverwrites.cache.map(p => p.toJSON()) })),
        roles: roles.map(r => ({ id: r.id, name: r.name, permissions: r.permissions.toArray(), position: r.position })),
        botPermissions: me.permissions.toArray(),
        channelPermissions: channel ? await Promise.all(this.config.userIds.map(async id => {
          const member = await guild.members.fetch({ user: id, force: true });
          return { userId: id, permissions: channel.permissionsFor(member)?.toArray() ?? [] };
        })) : undefined
      };
    }
    if (input.op === 'messages') {
      const channel = await this.channel(input.channelId);
      return (await channel.messages.fetch({ limit: input.limit })).map(messageData).reverse();
    }
    if (input.op === 'wait') {
      const channel = await this.channel(input.channelId);
      const deadline = Date.now() + input.timeoutMs;
      do {
        const messages = await channel.messages.fetch({ limit: 100, after: input.after });
        const match = [...messages.values()].find(m => m.content.includes(input.contains));
        if (match) return { matched: true, message: messageData(match) };
        await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
      } while (Date.now() < deadline);
      return { matched: false, timeoutMs: input.timeoutMs };
    }
    if (input.op === 'assert') {
      if ([input.contains, input.embedTitle, input.componentId, input.componentType].every(value => value === undefined)) throw new Error('Provide at least one assertion');
      const channel = await this.channel(input.channelId);
      const messages = input.messageId ? [await channel.messages.fetch(input.messageId)] : [...(await channel.messages.fetch({ limit: 100 })).values()];
      const matches = messages.filter(message => {
        const components = message.components.map(c => c.toJSON());
        return (input.contains === undefined || [message.content, componentText(components)].join('\n').includes(input.contains))
          && (input.embedTitle === undefined || message.embeds.some(e => e.title === input.embedTitle))
          && ((input.componentId === undefined && input.componentType === undefined) || componentTree(components).some(component => (input.componentId === undefined || component.custom_id === input.componentId) && (input.componentType === undefined || component.type === input.componentType)));
      });
      return { passed: matches.length > 0, examined: messages.length, messageIds: matches.map(m => m.id) };
    }
    if (input.op === 'runs') {
      if (input.runId) return JSON.parse(await readFile(join(this.directory, 'runs', input.runId + '.json'), 'utf8'));
      const files = (await readdir(join(this.directory, 'runs'))).filter(f => /^[0-9a-f-]{36}\.json$/.test(f));
      const runs = await Promise.all(files.map(async f => JSON.parse(await readFile(join(this.directory, 'runs', f), 'utf8'))));
      return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
    }
    if (this.busy || this.activeHandlers > 0) throw new Error('A mutating operation is still running. Wait for it to finish before retrying.');
    this.busy = true;
    try {
      if (input.op === 'interact') return await this.interact(input.interaction);
      if (input.op === 'send') {
        const channel = await this.channel(input.channelId);
        const payload = { ...(input.message ?? { content: input.content }), allowedMentions: { parse: [] } } as MessageCreateOptions;
        return { mode: 'real-bot-message', message: messageData(await channel.send(payload)), note: 'Sent by the bot. Handlers that ignore bot messages will ignore this message.' };
      }
      if (input.op === 'fixture') {
        const guild = await this.guild();
        const name = 'testbench-' + input.name;
        const resource = input.kind === 'channel'
          ? await guild.channels.create({ name, type: ChannelType.GuildText, reason: 'Discord Bot Testbench fixture' })
          : await guild.roles.create({ name, permissions: [], reason: 'Discord Bot Testbench fixture' });
        this.fixtures.set(resource.id, input.kind);
        await this.saveFixtures();
        return { id: resource.id, kind: input.kind, name };
      }
      if (input.op === 'cleanup') {
        const guild = await this.guild();
        const deleted: string[] = [];
        const errors: { id: string; error: string }[] = [];
        for (const [id, kind] of this.fixtures) {
          try {
            const resource = kind === 'channel' ? await guild.channels.fetch(id) : await guild.roles.fetch(id);
            if (resource) await resource.delete('Discord Bot Testbench cleanup');
            this.fixtures.delete(id); deleted.push(id); await this.saveFixtures();
          } catch (error) { errors.push({ id, error: errorMessage(error) }); }
        }
        return { deleted, errors, note: 'Only tracked fixtures are removed. Handler-created resources and test messages are retained.' };
      }
    } finally { this.busy = false; }
  }

  async restoreFixtures() {
    try {
      const data = JSON.parse(await readFile(join(this.directory, 'fixtures.json'), 'utf8'));
      if (data.guildId === this.config.guildId && Array.isArray(data.fixtures)) {
        for (const entry of data.fixtures) {
          if (/^\d{17,20}$/.test(entry.id) && ['channel', 'role'].includes(entry.kind)) this.fixtures.set(entry.id, entry.kind);
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  private async saveFixtures() {
    await writeJson(join(this.directory, 'fixtures.json'), { guildId: this.config.guildId, fixtures: [...this.fixtures].map(([id, kind]) => ({ id, kind })) });
  }

  private async resolve(input: InteractionInput, channel: any, guild: any) {
    const resolved: Record<string, any> = { users: {}, members: {}, roles: {}, channels: {}, messages: {}, attachments: {} };
    const addUser = async (id: string) => {
      const member = await guild.members.fetch({ user: id, force: true });
      resolved.users[id] = userData(member.user); resolved.members[id] = memberData(member);
    };
    const addValue = async (type: number, id: string) => {
      if (type === 6) await addUser(id);
      if (type === 7) {
        const found = await guild.channels.fetch(id);
        if (!found) throw new Error('Option channel does not exist in the test guild');
        resolved.channels[id] = { id, name: found.name, type: found.type, permissions: found.permissionsFor(await guild.members.fetchMe())?.bitfield.toString() ?? '0' };
      }
      if (type === 8) {
        const role = await guild.roles.fetch(id);
        if (!role) throw new Error('Option role does not exist in the test guild');
        resolved.roles[id] = { id, name: role.name, color: role.color, position: role.position, permissions: role.permissions.bitfield.toString(), managed: role.managed, hoist: role.hoist, mentionable: role.mentionable };
      }
      if (type === 9) {
        const role = await guild.roles.fetch(id);
        await addValue(role ? 8 : 6, id);
      }
      if (type === 11) throw new Error('Attachment command options are not supported by the synthetic adapter');
    };
    const walk = async (options: any[]) => {
      for (const option of options) {
        if (option.options) await walk(option.options);
        if ([6, 7, 8, 9, 11].includes(option.type)) await addValue(option.type, option.value);
      }
    };
    await walk(input.options);
    if (input.kind === 'user-context') await addUser(input.targetId!);
    if (input.kind === 'message-context') {
      if (input.targetId !== input.messageId) throw new Error('message-context targetId must equal messageId');
      const message = await channel.messages.fetch(input.targetId!);
      resolved.messages[message.id] = messageData(message);
    }
    if (input.kind === 'select' && input.componentType !== 3) {
      const type = { 5: 6, 6: 8, 7: 9, 8: 7 }[input.componentType];
      for (const value of input.values) await addValue(type!, value);
    }
    if (input.kind === 'modal') {
      const source = input.attachmentMessageId ? await channel.messages.fetch(input.attachmentMessageId) : undefined;
      for (const field of input.modalFields) {
        if ([5, 6, 7, 8].includes(field.type) && 'values' in field) {
          const type = { 5: 6, 6: 8, 7: 9, 8: 7 }[field.type as 5 | 6 | 7 | 8];
          for (const value of field.values) await addValue(type, value);
        }
        if (field.type === 19) {
          if (!source && field.values.length) throw new Error('File-upload fields require attachmentMessageId from this test channel');
          for (const id of field.values) {
            const attachment = source?.attachments.get(id);
            if (!attachment) throw new Error('Uploaded file ID does not exist on the attachment source message');
            resolved.attachments[id] = attachmentData(attachment);
          }
        }
      }
    }
    return resolved;
  }

  private async interact(input: InteractionInput) {
    const channel = await this.channel(input.channelId);
    if (!this.config.userIds.includes(input.userId)) throw new Error('User is outside the configured testbench identities');
    const guild = await this.guild();
    const member = await guild.members.fetch({ user: input.userId, force: true });
    if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) throw new Error('Test identity cannot view this channel');
    const resolved = await this.resolve(input, channel, guild);
    let commandId: string | undefined;
    if (input.name) {
      const type = input.kind === 'user-context' ? 2 : input.kind === 'message-context' ? 3 : 1;
      const [local, global] = await Promise.all([guild.commands.fetch(), this.client.application.commands.fetch()]);
      const command = local.find(c => c.name === input.name && c.type === type) ?? global.find(c => c.name === input.name && c.type === type);
      if (!command) throw new Error(`Command ${input.name} is not registered. Register it before testing.`);
      if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.UseApplicationCommands)) throw new Error('Test identity lacks UseApplicationCommands');
      if (command.defaultMemberPermissions && !channel.permissionsFor(member)?.has(command.defaultMemberPermissions)) throw new Error('Test identity lacks the command default member permissions');
      commandId = command.id;
    }
    let message: Message | undefined;
    if (input.messageId) {
      message = await channel.messages.fetch(input.messageId);
      if (['button', 'select'].includes(input.kind)) {
        if (message.author.id !== this.client.user.id) throw new Error('Component source must be a message authored by the connected bot');
        const component = componentTree(message.components.map(c => c.toJSON())).find(component => component.custom_id === input.customId);
        if (!component || component.disabled) throw new Error('Component does not exist or is disabled');
        if (component.type !== (input.kind === 'button' ? 2 : input.componentType)) throw new Error('Component type does not match');
        if (input.kind === 'select') {
          if (input.values.length < (component.min_values ?? 1) || input.values.length > (component.max_values ?? 1)) throw new Error('Select value count is outside the component limits');
          if (input.componentType === 3 && input.values.some(value => !component.options.some((o: any) => o.value === value))) throw new Error('Select contains a value absent from the source component');
          if (new Set(input.values).size !== input.values.length) throw new Error('Select values must be unique');
          if (input.componentType === 8 && component.channel_types?.length && input.values.some(value => !component.channel_types.includes(resolved.channels[value]?.type))) throw new Error('Selected channel type is not allowed');
        }
      }
    }
    if (input.kind === 'modal') {
      const definition = this.modals.get(`${input.channelId}:${input.userId}:${input.customId}`);
      if (definition) validateModal(definition, modalComponents(input.fields, input.modalFields), resolved);
    }
    const interaction = constructInteraction(this.client, input, { guildId: guild.id, member, channel, commandId, resolved, message });
    const id = randomUUID();
    const started = Date.now();
    const events: ResponseEvent[] = [];
    const pending = new Set<Promise<unknown>>();
    const errors: string[] = [];
    const capture = captureResponses(interaction, { mirror: this.config.mirrorResponses, events, pending, startedAt: started, errors });
    this.activeHandlers++;
    const task = (async () => {
      const listeners = this.dispatch ? [this.dispatch] : this.client.rawListeners('interactionCreate');
      if (!listeners.length) throw new Error('No interactionCreate listeners found. Attach handlers before starting the testbench.');
      const results = await Promise.allSettled(listeners.map(listener => Promise.resolve().then(() => listener.call(this.client, interaction))));
      for (const result of results) if (result.status === 'rejected') errors.push(errorMessage(result.reason));
      while (pending.size) {
        const results = await Promise.allSettled([...pending]);
        for (const result of results) if (result.status === 'rejected') errors.push(errorMessage(result.reason));
      }
    })().finally(() => { this.activeHandlers--; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await Promise.race([task, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(new Error(`Handler exceeded ${this.config.timeoutMs}ms. It may still be running; mutations remain locked until it settles.`)); }, this.config.timeoutMs);
      })]);
    } catch (error) { errors.push(errorMessage(error)); }
    finally { clearTimeout(timer); capture.close(); }
    for (const event of events) {
      if (event.method === 'showModal') {
        const modal = event.data as Record<string, any>;
        this.modals.set(`${input.channelId}:${input.userId}:${modal.custom_id}`, modal);
        if (this.modals.size > 100) this.modals.delete(this.modals.keys().next().value!);
      }
    }
    if (!capture.acknowledged()) errors.push('Handler did not acknowledge the interaction');
    if ((capture.acknowledgementMs() ?? 0) > 3000) errors.push('Initial acknowledgement exceeded the Discord 3 second deadline');
    const report = this.redact({
      id, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
      status: timedOut ? 'timed_out' : errors.length ? 'failed' : 'passed',
      mode: 'synthetic-dispatch-with-live-discord-effects', input,
      acknowledgementMs: capture.acknowledgementMs(), events: serialize(events), errors: [...new Set(errors)],
      limits: ['No Discord client input or Gateway interaction delivery was tested.', 'Server command overrides, option schema enforcement and client rendering are not reproduced.', 'Unreturned background work cannot be awaited or rolled back.']
    });
    await writeJson(join(this.directory, 'runs', id + '.json'), report);
    if (timedOut) void task.catch(() => undefined);
    return report;
  }
}
