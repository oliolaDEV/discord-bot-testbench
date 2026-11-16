import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { parseChannelUrl, planSetup } from '../dist/setup.js';

const exec = promisify(execFile);
const guild = '100000000000000001';
const channel = '100000000000000002';
const user = '100000000000000003';

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'discord-testbench-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'test-bot', dependencies: { 'discord.js': '^14.28.1' } }));
  return root;
}

test('channel links extract IDs and reject invites, DMs, messages and foreign hosts', () => {
  assert.deepEqual(parseChannelUrl(`https://discord.com/channels/${guild}/${channel}`), { guild, channel });
  for (const url of [
    `https://example.com/channels/${guild}/${channel}`,
    `http://discord.com/channels/${guild}/${channel}`,
    'https://discord.com/channels/@me/100000000000000002',
    `https://discord.com/channels/${guild}/${channel}/100000000000000004`,
    'https://discord.gg/example'
  ]) assert.throws(() => parseChannelUrl(url));
});

test('setup reads local test IDs and detects credentials without exposing values', async t => {
  const root = await project(t);
  const secret = 'a-local-secret-that-must-not-appear';
  await writeFile(join(root, '.env'), `DISCORD_TEST_GUILD_ID=${guild}\nDISCORD_TEST_CHANNEL_ID=${channel}\nDISCORD_TEST_USER_ID=${user}\nPLAYGROUND_TEST_SECRET=${secret}\n`);
  const plan = await planSetup(root, { tokenEnv: 'PLAYGROUND_TEST_SECRET' });
  assert.equal(plan.state, 'ready_to_configure');
  assert.equal(plan.config.guildId, guild);
  assert.equal(plan.credentials.detected, true);
  assert.equal(JSON.stringify(plan).includes(secret), false);
  assert.deepEqual(plan.userActions, []);
  await assert.rejects(access(join(root, '.mcp.json')));
});

test('setup configures skills from one channel link and a member ID', async t => {
  const root = await project(t);
  const args = [resolve('dist/cli.js'), 'setup', '--root', root, '--channel-url', `https://discord.com/channels/${guild}/${channel}`, '--user', user];
  const first = JSON.parse((await exec(process.execPath, args)).stdout);
  assert.equal(first.state, 'configured');
  assert.equal(first.config.guildId, guild);
  assert.deepEqual(first.config.channelIds, [channel]);
  assert.equal(first.skills.length, 2);
  for (const skill of first.skills) assert.match(await readFile(skill, 'utf8'), /^---\nname: discord-bot-testbench/);
  const second = JSON.parse((await exec(process.execPath, args)).stdout);
  assert.equal(second.state, 'configured');
  await assert.rejects(exec(process.execPath, [...args.slice(0, -1), '100000000000000099']), /supplied IDs differ/);
});

test('setup reports missing user inputs without writing partial configuration', async t => {
  const root = await project(t);
  const env = { ...process.env };
  for (const name of ['DISCORD_TEST_GUILD_ID', 'DISCORD_TEST_CHANNEL_ID', 'DISCORD_TEST_USER_ID']) delete env[name];
  const result = JSON.parse((await exec(process.execPath, [resolve('dist/cli.js'), 'setup', '--root', root], { env })).stdout);
  assert.equal(result.state, 'needs_input');
  assert.deepEqual(result.userActions.map(a => a.id), ['test_channel', 'test_user']);
  await assert.rejects(access(join(root, 'testbench.config.json')));
  await assert.rejects(access(join(root, '.mcp.json')));
});

test('customized project skills are preserved when setup detects a conflict', async t => {
  const root = await project(t);
  const args = [resolve('dist/cli.js'), 'setup', '--root', root, '--channel-url', `https://discord.com/channels/${guild}/${channel}`, '--user', user];
  const first = JSON.parse((await exec(process.execPath, args)).stdout);
  await writeFile(first.skills[0], 'custom instructions');
  await assert.rejects(exec(process.execPath, args), /existing testbench skill differs/);
  assert.equal(await readFile(first.skills[0], 'utf8'), 'custom instructions');
});

test('setup does not configure an unsupported framework', async t => {
  const root = await project(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'different-framework' }));
  const result = JSON.parse((await exec(process.execPath, [resolve('dist/cli.js'), 'setup', '--root', root, '--channel-url', `https://discord.com/channels/${guild}/${channel}`, '--user', user])).stdout);
  assert.equal(result.project.discordJsDetected, false);
  assert.equal(result.configured, undefined);
  await assert.rejects(access(join(root, '.mcp.json')));
});

test('setup recognizes discord.py without a Node application manifest', async t => {
  const root = await project(t);
  await rm(join(root, 'package.json'));
  await writeFile(join(root, 'requirements.txt'), 'discord.py>=2.6,<2.8\n');
  const result = JSON.parse((await exec(process.execPath, [resolve('dist/cli.js'), 'setup', '--root', root, '--channel-url', `https://discord.com/channels/${guild}/${channel}`, '--user', user])).stdout);
  assert.equal(result.configured, true);
  assert.equal(result.config.adapter, 'discord.py');
  assert.equal(result.project.integration, 'native-adapter');
  assert.ok(JSON.parse(await readFile(join(root, '.testbench', 'runtime.json'), 'utf8')).cli);
});

test('other languages use the explicit HTTP route and secrets stay out of connect output', async t => {
  const root = await project(t);
  await rm(join(root, 'package.json'));
  await writeFile(join(root, 'go.mod'), 'module example.com/test-bot\n\ngo 1.22\n');
  const setup = JSON.parse((await exec(process.execPath, [resolve('dist/cli.js'), 'setup', '--root', root, '--channel-url', `https://discord.com/channels/${guild}/${channel}`, '--user', user])).stdout);
  assert.equal(setup.config.adapter, 'http');
  assert.equal(setup.project.integration, 'http-handler-required');
  const connected = await exec(process.execPath, [resolve('dist/cli.js'), 'connect', '--root', root, '--endpoint', 'http://127.0.0.1:8788/testbench']);
  const descriptor = JSON.parse(await readFile(join(root, '.testbench', 'adapter.json'), 'utf8'));
  assert.equal(descriptor.token.length, 64);
  assert.equal(connected.stdout.includes(descriptor.token), false);
  await assert.rejects(exec(process.execPath, [resolve('dist/cli.js'), 'connect', '--root', root, '--endpoint', 'https://example.com/testbench']), /loopback/);
});
