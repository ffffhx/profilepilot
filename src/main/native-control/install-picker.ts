// JXA uses Chrome's scripting dictionary to bind the extensions tab to the
// exact invitation window. System Events only fills the native folder picker;
// Chrome's final Choose button and ProfilePilot's pairing approval stay visible.
export const macInstallPicker = String.raw`
function run(argv) {
  const [invitation, folder] = argv;
  const chrome = Application("com.google.Chrome");
  const events = Application("System Events");
  const process = events.applicationProcesses.byName("Google Chrome");
  function until(read, seconds) {
    const end = Date.now() + seconds * 1000;
    do {
      const value = read();
      if (value) return value;
      delay(0.15);
    } while (Date.now() < end);
    throw Error("Chrome setup control unavailable");
  }
  const window = until(() => chrome.windows().find(w => w.tabs().some(t => t.url() === invitation)), 5);
  if (chrome.windows[0].id() !== window.id() || window.activeTab.url() !== invitation) throw Error("Invitation lost focus");
  const windowId = window.id();
  const tab = chrome.Tab({url: "chrome://extensions/"});
  window.tabs.push(tab);
  const tabIndex = window.tabs.length;
  window.activeTabIndex = tabIndex;
  const tabId = window.tabs[tabIndex - 1].id();
  function target() {
    const front = chrome.windows[0];
    if (!process.frontmost() || front.id() !== windowId || front.activeTab.id() !== tabId ||
        front.activeTab.url() !== "chrome://extensions/") throw Error("Target changed");
    return process.windows[0];
  }
  function webControl(labels, roles) {
    return target().entireContents().find(item =>
      roles.includes(item.role()) && (labels.includes(item.name()) || labels.includes(item.description())));
  }
  const loadLabels = ["Load unpacked", "加载未打包的扩展程序", "加载已解压的扩展程序", "載入未封裝項目"];
  const load = until(() => {
    const button = webControl(loadLabels, ["AXButton"]);
    if (button && button.enabled()) return button;
    // Developer mode is a user-controlled Chrome setting. The button will
    // appear when the user enables it on the page.
    return null;
  }, 8);
  target();
  load.actions.byName("AXPress").perform();
  function identifier(item) {
    const attr = item.attributes.byName("AXIdentifier");
    return attr.exists() ? attr.value() : "";
  }
  function panels() {
    const front = target();
    return [front].concat(front.sheets());
  }
  function panel() { return panels().find(item => identifier(item) === "open-panel"); }
  until(panel, 3);
  events.keystroke("g", {using:["command down","shift down"]});
  const field = until(() => {
    for (const container of panels()) {
      if (!["open-panel", "GoToWindow"].includes(identifier(container))) continue;
      const input = container.entireContents().find(item => item.role() === "AXTextField" &&
        identifier(item) === "PathTextField" && item.focused());
      if (input) return input;
    }
  }, 3);
  field.value = folder;
  target();
  if (field.value() !== folder || !field.focused()) throw Error("Path field changed");
  events.keyCode(36);
}
`;
