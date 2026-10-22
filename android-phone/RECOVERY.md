# Android automatic recovery

The phone's **自动恢复** setting is opt-in. It makes the paired connection service
and user-enabled status synchronization eligible for Android sticky restarts and
post-boot / package-replacement startup. No session, generation, receipt or input
is persisted or replayed. A new process creates a new idle SessionState. Explicit
pause/stop of a session still applies; forgetting the computer disables recovery.

Advanced recovery is a separate opt-in and requires an explicitly granted
`android.permission.WRITE_SECURE_SETTINGS`. No runtime permission dialog can grant
it. On an authorized debugging computer the grant is `pm grant <applicationId>
android.permission.WRITE_SECURE_SETTINGS`; revoke with `pm revoke`. The development
application ID is `io.github.profilepilot.phone.debug`. Granting this permission
does not enable either recovery option or authorize a control session.

* Accessibility: wait 20 seconds for a service that remains in the enabled list
  but is not running. Briefly remove only our component and restore it after 500 ms
  if the list has not changed. Journal this owned edit for at most 10 seconds so a
  service restart can roll it back. Concurrent edits or expired transactions are
  not overwritten. Already-disabled permissions are not enabled.
* Wireless debugging: require that this process observed debugging enabled, then
  a Wi-Fi network loss, then a connected network stable for 5 seconds. The recovery
  window expires after 5 minutes. Retry at most 3 times with 15 / 60 second delays;
  do not replay recovery intent across process restarts. Stable-network OFF disarms
  recovery. Android does not identify who changed a setting: manual OFF coinciding
  with network loss cannot be distinguished, so turn off automatic recovery too
  when intentionally disabling debugging during an outage. New-network trust
  confirmation remains Android's responsibility and is never accepted by the app.
* Both actions have a persisted limit of 3 attempts per 30 minutes. No wake locks,
  exact alarms, root, automatic permission prompts or global battery exemptions.
  Polling runs only with advanced recovery in the existing foreground service.

Force-stop, revoked debugging authorization and vendor background restrictions
can still require the user to open the app. If recovery is disabled, boot/update
receivers do nothing and services use START_NOT_STICKY. There is no Windows/macOS
specific command path in the phone implementation; existing desktop discovery
continues to identify the same hardware and does not resume control.

Validation: `npm run build:phone` includes Android unit tests and lint. Policy tests
cover manual OFF, missing authorization, unknown settings, settling, retry budgets,
process restart, clock rollback and concurrent accessibility list changes. On-device
validation must also check UI opt-in, permission status and inactive old sessions
after service recovery. Do not use an active control session to kill its own service
or repeatedly toggle live wireless debugging as an unattended test.
