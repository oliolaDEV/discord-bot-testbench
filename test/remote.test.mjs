import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TestbenchService } from '../dist/service.js';
import { remoteDispatcher } from '../dist/remote.js';
import { operationSchema } from '../dist/protocol.js';
import { harness, ids } from './harness.mjs';

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

test('discord.py command, registered view, select, modal and private reply cross the adapter protocol', { skip: !process.env.TESTBENCH_PYTHON }, async t => {
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
  h.command.name = 'private';
  const sentBefore = h.sent.length;
  const privateReply = await run({ kind: 'command', name: 'private' });
  assert.equal(privateReply.status, 'passed', JSON.stringify(privateReply));
  assert.equal(h.sent.length, sentBefore);
});
