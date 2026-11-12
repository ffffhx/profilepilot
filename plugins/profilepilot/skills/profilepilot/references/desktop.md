# ppilot desktop: local Windows control

Desktop interaction is a fallback under the routing rule in [SKILL.md](../SKILL.md).
When that rule permits it, use `ppilot desktop` for this computer's native Windows
desktop and application windows, including system dialogs outside page interfaces.
ProfilePilot owns and bundles the native driver. Only the ProfilePilot app and
CLI are required; no ClipRelay, remote connection, MCP, administrator rights or
separately installed service is needed. macOS currently reports unsupported.

Use `ppilot desktop schema action` or `ppilot desktop action --help` for the current command's inputs. The action schema comes from the actual validator, including per-kind fields; runtime ownership and observation checks still apply. `ppilot desktop doctor --window ACTUAL_ID --session TASK` returns current readiness and the next command without claiming or resuming control.

1. Read `ppilot desktop status` and `ppilot desktop windows`. Select the exact
   window from the returned title, process and ID, without changing computers.
2. `ppilot desktop claim --session TASK --window ID` acquires one desktop owner.
   An occupied/paused session cannot be replaced to bypass user control.
   Add `--mode background` for concurrent use with a person working in other
   applications. The mode is fixed for the session, including select/resume and
   driver recovery. Omission retains `interactive` for existing callers.
3. `ppilot desktop observe --session TASK` returns UI Automation controls and a
   version. Use observed refs and supported actions, preferring semantic actions.
   Check `truncated` and `gaps`: provider failures or traversal limits mean the
   tree is incomplete, not that omitted controls do not exist.
4. `ppilot desktop action --session TASK --params-file action.json` accepts e.g.
   `{"version":"observed version","ref":"e1","kind":"invoke"}` or `set_value`
   with `value`. PowerShell and macOS shells must use UTF-8 JSON files/stdin.
5. Every input consumes the observation. By default the action returns a new
   UIA observation after a 500 ms wait; use its version for the next action.
   With `--no-observe`, explicitly reobserve before further input.
   `select --session TASK --window ID` explicitly selects another observed window
   and invalidates old refs; use it for a newly opened native dialog.
6. Finish using `complete --session TASK --require-active`; cancel using `release`.
   Conditional completion preserves a session that has already been paused or
   lost its observer, even if an earlier status read showed active. Do not start
   another task after that refusal. Plain `complete` retains its earlier behavior
   and can end a paused session; `release` remains available for cleanup.

## Background semantic mode

`claim --session TASK --window ID --mode background` permits only `invoke`,
`set_value`, `toggle`, `select`, `expand`, `collapse`, and UIA `scroll`. The native
driver enforces the policy too. Physical clicks (including ref clicks), pointer
movement, drag, wheel, typing, shortcuts, focus and window-state changes are
rejected before dispatch. Taskbar/tray `invoke` is rejected because its route
uses physical input. There is no automatic physical fallback or mode upgrade.
Use `set_value` to replace text, not `type_text`.

Input in other applications does not pause the background session. Foreground
activation of the target process, or keyboard/pointer activity directed to it,
pauses it; another window of the same process is conservatively included. Start
while using another app, and explicitly return control after a target takeover.
Manual takeover/stop, cross-route ownership, helper failure and unknown-result
protections still apply. A background session does not make simultaneous edits
to the same application safe.

The driver never calls a physical fallback, but an application's accessibility
provider can itself open a dialog or activate a window. Detected target
activation pauses control; a dispatched action can already have taken effect.
Inspect its receipt and current state, never replay it or restore the user's
focus automatically. This is a shared-desktop policy, not OS-level isolation.

## Ownership and observation

Desktop admission also checks known browser and Electron ownership by PID
association. An active session remains occupied after user takeover or while its
driver is parked/disconnected. Do not change the desktop task name to bypass it.
`DESKTOP_CONTROL_OCCUPIED` requires inspecting the original control entry;
`DESKTOP_CONTROL_STATE_UNKNOWN` means discovery or ownership could not be
confirmed. Neither grants permission to control the target. Checks run before
claim, selecting a new window, session observations, inputs and resuming a paused session.
They are snapshots, not an atomic reservation against another service claiming
the same process immediately afterward.

