# Chrome DevTools MCP through Gateway

Use the installed real `chrome-devtools-mcp` and ProfilePilot's corresponding launcher. Configure the MCP client to run that launcher with the selected logical port:

```sh
chrome-devtools-mcp --profilepilot-port 9223
```

The port is an example. ProfilePilot provides Agent session identity in a newly opened configured shell; the Wrapper supplies a temporary Gateway endpoint. Do not pass `--autoConnect`, a direct `--browserUrl`/`--wsEndpoint`, or use `npx` as a substitute for the managed route.

This is a long-running MCP server: ProfilePilot owns the binding for its process lifetime. Stop browser calls on user takeover or a conflict, wait for explicit return, then inspect the page again. Stop the server normally when the MCP task is finished so its binding can be released.

Prepare a missing real CLI and Wrapper in ProfilePilot's tool setup. A missing Profile/port needs configuration. An unavailable Gateway needs restoration. None of these authorizes launching another browser or silently selecting another account.
