import { z } from 'zod';
import { snowflake } from './config.js';

const data = z.record(z.string(), z.unknown());
const fieldId = z.string().min(1).max(100);
const field = { customId: fieldId };
export const modalFieldSchema = z.discriminatedUnion('type', [
  z.object({ ...field, type: z.literal(4), value: z.string().max(4000) }).strict(),
  z.object({ ...field, type: z.literal(3), values: z.array(z.string().max(100)).max(25) }).strict(),
  ...([5, 6, 7, 8, 19] as const).map(type => z.object({ ...field, type: z.literal(type), values: z.array(snowflake).max(25) }).strict()),
  z.object({ ...field, type: z.literal(21), value: z.string().max(100).nullable() }).strict(),
  z.object({ ...field, type: z.literal(22), values: z.array(z.string().max(100)).max(10) }).strict(),
  z.object({ ...field, type: z.literal(23), value: z.boolean() }).strict()
]);

export const messageSchema = z.object({
  content: z.string().max(2000).optional(),
  embeds: z.array(data).max(10).optional(),
  components: z.array(data).max(40).optional(),
  flags: z.number().int().nonnegative().optional()
}).strict().superRefine((message, context) => {
  if (!message.content && !message.embeds?.length && !message.components?.length) context.addIssue({ code: 'custom', message: 'A message needs content, embeds or components' });
  if ((message.flags ?? 0) & 64) context.addIssue({ code: 'custom', message: 'Ordinary channel messages cannot be ephemeral' });
});

export const interactionSchema = z.object({
  kind: z.enum(['command', 'autocomplete', 'button', 'select', 'modal', 'user-context', 'message-context']),
  channelId: snowflake,
  userId: snowflake,
  name: z.string().min(1).max(100).optional(),
  customId: z.string().min(1).max(100).optional(),
  options: z.array(data).max(25).default([]),
  values: z.array(z.string()).max(25).default([]),
  fields: z.record(z.string(), z.string()).default({}),
  modalFields: z.array(modalFieldSchema).max(5).default([]),
  attachmentMessageId: snowflake.optional(),
  messageId: snowflake.optional(),
  targetId: snowflake.optional(),
  componentType: z.union([z.literal(3), z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).default(3)
}).strict().superRefine((value, context) => {
  if (value.kind !== 'modal' && (value.modalFields.length || value.attachmentMessageId)) context.addIssue({ code: 'custom', message: 'modalFields and attachmentMessageId are only valid for modal submissions' });
  const fieldIds = [...Object.keys(value.fields), ...value.modalFields.map(field => field.customId)];
  if (new Set(fieldIds).size !== fieldIds.length) context.addIssue({ code: 'custom', message: 'Modal field custom IDs must be unique' });
  for (const field of value.modalFields) if ('values' in field && new Set(field.values).size !== field.values.length) context.addIssue({ code: 'custom', message: 'Selection values must be unique' });
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
  z.object({ op: z.literal('send'), channelId: snowflake, content: z.string().min(1).max(2000).optional(), message: messageSchema.optional() }).strict().superRefine((value, context) => {
    if (Boolean(value.content) === Boolean(value.message)) context.addIssue({ code: 'custom', message: 'Provide either content or message' });
  }),
  z.object({ op: z.literal('wait'), channelId: snowflake, contains: z.string().min(1), after: snowflake, timeoutMs: z.number().int().min(100).max(30000).default(10000) }).strict(),
  z.object({ op: z.literal('fixture'), kind: z.enum(['channel', 'role']), name: z.string().regex(/^[a-z0-9-]{1,60}$/) }).strict(),
  z.object({ op: z.literal('cleanup') }).strict(),
  z.object({ op: z.literal('runs'), runId: z.string().uuid().optional() }).strict(),
  z.object({ op: z.literal('assert'), channelId: snowflake, messageId: snowflake.optional(), contains: z.string().optional(), embedTitle: z.string().optional(), componentId: z.string().optional(), componentType: z.number().int().min(1).max(23).optional() }).strict()
]);

export type Operation = z.infer<typeof operationSchema>;

export function serialize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
