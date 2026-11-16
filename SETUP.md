# Let your coding agent set it up

Give your agent this repository or its release archive and say:

> Set up Discord Bot Testbench in my bot project. Read SETUP.md and the bundled skill, install and integrate it, start the development bot, and verify a real test result. Handle the coding and configuration yourself. Ask me only for information or Discord access you cannot obtain from the project. Never ask me to paste a token into chat.

The agent's setup instructions are in [skills/discord-bot-testbench/SKILL.md](skills/discord-bot-testbench/SKILL.md). Agents that can read this repository can follow them immediately; a separately installed skill is optional.

## What you provide

For an existing bot, the usual missing input is one message containing:

- A link to a text channel in your development server.
- Your Discord test user's ID, so the agent tests with the intended member's actual permissions.

The channel link contains both server and channel IDs. If the project already has this configuration, you do not need to supply it again. The agent should reuse existing bot credentials without revealing them.

If there is no development bot or server yet, someone with the necessary Discord access must create the application, invite its bot and store its token locally. The agent explains these steps only when they are missing. A skill cannot supply account access or credentials you have not granted.

## What the agent does

The agent checks the framework, installs the package, configures test identities, adds the development-only integration to your existing bot, starts it, registers commands through your normal workflow, and verifies the result of a test. Setup installs project skills for Codex and Claude Code and preserves unrelated configuration.

The helper command is:

```sh
discord-bot-testbench setup --channel-url https://discord.com/channels/SERVER_ID/CHANNEL_ID --user USER_ID
```

Replace the illustrative IDs. Running `setup` without these inputs first inspects the project and returns a JSON checklist. It never displays token values. `--token-env NAME` checks a custom credential variable. Existing configurations and `DISCORD_TEST_GUILD_ID`, `DISCORD_TEST_CHANNEL_ID`, `DISCORD_TEST_USER_ID` can supply the identities.

The helper writes configuration and skills; the coding agent performs the source integration. It does not automatically understand or rewrite every possible bot architecture.

## What daily use looks like

> Add the feature and test it with Discord Bot Testbench. Verify the actual outcome and fix failures.

The agent can use MCP tools after its client loads the connection, or use the CLI in the same chat immediately. You do not have to run each command or copy test output back manually.

Native adapters support discord.js 14 and discord.py 2.6–2.7. Other runtimes use a language-neutral development HTTP router. See [the adapter guide](docs/ADAPTERS.md) for coverage and required application integration. Handler inputs are synthetic and Discord effects are live. Discord client rendering and Gateway delivery are outside coverage. Private responses are captured locally rather than delivered as real ephemeral Discord replies.

## Distribution status

The repository includes the controller, Python adapter, HTTP endpoint helpers and a portable skill. It is not a hosted cloud service. Install from [the GitHub repository](https://github.com/oliolaDEV/discord-bot-testbench), a checkout or a release archive. No npm registry publication is claimed.
