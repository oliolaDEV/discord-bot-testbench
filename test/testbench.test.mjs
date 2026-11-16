import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Collection, MessageFlags, StringSelectMenuBuilder } from 'discord.js';
import { parse as parseToml } from 'smol-toml';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestbench } from '../dist/index.js';
import { TestbenchService } from '../dist/service.js';
import { operationSchema } from '../dist/protocol.js';
import { requestBridge } from '../dist/connection.js';
import { runScenario, substitute } from '../dist/scenarios.js';
import { harness, ids } from './harness.mjs';

const exec = promisify(execFile);
const commandInput = extra => ({ op: 'interact', interaction: { kind: 'command', name: 'ping', channelId: ids.channel, userId: ids.user, ...extra } });

async function service(t, handler, overrides = {}) {
  const h = harness();
  const root = await mkdtemp(join(tmpdir(), 'discord-testbench-'));
  await mkdir(join(root, 'runs'));
  t.after(async () => { h.client.destroy(); await rm(root, { recursive: true, force: true }); });
  const app = new TestbenchService(h.client, { ...h.config, ...overrides }, root, handler);
  return { ...h, root, app, run: input => app.execute(operationSchema.parse(input)) };
}

test('real discord.js command instances, options, response capture and live-state assertions', async t => {
  const h = await service(t, async interaction => {
    assert.equal(interaction.isChatInputCommand(), true);
    assert.equal(interaction.member.id, ids.user);
    assert.equal(interaction.options.getString('text'), 'hello');
    await interaction.deferReply();
    await interaction.editReply({ content: 'hello', embeds: [{ title: 'Verified' }] });
  });
  const result = await h.run(commandInput({ options: [{ name: 'text', type: 3, value: 'hello' }] }));
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.events.map(e => e.method), ['deferReply', 'editReply']);
  assert.equal(h.sent.length, 1);
  assert.equal((await h.run({ op: 'assert', channelId: ids.channel, messageId: result.events[1].messageId, contains: 'hello', embedTitle: 'Verified' })).passed, true);
  assert.equal((await h.run({ op: 'assert', channelId: ids.channel, contains: 'missing' })).passed, false);
  assert.equal(JSON.parse(await readFile(join(h.root, 'runs', result.id + '.json'), 'utf8')).status, 'passed');
});

test('ephemeral replies and edits are never mirrored, including flag arrays', async t => {
  for (const flags of [MessageFlags.Ephemeral, ['Ephemeral']]) {
    const h = await service(t, async interaction => {
      await interaction.reply({ content: 'private', flags });
      await interaction.editReply('still private');
      assert.equal((await interaction.fetchReply()).content, 'still private');
    });
    const result = await h.run(commandInput());
    assert.equal(result.status, 'passed');
    assert.equal(h.sent.length, 0);
    assert.equal(result.events[0].visibility, 'captured-ephemeral');
  }
});

test('exceptions, missing acknowledgements and duplicate replies fail instead of passing', async t => {
  for (const handler of [async () => { throw new Error('broken'); }, async () => {}, async i => { await i.reply('one'); await i.reply('two'); }]) {
    const h = await service(t, handler);
    const result = await h.run(commandInput());
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.length);
  }
});

test('guild channel and user boundaries reject before invoking the handler', async t => {
  let calls = 0;
  const h = await service(t, async () => { calls++; });
  await assert.rejects(h.run(commandInput({ channelId: ids.outside })), /outside/);
  await assert.rejects(h.run(commandInput({ userId: ids.outside })), /outside/);
  await assert.rejects(h.run(commandInput({ name: 'unregistered' })), /not registered/);
  assert.equal(calls, 0);
});

test('button, select, modal and autocomplete inputs use actual interaction classes', async t => {
  const h = await service(t, async i => {
    if (i.isButton()) { assert.equal(i.customId, 'open'); await i.reply('clicked'); }
    if (i.isStringSelectMenu()) { assert.deepEqual(i.values, ['blue']); await i.update({ content: 'blue' }); }
    if (i.isModalSubmit()) { assert.equal(i.fields.getTextInputValue('subject'), 'Hello'); await i.reply('submitted'); }
    if (i.isAutocomplete()) { assert.equal(i.options.getFocused(), 'ap'); await i.respond([{ name: 'Apple', value: 'apple' }]); }
  });
  const button = h.create({ content: 'button', components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open').setLabel('Open').setStyle(ButtonStyle.Primary))] });
  const select = h.create({ content: 'select', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('color').addOptions({ label: 'Blue', value: 'blue' }))] });
  const base = { channelId: ids.channel, userId: ids.user };
  for (const interaction of [
    { ...base, kind: 'button', customId: 'open', messageId: button.id },
    { ...base, kind: 'select', customId: 'color', messageId: select.id, values: ['blue'] },
    { ...base, kind: 'modal', customId: 'form', fields: { subject: 'Hello' } },
    { ...base, kind: 'autocomplete', name: 'ping', options: [{ type: 3, name: 'query', value: 'ap', focused: true }] }
  ]) {
    const result = await h.run({ op: 'interact', interaction });
    assert.equal(result.status, 'passed', JSON.stringify(result));
  }
  await assert.rejects(h.run({ op: 'interact', interaction: { ...base, kind: 'select', customId: 'color', messageId: select.id, values: ['red'] } }), /absent/);
});

