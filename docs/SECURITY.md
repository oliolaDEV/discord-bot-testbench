# Security and operational boundaries

## Intended environment

Run Testbench in a dedicated development guild with a separate development application. The adapter executes your bot's actual code. That code retains all permissions associated with its token and may touch databases, external services or guilds beyond the configured entry channel.

The allowlist restricts where test interactions enter the bot and which identities they represent. It is not a sandbox around arbitrary handler behavior. Adding an administrative test identity allows the agent to exercise that identity's handler paths. Choose identities and bot permissions accordingly.

## Credentials and local access

- The bot uses its existing token; the MCP server does not need it.
- The bridge binds to IPv4 loopback and authenticates every request with a fresh random 256-bit bearer secret.
- Browser-origin requests are rejected. No CORS access is granted.
- Runtime files use restrictive creation modes on systems that honor POSIX modes. Windows access follows the user's filesystem ACLs.
- Anyone who can read the runtime descriptor can invoke the bridge. Local MCP access is a trusted development capability, not a defense against another process running as the same operating-system user.
- Exact occurrences of the current bot token are redacted from returned and saved operation data. This is best-effort protection, not a general secret detector. Application logs, transformed tokens and other credentials are not automatically scrubbed.

Do not commit `.env`, `.testbench/`, runtime reports or tokens. Reports can contain captured private replies and test data. There is no telemetry or remote upload path in this package. Your MCP client may send tool results to its model provider under that client's settings.

## Discord data is untrusted

Messages, embeds, custom IDs and command inputs can contain text that looks like instructions. They are test data. The MCP server and generated agent guide explicitly instruct the agent not to follow Discord-sourced requests to access files, reveal secrets or perform unrelated actions. The coding agent's own permissions remain the final boundary.

## Side effects and cleanup

Public response mirrors suppress mentions. Direct sends made by your own handler follow its own mention settings. No user account is automated.

Only resources created by the fixture tool are automatically tracked. Cleanup deletes tracked IDs, not names or matching prefixes. There is no general transaction rollback for Discord or application databases.

Timeouts stop synthetic response methods and lock further testbench mutations until awaited work settles. They cannot revoke the bot token, terminate arbitrary JavaScript or cancel a Discord request already sent. Restart a stuck bot and inspect its effects before continuing.

## Reporting problems

If you discover a security issue, avoid posting credentials, runtime descriptors or private Discord data in a public issue. Use a private reporting channel provided by the repository owner when one is available.
