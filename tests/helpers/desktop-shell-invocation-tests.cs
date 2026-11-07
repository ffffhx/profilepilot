using System;
using ProfilePilot.Desktop;

public static class DesktopShellInvocationTests {
    static void Check(bool condition) { if(!condition)throw new Exception("Unexpected shell invocation route"); }
    public static int Main() {
        foreach(string root in new[]{"Shell_TrayWnd","Shell_SecondaryTrayWnd","NotifyIconOverflowWindow"}) {
            Check(DesktopShellInvocation.UsesPointer(root,"Button",true));
            Check(!DesktopShellInvocation.UsesPointer(root,"Button",false));
            foreach(string role in new[]{"MenuItem","Pane","ToolBar","CheckBox","",null})
                Check(!DesktopShellInvocation.UsesPointer(root,role,true));
        }
        foreach(string root in new[]{"Button","Chrome_WidgetWin_1","WindowsForms10.Window","Shell_TrayWndSuffix","shell_traywnd","",null})
            Check(!DesktopShellInvocation.UsesPointer(root,"Button",true));
        Check(DesktopShellInvocation.PrimaryButton(false)=="left");
        Check(DesktopShellInvocation.PrimaryButton(true)=="right");
        Console.WriteLine("Shell button routing, ordinary provider isolation and swapped primary button passed.");
        return 0;
    }
}