test('a timeout returns a report and locks mutations until the handler settles', async t => {
  let release;
  const gate = new Promise(resolvePromise => { release = resolvePromise; });
  const h = await service(t, async i => { await i.deferReply(); await gate; }, { timeoutMs: 100 });
  const result = await h.run(commandInput());
  assert.equal(result.status, 'timed_out');
  assert.equal((await h.run({ op: 'status' })).busy, true);
  await assert.rejects(h.run({ op: 'send', channelId: ids.channel, content: 'blocked' }), /still running/);
  release(); await delay(10);
  assert.equal((await h.run({ op: 'status' })).busy, false);
});

test('bot tokens are redacted in returned and persisted reports', async t => {
  const h = await service(t, async i => { throw new Error(i.client.token); });
  const result = await h.run(commandInput());
  assert.ok(!JSON.stringify(result).includes(h.client.token));
  assert.ok(!(await readFile(join(h.root, 'runs', result.id + '.json'), 'utf8')).includes(h.client.token));
});

test('local HTTP authentication, origin rejection, validation and MCP stdio round trip', async t => {
  const h = harness();
  const root = await mkdtemp(join(tmpdir(), 'discord-testbench-bridge-'));
  const handle = await startTestbench(h.client, { root, config: h.config, dispatch: async i => i.reply('Pong!') });
  t.after(async () => { await handle.close(); h.client.destroy(); await rm(root, { recursive: true, force: true }); });
  const descriptor = JSON.parse(await readFile(join(root, '.testbench', 'bridge.json'), 'utf8'));
  const unauthorized = await fetch(handle.url + '/v1/run', { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401);
  const headers = { Authorization: 'Bearer ' + descriptor.token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(handle.url + '/v1/run', { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: '{}' })).status, 403);
  assert.equal((await fetch(handle.url + '/v1/run', { method: 'POST', headers, body: '{"op":"unknown"}' })).status, 400);
  assert.equal((await requestBridge(root, { op: 'status' })).ready, true);
  await assert.rejects(startTestbench(h.client, { root, config: h.config }), /already exists/);
  const client = new McpClient({ name: 'integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'serve', '--root', root] });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 12);
    const result = await client.callTool({ name: 'testbench_interact', arguments: { interaction: commandInput().interaction } });
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.content[0].text).status, 'passed');
    const failed = await client.callTool({ name: 'testbench_assert', arguments: { channelId: ids.channel, contains: 'not present' } });
    assert.equal(failed.isError, true);
  } finally { await client.close(); }
});

test('init preserves other MCP servers and is repeatable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'discord-testbench-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { existing: { command: 'existing' } } }));
  const args = [resolve('dist/cli.js'), 'init', '--root', root, '--guild', ids.guild, '--channel', ids.channel, '--user', ids.user];
  await exec(process.execPath, args);
  await exec(process.execPath, args);
  const mcp = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.existing.command, 'existing');
  assert.ok(mcp.mcpServers['discord-testbench']);
  assert.equal(parseToml(await readFile(join(root, '.codex', 'config.toml'), 'utf8')).mcp_servers['discord-testbench'].command, process.execPath);
  assert.equal((await readFile(join(root, 'AGENTS.md'), 'utf8')).match(/TESTBENCH.md/g).length, 1);
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /\.testbench\//);
  assert.match(await readFile(join(root, 'TESTBENCH.md'), 'utf8'), /Test your changes/);
});

test('scenario references resolve structurally and failures stop execution', async () => {
  assert.deepEqual(substitute({ id: '{{steps.first.id}}' }, { steps: { first: { id: 'abc' } } }), { id: 'abc' });
  assert.throws(() => substitute('{{steps.__proto__}}', { steps: {} }), /Invalid/);
  let calls = 0;
  const result = await runScenario({ name: 'failure', steps: [
    { id: 'first', request: { op: 'status' }, expect: [{ path: 'ready', equals: true }] },
    { id: 'second', request: { op: 'cleanup' } }
  ] }, async () => { calls++; return { ready: false }; });
  assert.equal(result.passed, false);
  assert.equal(calls, 1);
});

