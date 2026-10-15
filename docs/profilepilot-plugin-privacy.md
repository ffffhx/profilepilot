# ProfilePilot plugin privacy notice

Effective date: 15 October 2026. Publisher: **ffffhx**, maintainer of [ProfilePilot](https://github.com/ffffhx/profilepilot).

This notice covers the ProfilePilot plugin's instructions and their use of the local ProfilePilot CLI. The plugin has no hosted MCP server, publisher account system, advertising, or plugin-specific analytics service. It requires a separately installed CLI and, for some functions, the desktop app, browser extension, or Android companion.

## Information used and why

At the user's request, ProfilePilot can return browser profile and tab identifiers, page titles and URLs, page text and structure, screenshots, selected browser history, downloads, and diagnostic results. Android tasks can use device identifiers, connection state, screen images, accessibility trees, and requested interaction text. These observations support the selected task and can include personal information visible in the chosen page or app.

Control sessions use local session identifiers, connection metadata, and ownership state to coordinate the agent with user pause, stop, and takeover. The CLI and app keep local diagnostic logs with timestamps, component names, operation results, and runtime information to diagnose failures. Sensitive keys are redacted where recognized; this is not a guarantee that every page string or diagnostic message is free of personal information.

Do not supply passwords, API keys, payment-card information, government identifiers, or medical records to the plugin. Complete sign-in and device permission prompts directly. Pairing credentials belong in the local connection interface, not in public issues or conversation transcripts. Scope observations to the information the task needs.

## Where information goes

The browser extension communicates with the local ProfilePilot service. Android connections use the configured USB or local-network connection. The plugin does not send browser or phone observations to a publisher-operated analytics endpoint or sell them.

CLI results and requested screenshots are returned to the calling agent. **The agent host, including ChatGPT or Codex, may send this information to its model service** according to that host's settings and privacy terms. Requested website or device actions also send data to the selected website, application, or service. GitHub hosts this repository and downloads, and receives information when users visit those pages or submit support issues under GitHub's policies.

ProfilePilot's separate built-in AI tasks, optional cloud phone-status service, and optional external CAPTCHA services have additional recipients and settings. Installing or setting up this plugin does not enable those services. If explicitly used, their data handling must be considered separately; the plugin does not promise that all product data stays on the computer.

## Storage and retention

- The plugin's packaged instructions and assets stay in the host's plugin cache until removed or replaced by the host.
- Local connection preferences and pairing state remain until the user disconnects/removes the integration or deletes the corresponding application data. Uninstalling the plugin alone does not remove the separately installed app, extension, or their data.
- Screenshots, downloads, saved reports, and task history remain in their selected local locations until the user deletes them or the responsible application's retention settings remove them. They have no plugin-wide time-based expiry.
- By default, ProfilePilot diagnostic logs rotate at approximately 5 MiB per file and retain five rotated files plus the active file. Retention is size-based, not a fixed number of days; local configuration can change it. Logs normally live in `~/.profilepilot/logs/`.
- The agent host, visited services, and support platform control retention of the information they receive. Removing local data does not delete those copies.

## Your controls and support

Choose the target profile/device and limit tasks to the intended pages. Pause, stop, or take over through ProfilePilot; revoke browser extension site access or Android permissions; disconnect pairing; remove the plugin; and delete saved artifacts when no longer needed. Stopping control does not undo an action already submitted to a website or device.

For help or privacy questions, open an issue at [ProfilePilot support](https://github.com/ffffhx/profilepilot/issues). Issues are public: describe the issue without credentials, full browsing history, device screenshots, or unredacted logs. Ask for an appropriate private reporting route before sharing sensitive details.
