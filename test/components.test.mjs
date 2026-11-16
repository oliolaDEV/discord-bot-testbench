import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Attachment, MessageFlags } from 'discord.js';
import { TestbenchService } from '../dist/service.js';
import { operationSchema } from '../dist/protocol.js';
import { harness, ids } from './harness.mjs';

const v2 = 32768;
const panel = [
  { type: 17, accent_color: 5793266, components: [
    { type: 10, content: 'Ticket controls' },
    { type: 14, divider: true, spacing: 1 },
    { type: 9, components: [{ type: 10, content: 'Open a ticket' }], accessory: { type: 2, style: 1, custom_id: 'ticket:open', label: 'Open' } },
    { type: 9, components: [{ type: 10, content: 'Preview' }], accessory: { type: 11, media: { url: 'https://example.com/preview.png' } } },
    { type: 12, items: [{ media: { url: 'https://example.com/gallery.png' } }] },
    { type: 13, file: { url: 'https://example.com/readme.txt' } }
  ] }
];

async function setup(t, dispatch, overrides = {}) {
  const h = harness();
  const root = await mkdtemp(join(tmpdir(), 'testbench-components-'));
  await mkdir(join(root, 'runs'));
  t.after(async () => { h.client.destroy(); await rm(root, { recursive: true, force: true }); });
  const service = new TestbenchService(h.client, { ...h.config, ...overrides }, root, dispatch);
  return { ...h, service, run: operation => service.execute(operationSchema.parse(operation)), interact: input => service.execute(operationSchema.parse({ op: 'interact', interaction: { channelId: ids.channel, userId: ids.user, ...input } })) };
}

test('plain messages, embeds and full Components v2 trees can be sent, read and asserted', async t => {
  const h = await setup(t);
  await h.run({ op: 'send', channelId: ids.channel, content: 'Plain message' });
  await h.run({ op: 'send', channelId: ids.channel, message: { embeds: [{ title: 'An embed', description: 'Details' }] } });
  const sent = await h.run({ op: 'send', channelId: ids.channel, message: { flags: v2, components: panel } });
  assert.equal(sent.message.flags, v2);
  assert.equal(sent.message.components[0].type, 17);
  for (const componentType of [2, 9, 10, 11, 12, 13, 14, 17]) {
    assert.equal((await h.run({ op: 'assert', channelId: ids.channel, messageId: sent.message.id, componentType })).passed, true);
  }
  assert.equal((await h.run({ op: 'assert', channelId: ids.channel, contains: 'Ticket controls' })).passed, true);
  assert.equal((await h.run({ op: 'assert', channelId: ids.channel, contains: 'Plain message' })).passed, true);
  assert.equal((await h.run({ op: 'assert', channelId: ids.channel, embedTitle: 'An embed' })).passed, true);
  assert.equal((await h.run({ op: 'assert', channelId: ids.channel, componentId: 'ticket:open', componentType: 2 })).passed, true);
  assert.equal((await h.run({ op: 'assert', channelId: ids.channel, componentId: 'ticket:open', componentType: 17 })).passed, false);
});

test('buttons nested as section accessories run their existing handlers', async t => {
  const h = await setup(t, async interaction => {
    assert.equal(interaction.isButton(), true);
    assert.equal(interaction.component.customId, 'ticket:open');
    await interaction.update({ flags: v2, components: [{ type: 10, content: 'Opened' }] });
  });
  const source = h.create({ flags: v2, components: panel });
  const result = await h.interact({ kind: 'button', messageId: source.id, customId: 'ticket:open' });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal((await h.run({ op: 'assert', channelId: ids.channel, messageId: source.id, contains: 'Opened' })).passed, true);
});

test('all select types resolve users, roles, mentionables and channels inside containers', async t => {
  const h = await setup(t, async interaction => {
    if (interaction.isStringSelectMenu()) assert.deepEqual(interaction.values, ['blue']);
    if (interaction.isUserSelectMenu()) assert.equal(interaction.users.first().id, ids.user);
    if (interaction.isRoleSelectMenu()) assert.equal(interaction.roles.first().id, ids.guild);
    if (interaction.isMentionableSelectMenu()) { assert.equal(interaction.users.first().id, ids.user); assert.equal(interaction.roles.first().id, ids.guild); }
    if (interaction.isChannelSelectMenu()) assert.equal(interaction.channels.first().id, ids.channel);
    await interaction.deferUpdate();
  });
  for (const [componentType, values] of [[3, ['blue']], [5, [ids.user]], [6, [ids.guild]], [7, [ids.user, ids.guild]], [8, [ids.channel]]]) {
    const select = { type: componentType, custom_id: 'choose', max_values: 2, ...(componentType === 3 ? { options: [{ label: 'Blue', value: 'blue' }] } : {}) };
    const source = h.create({ flags: v2, components: [{ type: 17, components: [{ type: 1, components: [select] }] }] });
    const result = await h.interact({ kind: 'select', messageId: source.id, customId: 'choose', componentType, values });
    assert.equal(result.status, 'passed', JSON.stringify(result));
  }
});

