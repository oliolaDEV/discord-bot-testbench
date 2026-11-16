import { z } from 'zod';
import { snowflake } from './config.js';

const data = z.record(z.string(), z.unknown());

export const interactionSchema = z.object({
  kind: z.enum(['command', 'autocomplete', 'button', 'select', 'modal', 'user-context', 'message-context']),
  channelId: snowflake,
  userId: snowflake,
  name: z.string().min(1).max(100).optional(),
  customId: z.string().min(1).max(100).optional(),
  options: z.array(data).max(25).default([]),
  values: z.array(z.string()).max(25).default([]),
  fields: z.record(z.string(), z.string()).default({}),
  messageId: snowflake.optional(),
  targetId: snowflake.optional(),
  componentType: z.union([z.literal(3), z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).default(3)
}).strict().superRefine((value, context) => {
  const command = ['command', 'autocomplete', 'user-context', 'message-context'].includes(value.kind);
  if (command && !value.name) context.addIssue({ code: 'custom', message: 'name is required' });
  if (!command && !value.customId) context.addIssue({ code: 'custom', message: 'customId is required' });
  if (['button', 'select', 'message-context'].includes(value.kind) && !value.messageId) {
    context.addIssue({ code: 'custom', message: 'messageId is required' });
  }
  if (['user-context', 'message-context'].includes(value.kind) && !value.targetId) {
    context.addIssue({ code: 'custom', message: 'targetId is required' });
  }
});

export type InteractionInput = z.infer<typeof interactionSchema>;

export const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status') }).strict(),
  z.object({ op: z.literal('inspect'), channelId: snowflake.optional() }).strict(),
  z.object({ op: z.literal('commands') }).strict(),
  z.object({ op: z.literal('interact'), interaction: interactionSchema }).strict(),
  z.object({ op: z.literal('messages'), channelId: snowflake, limit: z.number().int().min(1).max(100).default(20) }).strict(),
  z.object({ op: z.literal('send'), channelId: snowflake, content: z.string().min(1).max(1900) }).strict(),
  z.object({ op: z.literal('wait'), channelId: snowflake, contains: z.string().min(1), after: snowflake, timeoutMs: z.number().int().min(100).max(30000).default(10000) }).strict(),
  z.object({ op: z.literal('fixture'), kind: z.enum(['channel', 'role']), name: z.string().regex(/^[a-z0-9-]{1,60}$/) }).strict(),
  z.object({ op: z.literal('cleanup') }).strict(),
  z.object({ op: z.literal('runs'), runId: z.string().uuid().optional() }).strict(),
  z.object({ op: z.literal('assert'), channelId: snowflake, messageId: snowflake.optional(), contains: z.string().optional(), embedTitle: z.string().optional(), componentId: z.string().optional() }).strict()
]);

export type Operation = z.infer<typeof operationSchema>;

export function serialize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
