#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, mkdir, access, appendFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, loadConfig, writeJson } from './config.js';
import { requestBridge } from './connection.js';
import { serveMcp } from './mcp.js';
import { errorMessage, operationSchema } from './protocol.js';
import { runScenario } from './scenarios.js';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { planSetup } from './setup.js';
import { serveAdapter } from './observer.js';
import { loopbackUrl } from './remote.js';
import { randomBytes } from 'node:crypto';

const help = `Discord Bot Testbench

  setup                                  Inspect setup and report remaining work
  setup --channel-url URL --user ID       Configure from a Discord channel link
  init --guild ID --channel ID --user ID   Configure a development project
  serve                                  Run the MCP server over stdio
  bridge                                 Connect a language-neutral bot adapter
  connect --endpoint URL                 Configure a development HTTP handler
  doctor                                 Check configuration and running bridge
  call operation.json                    Execute a protocol operation
  run scenario.json                      Run a repeatable test scenario

Options:
  --root PATH      Bot project directory (default: current directory)
  --channel ID     Allowed test channel (repeatable)
  --user ID        Allowed test identity (repeatable)
  --channel-url URL  Discord channel link containing server and channel IDs
  --token-env NAME   Credential variable to check without exposing its value
  --help           Show this help

Keep your normal bot token in the bot's environment. The MCP server needs no token.
`;

async function readOptional(path: string) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function init(root: string, values: Record<string, any>) {
  await access(root);
  const path = join(root, 'testbench.config.json');
  let config;
  const existing = await readOptional(path);
  if (existing) {
    config = configSchema.parse(JSON.parse(existing));
    if ((values.guild && values.guild !== config.guildId)
      || (values.channel && JSON.stringify(values.channel) !== JSON.stringify(config.channelIds))
      || (values.user && JSON.stringify(values.user) !== JSON.stringify(config.userIds))) {
      throw new Error('The supplied IDs differ from the existing testbench.config.json. Edit that file and restart the bot to change the setup.');
    }
  }
  else {
    if (!values.guild || !values.channel?.length || !values.user?.length) throw new Error('Provide --guild, at least one --channel and at least one --user. Enable Developer Mode in Discord to copy their IDs.');
    config = configSchema.parse({ adapter: values.adapter ?? 'discord.js', guildId: values.guild, channelIds: values.channel, userIds: values.user });
  }
  const mcpPath = join(root, '.mcp.json');
  const mcp = JSON.parse(await readOptional(mcpPath) ?? '{"mcpServers":{}}');
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) throw new Error('.mcp.json must be an object');
  if (mcp.mcpServers !== undefined && (typeof mcp.mcpServers !== 'object' || mcp.mcpServers === null || Array.isArray(mcp.mcpServers))) throw new Error('.mcp.json mcpServers must be an object');
  const cli = fileURLToPath(import.meta.url);
  const entry = { command: process.execPath, args: [cli, 'serve', '--root', root] };
  mcp.mcpServers ??= {};
  if (mcp.mcpServers['discord-testbench'] && JSON.stringify(mcp.mcpServers['discord-testbench']) !== JSON.stringify(entry)) {
    throw new Error('An existing discord-testbench MCP entry differs. Update or remove that entry before running init.');
  }
  mcp.mcpServers['discord-testbench'] = entry;
  const codexPath = join(root, '.codex', 'config.toml');
  const codexText = await readOptional(codexPath) ?? '';
  const codex = parseToml(codexText) as any;
  if (codex.mcp_servers !== undefined && (!codex.mcp_servers || typeof codex.mcp_servers !== 'object' || Array.isArray(codex.mcp_servers))) throw new Error('Codex mcp_servers must be a table');
  const existingCodex = codex.mcp_servers?.['discord-testbench'];
  if (existingCodex && (existingCodex.command !== entry.command || JSON.stringify(existingCodex.args) !== JSON.stringify(entry.args))) {
    throw new Error('An existing Codex discord-testbench entry differs. Update or remove that entry before running init.');
  }
  const skillText = await readFile(resolve(dirname(cli), '../skills/discord-bot-testbench/SKILL.md'), 'utf8');
  const skillPaths = ['.agents', '.claude'].map(folder => join(root, folder, 'skills', 'discord-bot-testbench', 'SKILL.md'));
  for (const skillPath of skillPaths) {
    const current = await readOptional(skillPath);
    if (current !== null && current !== skillText) throw new Error(`An existing testbench skill differs at ${skillPath}. Preserve or merge its customizations before running setup again.`);
  }
  await writeJson(path, config);
  await mkdir(join(root, '.testbench'), { recursive: true });
  await writeJson(join(root, '.testbench', 'runtime.json'), { node: process.execPath, cli });
  await writeJson(mcpPath, mcp);
  await mkdir(dirname(codexPath), { recursive: true });
  if (!existingCodex) await appendFile(codexPath, '\n' + stringifyToml({ mcp_servers: { 'discord-testbench': entry } }));
  for (const skillPath of skillPaths) {
    await mkdir(dirname(skillPath), { recursive: true });
    await writeFile(skillPath, skillText, 'utf8');
  }
  const ignore = join(root, '.gitignore');
  const ignored = await readOptional(ignore) ?? '';
  const missing = ['.testbench/', '.env', '.env.*', '!.env.example'].filter(line => !ignored.split(/\r?\n/).includes(line));
  if (missing.length) await appendFile(ignore, '\n' + missing.join('\n') + '\n');
  const source = resolve(dirname(cli), '../agent/TESTBENCH.md');
  if (!await readOptional(join(root, 'TESTBENCH.md'))) {
    await appendFile(join(root, 'TESTBENCH.md'), await readFile(source, 'utf8'));
  }
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const instructionsPath = join(root, name);
    const instructions = await readOptional(instructionsPath) ?? '';
    if (!instructions.includes('TESTBENCH.md')) await appendFile(instructionsPath, '\nRead TESTBENCH.md and use Discord Bot Testbench to test changes to the development bot.\n');
  }
  const codexCommand = ['codex', 'mcp', 'add', 'discord-testbench', '--', process.execPath, cli, 'serve', '--root', root];
  return {
    configured: true, root, config, claudeMcp: mcpPath, codexMcp: codexPath,
    skills: skillPaths,
    codexCommand,
    next: [config.adapter === 'discord.py' ? 'Install the bundled Python adapter and await start_testbench(bot) once after ready. See docs/ADAPTERS.md.' : config.adapter === 'http' ? 'Connect the application development HTTP route using connect, then start bridge. See docs/ADAPTERS.md.' : 'Add startTestbench(client) to your bot after it becomes ready. See TESTBENCH.md.', 'Start the bot normally, then run discord-bot-testbench doctor.', 'Project MCP entries are configured for Claude Code and Codex. Trust the project and enable the entry in your client.', 'Use the CLI immediately if MCP is not loaded. Use codexCommand only if you prefer user-level registration.']
  };
}

