import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Client } from 'discord.js';
import { configSchema, loadConfig, stateDirectory, writeJson, type TestbenchConfig } from './config.js';
import { errorMessage, operationSchema } from './protocol.js';
import { TestbenchService, type Dispatcher } from './service.js';

export type TestbenchOptions = {
  root?: string;
  config?: TestbenchConfig;
  dispatch?: Dispatcher;
};

export type TestbenchHandle = { url: string; close(): Promise<void> };

export async function startTestbench(client: Client, options: TestbenchOptions = {}): Promise<TestbenchHandle> {
  if (!client.isReady()) throw new Error('Start the testbench after the Discord client is ready');
  const root = resolve(options.root ?? process.cwd());
  const config = options.config ? configSchema.parse(options.config) : await loadConfig(root);
  const directory = await stateDirectory(root);
  await mkdir(join(directory, 'runs'), { recursive: true, mode: 0o700 });
  const descriptor = join(directory, 'bridge.json');
  try {
    const previous = JSON.parse(await readFile(descriptor, 'utf8'));
    if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error('Invalid existing bridge descriptor. Remove it after checking that the bot is stopped.');
    try { process.kill(previous.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') await unlink(descriptor);
      else throw error;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const token = randomBytes(32).toString('hex');
  const service = new TestbenchService(client, config, directory, options.dispatch);
  await service.restoreFixtures();
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    const authorization = request.headers.authorization ?? '';
    const expected = Buffer.from('Bearer ' + token);
    const supplied = Buffer.from(authorization);
    const reply = (code: number, body: unknown) => {
      if (response.destroyed) return;
      response.writeHead(code); response.end(JSON.stringify(body));
    };
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: 'Unauthorized' });
    if (request.headers.origin) return reply(403, { error: 'Browser-origin requests are not accepted' });
    if (request.method !== 'POST' || request.url !== '/v1/run') return reply(404, { error: 'Not found' });
    if (!request.headers['content-type']?.startsWith('application/json')) return reply(415, { error: 'Expected application/json' });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1048576) { reply(413, { error: 'Request exceeds 1 MiB' }); request.resume(); return; }
        chunks.push(chunk);
      }
      const input = operationSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      reply(200, { result: await service.execute(input) });
    } catch (error) {
      const message = errorMessage(error).split(client.token ?? token).join('[REDACTED]').split(token).join('[REDACTED]');
      reply(400, { error: message });
    }
  });
  server.requestTimeout = 150000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolvePromise(); });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await writeJson(descriptor, { version: 1, pid: process.pid, url, token, guildId: config.guildId }, true);
  } catch (error) {
    server.close();
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A bridge descriptor already exists. Stop the other bot, or remove .testbench/bridge.json after verifying that its process has stopped.');
    throw error;
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeIdleConnections(); });
    try {
      const current = JSON.parse(await readFile(descriptor, 'utf8'));
      if (current.token === token) await unlink(descriptor);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  return { url, close };
}
