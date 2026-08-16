---
name: chrome-devtools-mcp-profilepilot
description: Configure and use Chrome DevTools MCP through ProfilePilot Gateway with a real managed Chrome Profile. Trigger whenever an MCP server should reuse a local Chrome login, extensions, proxy route, or ProfilePilot logical port, and whenever user takeover, session conflicts, or structured ProfilePilot hard-stop errors appear.
compatibility: Requires a globally installed chrome-devtools-mcp binary plus the ProfilePilot DevTools MCP Wrapper.
---

# Chrome DevTools MCP through ProfilePilot

Use the ProfilePilot-managed `chrome-devtools-mcp` launcher when an MCP client needs a real Chrome Profile. Do not use `npx`: install the real CLI first so ProfilePilot can detect and verify it.

## Configure the MCP server

Set the MCP server command to the installed launcher and select a ProfilePilot logical port:

```bash
chrome-devtools-mcp --profilepilot-port 9223
```

ProfilePilot injects the Agent Session identity in a new Codex or Claude shell. The Wrapper replaces direct browser targets with a one-time Gateway endpoint before the MCP server starts.

## Boundaries

- Do not pass a direct `--browserUrl`, `--wsEndpoint`, or Chrome WebSocket address for a managed Profile.
- Do not start another Chrome with `--remote-debugging-port`.
- Do not fall back to `npx`, Playwright, Puppeteer, or another MCP server to bypass Gateway control.
- One Agent Session can bind one Profile; one Profile can be driven by one Session.
- Treat exit code `75` and structured ProfilePilot errors as hard stops.

## Control lifecycle

Chrome DevTools MCP is a long-running server. ProfilePilot owns its Gateway binding for the life of the MCP process.

- If ProfilePilot reports that the user has control, stop issuing MCP browser operations and wait for an explicit return.
- If the Profile is occupied, do not switch accounts or steal the lease. Explain the conflict.
- When the task finishes, allow the MCP client to stop the server normally so ProfilePilot can release its binding.
- When browser state may have changed during user control, inspect the page again before continuing.

## Failure handling

- Missing real CLI: ask the user to install `chrome-devtools-mcp` globally, then re-run ProfilePilot detection.
- Missing Profile/port: ask the user to prepare a Profile in ProfilePilot.
- Gateway unavailable: restore ProfilePilot/Gateway; direct Chrome CDP is not a fallback.
