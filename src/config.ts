import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';

export const snowflake = z.string().regex(/^\d{17,20}$/, 'Expected a Discord snowflake ID');

export const configSchema = z.object({
  adapter: z.enum(['discord.js', 'discord.py', 'http']).default('discord.js'),
  guildId: snowflake,
  channelIds: z.array(snowflake).min(1),
  userIds: z.array(snowflake).min(1),
  mirrorResponses: z.boolean().default(true),
  timeoutMs: z.number().int().min(100).max(120000).default(15000)
}).strict();

export type TestbenchConfig = z.infer<typeof configSchema>;

export async function loadConfig(root = process.cwd()) {
  return configSchema.parse(JSON.parse(await readFile(resolve(root, 'testbench.config.json'), 'utf8')));
}

export async function stateDirectory(root: string) {
  const path = join(await realpath(root), '.testbench');
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

export async function writeJson(path: string, value: unknown, exclusive = false) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
}
