import { execFileAsync } from "../fs-util";
import { toAppleScriptString } from "../chrome-launch";
import { runWindowsPowerShell } from "../windows-platform";

export type OnboardingChromePage = "extensions" | "debugging";
const pages: Record<OnboardingChromePage, string> = {
  extensions: "chrome://extensions/",
  debugging: "chrome://inspect/#remote-debugging"
};

// Chrome filters these internal URLs out of command-line launches on both
// Windows and macOS. Create a native Chrome tab next to the invitation, then
// open the internal URL there. Never edit the invitation or load a handoff page.
export async function openNativeOnboardingTab(invitation: string | undefined, page: OnboardingChromePage): Promise<void> {
  const url = pages[page];
  if (!url || !invitation || !/^http:\/\/127\.0\.0\.1:\d+\/profilepilot-connect\/[a-f0-9]{48}$/.test(invitation)) {
    throw new Error("连接页面无效，请返回 ProfilePilot 重新连接。");
  }
  try {
    if (process.platform === "win32") {
      const result = await runWindowsPowerShell(windowsOnboardingTabScript(invitation, url), { timeout: 12000 });
      if (result.trim() !== "opened") throw new Error("Chrome did not confirm the tab");
    } else if (process.platform === "darwin") {
      await execFileAsync("osascript", ["-e", macOnboardingTabScript(invitation, url)], { timeout: 10000 });
    } else {
      throw new Error("Unsupported platform");
    }
  } catch (cause) {
    throw new Error(`未能确认扩展设置页已打开。请在当前新标签页的地址栏输入 ${url}。`, { cause });
  }
}

function macOnboardingTabScript(invitation: string, url: string): string {
  return `tell application ${toAppleScriptString(process.env.CHROME_APP_NAME || "Google Chrome")}
  repeat with targetWindow in windows
    repeat with sourceIndex from 1 to count of tabs of targetWindow
      if URL of tab sourceIndex of targetWindow is ${toAppleScriptString(invitation)} then
        tell targetWindow
          make new tab at after tab sourceIndex with properties {URL:${toAppleScriptString(url)}}
          set active tab index to sourceIndex + 1
          set index to 1
        end tell
        activate
        return
      end if
    end repeat
  end repeat
  error "Connection tab not found"
end tell`;
}

function windowsOnboardingTabScript(invitation: string, url: string): string {
  // Values are restricted above to literal loopback invitations and fixed URLs.
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OnboardingChromeWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
$invitation = '${invitation}'
$targetUrl = '${url}'
$window = [OnboardingChromeWindow]::GetForegroundWindow()
$chromePid = [uint32]0
[void][OnboardingChromeWindow]::GetWindowThreadProcessId($window, [ref]$chromePid)
$foregroundProcess = (Get-Process -Id $chromePid).ProcessName
if ($foregroundProcess -ne 'chrome') { throw ('Chrome is not foreground: ' + $foregroundProcess) }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
$condition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit)
function Find-Address([string]$expected) {
  $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  foreach ($edit in $edits) {
    $pattern = $null
    if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      $value = $pattern.Current.Value.TrimEnd('/')
      if ($value -ceq $expected.TrimEnd('/') -or ('http://' + $value) -ceq $expected.TrimEnd('/')) { return $edit }
    }
  }
  return $null
}
function Assert-Foreground {
  if ([OnboardingChromeWindow]::GetForegroundWindow() -ne $window) { throw 'Chrome focus changed' }
}
$tabCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TabItem)
function Read-Tabs {
  foreach ($tab in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCondition)) {
    $pattern = $null
    if ($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
      [pscustomobject]@{ Id = ($tab.GetRuntimeId() -join ','); Selected = $pattern.Current.IsSelected }
    }
  }
}
if ($null -eq (Find-Address $invitation)) { throw 'The foreground tab is not the connection page' }
$before = @(Read-Tabs)
$source = @($before | Where-Object Selected)
if ($source.Count -ne 1) { throw 'Cannot identify the connection tab' }
$sourceId = $source[0].Id
Assert-Foreground
# Create the tab before touching any address bar. This never navigates or edits
# the invitation, even if a later OS operation fails.
[System.Windows.Forms.SendKeys]::SendWait('^t')
$newTab = $null
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Assert-Foreground
  $tabs = @(Read-Tabs)
  $created = @($tabs | Where-Object { $_.Id -notin $before.Id })
  if ($tabs.Count -eq $before.Count + 1 -and $created.Count -eq 1 -and $created[0].Selected) { $newTab = $created[0]; break }
  Start-Sleep -Milliseconds 50
}
if ($null -eq $newTab) { throw 'Chrome did not create a new tab' }
function Assert-NewTab {
  Assert-Foreground
  $current = @(Read-Tabs)
  $selected = @($current | Where-Object Selected)
  if ($current.Count -ne $before.Count + 1 -or $selected.Count -ne 1 -or $selected[0].Id -ne $newTab.Id -or $sourceId -notin $current.Id) { throw 'Chrome tabs changed' }
  return $current
}
# Ctrl+T appends a tab. Move only that newly created tab next to the source.
for ($move = 0; $move -lt $before.Count; $move++) {
  $tabs = @(Assert-NewTab)
  $sourceIndex = [array]::IndexOf($tabs.Id, $sourceId)
  $newIndex = [array]::IndexOf($tabs.Id, $newTab.Id)
  if ($newIndex -eq $sourceIndex + 1) { break }
  if ($newIndex -le $sourceIndex) { throw 'Unexpected new tab position' }
  [System.Windows.Forms.SendKeys]::SendWait('^+{PGUP}')
}
$tabs = @(Assert-NewTab)
if ([array]::IndexOf($tabs.Id, $newTab.Id) -ne [array]::IndexOf($tabs.Id, $sourceId) + 1) { throw 'Chrome did not position the new tab' }
[System.Windows.Forms.SendKeys]::SendWait('^l')
[void](Assert-NewTab)
$address = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($address.Current.ProcessId -ne $chromePid -or $address.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) { throw 'Chrome address bar is not focused' }
# Set the omnibox value directly: typing through SendKeys lets an active IME
# transform ASCII punctuation (for example ':' into a full-width colon).
$address.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($targetUrl)
[void](Assert-NewTab)
# Remove a selected inline history completion (e.g. ?id=...) before submitting.
# Delete is a no-op at the end when Chrome has not added a completion.
[System.Windows.Forms.SendKeys]::SendWait('{DELETE}')
if ($null -eq (Find-Address $targetUrl)) { throw 'Chrome address did not match' }
[void](Assert-NewTab)
# This is already a new tab. Enter commits its URL; Alt+Enter is never needed.
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 100
  Assert-Foreground
  $committed = Find-Address $targetUrl
  if ($null -ne $committed -and -not $committed.Current.HasKeyboardFocus) { 'opened'; return }
}
throw 'Chrome did not confirm the requested address'
`;
}
