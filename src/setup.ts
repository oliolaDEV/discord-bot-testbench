import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { configSchema, snowflake, type TestbenchConfig } from './config.js';

export type SetupInput = { guild?: string; channel?: string[]; user?: string[]; channelUrl?: string; tokenEnv?: string; adapter?: string };

async function optional(path: string) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export function parseChannelUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['discord.com', 'www.discord.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname) || url.port || url.username || url.password) {
    throw new Error('Use a Discord server channel link: https://discord.com/channels/SERVER_ID/CHANNEL_ID');
  }
  const match = /^\/channels\/(\d{17,20})\/(\d{17,20})\/?$/.exec(url.pathname);
  if (!match || url.search || url.hash) throw new Error('Expected a server channel link, not an invite, DM or message link');
  return { guild: match[1]!, channel: match[2]! };
}

export async function planSetup(root: string, input: SetupInput) {
  const packageText = await optional(join(root, 'package.json'));
  const manifest = packageText ? JSON.parse(packageText) : {};
  const filenames = await readdir(root);
  const pythonManifests = await Promise.all(['requirements.txt', 'requirements-dev.txt', 'pyproject.toml'].map(name => optional(join(root, name))));
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const discordJsDetected = typeof dependencies['discord.js'] === 'string';
  const discordPyDetected = pythonManifests.some(text => text !== null && /discord[._-]py/i.test(text));
  const language = discordJsDetected ? 'JavaScript/TypeScript' : discordPyDetected ? 'Python' : filenames.some(name => name.endsWith('.csproj')) ? 'C#' : filenames.includes('go.mod') ? 'Go' : filenames.includes('Cargo.toml') ? 'Rust' : filenames.some(name => ['pom.xml', 'build.gradle', 'build.gradle.kts'].includes(name)) ? 'Java/Kotlin' : filenames.some(name => ['CMakeLists.txt', 'meson.build'].includes(name)) ? 'C++' : null;
  const existing = await optional(join(root, 'testbench.config.json'));
  let config: TestbenchConfig | undefined = existing ? configSchema.parse(JSON.parse(existing)) : undefined;
  const local: Record<string, string> = {};
  for (const filename of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    const text = await optional(join(root, filename));
    if (text !== null) Object.assign(local, parseEnv(text));
  }
  const environment = { ...local, ...process.env };
  const link = input.channelUrl ? parseChannelUrl(input.channelUrl) : undefined;
  if (link && input.guild && input.guild !== link.guild) throw new Error('--guild conflicts with the channel link');
  if (link && input.channel && (input.channel.length !== 1 || input.channel[0] !== link.channel)) throw new Error('--channel conflicts with the channel link');
  const guild = input.guild ?? link?.guild ?? config?.guildId ?? environment.DISCORD_TEST_GUILD_ID;
  const channels = input.channel ?? (link ? [link.channel] : config?.channelIds ?? (environment.DISCORD_TEST_CHANNEL_ID ? [environment.DISCORD_TEST_CHANNEL_ID] : undefined));
  const users = input.user ?? config?.userIds ?? (environment.DISCORD_TEST_USER_ID ? [environment.DISCORD_TEST_USER_ID] : undefined);
  if (config && ((guild && guild !== config.guildId) || (channels && JSON.stringify(channels) !== JSON.stringify(config.channelIds)) || (users && JSON.stringify(users) !== JSON.stringify(config.userIds)))) {
    throw new Error('The supplied IDs differ from testbench.config.json. Edit that file and restart the bot to change the setup.');
  }
  if (guild) snowflake.parse(guild);
  channels?.forEach(id => snowflake.parse(id));
  users?.forEach(id => snowflake.parse(id));
  const missing = [];
  if (!guild || !channels?.length) missing.push({ id: 'test_channel', instruction: 'Provide a link to a text channel in your Discord development server. Copy Channel Link provides both server and channel IDs.' });
  if (!users?.length) missing.push({ id: 'test_user', instruction: 'Provide the Discord user ID of the real server member whose permissions should be exercised. Enable Developer Mode, then Copy User ID.' });
  if (!config && guild && channels?.length && users?.length) config = configSchema.parse({ adapter: input.adapter ?? (discordPyDetected ? 'discord.py' : discordJsDetected ? 'discord.js' : 'http'), guildId: guild, channelIds: channels, userIds: users });
  const tokenKeys = input.tokenEnv ? [input.tokenEnv] : ['DISCORD_BOT_TOKEN', 'DISCORD_TOKEN', 'BOT_TOKEN'];
  if (tokenKeys.some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new Error('Invalid token environment variable name');
  const credentialsDetected = tokenKeys.some(key => Boolean(environment[key]?.trim()));
  return {
    state: missing.length ? 'needs_input' : 'ready_to_configure',
    config,
    project: { hasPackageJson: packageText !== null, discordJsDetected, discordPyDetected, language, supported: language !== null || input.adapter === 'http' || Boolean(existing && config?.adapter === 'http'), integration: discordJsDetected || discordPyDetected ? 'native-adapter' : 'http-handler-required', scripts: Object.keys(manifest.scripts ?? {}) },
    credentials: { detected: credentialsDetected, checkedVariableNames: tokenKeys, valuesExposed: false },
    userActions: missing,
    agentActions: [
      ...(!language ? ['Identify the bot framework. Native adapters exist for discord.js and discord.py; other runtimes require a development HTTP handler using the documented adapter protocol.'] : []),
      ...(!credentialsDetected ? ['Inspect how the existing bot receives credentials without printing secrets. Reuse that mechanism. If none exists, ask the user to create a development bot and store its token locally.'] : []),
      'Install the local package or release archive in the bot project if needed.',
      ...(discordPyDetected ? ['Install adapters/python with pip in the bot virtual environment, then await start_testbench(bot) after ready. It starts the Node observer using the existing bot token.'] : []),
      ...(!discordJsDetected && !discordPyDetected ? ['Implement the authenticated development-only HTTP adapter route around the existing interaction router. Use adapters/http examples and the protocol; do not claim a native SDK adapter exists.'] : []),
      'Read the installed discord-bot-testbench skill and docs/ADAPTERS.md, then integrate the detected adapter behind the existing development guard.',
      'Start the bot using its normal development command and run doctor.',
      'Use MCP tools when available; otherwise use call or run through the CLI in this chat.',
      'Run a discovered command and independently verify its result before claiming the setup is working.'
    ]
  };
}
