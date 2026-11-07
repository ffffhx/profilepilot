# ppilot phone: iPhone real devices

Read personal `local/phone-control.md` (or the shipped phone template). Use ProfilePilot's desktop app and `ppilot phone` throughout. Select the real USB UDID from `iphone devices`, then use the `iphone-…` device ID returned after connection for ordinary phone commands. Do not substitute an Android serial or a Chrome emulated iPhone.

## First connection

Windows and macOS support automatic USB preparation for iOS 18+. Windows requires Apple's device driver (Apple Devices). The user unlocks the phone, trusts the computer and enables Developer Mode. Never request the user's passcode or Apple password in chat.

```text
ppilot phone iphone setup
ppilot phone iphone doctor
ppilot phone iphone devices
ppilot phone iphone devmode-reveal --udid <discovered-UDID>
ppilot phone iphone prepare-wda
```

`setup` downloads and checks a pinned go-ios build. `prepare-wda` returns an **unsigned** Appium WebDriverAgent IPA. Neither grants phone control. The desktop “添加设备 → iPhone 真机” page exposes the same preparation steps.

On macOS the user can sign/install WebDriverAgent with Xcode. A complete signed IPA can be installed with `iphone install-signed --udid <UDID> --ipa <path>`.

On Windows without a Mac, the user installs the prepared IPA once using Sideloadly and their own Apple ID. Apple authentication stays in Sideloadly. A free-account signature expires and must be renewed. Sideloadly may omit the nested XCTest signature; after its initial install:

```text
ppilot phone iphone signing-setup
ppilot phone iphone sign-sideloadly --udid <UDID>
```

This explicit repair uses `%APPDATA%/Sideloadly/key.pem` and matching `cert-*.pem`, reads the WDA provisioning profile from that USB phone, checks device/bundle/certificate/expiry, then re-signs the full IPA and installs it. It never reads Apple login/session files. Temporary signing materials are deleted afterward. `signing-setup` needs Python 3.11+ and creates an isolated environment. If multiple WDA bundles match, select the user's intended `--bundle-id`; do not choose arbitrarily. Signing repair is currently Windows-only.

```text
ppilot phone iphone usb-start --udid <UDID>
ppilot phone iphone usb-status
```

The background job reports USB checks, tunnel, developer image, runner and readiness. It owns its processes and a loopback-only USB forward. It does not stop another go-ios agent or replace another WDA session. `usb-status` returns `deviceId` once ready. `iphone usb-stop --udid <UDID>` cancels preparation or closes the connection. No input is sent by connection setup.

An already-running WDA can instead be added with `iphone add --endpoint http://127.0.0.1:8100 --name iPhone`. Only explicit loopback or private-LAN IP roots are accepted. WDA itself has no authentication; use USB by default. Saved USB records require explicit reconnection after restarting ProfilePilot.

## Observe and operate

```text
ppilot phone list
ppilot phone start --device <iphone-ID> --mode view --controller <name> --task <task>
ppilot phone action --params-file <UTF-8-JSON-file>
ppilot phone pause --device <iphone-ID>
ppilot phone resume --device <iphone-ID>
ppilot phone stop --device <iphone-ID>
```

Use `--mode control` only within the user's authorized scope. Actions use the returned session ID and generation plus a new UUID request ID:

```json
{"id":"iphone-…","sessionId":"…","generation":1,"requestId":"UUID","action":{"kind":"screenshot"}}
```

Supported: `screenshot`, `snapshot` (WDA JSON accessibility tree), `find`, `tap`, `swipe`, `text`, `click`, `fill`, `scroll`, and `key` with `home`. Screenshot coordinates are physical pixels; ProfilePilot converts to iOS logical points. Refresh the screenshot before coordinate input and after each input. A rotated/stale frame is rejected. Selector fields: `resourceId`/`description` map to accessibility name, `text` to label, `className` to type, and `enabled`; input requires one exact visible match.

Pause/stop are host-side. iPhone has no ProfilePilot Android overlay, hardware-input takeover detection, Android back/recents keys, ADB/APK access or Android companion permissions. A user who wants to operate the phone should pause from the computer first. Do not use Android-only wrapper/flow/follow/camera commands for iPhone. Current preview uses consecutive PNG frames, not a video stream.

Never resume after user takeover without explicit return of control. A disconnect, generation mismatch, identity change or uncertain input is final for that action; observe state and do not retry or switch routes. A restarted desktop does not restore authority. Finish with `phone stop`; use `phone disconnect`/`iphone usb-stop` to stop the USB connection too.

Implementation references: [Appium non-macOS hosts](https://appium.github.io/appium-xcuitest-driver/latest/guides/non-macos-hosts/), [go-ios](https://github.com/danielpaulus/go-ios), [Appium WebDriverAgent](https://github.com/appium/WebDriverAgent), [Sideloadly](https://sideloadly.io/), [SideTap Windows signing explanation](https://github.com/ucsandman/SideTap/blob/main/src/phone_harness/signing.py).

Validation boundary: protocol fixtures and Windows desktop preparation are testable without a phone. Actual iPhone signing, USB startup and input require the user's connected device; macOS hardware behavior requires a Mac. Do not describe fixture results as hardware verification.