Window list rows include sampled `enabled`, `minimized`, and
`ownerNativeHandle`. The latter is the Win32 owner relationship: match it to a
fresh row's `nativeHandle` to help locate an application's owned dialog. An owned
window is not necessarily modal; a disabled parent is a reason to inspect its
other windows, not to bypass the disabled state. These samples neither grant
control nor select a window automatically. A null owner means the query returned
no owner handle; it does not establish application or control ownership.

`doctor [--window ID]` reads the helper, foreground and target integrity levels,
interactive desktop state and foreground activation evidence without claiming
control or renewing a lease. A failed token query is unknown, not proof of UIPI.
With `--window`, it also reports `admission` and its association gaps without
claiming or pausing a session. An unknown diagnosis does not authorize input.
Its input-state evidence reports held keys, pointer capture and unreadable
conditions. These samples do not identify every physical human input.
Desktop control separately requires `status.inputObservation` to reach `ready`
after the shared Windows observer acknowledges the current driver and mode. `arming`
and `pending` do not authorize input. In interactive mode, observed non-injected input or an injected
event that does not match the driver's registered marker pauses control; helper
loss also pauses it. This is not authentication or proof of continuous hardware
coverage: another hook or Windows hook removal can prevent observation, and
injection markers can collide or be copied. Keyboard markers retain 64 bits;
the tested Windows mouse path uses a separately registered 32-bit marker.
Observer startup failures distinguish an existing instance lock (Win32 183),
inaccessible lock (5), and other lock-creation failures. These are diagnostic
errors, not permission to kill another instance, elevate, or resume automatically.
`DESKTOP_FOCUS_REQUIRED` means the required foreground transition was not
confirmed before input. Inspect the diagnostic fields and ask the user to bring
the selected window forward when needed; do not replay an unknown action or
try to solve foreground restrictions by elevating ProfilePilot.

`screenshot --session TASK [--output new-file.jpg] [--image-only]` saves a window
image and returns a fresh version. `--image-only` skips UIA traversal and returns
`elements: []`, `gaps: ["uia_skipped"]`, and `truncated: false`; it does not mean
the window has no controls. Omit the flag when both an image and UIA refs are
needed. Inspect the image before coordinate input. Coordinates are
relative to the window in original physical pixels. With `image.captureRect`,
map image pixels using `x = captureRect.x + pixelX * captureRect.width / image.width`
and the equivalent formula for y. Otherwise scale to `windowWidth/windowHeight`.
Round to integers and keep every point within the selected window. Apply the
same mapping to drag endpoints. Moving/resizing or an overlapping window can
invalidate coordinate input; refresh state instead of using old coordinates.
Check `image.coordinateInputAvailable`. External Chromium compositor captures
report false because their border cropping differs from native input coordinates;
use observed controls or the dedicated browser/Electron route for those windows.
The native WGC source currently also reports false: `candidateCaptureRect` is
diagnostic evidence, never a coordinate authorization. Unsupported WGC APIs may
fall back explicitly; protection, cancellation, timeout or changed geometry must
remain capture failures.
`physicalPixelsAvailable` describes the native coordinate environment; it does
not authorize input by itself. Only `coordinateInputAvailable` qualifies the
image. Mouse input requires a supported physical-pixel environment and a point
on a real monitor; an unsupported display span or changed cursor position stops
the action instead of silently clamping the point onto another window.

Supported action kinds:

| Kind | Parameters and behavior |
| --- | --- |
| `invoke`, `toggle`, `select`, `expand`, `collapse`, `focus` | Use a fresh `ref`; use the actions reported for that control. |
| `restore`, `minimize`, `maximize` | Only the selected window root's fresh `ref` and `version`; requires its reported WindowPattern capability. `restore` requests Normal, including after a maximized window was minimized. |
| `set_value` | `ref` and `value`; replace an editable control's value. |
| `scroll` | `ref`, `horizontal` / `vertical` UIA ScrollAmount values: 0 large decrement, 1 small decrement, 2 no movement, 3 large increment, 4 small increment. Requires the control's scroll pattern. |
| `click`, `double_click` | Start at `ref` or `x` / `y`; `button` is `left`, `right`, or `middle` (default `left`). |
| `move` | Move the pointer to `ref` or `x` / `y` without clicking. |
| `drag` | Start at `ref` or `x` / `y`, then drag to `toX` / `toY`; `button` is `left`, `right`, or `middle` (default `left`). Requires a current coordinate-capable screenshot even when the start uses a ref. |
| `wheel` | Start at `ref` or `x` / `y`; `deltaX` / `deltaY` are integers from -1200 to 1200, with at least one nonzero. 120 is one wheel notch; positive Y scrolls up, positive X scrolls right. |
| `type_text` | `value` is literal text for the focused control, at most 512 UTF-16 units per action; use `press_key` for control characters. |
| `press_key` | `keys`, for example `["CTRL", "A"]`; press a supported key or chord. Duplicate keys, including aliases such as CTRL/CONTROL, are rejected. |

