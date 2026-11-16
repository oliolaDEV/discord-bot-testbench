# Contributing

The goal is straightforward: let a coding agent verify Discord bot changes without requiring the developer to manually repeat every supported flow.

Keep the boundary between synthetic interactions and live Discord behavior explicit. New functionality must describe what is exercised, what is simulated and what remains untested. Do not implement user-token automation or present synthetic interactions as real Discord client input.

## Working locally

Use Node.js 22.12 or newer.

```sh
npm ci
npm run check
npm test
npm run test:package
npm pack --dry-run
```

Tests run offline against real discord.js structures and an isolated transport double. Add focused tests when changing routing, response semantics, validation, access boundaries or lifecycle behavior. For a live check, run the example bot against your own development application and guild; never commit its credentials or reports.

## Project structure

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Setup, connection checks and CLI entry points |
| `src/setup.ts` | Agent-facing onboarding plan, identity resolution and credential-presence checks |
| `src/mcp.ts` | Agent-facing tools and prompt |
| `src/bridge.ts` | Authenticated local bot bridge and lifecycle |
| `src/service.ts` | Discord operations, resource scope, reports and fixtures |
| `src/interactions.ts` | discord.js interaction construction and response capture |
| `src/protocol.ts` | Validated wire format |
| `src/scenarios.ts` | Repeatable flows and expectations |
| `agent/` | Instructions installed into bot projects |
| `skills/` | Portable setup and testing skill installed into bot projects |
| `examples/` | Development bot and smoke scenario |

Use small functions and descriptive names. Keep explanations in Markdown documentation rather than code comments. Preserve existing project instructions and client configuration during setup. Do not add contributor attribution to generated source files.

## Pull requests

Explain the concrete behavior change, relevant limitations and validation performed. Changes to tools, configuration or interaction fidelity should update the corresponding documentation. Release metadata should use the actual repository and package ownership; do not invent a published package or repository URL.
