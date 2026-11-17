import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TestbenchService } from '../dist/service.js';
import { remoteDispatcher } from '../dist/remote.js';
import { operationSchema } from '../dist/protocol.js';
import { harness, ids } from './harness.mjs';
import { Attachment } from 'discord.js';

test('language-neutral Discord HTTP handlers return real command and button responses', async t => {
  const h = harness();
  const root = await mkdtemp(join(tmpdir(), 'testbench-http-'));
  await mkdir(join(root, 'runs'));
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer ' + 'a'.repeat(64));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const interaction = JSON.parse(Buffer.concat(chunks));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(interaction.type === 3 ? { type: 7, data: { content: 'Button updated' } } : { type: 4, data: { content: 'HTTP pong' } }));
  });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); h.client.destroy(); await rm(root, { recursive: true, force: true }); });
  const app = new TestbenchService(h.client, h.config, root, remoteDispatcher(`http://127.0.0.1:${server.address().port}/interactions`, 'a'.repeat(64), 5000, 'discord-http'));
  const input = { channelId: ids.channel, userId: ids.user };
  const command = await app.execute(operationSchema.parse({ op: 'interact', interaction: { ...input, kind: 'command', name: 'ping' } }));
  assert.equal(command.status, 'passed', JSON.stringify(command));
  assert.equal(h.sent[0].content, 'HTTP pong');
  const message = h.create({ content: 'button', components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'test', label: 'Test' }] }] });
  const button = await app.execute(operationSchema.parse({ op: 'interact', interaction: { ...input, kind: 'button', messageId: message.id, customId: 'test' } }));
  assert.equal(button.status, 'passed', JSON.stringify(button));
  assert.equal(message.content, 'Button updated');
});

test('adapter callbacks allow 10 MiB uploads while retaining body limits', async t => {
  let payload;
  let callbackResult;
  const received = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { callback } = JSON.parse(Buffer.concat(chunks));
      const result = await fetch(callback.url, {
        method: 'POST', headers: { Authorization: 'Bearer ' + callback.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'reply', args: [payload] })
      });
      callbackResult = { status: result.status, body: await result.json() };
      response.end(JSON.stringify({ handled: true, errors: [] }));
    } catch (error) {
      response.end(JSON.stringify({ handled: true, errors: [error.message] }));
    }
  });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const dispatch = remoteDispatcher(`http://127.0.0.1:${server.address().port}/interactions`, 'a'.repeat(64), 10000);
  const interaction = { testbenchPayload: {}, reply: async value => { received.push(value); } };
  const file = { attachment: Buffer.alloc(10 * 1048576, 42).toString('base64'), encoding: 'base64', name: 'large.bin' };
  payload = { files: [file] };
  await dispatch(interaction);
  assert.equal(callbackResult.status, 200);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].files[0].attachment, Buffer.alloc(10 * 1048576, 42));
  for (const extra of [{}, { files: [] }, { files: 'placeholder' }]) {
    payload = { content: 'x'.repeat(1048576), ...extra };
    await dispatch(interaction);
    assert.equal(callbackResult.status, 413);
    assert.equal(callbackResult.body.error, 'Response exceeds 1 MiB');
  }
  payload = { files: [{ ...file, attachment: 'A'.repeat(14 * 1048576) }] };
  await dispatch(interaction);
  assert.equal(callbackResult.status, 413);
  assert.equal(callbackResult.body.error, 'Response exceeds 14 MiB');
  assert.equal(received.length, 1);
});

