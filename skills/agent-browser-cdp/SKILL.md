---
name: agent-browser-cdp
description: Safely control a real local Chrome Profile with agent-browser through ProfilePilot Gateway. Use whenever agent-browser should reuse an existing Chrome login, extension set, or proxy route; whenever a ProfilePilot logical CDP port, browser handoff, user takeover, session conflict, or Gateway hard-stop appears; and whenever browser work must preserve ProfilePilot's one-Profile/one-Session boundary.
compatibility: Requires agent-browser plus the ProfilePilot agent-browser Wrapper.
---

# agent-browser through ProfilePilot

Route browser automation through ProfilePilot so the Agent and the user cannot drive the same Chrome Profile at the same time.

```text
Agent command → ProfilePilot Wrapper → Gateway → managed Chrome Profile
```

## Operating rules

- Use the installed `agent-browser` command. The Wrapper will protect configured ProfilePilot logical ports.
- Do not launch another Chrome, Playwright, or Puppeteer browser to bypass a Gateway error.
- Do not add `--remote-debugging-port` to managed Chrome. ProfilePilot owns the transport.
- Keep one Agent Session bound to one Profile. A Profile can be driven by only one Session at a time.
- Treat exit code `75` and structured ProfilePilot errors as hard stops. Report the action the error requests instead of retrying around it.
- Re-snapshot after the user returns control because earlier element references are stale.

## Normal workflow

When the Profile or logical port is already known, keep it consistent across commands:

```bash
agent-browser --cdp 9223 open https://example.com
agent-browser --cdp 9223 snapshot -i
agent-browser --cdp 9223 click @e3
```

The first browser command acquires the Profile through Gateway. If the configured Profile is stopped, ProfilePilot may start it. Do not run a separate direct-CDP connectivity probe.

Inspect the current binding when diagnosis is needed:

```bash
agent-browser profilepilot status
```

## User handoff

When the user must complete a CAPTCHA, login, native picker, hardware-key step, or another manual action:

```bash
agent-browser profilepilot handoff --reason "请用户完成登录"
```

Tell the user what to do and wait. After the user explicitly asks to continue:

```bash
agent-browser profilepilot resume
agent-browser snapshot -i
```

Do not call `complete` while a user action is still pending.

## Finish or stop

On normal completion, release the browser Session:

```bash
agent-browser profilepilot complete
```

If the user cancels or explicitly asks to end early:

```bash
agent-browser profilepilot release
```

Do not reconnect the released Session.

## Conflicts and control

- `AGENT_USER_IN_CONTROL`: stop browser commands and wait for the user to return control.
- `PROFILE_LEASE_CONFLICT` or `SESSION_ALREADY_BOUND`: do not steal the Profile or silently switch accounts. Explain the conflict and ask before choosing another Profile.
- `GATEWAY_PROFILE_NOT_CONFIGURED`: ask the user to prepare a Profile in ProfilePilot; do not start an unmanaged browser.
- Gateway unavailable: restore ProfilePilot/Gateway first. Direct Chrome CDP is not a fallback.
