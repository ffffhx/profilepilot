using System;

namespace ProfilePilot.Desktop {
    // Windows' legacy shell UIA proxies can synthesize unmarked input from
    // InvokePattern (including SetFocus's keyboard fallback). Use our existing
    // guarded pointer delivery for these observed shell buttons instead. Never
    // exempt arbitrary injected input, and never retry a dispatched UIA call.
    public static class DesktopShellInvocation {
        public static bool UsesPointer(string rootClass,string role,bool invokeAvailable) {
            return invokeAvailable && role=="Button" &&
                (String.Equals(rootClass,"Shell_TrayWnd",StringComparison.Ordinal) ||
                 String.Equals(rootClass,"Shell_SecondaryTrayWnd",StringComparison.Ordinal) ||
                 String.Equals(rootClass,"NotifyIconOverflowWindow",StringComparison.Ordinal));
        }
        public static string PrimaryButton(bool swapped) { return swapped?"right":"left"; }
    }
}
