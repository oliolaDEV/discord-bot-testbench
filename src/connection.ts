import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { operationSchema, type Operation } from './protocol.js';

const descriptorSchema = z.object({
  version: z.literal(1), pid: z.number().int().positive(), url: z.string(),
  token: z.string().regex(/^[a-f0-9]{64}$/), guildId: z.string()
});

export async function requestBridge(root: string, operation: Operation): Promise<any> {
  let descriptor;
  try {
    descriptor = descriptorSchema.parse(JSON.parse(await readFile(resolve(root, '.testbench/bridge.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('No running testbench found. Start your bot with startTestbench(client) first.');
    throw error;
  }
  const url = new URL(descriptor.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Bridge descriptor must point to an HTTP loopback port');
  }
  let response;
  try {
    response = await fetch(new URL('/v1/run', url), {
      method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(operationSchema.parse(operation)), signal: AbortSignal.timeout(130000), redirect: 'error'
    });
  } catch {
    throw new Error('Cannot reach the local bot bridge. Check that the bot is running and restart it if needed.');
  }
  const body = await response.json() as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Bridge returned HTTP ${response.status}`);
  return body.result;
}