test('discord.py commands, hybrid replies, files, deletion, views, dynamic items and modals cross the adapter protocol', { skip: !process.env.TESTBENCH_PYTHON }, async t => {
  const h = harness();
  const root = await mkdtemp(join(tmpdir(), 'testbench-python-'));
  await mkdir(join(root, 'runs'));
  await writeFile(join(root, 'testbench.config.json'), JSON.stringify(h.config));
  const child = spawn(process.env.TESTBENCH_PYTHON, [resolve('test/python_worker.py'), root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', data => { diagnostics += data; });
  t.after(async () => { child.kill(); h.client.destroy(); await rm(root, { recursive: true, force: true }); });
  let descriptor;
  for (let i = 0; i < 100; i++) {
    try { descriptor = JSON.parse(await readFile(join(root, '.testbench', 'adapter.json'), 'utf8')); break; }
    catch { if (child.exitCode !== null) break; await delay(50); }
  }
  assert.ok(descriptor, diagnostics);
  const app = new TestbenchService(h.client, { ...h.config, timeoutMs: 5000 }, root, remoteDispatcher(descriptor.url, descriptor.token, 5000));
  const base = { channelId: ids.channel, userId: ids.user };
  const run = interaction => app.execute(operationSchema.parse({ op: 'interact', interaction: { ...base, ...interaction } }));
  const command = await run({ kind: 'command', name: 'ping' });
  assert.equal(command.status, 'passed', JSON.stringify(command) + diagnostics);
  assert.equal(h.sent[0].content, 'Python pong');
  const messageId = command.events[0].messageId;
  const button = await run({ kind: 'button', messageId, customId: 'ticket:open' });
  assert.equal(button.status, 'passed', JSON.stringify(button));
  assert.equal(button.events[0].method, 'showModal');
  const modal = await run({ kind: 'modal', customId: 'ticket:submit', fields: { subject: 'Agent ticket' } });
  assert.equal(modal.status, 'passed', JSON.stringify(modal));
  assert.equal(h.sent.at(-1).content, 'Ticket: Agent ticket');
  const select = await run({ kind: 'select', messageId, customId: 'color', values: ['blue'] });
  assert.equal(select.status, 'passed', JSON.stringify(select));
  assert.equal(select.events[0].data.files[0].name, 'component.txt');
  h.command.name = 'private';
  const sentBefore = h.sent.length;
  const privateReply = await run({ kind: 'command', name: 'private' });
  assert.equal(privateReply.status, 'passed', JSON.stringify(privateReply));
  assert.equal(h.sent.length, sentBefore);
  const version = execFileSync(process.env.TESTBENCH_PYTHON, ['-c', 'import discord; print(discord.__version__)'], { encoding: 'utf8' }).trim();
  if (Number(version.split('.')[1]) >= 7) {
    h.command.name = 'v2';
    const v2 = await run({ kind: 'command', name: 'v2' });
    assert.equal(v2.status, 'passed', JSON.stringify(v2));
    assert.equal(h.sent.at(-1).flags, 32768);
    const modernButton = await run({ kind: 'button', messageId: v2.events[0].messageId, customId: 'advanced:open' });
    assert.equal(modernButton.status, 'passed', JSON.stringify(modernButton));
    const modern = await run({ kind: 'modal', customId: 'advanced:submit', modalFields: [
      { type: 23, customId: 'consent', value: true },
      { type: 21, customId: 'priority', value: 'high' },
      { type: 22, customId: 'days', values: ['monday', 'friday'] },
      { type: 3, customId: 'color', values: ['blue'] },
      { type: 5, customId: 'person', values: [ids.user] }
    ] });
    assert.equal(modern.status, 'passed', JSON.stringify(modern));
    assert.equal(h.sent.at(-1).content, 'Python modern fields verified');
    h.command.name = 'entities';
    assert.equal((await run({ kind: 'command', name: 'entities' })).status, 'passed');
    const entities = await run({ kind: 'modal', customId: 'entities:submit', modalFields: [
      { type: 6, customId: 'role', values: [ids.guild] },
      { type: 8, customId: 'channel', values: [ids.channel] },
      { type: 7, customId: 'mentionable', values: [ids.user, ids.guild] }
    ] });
    assert.equal(entities.status, 'passed', JSON.stringify(entities));
    assert.equal(h.sent.at(-1).content, 'Python resource fields verified');
    h.command.name = 'upload';
    assert.equal((await run({ kind: 'command', name: 'upload' })).status, 'passed');
    const attachmentSource = h.create({ content: 'Attachment' });
    const attachmentId = '100000000000000040';
    attachmentSource.attachments.set(attachmentId, new Attachment({ id: attachmentId, filename: 'report.txt', size: 12, url: 'https://example.com/report.txt', proxy_url: 'https://example.com/report.txt' }));
    const upload = await run({ kind: 'modal', customId: 'upload:submit', attachmentMessageId: attachmentSource.id, modalFields: [{ type: 19, customId: 'files', values: [attachmentId] }] });
    assert.equal(upload.status, 'passed', JSON.stringify(upload));
    assert.equal(h.sent.at(-1).content, 'Python attachment metadata verified');
  }
  for (const name of ['hybrid', 'hybrid_defer']) {
    for (const privateReply of [false, true]) {
      h.command.name = name;
      const before = h.sent.length;
      const result = await run({ kind: 'command', name, options: [{ type: 5, name: 'private', value: privateReply }] });
      assert.equal(result.status, 'passed', JSON.stringify(result) + diagnostics);
      assert.equal(h.sent.length, before + (privateReply ? 0 : 1));
      assert.equal(result.events.at(-1).visibility, privateReply ? 'captured-ephemeral' : 'discord-channel');
      assert.equal(result.events.at(-1).data.content, name === 'hybrid' ? 'Python hybrid' : 'Python hybrid followup');
      assert.deepEqual(result.events.map(event => event.method), name === 'hybrid' ? ['reply'] : ['deferReply', 'followUp']);
    }
  }
  for (const name of ['response_file', 'file_edits']) {
    for (const privateReply of [false, true]) {
      h.command.name = name;
      const before = h.sent.length;
      const result = await run({ kind: 'command', name, options: [{ type: 5, name: 'private', value: privateReply }] });
      assert.equal(result.status, 'passed', JSON.stringify(result) + diagnostics);
      assert.equal(h.sent.length, before + (privateReply ? 0 : name === 'file_edits' ? 2 : 1));
      if (name === 'file_edits') assert.equal(result.events[1].messageId, result.events[0].messageId);
      const saved = JSON.parse(await readFile(join(root, 'runs', result.id + '.json'), 'utf8'));
      assert.deepEqual(saved.events, result.events);
      const files = result.events.filter(event => event.data?.files).flatMap(event => event.data.files);
      assert.deepEqual(files.map(file => file.name), name === 'response_file' ? ['response.txt'] : ['edited.txt', 'followup.txt']);
      for (const file of files) assert.equal(Buffer.from(file.attachment.data).toString(), 'Python file bytes');
      if (!privateReply) {
        assert.ok(Buffer.isBuffer(h.sent.at(-1).files[0].attachment));
        assert.equal(h.sent.at(-1).files[0].attachment.toString(), 'Python file bytes');
      }
    }
  }
  h.command.name = 'temporary';
  const temporary = await run({ kind: 'command', name: 'temporary' });
  assert.equal(temporary.status, 'passed', JSON.stringify(temporary));
  await delay(200);
  for (const event of temporary.events) assert.ok(h.deleted.includes(event.messageId));
  for (const [number, v2] of [[42, false], [43, true], [0, false]]) {
    const row = { type: 1, components: [{ type: 2, style: 1, custom_id: `dynamic:${number}`, label: 'Dynamic' }] };
    const dynamicMessage = h.create({ flags: v2 ? 32768 : 0, components: v2 ? [{ type: 17, components: [row] }] : [row] });
    const dynamic = await run({ kind: 'button', messageId: dynamicMessage.id, customId: `dynamic:${number}` });
    assert.equal(dynamic.status, number ? 'passed' : 'failed', JSON.stringify(dynamic));
    if (number) assert.equal(h.sent.at(-1).content, `Dynamic: ${number}`);
    else assert.ok(dynamic.errors.some(error => error.includes('Dynamic item interaction check rejected')));
  }
});
