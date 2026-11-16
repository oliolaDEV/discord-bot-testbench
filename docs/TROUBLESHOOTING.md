# Troubleshooting

## No running testbench found

Start the bot and await `startTestbench(client)` after `ClientReady`. The bot and MCP server must point to the same project root. Run `doctor` from that root or pass `--root` explicitly. Installing the package alone does not instrument the bot.

## The MCP tools do not appear

The agent can still test in this chat through `discord-bot-testbench call FILE` and `run FILE`. The installed skill explains this fallback; a client reconnect is needed only to make the new MCP tools available directly.

Run `init` from the bot project. Inspect the generated `.mcp.json` or `.codex/config.toml`, enable the entry, trust the project in your client, then reconnect. Project configuration support and trust requirements depend on your installed client. Setup also prints an argument array for optional user-level `codex mcp add` registration. Avoid registering the same server twice.

The generated entries contain absolute local paths. Regenerate them after moving the checkout, installing the package elsewhere or switching computers. Existing conflicting entries must be updated or removed explicitly.

For Claude Code configuration details, see [the official MCP guide](https://code.claude.com/docs/en/mcp).

## A bridge descriptor already exists

One bot bridge owns a project root at a time. Stop the other bot. Graceful shutdown removes its descriptor. After an ungraceful crash, a descriptor whose process no longer exists is reclaimed automatically at startup. If a live or reused process ID remains, verify that no bridge is running before removing `.testbench/bridge.json`. Do not delete the entire state directory unless you also intend to discard reports and tracked fixture metadata.

## Command is not registered

Register commands through your application's existing deployment workflow. Testbench discovers the real guild and global command definitions; it does not deploy your code or command schemas automatically. The included example registers its own commands on startup.

## Missing Access or Missing Permissions

Verify that the development application belongs to the configured guild. Grant View Channel, Send Messages, Read Message History and any permission your handlers need. Fixture operations require Manage Channels or Manage Roles. Role hierarchy restrictions still apply. The configured test member must be able to view the entry channel and use its command.

The bridge does not grant Administrator or change existing server permissions automatically.

## Handler did not acknowledge the interaction

The selected router did not call a supported response method. Check command names, routing guards and returned promises. Provide `dispatch: interaction => routeInteraction(interaction)` if your event listener starts a detached task. Errors caught and hidden inside your bot cannot automatically be identified as failures; verify the expected results independently.

## The handler passed but the feature is broken

A handler report checks observed completion and acknowledgement. Add assertions against the exact returned message ID and inspect the affected channel, role or application state. The adapter does not test Discord client rendering, Gateway delivery or all Discord validation rules.

## Collector waits or an interaction token error

Synthetic interactions have no real callback token. Route follow-up buttons and modal submissions through ordinary `interactionCreate` handlers and invoke them in separate test calls. Collector-based flows, raw callback REST requests and unimplemented webhook methods need separate testing or an explicit application test adapter.

## A timed-out handler blocks further tests

Read-only tools remain available. Wait for the handler to settle or restart the bot. Inspect direct Discord and database effects before retrying. The timeout does not undo them.

## A prefix command does not run

`testbench_send` sends as a bot. Most prefix-command handlers intentionally ignore bot-authored messages. No human message or user-client automation is supplied by this adapter.