test('typed modal fields populate native text, checkbox, checkbox-group and radio getters', async t => {
  const h = await setup(t, async interaction => {
    assert.equal(interaction.fields.getTextInputValue('subject'), 'A ticket');
    assert.equal(interaction.fields.getCheckbox('consent'), false);
    assert.deepEqual(interaction.fields.getCheckboxGroup('days'), ['monday', 'friday']);
    assert.equal(interaction.fields.getRadioGroup('priority'), 'high');
    await interaction.reply('Captured');
  });
  const result = await h.interact({ kind: 'modal', customId: 'settings', modalFields: [
    { type: 4, customId: 'subject', value: 'A ticket' },
    { type: 23, customId: 'consent', value: false },
    { type: 22, customId: 'days', values: ['monday', 'friday'] },
    { type: 21, customId: 'priority', value: 'high' }
  ] });
  assert.equal(result.status, 'passed', JSON.stringify(result));
});

test('typed modal selects populate all native resolved selection getters', async t => {
  const h = await setup(t, async interaction => {
    assert.deepEqual(interaction.fields.getStringSelectValues('color'), ['blue']);
    assert.equal(interaction.fields.getSelectedUsers('user').first().id, ids.user);
    assert.equal(interaction.fields.getSelectedRoles('role').first().id, ids.guild);
    assert.equal(interaction.fields.getSelectedChannels('channel').first().id, ids.channel);
    assert.equal(interaction.fields.getSelectedMentionables('mentionable').users.first().id, ids.user);
    await interaction.reply('Resolved');
  });
  const result = await h.interact({ kind: 'modal', customId: 'selects', modalFields: [
    { type: 3, customId: 'color', values: ['blue'] },
    { type: 5, customId: 'user', values: [ids.user] },
    { type: 6, customId: 'role', values: [ids.guild] },
    { type: 8, customId: 'channel', values: [ids.channel] },
    { type: 7, customId: 'mentionable', values: [ids.user, ids.guild] }
  ] });
  assert.equal(result.status, 'passed', JSON.stringify(result));
});

test('captured modals validate field types, required fields, lengths and choices before dispatch', async t => {
  let submits = 0;
  const h = await setup(t, async interaction => {
    if (interaction.isChatInputCommand()) await interaction.showModal({ custom_id: 'consent', title: 'Settings', components: [
      { type: 18, label: 'Subject', component: { type: 4, custom_id: 'subject', style: 1, min_length: 3 } },
      { type: 18, label: 'Choice', component: { type: 22, custom_id: 'days', options: [{ label: 'Monday', value: 'monday' }], min_values: 1, max_values: 1 } }
    ] });
    else { submits++; await interaction.reply('Valid'); }
  });
  await h.interact({ kind: 'command', name: 'ping' });
  await assert.rejects(h.interact({ kind: 'modal', customId: 'consent', fields: { subject: 'no' }, modalFields: [{ type: 22, customId: 'days', values: ['monday'] }] }), /Text length/);
  await assert.rejects(h.interact({ kind: 'modal', customId: 'consent', fields: { subject: 'Valid' }, modalFields: [{ type: 22, customId: 'days', values: ['friday'] }] }), /Unknown modal selection/);
  assert.equal(submits, 0);
  const result = await h.interact({ kind: 'modal', customId: 'consent', fields: { subject: 'Valid' }, modalFields: [{ type: 22, customId: 'days', values: ['monday'] }] });
  assert.equal(result.status, 'passed');
  assert.equal(submits, 1);
});

test('captured-only private Components v2 responses preserve both flags on edit', async t => {
  const h = await setup(t, async interaction => {
    await interaction.reply({ flags: v2 | MessageFlags.Ephemeral, components: panel });
    await interaction.editReply({ flags: v2, components: [{ type: 10, content: 'Private update' }] });
    const response = await interaction.fetchReply();
    assert.equal(response.flags.has(MessageFlags.IsComponentsV2), true);
    assert.equal(response.flags.has(MessageFlags.Ephemeral), true);
  }, { mirrorResponses: false });
  const result = await h.interact({ kind: 'command', name: 'ping' });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(h.sent.length, 0);
});

test('modal file-upload metadata is resolved only from an existing allowed message', async t => {
  const h = await setup(t, async interaction => {
    assert.equal(interaction.fields.getUploadedFiles('files').first().name, 'report.txt');
    await interaction.reply('File metadata resolved');
  });
  const source = h.create({ content: 'Attachment source' });
  const attachmentId = '100000000000000040';
  source.attachments.set(attachmentId, new Attachment({ id: attachmentId, filename: 'report.txt', size: 12, url: 'https://example.com/report.txt', proxy_url: 'https://example.com/report.txt' }));
  const input = { kind: 'modal', customId: 'upload', attachmentMessageId: source.id, modalFields: [{ type: 19, customId: 'files', values: [attachmentId] }] };
  assert.equal((await h.interact(input)).status, 'passed');
  await assert.rejects(h.interact({ ...input, attachmentMessageId: undefined }), /require attachmentMessageId/);
});
