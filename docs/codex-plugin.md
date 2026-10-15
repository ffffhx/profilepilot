# ProfilePilot plugin distribution

The public plugin is a desktop-only, skills-only integration with the existing `ppilot` CLI. It includes setup guidance, browser/Android workflows, and the product icon. It does not bundle the Electron application, Android APK, local preferences, credentials, or an MCP server.

## Source and packaging

- `plugins/profilepilot/plugin.json`: portable Agent Plugins manifest and OpenAI listing metadata.
- `plugins/profilepilot/skills/profilepilot/SKILL.md`: public integration entrypoint.
- `plugins/profilepilot/skills/setup/SKILL.md`: onboarding skill.
- `.agents/plugins/marketplace.json`: Git/repository marketplace catalog.
- `skills/profilepilot/references/`: canonical command references shared with the desktop app.

The packaging script copies only named references, the existing logo, and the MIT license into the plugin directory. Commit those generated copies so Git marketplace users can install without building the desktop app. Never copy `local/` or a whole installed skill directory. Edit shared references at their canonical paths, then run:

```sh
npm run plugin:sync
npm run plugin:check
npm run plugin:pack
```

`plugin:check` verifies generated files, the explicit file inventory, local references, and a ZIP extraction round trip. It rejects symlinks and unlisted files. `plugin:pack` requires synchronized sources and writes `dist/plugins/profilepilot-VERSION.zip` and its SHA-256 file. ZIP entries use normalized line endings, fixed timestamps, and no platform-specific shell archiver. Bump the plugin manifest version for published updates; it is independent of the desktop app's version.

The manual `verify-plugin.yml` workflow repeats packaging and isolated Codex installation on Windows and macOS. It uploads test artifacts and does not publish a desktop/Android release or deploy the website.

## Install from the repository marketplace

After the catalog is available on GitHub:

```sh
codex plugin marketplace add ffffhx/profilepilot
codex plugin add profilepilot@profilepilot
```

For a local checkout, use `codex plugin marketplace add /absolute/path/to/profilepilot`. Open a new conversation to discover the installed skills. Run setup and verify the actual local CLI and selected target. Installation of the plugin alone does not install its desktop prerequisites.

The marketplace is a separate distribution channel from the OpenAI public directory. Adding it does not mean that OpenAI has reviewed or listed the plugin.

## Submit to the public directory

Use [OpenAI Plugins](https://platform.openai.com/plugins), a verified individual/business identity, and the generated ZIP. Follow [submission requirements](https://developers.openai.com/plugins/deploy/submission) and [desktop-only requirements](https://developers.openai.com/plugins/deploy/desktop-only). Preserve `requires_local_executor: true`. Resolve the actual portal findings, then submit for review; publish only after approval. The portal's verified developer identity must match the publisher shown in the listing.

The public [privacy notice](profilepilot-plugin-privacy.md) and support links must be accessible before submission. Skills-only packages do not require a remote MCP server. Local MCP submissions have separate partner eligibility; do not remove the desktop flag or add a placeholder server to bypass eligibility checks.

## Validation to record for each release

Record actual results, including unavailable platforms or prerequisites; do not infer runtime success from ZIP validation.

| Scenario | Expected result |
| --- | --- |
| Install into an isolated Codex configuration | Catalog resolves the intended package and lists its bundled skills |
| Missing CLI or unsupported environment | Setup identifies the missing prerequisite without claiming a connection |
| Windows PowerShell and macOS | Correct CLI discovery, paths, UTF-8 argument files, and matching architecture guidance |
| Connected Chrome profile | Observe an authorized test tab and complete the owned session |
| Paused/occupied browser | Report ownership and wait; do not resume, replace, or change transport |
| Android device selection | List actual devices; ask if ambiguous; permissions remain with the user |
| Signed-in page | Read only task-relevant content; do not request secrets in chat |
| Repeated package build | Same content yields the same archive checksum |

Official listing status must be verified in the publishing portal. A successful local installation, repository push, or ZIP upload is not proof of approval or publication.
