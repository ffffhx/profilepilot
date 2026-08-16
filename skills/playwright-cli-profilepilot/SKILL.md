---
name: playwright-cli-profilepilot
description: Use Playwright CLI with a real Chrome Profile through ProfilePilot Gateway. Trigger whenever Playwright CLI should reuse an existing login, extension set, proxy route, or ProfilePilot logical CDP port, and whenever user takeover, handoff, session conflicts, or structured ProfilePilot hard-stop errors appear.
compatibility: Requires Playwright CLI plus the ProfilePilot Playwright CLI Wrapper.
---

# Playwright CLI through ProfilePilot

Use ProfilePilot's Wrapper whenever Playwright CLI must operate a managed Chrome Profile. The Wrapper exchanges the logical CDP address for a one-time Gateway endpoint and preserves user/Agent control boundaries.

## Boundaries

- Use the installed `playwright-cli`; do not substitute `npx`, a Playwright script, or a separately launched browser.
- Connect only through a ProfilePilot logical port. Do not copy a WebSocket URL or query Chrome discovery endpoints directly.
- Keep commands for one browser task in the same working directory and Playwright session.
- Treat exit code `75` and structured ProfilePilot errors as hard stops. Do not retry by bypassing the Wrapper.

## Start a managed session

Attach once to the logical port selected in ProfilePilot:

```bash
playwright-cli attach --cdp=http://127.0.0.1:9223
```

Then use normal Playwright CLI commands in the same working directory:

```bash
playwright-cli goto https://example.com
playwright-cli snapshot
playwright-cli click e3
```

The Wrapper remembers the managed session and reconnects it through Gateway when safe.

Inspect the binding when needed:

```bash
playwright-cli profilepilot status
```

## User handoff

For login, CAPTCHA, or another required manual step:

```bash
playwright-cli profilepilot handoff --reason "请用户完成登录"
```

Wait for the user. After the user explicitly asks to continue:

```bash
playwright-cli profilepilot resume
playwright-cli snapshot
```

## Finish or cancel

Use `complete` after successful browser work:

```bash
playwright-cli profilepilot complete
```

Use `release` only when the task is cancelled or ended early:

```bash
playwright-cli profilepilot release
```

- `AGENT_USER_IN_CONTROL`: stop and wait.
- `SESSION_ALREADY_BOUND`: do not silently switch Profiles; release or ask the user.
- Gateway/Profile errors: restore the ProfilePilot configuration instead of connecting directly.
