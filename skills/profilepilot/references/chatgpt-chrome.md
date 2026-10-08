# ChatGPT Chrome integration

Use this route only when the user explicitly selects it. The normal default-Profile route is the ProfilePilot extension with `ppilot browser`. `@Chrome` is a host integration, not a command installed by ProfilePilot and not a general MCP server. Check the actual tools offered by the current host/session; model name alone does not establish availability. A missing literal `@Chrome` in the request does not mean the extension is uninstalled.

1. Discover available Chrome tools when the host supports discovery. Confirm the connected browser Profile is the requested one, then use the host's tools and permissions.
2. If tools are available, use them without asking the user to reinstall or mention the browser again. If the integration exists but is not attached, try the host's connection capability; only ask for the browser selection when the user must attach it.
3. If the host lacks this integration, explain the limitation and preserve the target and task. Follow the user's routing preference; do not silently substitute another Profile, copied cookies, direct CDP or another transport.
4. If the supported host lacks prerequisites and installation is authorized, use actual official installation/settings tools. Verify the installed connection before claiming success. If a local step is required, give that step and stop retrying.

The documented setup is in ChatGPT desktop Settings → Computer Use → Chrome: install required plugin/extension, confirm Manage, then choose Chrome in the chat's `@` menu. Verify the current official instructions when troubleshooting changed UI: https://learn.chatgpt.com/docs/chrome-extension

Windows/macOS support depends on the actual host and provided tools. `@Chrome` uses the host's permissions and takeover mechanism; it does not belong to Gateway and must never bypass a stopped ProfilePilot session or control the same Profile concurrently.