On Windows taskbar and notification-area buttons, `invoke` uses a guarded
primary-button click because the system UIA proxy can synthesize unmarked input.
It can move the pointer and requires a fresh, visible, unobstructed control;
the receipt reports `requestedAction: "invoke"` and `inputRoute: "marked-pointer"`.
Ordinary application controls retain their UIA invocation. Unknown injected
input still pauses control; it is not proof of a human taking over.

Supported keys are A-Z, 0-9, F1-F12, CTRL/CONTROL, ALT, SHIFT, ENTER, TAB,
ESC/ESCAPE, BACKSPACE, DELETE, LEFT, UP, RIGHT, DOWN, HOME, END, PAGEUP,
PAGEDOWN, and SPACE, without case sensitivity. Other key names and duplicate
aliases in the same chord are rejected before dispatch.

Window-state actions report success only after UIA and Win32 placement agree on
the requested state for the same window identity. The root's `state.window`
reports readability, visual state and capabilities; unavailable state is not
permission to use a fallback. Only restoring the enabled, confirmed minimized
root may pass the offscreen check. A result that cannot be confirmed after
dispatch is unknown and pauses control; do not replay or resume automatically.
Window-state success does not establish foreground focus. Read fresh state and
capture again before any later coordinate input.

All coordinate pointer actions require a current screenshot. A text-only
`observe` is sufficient for ref-based pointer actions except `drag`. UIA `scroll`
and pointer `wheel` are separate operations; choose `wheel` for a pane without
a UIA scroll pattern. A drag must stay inside the selected window and uses a
fixed short duration; cross-window drags are not supported. Pointer modifiers,
custom drag durations, arbitrary key holds, and action batches are not exposed
by this interface.

`action --session TASK --params-file action.json` runs exactly one action,
waits 500 ms, and reads fresh UIA state by default, without taking a screenshot.
Use `--no-observe` to opt out; `--observe` remains a compatibility alias. On success,
`result.observation` contains the next version and controls, and
`result.requiresObservation` is false. It is ready for a next semantic action;
get a new screenshot before coordinate input. If the input succeeded but the
following observation failed, the command returns `ok: true`, `executed: true`,
`requiresObservation: true`, `actionOutcome: "completed"`,
`observationStatus: "unavailable"`, and `observationError: {code, message}` inside
`result`. Inspect state and retry the read, never the already executed input.
On success, `observationStatus` is `available`. The short wait does not prove
business completion or capture every transient dialog; use `wait` for known conditions.

An action returning successfully does not prove that an asynchronous save,
dialog or other visible effect has finished. Use a separate read-only wait:

```sh
ppilot desktop wait --session TASK --name "Saved" --role Text --timeout-ms 10000
```

At least one of `--name`, `--role`, `--automation-id`, `--text`, or `--has-action`
is required. All supplied conditions must match the same element exactly.
Password names and text never match. `--text=` matches only a successfully
read empty value and avoids shells that discard empty quoted arguments.
Valued options also accept `--name=VALUE`; use `--text=--literal` for text
starting with two hyphens. Only the first equals sign separates the option from
its value. Boolean flags such as `--json` do not accept `=VALUE`.
Truncated or unavailable predicate fields do not match;
unrelated traversal gaps do not invalidate a complete positive match.
`--has-action` checks a capability actually reported in the element's `actions`,
including `text` for TextPattern; it does not establish visibility, enabled state,
or input permission. `text` is not an input action kind.
The default interval is 250 ms (`--interval-ms`
100–2000) and the default deadline is 10 seconds (`--timeout-ms` 100–20000).
Only completed observations with no match are polled again; provider errors are
returned and actions are never repeated. Success returns `matchedReferences`
and a fresh `observation`. Timeout returns `timedOut: true`, exit 75, and the last
observation if available. That observation is historical evidence: observe again
before input. Every timeout returns `requiresObservation: true`, including
timeouts between completed reads. Input remains blocked with
`DESKTOP_FRESH_OBSERVATION_REQUIRED` until a fresh observation succeeds.
A blocked read is cancelled when the deadline is reached, and any
replacement helper must wait for the previous one to stop. User takeover or
stop cancels the wait without granting control back.

