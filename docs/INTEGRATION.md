# Integration

This page describes the discord.js API. For discord.py and language-neutral HTTP handlers, see [the adapter guide](ADAPTERS.md).

## API

```ts
startTestbench(client, {
  root,
  config,
  dispatch
})
```

`client` must be a ready discord.js 14 client. The function returns a promise for `{ url, close }`. Await `close()` during graceful shutdown. The URL is a randomly allocated loopback port and is not a public endpoint.

| Option | Default | Meaning |
| --- | --- | --- |
| `root` | `process.cwd()` | Bot project directory containing configuration and runtime state |
| `config` | Read `testbench.config.json` | Explicit configuration override |
| `dispatch` | Existing `interactionCreate` listeners | Awaitable interaction router |

Register event listeners before starting the adapter. Automatic dispatch calls the current raw listeners with the Discord client as `this` and awaits their returned promises. It does not emit a new Gateway event. Once-listeners retain their normal once behavior. Prefer a router when global listeners also contain telemetry, collectors or unrelated behavior.

The package is ESM. On the supported Node versions, CommonJS projects can also load the API using `const { startTestbench } = require('discord-bot-testbench')` through Node's support for requiring synchronous ESM modules. Node 22.12 may print an experimental-feature warning for this form.

## Configuration

```json
{
  "guildId": "100000000000000001",
  "channelIds": ["100000000000000002"],
  "userIds": ["100000000000000003"],
  "mirrorResponses": true,
  "timeoutMs": 15000
}
```

Replace the illustrative IDs with actual resources. IDs remain strings throughout the protocol. At least one channel and identity are required. The configuration rejects unknown keys. `timeoutMs` accepts 100–120000 milliseconds.

`mirrorResponses: false` captures interaction responses without sending their mirror messages. It does not stop Discord API calls made directly by your handler. For example, `interaction.channel.send()` and `guild.channels.create()` still perform real operations.

The actor must be a real member of the configured guild, be listed in `userIds`, and have View Channel. Commands additionally check Use Application Commands and default member permissions. This is a partial availability check; command overrides, contexts, installation rules and complete Discord validation remain outside coverage. Other target members may be resolved within the test guild for command options.

## Responses

The adapter constructs actual discord.js interaction classes. Type guards, option getters, member objects and role/channel resolution therefore use the library's normal structures.

It replaces interaction response methods because synthetic interactions have no Discord-issued callback token. Supported methods include `reply`, `deferReply`, `editReply`, `followUp`, `fetchReply`, `deleteReply`, `showModal`, `respond`, `update` and `deferUpdate` where the interaction class provides them. The synthetic webhook supports send, original-reply edits, fetch and delete. Follow-up webhook editing and arbitrary webhook operations are not implemented.

Public response mirrors are ordinary bot messages, not interaction webhooks. They preserve the supplied content, embeds and components. Mentions are suppressed on mirrored sends and edits. Public mirrored file uploads use discord.js's normal channel-send behavior. Captured private file objects are not validated as delivered attachments.

`reply({ fetchReply: true })` returns a message. `reply({ withResponse: true })` returns the minimal `{ resource: { message } }` shape; this is not a complete Discord callback response. Fetching the original reply returns the captured or mirrored message. Code depending on additional callback metadata needs a separate test.

Private responses are represented by local message objects and stored in the report. No private response is mirrored into a public channel. These local objects are not fully equivalent to Discord Message objects: collectors, transport-backed fetches, attachments and arbitrary message mutations require separate testing.

## Completion and timeouts

Handlers should return or await every operation relevant to a test. The adapter waits for returned listener promises and in-flight captured response methods. It cannot discover arbitrary detached tasks, scheduled jobs, swallowed exceptions or later Gateway events.

An unacknowledged interaction fails. A first acknowledgement after three seconds fails. The timing measures adapter dispatch, not Discord transport latency.

When a handler exceeds `timeoutMs`, the adapter returns a `timed_out` report and closes its synthetic response methods. Further mutating testbench calls remain locked until that handler settles. An endless handler requires a bot restart. Node.js cannot safely cancel arbitrary application code, and direct Discord calls or background effects may still continue. No automatic rollback is claimed.

## Framework scope

Native runtime adapters target discord.js and discord.py. Other languages can use a development HTTP interaction router through the shared observer. Existing bots need a source-level integration; a gateway-only library is not automatically adapted merely by installing the controller. See [adapters and language support](ADAPTERS.md) for the exact integration routes, helpers and limits.
