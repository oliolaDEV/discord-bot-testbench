# Local protocol and scenarios

## Transport

The bot adapter listens on a random `127.0.0.1` port. Its owner-only runtime descriptor is `.testbench/bridge.json` under the project root. It contains protocol version `1`, process ID, URL, a random bearer secret and guild ID. Do not commit, expose or copy that file into prompts.

Clients send authenticated JSON requests to `POST /v1/run`:

```json
{ "op": "status" }
```

Success is HTTP 200 with `{ "result": ... }`. Validation or execution errors return HTTP 400 with `{ "error": "..." }`. Unauthenticated requests return 401, browser-origin requests 403, unsupported paths 404, non-JSON requests 415, and bodies larger than 1 MiB 413. The bridge does not accept redirects, expose an arbitrary Discord REST proxy or execute shell commands.

The protocol's runtime schemas and TypeScript definitions are in `src/protocol.ts`. An alternative framework adapter must implement the operations and clearly describe its interaction fidelity. It must not present synthetic callbacks as Discord-issued interactions.

## Operations

| `op` | Fields |
| --- | --- |
| `status` | None |
| `commands` | None |
| `inspect` | Optional `channelId` |
| `interact` | `interaction`, documented in [INTERACTIONS.md](INTERACTIONS.md) |
| `messages` | `channelId`, optional `limit` from 1 to 100 |
| `send` | `channelId`, either `content` from 1 to 2000 characters or a `message` object with content, embeds, components and flags |
| `wait` | `channelId`, `contains`, `after`, optional `timeoutMs` from 100 to 30000 |
| `assert` | `channelId`, optional `messageId`, one or more of `contains`, `embedTitle`, `componentId`, `componentType` |
| `fixture` | `kind` of `channel` or `role`, `name` containing lowercase letters, digits or hyphens |
| `cleanup` | None |
| `runs` | Optional report UUID `runId` |

Mutating operations are serialized. While an interaction handler is still running, new mutations are rejected rather than queued. Read-only inspection remains available. A fixture channel is automatically eligible as an interaction and message entry channel. Fixture metadata persists across restarts in the same root and guild.

`cleanup` removes only tracked fixture IDs. It never searches by name or deletes resources based on a prefix. Handler-created channels, roles, database rows and ordinary test messages are not automatically tracked or rolled back.

Reports are saved as `.testbench/runs/<uuid>.json`. `runs` returns one report or the latest 50 reports. Reports remain on disk until removed locally. Only interaction dispatches produce these reports; transport errors, message assertions and standalone sends do not create interaction reports.

## CLI

`setup` inspects a bot project and returns separate `userActions` and `agentActions`. A Discord channel link passed with `--channel-url` supplies guild and channel IDs; `--user` supplies the test member. It detects discord.js, discord.py and common project manifests for HTTP integration, then configures MCP entries, project skills and agent instructions once IDs are present. `--adapter http` explicitly selects the language-neutral route. The helper does not patch or start the bot itself; the installed skill directs the agent to integrate the selected adapter and verify a live result. `connect --endpoint URL` writes an authenticated local adapter descriptor, and `bridge` starts its shared observer. See [ADAPTERS.md](ADAPTERS.md).

```sh
discord-bot-testbench call operation.json
discord-bot-testbench run scenario.json
discord-bot-testbench serve --root /absolute/path/to/bot
```

`call` prints the result. `run` prints the scenario result. Both exit with code 1 for reported failures, unsuccessful assertions, wait timeouts or cleanup errors. Execution and configuration errors also exit with code 1. `serve` reserves stdout for MCP JSON-RPC; diagnostics go to stderr.

## Repeatable scenarios

A scenario is an ordered list of steps. Each step has a unique `id`, a protocol `request`, and optional expectations. A failure stops subsequent steps. Cleanup after a failed scenario is explicit; call `cleanup` afterward if needed.

```json
{
  "name": "Inspect the connection",
  "steps": [
    {
      "id": "connection",
      "request": { "op": "status" },
      "expect": [{ "path": "ready", "equals": true }]
    },
    {
      "id": "channel",
      "request": {
        "op": "messages",
        "channelId": "{{steps.connection.channelIds.0}}",
        "limit": 5
      }
    }
  ]
}
```

Expectations use dot-separated paths, including numeric array indices, and compare values deeply. A whole-string reference such as `{{steps.connection.channelIds.0}}` substitutes the original JSON value. Inline interpolation inside a larger string is not supported. Missing or unsafe paths fail the scenario.

The included [smoke scenario](../examples/smoke.scenario.json) executes a command and asserts the exact returned message ID.
