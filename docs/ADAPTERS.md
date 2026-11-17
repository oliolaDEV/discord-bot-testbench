# Adapters and language support

The MCP client and CLI speak one protocol. Your bot keeps its language and framework. Choose the adapter that matches its architecture; installing the controller alone does not connect arbitrary gateway SDKs.

| Runtime | Integration | Verification |
| --- | --- | --- |
| JavaScript / TypeScript, discord.js 14 | Native `startTestbench(client)` | Command, components, modal, autocomplete and context-menu integration tests |
| Python, discord.py 2.6–2.8 | Native `start_testbench(bot)` | Real discord.py command tree including hybrid slash commands, View and DynamicItem button/select dispatch, Modal, file responses and private captures over the shared transport |
| C# / .NET | HTTP interaction router | ASP.NET helper included; application router integration required |
| Java / Kotlin | HTTP interaction router | JDK HTTP helper included; application router integration required |
| Go | HTTP interaction router | Standard-library helper and authentication test included |
| Rust, C++, Ruby, PHP, other runtimes | HTTP interaction router | Same JSON contract; application endpoint required, no native SDK adapter bundled |

HTTP is language-neutral. This does not imply a tested native integration for every library or version. Gateway-only libraries need a development router around their existing command/component callbacks. The coding agent performs that integration and verifies the affected flows. Do not silently bypass authorization, conversion or application checks to make tests pass.

## discord.js

Install the Node package into the bot project. After ready, behind the existing development guard:

```js
import { startTestbench } from 'discord-bot-testbench';

const testbench = await startTestbench(client, {
  dispatch: interaction => routeInteraction(interaction)
});
```

The dispatch option is optional when existing listeners return their promises. Close the handle during normal shutdown. See [INTEGRATION.md](INTEGRATION.md).

## discord.py

Keep the existing bot virtual environment. Install the controller in a local tool directory or checkout, then install its bundled Python adapter:

```sh
python -m pip install /absolute/path/to/discord-bot-testbench/adapters/python
```

Run the controller's `setup --root BOT_PROJECT --channel-url CHANNEL_LINK --user USER_ID`. Requirements and pyproject files containing discord.py are recognized. It writes `testbench.config.json`, local runtime paths and agent configuration into the bot project.

Inside the existing bot, after ready and behind its development guard:

```python
from discord_testbench import start_testbench

testbench = await start_testbench(bot, root="/absolute/path/to/bot")
```

Do this once, even if `on_ready` fires again. Await `testbench.close()` during shutdown. The adapter starts an authenticated Python HTTP endpoint and the Node observer automatically using the bot's existing token, without printing it. The observer opens an additional development-bot Gateway session for discovery and live checks. MCP itself does not receive the token.

Commands run through the actual CommandTree, preserving its converters and checks. Hybrid commands support the slash-command path, including `ctx.send()` and `ctx.defer()` followed by `ctx.send()`. Components use registered Views and LayoutViews or registered DynamicItem regex factories, and captured modals use their real instances. The adapter uses internal discord.py routing APIs; supported versions 2.6–2.8 are constrained and exercised in CI (2.8 currently uses 2.8.0a). Checkbox, radio and file-upload widgets require discord.py 2.7. LayoutView messages receive the Components v2 flag automatically. Modal select resources and existing attachment metadata are resolved into native objects.

`discord.File` responses support `file`/`files` on initial replies and followups, and new files in `attachments` on original-response and component edits. Public mirrors upload the bytes; private reports capture filenames, descriptions and bytes without delivering them to Discord. The JSON callback transport encodes uploads as base64 and limits the complete request to 1 MiB. `delete_after` schedules public mirror deletion in the controller process, including after handler completion; deletion failures are ignored. Unset (`MISSING` or `None`) response options are ignored. A supplied `poll` or other unsupported option raises a clear error.

Prefix-message dispatch, persistent component database reconstruction and full callback-response metadata are not implemented. Provide an explicit async `dispatch` function for application-specific routing. Private response objects are local captures and have partial Message semantics.

## Any language: immediate HTTP responses

This mode fits an existing JSON interaction router. Configure the development route:

```sh
discord-bot-testbench setup --adapter http --root BOT_PROJECT --channel-url CHANNEL_LINK --user USER_ID
discord-bot-testbench connect --root BOT_PROJECT --endpoint http://127.0.0.1:8788/testbench
```

The second command creates `.testbench/adapter.json` with a random bearer secret. Have the development handler read that secret locally. Bind it to loopback, authenticate the bearer header, reject browser origins, cap requests at 1 MiB and forward the JSON payload into your existing router. Keep production Discord signature verification unchanged; this separate development route authenticates Testbench requests.

The handler receives a Discord-shaped interaction payload and returns standard interaction response JSON:

```json
{ "type": 4, "data": { "content": "The real application handler produced this response" } }
```

Supported response types: `4` message, `5` defer message, `6` defer update, `7` update source message, `8` autocomplete choices and `9` modal. Public message and update results are mirrored to Discord by the observer. The same input handles commands, buttons, selects and modals. Reuse your actual application handler rather than writing a separate hard-coded test implementation.

Start the bot endpoint and run `discord-bot-testbench bridge --root BOT_PROJECT` with the development bot token already available in its environment or local `.env`. This authenticates the observer, discovers commands and performs live assertions. A deferred HTTP response alone does not exercise later webhook operations; use full duplex for those flows.

Reusable endpoint helpers are in `adapters/http/go`, `adapters/http/dotnet` and `adapters/http/java`. They authenticate and bound requests; the application supplies the existing router callback. Java's helper can also be called from Kotlin. Rust/C++ and other runtimes implement the same contract using the HTTP server already present in their project. These helpers do not transform Discord.Net, JDA, DiscordGo, Serenity or DPP gateway objects automatically.

## Any language: full duplex

Use `connect --mode testbench --endpoint URL` for asynchronous handlers. Testbench sends:

```json
{
  "version": 1,
  "interaction": { "type": 2, "data": { "name": "example" } },
  "callback": { "url": "http://127.0.0.1:12345/response", "token": "PER_RUN_SECRET" }
}
```

The illustrative interaction above is abbreviated; real payloads include guild, channel, member, permissions, command definitions and resolved data. Only accept loopback callback URLs and do not log their bearer secrets.

During execution, post `{ "method": "reply", "args": [{ "content": "Hello", "fetchReply": true }] }` to the callback URL with its bearer token. Other methods are `deferReply`, `editReply`, `followUp`, `fetchReply`, `deleteReply`, `showModal`, `respond`, `update` and `deferUpdate`. The callback returns `{ "result": ... }`, including `{ "message": DISCORD_MESSAGE_JSON }` for returned messages. It authenticates requests and rejects unsupported methods.

Response payloads can include `files: [{ "attachment": "BASE64_BYTES", "encoding": "base64", "name": "report.txt", "description": "Optional description" }]`. The callback decodes these into upload buffers; the complete JSON request must fit within 1 MiB. A `deleteAfter` number schedules mirror deletion after that many seconds without keeping the callback open.

After awaited work completes, return `{ "handled": true, "errors": [] }` from the original endpoint. Include application failures in `errors`. Do not return completion while relevant work is detached. The Python adapter is a complete example of this contract.

## Fidelity

All modes simulate the initiating interaction. No mode drives a normal Discord user account or proves client rendering and Gateway delivery. Public effects and live observations use a real development bot. A handler report checks completion and acknowledgement; independent assertions establish the intended outcome. Voice, payments, Activities and unimplemented library features require other tests.
