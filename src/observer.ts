import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { Client, Events } from 'discord.js';
import { startTestbench } from './bridge.js';
import { remoteDispatcher } from './remote.js';

export async function serveAdapter(root: string) {
  const descriptor = JSON.parse(await readFile(join(root, '.testbench', 'adapter.json'), 'utf8'));
  const environment: Record<string, string | undefined> = {};
  for (const filename of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    try { Object.assign(environment, parseEnv(await readFile(join(root, filename), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  Object.assign(environment, process.env);
  const token = environment.DISCORD_BOT_TOKEN ?? environment.DISCORD_TOKEN ?? environment.BOT_TOKEN;
  if (!token) throw new Error('The adapter observer needs a development bot token in DISCORD_BOT_TOKEN, DISCORD_TOKEN or BOT_TOKEN');
  const client = new Client({ intents: [] });
  const ready = new Promise<void>(resolve => client.once(Events.ClientReady, () => resolve()));
  let handle;
  try {
    await client.login(token); await ready;
    if (descriptor.mode !== undefined && !['testbench', 'discord-http'].includes(descriptor.mode)) throw new Error('Unsupported adapter mode');
    handle = await startTestbench(client, { root, dispatch: remoteDispatcher(descriptor.url, descriptor.token, 120000, descriptor.mode) });
    console.error('Testbench adapter bridge is ready.');
  } catch (error) { client.destroy(); throw error; }
  const close = async () => { await handle.close(); client.destroy(); };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().catch(error => { console.error(error.message); process.exitCode = 1; }); });
}