test('context menus resolve real users and messages', async t => {
  const h = await service(t, async i => {
    if (i.isUserContextMenuCommand()) { assert.equal(i.targetUser.id, ids.user); await i.reply(i.targetUser.username); }
    if (i.isMessageContextMenuCommand()) { assert.equal(i.targetMessage.content, 'context target'); await i.reply('quoted'); }
  });
  const source = h.create({ content: 'context target' });
  for (const type of [2, 3]) {
    h.command.type = type;
    const result = await h.run(commandInput({
      kind: type === 2 ? 'user-context' : 'message-context',
      targetId: type === 2 ? ids.user : source.id,
      ...(type === 3 ? { messageId: source.id } : {})
    }));
    assert.equal(result.status, 'passed', JSON.stringify(result));
  }
});

test('subcommands and user, channel and role options are resolved into discord.js objects', async t => {
  const h = await service(t, async i => {
    assert.equal(i.options.getSubcommand(), 'create');
    assert.equal(i.options.getUser('user').id, ids.user);
    assert.equal(i.options.getChannel('channel').id, ids.channel);
    assert.equal(i.options.getRole('role').id, ids.guild);
    await i.reply('resolved');
  });
  const result = await h.run(commandInput({ options: [{ name: 'create', type: 1, options: [
    { name: 'user', type: 6, value: ids.user },
    { name: 'channel', type: 7, value: ids.channel },
    { name: 'role', type: 8, value: ids.guild }
  ] }] }));
  assert.equal(result.status, 'passed', JSON.stringify(result));
});

test('tracked fixtures survive restarts and cleanup leaves unrelated resources alone', async t => {
  const h = await service(t, async i => i.reply('fixture'));
  const deletions = [];
  const createdId = '100000000000000030';
  h.guild.roles.create = async body => {
    const resource = { id: createdId, name: body.name, delete: async () => { deletions.push(createdId); } };
    h.guild.roles.cache.set(createdId, resource);
    return resource;
  };
  const fixture = await h.run({ op: 'fixture', kind: 'role', name: 'test-role' });
  assert.equal(fixture.name, 'testbench-test-role');
  const second = new TestbenchService(h.client, h.config, h.root);
  await second.restoreFixtures();
  const result = await second.execute({ op: 'cleanup' });
  assert.deepEqual(result.deleted, [createdId]);
  assert.deepEqual(deletions, [createdId]);
  assert.ok(h.guild.roles.cache.has(ids.guild));
  assert.deepEqual((await second.execute({ op: 'status' })).fixtures, []);
});

test('automatic listener dispatch awaits handlers and preserves client context', async t => {
  const h = await service(t, undefined);
  h.client.on('interactionCreate', async function (i) {
    assert.equal(this, h.client);
    await delay(5);
    await i.reply('listener was awaited');
  });
  assert.equal((await h.run(commandInput())).status, 'passed');
  assert.equal(h.sent[0].content, 'listener was awaited');
});

test('private edits preserve message identity and ephemeral flags', async t => {
  const h = await service(t, async i => {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const first = await i.editReply({ content: 'first', embeds: [{ title: 'Initial' }] });
    const edited = await i.editReply({ embeds: [{ title: 'Changed' }] });
    assert.equal(first.id, edited.id);
    assert.equal(edited.content, 'first');
    assert.equal(edited.embeds[0].title, 'Changed');
    assert.equal(edited.flags.has(MessageFlags.Ephemeral), true);
  });
  const result = await h.run(commandInput());
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(h.sent.length, 0);
});

test('captured response failures cannot silently pass when the handler catches them', async t => {
  const h = await service(t, async i => {
    await i.reply('first');
    await i.reply('duplicate').catch(() => undefined);
  });
  const result = await h.run(commandInput());
  assert.equal(result.status, 'failed');
  assert.ok(result.errors.includes('InteractionAlreadyReplied'));
});

test('CLI scenarios run through a real bridge and use exact reply references', async t => {
  const h = harness();
  const root = await mkdtemp(join(tmpdir(), 'discord-testbench-scenario-'));
  const handle = await startTestbench(h.client, { root, config: h.config, dispatch: async i => i.reply('Pong!') });
  t.after(async () => { await handle.close(); h.client.destroy(); await rm(root, { recursive: true, force: true }); });
  const { stdout } = await exec(process.execPath, [resolve('dist/cli.js'), 'run', resolve('examples/smoke.scenario.json'), '--root', root]);
  const result = JSON.parse(stdout);
  assert.equal(result.passed, true);
  assert.equal(result.steps.length, 3);
});

test('bridge client rejects non-loopback descriptors before making requests', async t => {
  const root = await mkdtemp(join(tmpdir(), 'discord-testbench-descriptor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.testbench'));
  await writeFile(join(root, '.testbench', 'bridge.json'), JSON.stringify({ version: 1, pid: process.pid, url: 'https://example.com', token: 'a'.repeat(64), guildId: ids.guild }));
  await assert.rejects(requestBridge(root, { op: 'status' }), /loopback/);
});
