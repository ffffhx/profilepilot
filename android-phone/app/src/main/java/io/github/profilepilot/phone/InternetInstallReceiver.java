package io.github.profilepilot.phone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Only an explicit, session-bound PackageInstaller pending intent reaches this receiver. */
public final class InternetInstallReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context context, Intent intent) {
    ControlService service=ControlService.current;
    if (service!=null) service.internetInstallResult(intent);
  }
}
