# Interaction inputs

All examples below are arguments for `testbench_interact`. Replace the illustrative IDs with your configured resources. Call `testbench_commands` first; registered names, types and options are the source of truth.

## Slash commands and subcommands

```json
{
  "interaction": {
    "kind": "command",
    "name": "echo",
    "channelId": "100000000000000002",
    "userId": "100000000000000003",
    "options": [{ "name": "text", "type": 3, "value": "Hello" }]
  }
}
```

Use Discord option type numbers: subcommand `1`, subcommand group `2`, string `3`, integer `4`, boolean `5`, user `6`, channel `7`, role `8`, mentionable `9`, number `10`. Attachment `11` is explicitly rejected by this adapter.

A subcommand such as `/ticket create subject:Hello` uses:

```json
[
  {
    "name": "create",
    "type": 1,
    "options": [{ "name": "subject", "type": 3, "value": "Hello" }]
  }
]
```

User, role, mentionable and channel option values are IDs. Their corresponding resources are fetched from the configured guild and supplied as resolved interaction data. The adapter does not implement Discord's complete option validation; schema-invalid requests must not be interpreted as evidence of client-reachable behavior.

## Buttons

```json
{
  "interaction": {
    "kind": "button",
    "channelId": "100000000000000002",
    "userId": "100000000000000003",
    "messageId": "100000000000000010",
    "customId": "ticket:open"
  }
}
```

The source message must exist in the allowed channel, belong to the connected bot and contain an enabled component with the requested custom ID and type. Obtain its message ID from a prior reply event or `testbench_messages`. Link buttons do not create interactions and are not supported.

## Select menus

Use `kind: "select"`, the source `messageId`, `customId` and a `values` array. `componentType` selects the interaction class:

| Value | Select type | Values |
| --- | --- | --- |
| `3` | String, the default | Option values from the source component |
| `5` | User | Guild member IDs |
| `6` | Role | Guild role IDs |
| `7` | Mentionable | Guild member or role IDs |
| `8` | Channel | Guild channel IDs |

The adapter checks the source component, disabled state and value count. String values must exist on the source menu. Complete client filtering, channel type restrictions and duplicate-selection rules are not reproduced.

## Modals

When a handler calls `showModal`, its definition appears in a response event. Submit a text-input modal in a separate call:

```json
{
  "interaction": {
    "kind": "modal",
    "channelId": "100000000000000002",
    "userId": "100000000000000003",
    "customId": "ticket:submit",
    "fields": { "subject": "A ticket created by the agent" }
  }
}
```

The current input model supports text fields. It does not require a previously opened modal session or enforce the modal's required fields and length constraints. This allows direct handler and negative-path tests but does not reproduce client validation. Newer modal component types are not represented by this input model.

## Autocomplete

Use `kind: "autocomplete"`, the registered command name and command options. Set `focused: true` on the option being completed. Captured `respond` events contain the choices returned by the handler. Choice limits and localization validation are not reproduced.

## Context menus

Use the exact registered name and either `kind: "user-context"` with `targetId` set to a guild member, or `kind: "message-context"` with both `targetId` and `messageId` set to the same live message ID in the allowed channel.

## Read and assert

`testbench_assert` accepts `channelId`, optional `messageId` and one or more of `contains`, `embedTitle` or `componentId`. All supplied predicates must match one message. Without a message ID it searches the latest 100 messages; prefer exact IDs to avoid matching an earlier run.

`testbench_wait` requires `channelId`, `contains` and an `after` message ID. It polls up to 100 messages at a time for at most 30 seconds. It is intended for quiet development channels, not exhaustive high-volume history searches.

`testbench_send` sends as the connected bot. It does not create a human-authored message. Prefix-command handlers that ignore bot messages will ignore it.
