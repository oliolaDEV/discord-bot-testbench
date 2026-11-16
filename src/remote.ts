import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Interaction, Message } from 'discord.js';
import { messageData } from './interactions.js';
import { errorMessage, serialize } from './protocol.js';

export function loopbackUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash) throw new Error('Adapter URLs must use an explicit HTTP loopback port');
  return url;
}

export function remoteDispatcher(endpoint: string, secret: string, timeoutMs = 120000, mode: 'testbench' | 'discord-http' = 'testbench') {
  const url = loopbackUrl(endpoint);
  if (secret.length < 32) throw new Error('Adapter secrets must contain at least 32 characters');
  return async (interaction: Interaction) => {
    const callbackSecret = randomBytes(32).toString('hex');
    const methods = new Set(['reply', 'deferReply', 'editReply', 'deleteReply', 'fetchReply', 'followUp', 'update', 'deferUpdate', 'showModal', 'respond']);
    const callback = createServer(async (request, response) => {
      const reply = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
      const actual = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from('Bearer ' + callbackSecret);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(401, { error: 'Unauthorized' });
      if (request.headers.origin || request.method !== 'POST' || request.url !== '/response') return reply(403, { error: 'Unsupported request' });
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1048576) { reply(413, { error: 'Response exceeds 1 MiB' }); return; }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!methods.has(body.method) || !Array.isArray(body.args) || body.args.length > 2 || typeof (interaction as any)[body.method] !== 'function') throw new Error('Unsupported response method');
        const result = await (interaction as any)[body.method](...body.args);
        const value = result && typeof result === 'object' && 'channelId' in result ? { message: messageData(result as Message) } : result?.resource?.message ? { message: messageData(result.resource.message) } : result ?? null;
        reply(200, { result: serialize(value) });
      } catch (error) { reply(400, { error: errorMessage(error) }); }
    });
    callback.headersTimeout = 10000;
    callback.requestTimeout = timeoutMs;
    await new Promise<void>((resolve, reject) => { callback.once('error', reject); callback.listen(0, '127.0.0.1', () => { callback.off('error', reject); resolve(); }); });
    try {
      const callbackUrl = `http://127.0.0.1:${(callback.address() as AddressInfo).port}/response`;
      const response = await fetch(url, {
        method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'discord-http' ? (interaction as any).testbenchPayload : { version: 1, interaction: (interaction as any).testbenchPayload, callback: { url: callbackUrl, token: callbackSecret } }),
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs)
      });
      const result = await response.json() as { error?: string; errors?: string[]; handled?: boolean; type?: number; data?: any };
      if (!response.ok) throw new Error(result.error ?? `Adapter returned HTTP ${response.status}`);
      if (mode === 'discord-http') {
        const target = interaction as any;
        const data = result.data ?? {};
        if (result.type === 4) await target.reply(data);
        else if (result.type === 5) await target.deferReply(data);
        else if (result.type === 6) await target.deferUpdate();
        else if (result.type === 7) await target.update(data);
        else if (result.type === 8) await target.respond(data.choices ?? []);
        else if (result.type === 9) await target.showModal(data);
        else throw new Error(`Unsupported Discord HTTP response type: ${result.type}`);
        return;
      }
      if (result.handled !== true) throw new Error('Adapter did not confirm handler completion');
      if (result.errors?.length) throw new Error(result.errors.join('; '));
    } finally {
      callback.closeAllConnections();
      await new Promise<void>(resolve => callback.close(() => resolve()));
    }
  };
}