async function main() {
  const { values, positionals } = parseArgs({ options: {
    root: { type: 'string' }, guild: { type: 'string' }, channel: { type: 'string', multiple: true },
    user: { type: 'string', multiple: true }, help: { type: 'boolean' },
    'channel-url': { type: 'string' }, 'token-env': { type: 'string' },
    adapter: { type: 'string' }, endpoint: { type: 'string' }, mode: { type: 'string' }
  }, allowPositionals: true });
  const root = resolve(values.root ?? process.cwd());
  const [command, file] = positionals;
  if (values.help || !command) { console.log(help); return; }
  if (command === 'init') { console.log(JSON.stringify(await init(root, values), null, 2)); return; }
  if (command === 'setup') {
    const plan = await planSetup(root, { adapter: values.adapter, guild: values.guild, channel: values.channel, user: values.user, channelUrl: values['channel-url'], tokenEnv: values['token-env'] });
    if (!plan.config || !plan.project.supported) { console.log(JSON.stringify(plan, null, 2)); return; }
    const configured = await init(root, { adapter: plan.config.adapter, guild: plan.config.guildId, channel: plan.config.channelIds, user: plan.config.userIds });
    console.log(JSON.stringify({ ...plan, state: 'configured', ...configured, note: 'Configuration is installed. Bot integration, startup and a live smoke test still need to be performed by the agent.' }, null, 2));
    return;
  }
  if (command === 'serve') { await serveMcp(root); return; }
  if (command === 'bridge') { await serveAdapter(root); return; }
  if (command === 'connect') {
    if (!values.endpoint) throw new Error('connect needs --endpoint with your development HTTP handler URL');
    const url = loopbackUrl(values.endpoint).href;
    const mode = values.mode ?? 'discord-http';
    if (!['discord-http', 'testbench'].includes(mode)) throw new Error('mode must be discord-http or testbench');
    await mkdir(join(root, '.testbench'), { recursive: true });
    await writeJson(join(root, '.testbench', 'adapter.json'), { version: 1, url, token: randomBytes(32).toString('hex'), mode }, true);
    console.log(JSON.stringify({ configured: true, mode, url, next: 'Have your development route read the bearer secret from .testbench/adapter.json, then start the bot and run bridge. Never expose that file in chat.' }, null, 2));
    return;
  }
  if (command === 'doctor') {
    const config = await loadConfig(root);
    const result = await requestBridge(root, { op: 'status' });
    if (result.guildId !== config.guildId) throw new Error('Running bridge guild differs from configuration. Restart the bot.');
    if (JSON.stringify(result.channelIds) !== JSON.stringify(config.channelIds) || JSON.stringify(result.userIds) !== JSON.stringify(config.userIds)) throw new Error('Running bridge identities or channels differ from configuration. Restart the bot.');
    console.log(JSON.stringify({ ok: true, node: process.version, root, ...result }, null, 2)); return;
  }
  if (command === 'call' || command === 'run') {
    if (!file) throw new Error(`${command} needs a JSON file path`);
    const raw = JSON.parse(await readFile(resolve(file), 'utf8'));
    const result = command === 'call' ? await requestBridge(root, operationSchema.parse(raw)) : await runScenario(raw, operation => requestBridge(root, operation));
    console.log(JSON.stringify(result, null, 2));
    if (result?.passed === false || result?.matched === false || result?.status === 'failed' || result?.status === 'timed_out' || result?.errors?.length > 0) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command: ${command}. Use --help.`);
}

main().catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