Observed elements include supported mutable state: read-only, toggle, selected
and expanded values. A changed value or state invalidates that control's old
reference. `stateGaps` means the provider could not supply part of the state;
such a reference cannot be used for input. Reobserve and inspect gaps. The
native traversal budget is checked between provider calls, not a guarantee
that every synchronous provider call will return within that time.

Check `truncatedFields` and `textStatus` before treating displayed text as complete.
Display truncation alone does not prevent ref-based input; `stateGaps`, including
`value_evidence`, do. `textSource` identifies Value or TextPattern text; they are
separate sources. For readable Value state, `valueEvidence` records the identity
evidence: `value`, `value_and_text`, or `unconfirmed`. Unconfirmed readable Value
state cannot authorize ref-based input. Reobserving does not remove a fixed
provider or evidence limit.

Displayed text is limited to 4096 UTF-16 units per element and a shared 32768-unit
observation budget. A known Windows Edit Value proxy limit of 2000 characters
triggers separate bounded TextPattern confirmation. Confirmed text of up to
16384 units contributes to identity; at or beyond the 16385-unit probe cap, or
when evidence is missing or inconsistent, the reference is unavailable for input.
This check does not establish completeness for every provider's private limits.

`DESKTOP_READ_INTERRUPTED` describes a failed read that sent no input. Check
control status, then request a fresh observation explicitly; there is no
automatic replay or return of user control. Input failures remain distinct:
inspect the retained receipt and `inputCleanup` diagnostics before continuing.
A queued release acknowledged by Windows does not prove the application has
processed it. A killed driver cannot prove all prior key/button downs were
released; do not attempt to repair this by releasing arbitrary user-held keys.

Native keyboard/pointer actions may activate the selected window and move the
mouse; never promise background input for these actions. Locked desktops and
higher-privilege windows may be unavailable. Password values are omitted.
Physical typing rechecks focus and yields between complete Unicode scalars, but
SendInput acknowledges insertion rather than application processing. Delayed
focus changes can still cause partial input in another control; inspect the
receipt and actual result after interruption. Prefer explicit `set_value` when
a control supports it and replacement is intended (up to 16384 UTF-16 units).
For longer physical text, split it and observe between actions; do not retry a
partially delivered chunk.

A Chromium window first loaded while fully covered can have no rendered content
surface: WGC may return a blank client area even with an advancing frame time.
This does not prove the page is empty or current. Do not treat capture timestamps
as a content-freshness guarantee or activate a window solely to bypass control
preferences. Use the dedicated browser/Electron route when available.

The app's **控制台 → Windows 桌面** lists windows and previews without taking
control. Its control bar offers takeover/return/stop. Check
`status.stopShortcutAvailable`: Ctrl+Alt+Esc is an additional stop mechanism
only when true. If false, use the control bar's stop button.
`handoff` pauses and preserves the task. Only after the user explicitly returns
control may an agent call `resume`; observe again before input. Five minutes of
inactivity ends a session; status polling does not extend the lease. App exit
terminates the helper and session. Do not restart a stopped task automatically.

Exit 75 means reconcile: busy/paused/ended session, changed window, stale
observation, or unknown result. Never replay unknown input. Actions return a
`requestId`; the same `--request-id UUID` and exact parameters retrieve a cached
receipt while it is retained, without input replay. Do not reuse an ID with new
parameters or a different `--observe` choice. A cached receipt's observation is
historical evidence, not a newly captured state. Input may have partially reached
the app before an error; an uncertain input result pauses control. Check the
actual window result and ownership before deciding what to do next. Do not
automatically resume after a timeout or disconnect.

Prefer `receipt --session TASK --request-id UUID` to inspect retained results
without resubmitting action parameters. It returns `pending`, `succeeded`, or
`failed`, including the confirmed result or original error. This works after
the task ends, takes no control and does not renew a lease. Receipts are retained
only in the running App, up to 256 entries. A missing receipt is not evidence
that the action never executed. An action rejected as `DESKTOP_BUSY` before
dispatch is not cached as a permanent failed operation.
