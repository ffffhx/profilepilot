# Playwright CLI through Gateway

Use the installed `playwright-cli` and its ProfilePilot Wrapper. Attach to the selected Profile's logical port. Keep one working directory and Playwright session for the task:

```sh
playwright-cli attach --cdp=http://127.0.0.1:9223
playwright-cli goto https://example.com
playwright-cli snapshot
playwright-cli click e3
playwright-cli profilepilot status
```

The port and element ref above are examples. The Wrapper remembers the binding and requests Gateway tickets. Do not replace it with `npx`, a raw Playwright script, direct Chrome discovery or a newly launched browser after failure.

For user input, run `playwright-cli profilepilot handoff --reason "Complete sign-in"`, then wait. After explicit return, run `playwright-cli profilepilot resume` and a fresh snapshot. Run `playwright-cli profilepilot complete` on success or `playwright-cli profilepilot release` on cancellation.

Exit 75 and structured Gateway errors stop operations. `AGENT_USER_IN_CONTROL` needs user return; `SESSION_ALREADY_BOUND` needs the original target or an authorized session transition. Restore missing Profile/Gateway configuration instead of connecting directly.
