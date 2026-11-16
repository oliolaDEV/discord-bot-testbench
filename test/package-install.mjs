import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'discord-testbench-package-'));
const archive = resolve('discord-bot-testbench-0.1.0.tgz');
if (!process.env.npm_execpath) throw new Error('Run this check with npm run test:package');

try {
  const contents = (await exec('tar', ['-tf', archive])).stdout;
  assert.equal(/__pycache__|\.pyc\b|\.egg-info|\/obj\//.test(contents), false, 'Package must contain source and runtime files only');
  await exec(process.execPath, [process.env.npm_execpath, 'install', '--prefix', root, archive, '--ignore-scripts', '--no-audit', '--no-fund']);
  const installed = join(root, 'node_modules', 'discord-bot-testbench');
  const esm = await exec(process.execPath, ['--input-type=module', '-e', 'import { startTestbench } from "discord-bot-testbench"; process.stdout.write(typeof startTestbench);'], { cwd: root });
  assert.equal(esm.stdout, 'function');
  const commonjs = await exec(process.execPath, ['-e', 'process.stdout.write(typeof require("discord-bot-testbench").startTestbench);'], { cwd: root });
  assert.equal(commonjs.stdout, 'function');
  const setup = await exec(process.execPath, [join(installed, 'dist', 'cli.js'), 'init', '--root', root, '--guild', '100000000000000001', '--channel', '100000000000000002', '--user', '100000000000000003']);
  assert.equal(JSON.parse(setup.stdout).configured, true);
  assert.ok(await readFile(join(root, 'TESTBENCH.md'), 'utf8'));
  assert.ok(await readFile(join(installed, '.env.example'), 'utf8'));
  assert.ok(await readFile(join(installed, 'CONTRIBUTING.md'), 'utf8'));
  assert.ok(await readFile(join(installed, 'SETUP.md'), 'utf8'));
  assert.ok(await readFile(join(installed, 'adapters', 'python', 'discord_testbench', 'adapter.py'), 'utf8'));
  assert.ok(await readFile(join(root, '.agents', 'skills', 'discord-bot-testbench', 'SKILL.md'), 'utf8'));
  assert.ok(await readFile(join(root, '.claude', 'skills', 'discord-bot-testbench', 'SKILL.md'), 'utf8'));
  assert.ok(JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')).mcpServers['discord-testbench']);
  console.log('Verified tarball installation, ESM/CommonJS imports, CLI setup and bundled documentation.');
} finally {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Refusing to remove a package test directory outside the temporary root');
  await rm(root, { recursive: true, force: true });
}
