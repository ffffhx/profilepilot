// macOS Native Desktop Control Driver for ProfilePilot.
// Implements the exact stdin/stdout JSON-line protocol shared with DesktopWorker.
// Semantic background actions use Accessibility APIs without cursor movement or focus changes.
// Interactive pointer/keyboard actions use CGEvent tagged with --input-marker.

import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif

private let maxResponseBytes = 3584 * 1024
private let maxErrorResponseBytes = 16 * 1024
private let maxRequestBytes = 65536

private final class AtomicCancelFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }
    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }
}

private struct AutomationFault: Error {
    let code: String
    let cause: String?
    let diagnostics: [String: Any]?
    init(_ code: String, cause: String? = nil, diagnostics: [String: Any]? = nil) {
        self.code = code
        self.cause = cause
        self.diagnostics = diagnostics
    }
}

private enum ProtocolJson {
    static func require(_ condition: Bool, _ code: String = "DESKTOP_BAD_REQUEST", cause: String? = nil) throws {
        if !condition { throw AutomationFault(code, cause: cause) }
    }

    static func sha256Hex(_ text: String) -> String {
        let digest = SHA256.hash(data: Data(text.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func text(_ map: [String: Any], _ key: String, fallback: String = "") throws -> String {
        guard let raw = map[key] else { return fallback }
        guard let str = raw as? String else { throw AutomationFault("DESKTOP_BAD_REQUEST") }
        return str
    }

    static func number(_ map: [String: Any], _ key: String, fallback: Int = 0) throws -> Int {
        guard let raw = map[key] else { return fallback }
        if let intVal = raw as? Int { return intVal }
        if let num = raw as? NSNumber, CFGetTypeID(num) != CFBooleanGetTypeID() {
            let doubleVal = num.doubleValue
            if doubleVal.isFinite && doubleVal.rounded() == doubleVal && doubleVal >= Double(Int.min) && doubleVal <= Double(Int.max) {
                return Int(doubleVal)
            }
        }
        throw AutomationFault("DESKTOP_BAD_REQUEST")
    }

    static func flag(_ map: [String: Any], _ key: String, fallback: Bool = false) throws -> Bool {
        guard let raw = map[key] else { return fallback }
        if let b = raw as? Bool { return b }
        if let num = raw as? NSNumber, CFGetTypeID(num) == CFBooleanGetTypeID() { return num.boolValue }
        throw AutomationFault("DESKTOP_BAD_REQUEST")
    }

    static func requireFields(_ map: [String: Any], _ allowedCsv: String) throws {
        let allowed = Set(allowedCsv.split(separator: ",").map(String.init))
        for key in map.keys where !allowed.contains(key) {
            throw AutomationFault("DESKTOP_BAD_REQUEST")
        }
    }

    private static func replyId(_ id: String) -> String {
        id.count <= 128 ? id : ""
    }

    private static func validCode(_ code: String) -> String? {
        guard code.count <= 88, code.hasPrefix("DESKTOP_") else { return nil }
        let suffix = code.dropFirst(8)
        guard !suffix.isEmpty else { return nil }
        for scalar in suffix.unicodeScalars {
            let v = scalar.value
            let ok = (v >= 65 && v <= 90) || (v >= 48 && v <= 57) || v == 95
            if !ok { return nil }
        }
        return code
    }

    private static func validCause(_ cause: String?) -> String? {
        guard let cause = cause, !cause.isEmpty, cause.count <= 128 else { return nil }
        for scalar in cause.unicodeScalars {
            let v = scalar.value
            let ok = (v >= 65 && v <= 90) || (v >= 97 && v <= 122) || (v >= 48 && v <= 57) || v == 95 || v == 46 || v == 58 || v == 45
            if !ok { return nil }
        }
        return cause
    }

    private static func serializeBounded(_ object: [String: Any], maxBytes: Int) -> (line: String?, tooLarge: Bool, bytes: Int) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: []),
              let str = String(data: data, encoding: .utf8),
              !str.contains("\n"), !str.contains("\r") else {
            return (nil, false, 0)
        }
        let total = data.count + 1
        if total > maxBytes {
            return (nil, true, total)
        }
        return (str, false, total)
    }

    static func successReply(id: String, operation: String, result: Any) -> String {
        let payload: [String: Any] = ["id": replyId(id), "ok": true, "result": result]
        let encoded = serializeBounded(payload, maxBytes: maxResponseBytes)
        if let line = encoded.line { return line }
        let code = operation == "window.action" || operation == "action"
            ? "DESKTOP_OUTCOME_UNKNOWN"
            : encoded.tooLarge ? "DESKTOP_RESPONSE_TOO_LARGE" : "DESKTOP_RESPONSE_SERIALIZATION_FAILED"
        let cause = encoded.tooLarge ? "UTF8_RESPONSE_LIMIT" : "RESPONSE_SERIALIZATION_FAILED"
        return smallFailure(id: id, code: code, cause: cause, diagnostics: [
            "response": ["limitBytes": maxResponseBytes, "observedBytes": encoded.bytes]
        ])
    }

    static func errorReply(id: String, operation: String, error: Error) -> String {
        let fault = error as? AutomationFault
        let fallbackCode = (operation == "window.action" || operation == "action") ? "DESKTOP_OUTCOME_UNKNOWN" : "DESKTOP_PROVIDER_FAILED"
        let code = (fault.flatMap { validCode($0.code) }) ?? fallbackCode
        let cause = validCause(fault?.cause)
        var payload: [String: Any] = ["id": replyId(id), "ok": false, "code": code]
        if let cause = cause { payload["cause"] = cause } else { payload["cause"] = NSNull() }
        if let diagnostics = fault?.diagnostics { payload["diagnostics"] = diagnostics } else { payload["diagnostics"] = NSNull() }
        let encoded = serializeBounded(payload, maxBytes: maxErrorResponseBytes)
        if let line = encoded.line { return line }
        return smallFailure(id: id, code: code, cause: cause, diagnostics: [
            "omitted": true,
            "reason": encoded.tooLarge ? "ERROR_RESPONSE_TOO_LARGE" : "ERROR_RESPONSE_SERIALIZATION_FAILED",
            "limitBytes": maxErrorResponseBytes
        ])
    }

    private static func smallFailure(id: String, code: String, cause: String?, diagnostics: [String: Any]?) -> String {
        var payload: [String: Any] = ["id": replyId(id), "ok": false, "code": code]
        payload["cause"] = cause ?? NSNull()
        payload["diagnostics"] = diagnostics ?? NSNull()
        if let line = serializeBounded(payload, maxBytes: maxErrorResponseBytes).line {
            return line
        }
        return "{\"id\":\"\(replyId(id))\",\"ok\":false,\"code\":\"\(code)\",\"cause\":null,\"diagnostics\":null}"
    }
}

// Dynamic lookup for CGWindowListCreateImage so compilation succeeds cleanly across
// macOS 12..15+ SDKs without deprecation errors, while ScreenCaptureKit is preferred on macOS 14+.
private typealias CGWindowListCreateImageFn = @convention(c) (
    CGRect, CGWindowListOption, CGWindowID, CGWindowImageOption
) -> Unmanaged<CGImage>?

private let cgWindowListCreateImageFn: CGWindowListCreateImageFn? = {
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return nil }
    return unsafeBitCast(sym, to: CGWindowListCreateImageFn.self)
}()

private typealias AXUIElementGetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
private let axGetWindowFn: AXUIElementGetWindowFn? = {
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
    return unsafeBitCast(sym, to: AXUIElementGetWindowFn.self)
}()

private final class MacDesktopDriver {
    struct TargetWindow {
        let id: String
        let windowNumber: CGWindowID
        let pid: pid_t
        let launchTicks: Int64
        let processName: String
        let bundleId: String
        let title: String
        let bounds: CGRect
        let isMinimized: Bool
    }

    struct StoredElement {
        let axElement: AXUIElement
        let fingerprint: String
        let role: String
        let actions: [String]
        let bounds: CGRect?
        let isRootWindow: Bool
    }

    private let inputMarker: UInt64
    private let cancelFlag: AtomicCancelFlag
    private var targets: [String: TargetWindow] = [:]
    private var elements: [String: StoredElement] = [:]
    private var selected: TargetWindow?
    private var selectedId: String = ""
    private var version: String = ""
    private var observedAtNs: UInt64 = 0
    private var imageReady: Bool = false
    private var imageBounds: CGRect = .zero
    private var lastImageWidth: Int = 0
    private var lastImageHeight: Int = 0
    private var lastCaptureRect: CGRect = .zero
    private var backgroundTarget: TargetWindow?
    private var backgroundWindowId: String = ""

    private static let backgroundActions: Set<String> = [
        "invoke", "set_value", "toggle", "select", "expand", "collapse", "scroll"
    ]

    init(inputMarker: UInt64, cancelFlag: AtomicCancelFlag) {
        self.inputMarker = inputMarker
        self.cancelFlag = cancelFlag
    }

    private func checkControl() throws {
        try ProtocolJson.require(!cancelFlag.isCancelled, "DESKTOP_USER_STOPPED")
        try ProtocolJson.require(isInteractiveSession(), "DESKTOP_DESKTOP_LOCKED")
        if let bg = backgroundTarget {
            try ProtocolJson.require(isWindowValid(bg), "DESKTOP_WINDOW_CHANGED")
        }
    }

    private func isInteractiveSession() -> Bool {
        guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
        if let locked = dict["CGSSessionScreenIsLocked"] as? Bool, locked { return false }
        if let onConsole = dict[kCGSessionOnConsoleKey as String] as? Bool, !onConsole { return false }
        return true
    }

    private func appLaunchTicks(_ app: NSRunningApplication?, pid: pid_t) -> Int64 {
        if let launchDate = app?.launchDate {
            return Int64(launchDate.timeIntervalSince1970 * 1000.0)
        }
        return Int64(pid)
    }

    private func currentWindowBounds(_ windowNumber: CGWindowID, expectedPid: pid_t) -> CGRect? {
        guard let infoList = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowNumber) as? [[String: Any]],
              let info = infoList.first,
              let ownerPid = info[kCGWindowOwnerPID as String] as? pid_t,
              ownerPid == expectedPid,
              let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: boundsDict),
              rect.width > 0, rect.height > 0 else {
            return nil
        }
        return rect
    }

    private func isWindowValid(_ target: TargetWindow) -> Bool {
        guard currentWindowBounds(target.windowNumber, expectedPid: target.pid) != nil else { return false }
        let app = NSRunningApplication(processIdentifier: target.pid)
        if let app = app, app.isTerminated { return false }
        return appLaunchTicks(app, pid: target.pid) == target.launchTicks
    }

    private var hasFreshObservation: Bool {
        guard selected != nil, observedAtNs > 0 else { return false }
        let elapsedMs = (DispatchTime.now().uptimeNanoseconds - observedAtNs) / 1_000_000
        return elapsedMs < 30_000
    }

    func handle(operation: String, params: [String: Any]) throws -> Any {
        if operation == "diagnostics" {
            try ProtocolJson.require(!cancelFlag.isCancelled, "DESKTOP_USER_STOPPED")
            try ProtocolJson.requireFields(params, "windowId")
            let id = try ProtocolJson.text(params, "windowId")
            var targetDict: [String: Any]? = nil
            if !id.isEmpty {
                guard let target = targets[id], isWindowValid(target) else {
                    throw AutomationFault("DESKTOP_WINDOW_CHANGED")
                }
                targetDict = [
                    "windowId": id,
                    "hwnd": String(target.windowNumber),
                    "pid": target.pid,
                    "className": target.bundleId,
                    "visible": true,
                    "minimized": target.isMinimized,
                    "bounds": [Int(target.bounds.origin.x), Int(target.bounds.origin.y), Int(target.bounds.width), Int(target.bounds.height)]
                ]
            }
            var result: [String: Any] = [
                "platform": "darwin",
                "accessibilityTrusted": AXIsProcessTrusted(),
                "screenCaptureTrusted": CGPreflightScreenCaptureAccess(),
                "interactiveDesktop": isInteractiveSession(),
                "integrityCompatible": AXIsProcessTrusted(),
                "coordinates": ["physicalPixelsAvailable": true, "maximumVirtualSpan": 32768]
            ]
            if let targetDict = targetDict { result["target"] = targetDict }
            return result
        }

        try checkControl()

        switch operation {
        case "windows":
            try ProtocolJson.requireFields(params, "")
            return try enumerateWindows()
        case "control.background":
            try ProtocolJson.requireFields(params, "windowId")
            let id = try ProtocolJson.text(params, "windowId")
            guard let target = targets[id], isWindowValid(target) else {
                throw AutomationFault("DESKTOP_WINDOW_CHANGED")
            }
            try ProtocolJson.require(backgroundTarget == nil || backgroundWindowId == id, "DESKTOP_MODE_CONFLICT")
            backgroundTarget = target
            backgroundWindowId = id
            version = ""
            imageReady = false
            return [
                "mode": "background",
                "backgroundTarget": [
                    "pid": target.pid,
                    "window": String(target.windowNumber)
                ]
            ]
        case "window.observe", "window.screenshot", "observe":
            return try observeWindow(params, forceScreenshot: operation == "window.screenshot")
        case "window.action", "action":
            return try performAction(params)
        default:
            throw AutomationFault("DESKTOP_BAD_REQUEST")
        }
    }

    private func enumerateWindows() throws -> [String: Any] {
        targets.removeAll()
        var list: [[String: Any]] = []
        var gaps = Set<String>()

        let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
        let runningByPid: [pid_t: NSRunningApplication] = Dictionary(
            uniqueKeysWithValues: NSWorkspace.shared.runningApplications.map { ($0.processIdentifier, $0) }
        )

        guard let rawList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return ["windows": [], "truncated": true, "gaps": ["window_enumeration_failed"]]
        }

        var foregroundMatchedForPid = Set<pid_t>()
        for info in rawList {
            if list.count >= 256 {
                gaps.insert("window_limit")
                break
            }
            if cancelFlag.isCancelled {
                gaps.insert("cancelled")
                break
            }
            let layer = (info[kCGWindowLayer as String] as? Int) ?? 0
            if layer != 0 { continue }
            let alpha = (info[kCGWindowAlpha as String] as? Double) ?? 1.0
            if alpha <= 0.01 { continue }
            guard let pid = info[kCGWindowOwnerPID as String] as? pid_t, pid > 0,
                  let windowNumber = info[kCGWindowNumber as String] as? UInt32, windowNumber > 0,
                  let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict),
                  bounds.width >= 2, bounds.height >= 2 else {
                continue
            }

            let app = runningByPid[pid] ?? NSRunningApplication(processIdentifier: pid)
            if let app = app, app.activationPolicy == .prohibited { continue }
            let ownerName = (info[kCGWindowOwnerName as String] as? String) ?? ""
            let processName = app?.localizedName ?? (ownerName.isEmpty ? "pid-\(pid)" : ownerName)
            let bundleId = app?.bundleIdentifier ?? (ownerName.isEmpty ? "macos.window" : ownerName)
            let windowTitle = (info[kCGWindowName as String] as? String) ?? ""
            let effectiveTitle = windowTitle.isEmpty ? processName : String(windowTitle.prefix(512))
            if windowTitle.count > 512 { gaps.insert("window_title_limit") }

            let ticks = appLaunchTicks(app, pid: pid)
            let id = String(ProtocolJson.sha256Hex("\(windowNumber):\(pid):\(ticks)").prefix(32))
            let isForeground = (pid == frontmostPid) && foregroundMatchedForPid.insert(pid).inserted
            let isMinimized = app?.isHidden ?? false

            let target = TargetWindow(
                id: id,
                windowNumber: windowNumber,
                pid: pid,
                launchTicks: ticks,
                processName: processName,
                bundleId: bundleId,
                title: effectiveTitle,
                bounds: bounds,
                isMinimized: isMinimized
            )
            targets[id] = target

            list.append([
                "id": id,
                "pid": Int(pid),
                "process": processName,
                "processName": processName,
                "title": effectiveTitle,
                "className": bundleId,
                "nativeHandle": String(windowNumber),
                "enabled": true,
                "minimized": isMinimized,
                "isMinimized": isMinimized,
                "isForeground": isForeground,
                "ownerNativeHandle": NSNull(),
                "bounds": [
                    "x": Int(bounds.origin.x.rounded()),
                    "y": Int(bounds.origin.y.rounded()),
                    "width": Int(bounds.size.width.rounded()),
                    "height": Int(bounds.size.height.rounded())
                ]
            ])
        }

        try checkControl()
        return [
            "windows": list,
            "truncated": !gaps.isEmpty,
            "gaps": gaps.sorted()
        ]
    }

    // MARK: - AX Inspection & Pruning

    private func axAttribute(_ element: AXUIElement, _ attr: String) -> AnyObject? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
        return err == .success ? value : nil
    }

    private func axBool(_ element: AXUIElement, _ attr: String, default fallback: Bool = false) -> Bool {
        if let val = axAttribute(element, attr) as? Bool { return val }
        if let num = axAttribute(element, attr) as? NSNumber { return num.boolValue }
        return fallback
    }

    private func axString(_ element: AXUIElement, _ attr: String) -> String? {
        if let str = axAttribute(element, attr) as? String { return str }
        if let attrStr = axAttribute(element, attr) as? NSAttributedString { return attrStr.string }
        return nil
    }

    private func axBounds(_ element: AXUIElement) -> CGRect? {
        guard let posVal = axAttribute(element, kAXPositionAttribute as String),
              let sizeVal = axAttribute(element, kAXSizeAttribute as String),
              CFGetTypeID(posVal) == AXValueGetTypeID(),
              CFGetTypeID(sizeVal) == AXValueGetTypeID() else {
            return nil
        }
        var pt = CGPoint.zero
        var sz = CGSize.zero
        guard AXValueGetValue(posVal as! AXValue, .cgPoint, &pt),
              AXValueGetValue(sizeVal as! AXValue, .cgSize, &sz),
              pt.x.isFinite, pt.y.isFinite, sz.width.isFinite, sz.height.isFinite else {
            return nil
        }
        return CGRect(origin: pt, size: sz)
    }

    private func axActions(_ element: AXUIElement) -> Set<String> {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success,
              let list = names as? [String] else {
            return []
        }
        return Set(list)
    }

    private func isAttributeSettable(_ element: AXUIElement, _ attr: String) -> Bool {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, attr as CFString, &settable) == .success else { return false }
        return settable.boolValue
    }

    private func resolveAXWindow(for target: TargetWindow) -> AXUIElement? {
        let appElement = AXUIElementCreateApplication(target.pid)
        AXUIElementSetMessagingTimeout(appElement, 1.5)
        guard let windowsRef = axAttribute(appElement, kAXWindowsAttribute as String) as? [AXUIElement], !windowsRef.isEmpty else {
            return nil
        }
        if let getWin = axGetWindowFn {
            for win in windowsRef {
                var wid: CGWindowID = 0
                if getWin(win, &wid) == .success && wid == target.windowNumber {
                    return win
                }
            }
        }
        var best: AXUIElement?
        var bestScore = Double.infinity
        for win in windowsRef {
            if let rect = axBounds(win) {
                let dist = abs(rect.origin.x - target.bounds.origin.x)
                    + abs(rect.origin.y - target.bounds.origin.y)
                    + abs(rect.width - target.bounds.width)
                    + abs(rect.height - target.bounds.height)
                let titleMatch = (axString(win, kAXTitleAttribute as String) == target.title) ? 0.0 : 50.0
                let score = dist + titleMatch
                if score < bestScore {
                    bestScore = score
                    best = win
                }
            }
        }
        return best ?? windowsRef.first
    }

    private static let layoutContainerRoles: Set<String> = [
        "AXGroup", "AXSplitGroup", "AXLayoutArea", "AXLayoutItem", "AXUnknown", "AXScrollArea", "AXSection"
    ]

    private func normalizeRole(_ axRole: String, subrole: String?) -> String {
        if subrole == "AXSecureTextField" { return "Edit" }
        switch axRole {
        case "AXWindow": return "Window"
        case "AXButton", "AXPopUpButton", "AXMenuButton": return "Button"
        case "AXTextField", "AXTextArea", "AXSearchField": return "Edit"
        case "AXStaticText": return "Text"
        case "AXCheckBox": return "CheckBox"
        case "AXRadioButton": return "RadioButton"
        case "AXComboBox": return "ComboBox"
        case "AXList", "AXOutline": return "List"
        case "AXRow", "AXCell": return "ListItem"
        case "AXMenu": return "Menu"
        case "AXMenuItem", "AXMenuBarItem": return "MenuItem"
        case "AXTabGroup": return "Tab"
        case "AXSlider": return "Slider"
        case "AXLink": return "Hyperlink"
        case "AXImage": return "Image"
        case "AXToolbar": return "ToolBar"
        case "AXScrollArea": return "Pane"
        case "AXGroup", "AXSplitGroup": return "Group"
        default:
            return axRole.hasPrefix("AX") ? String(axRole.dropFirst(2)) : axRole
        }
    }

    private func observeWindow(_ params: [String: Any], forceScreenshot: Bool) throws -> [String: Any] {
        try ProtocolJson.requireFields(params, "windowId,screenshot,screenshotOnly,imageOnly,format")
        let id = try ProtocolJson.text(params, "windowId")
        let screenshotOnly = try ProtocolJson.flag(params, "screenshotOnly") || ProtocolJson.flag(params, "imageOnly")
        let wantScreenshot = try forceScreenshot || screenshotOnly || ProtocolJson.flag(params, "screenshot")
        let format = try ProtocolJson.text(params, "format", fallback: "jpeg").lowercased()
        try ProtocolJson.require(format == "jpeg" || format == "jpg" || format == "png")

        guard let target = targets[id], isWindowValid(target) else {
            throw AutomationFault("DESKTOP_WINDOW_CHANGED")
        }
        if backgroundTarget != nil {
            try ProtocolJson.require(id == backgroundWindowId, "DESKTOP_WINDOW_CHANGED")
        }

        selected = nil
        elements.removeAll()
        version = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        imageReady = false

        var nodes: [[String: Any]] = []
        var gaps = Set<String>()
        let startNs = DispatchTime.now().uptimeNanoseconds
        var textBudget = 32768

        let withinBudget = { () -> Bool in
            (DispatchTime.now().uptimeNanoseconds - startNs) / 1_000_000 < 4000
        }

        if screenshotOnly {
            gaps.insert("uia_skipped")
        } else if !AXIsProcessTrusted() {
            gaps.insert("uia_provider_error")
        } else if let rootAX = resolveAXWindow(for: target) {
            struct QueueEntry {
                let element: AXUIElement
                let depth: Int
                let parentIndex: Int
                let isRoot: Bool
            }
            var queue: [QueueEntry] = [QueueEntry(element: rootAX, depth: 0, parentIndex: -1, isRoot: true)]
            var head = 0

            while head < queue.count && nodes.count < 512 && withinBudget() {
                try checkControl()
                let entry = queue[head]
                head += 1

                let axEl = entry.element
                AXUIElementSetMessagingTimeout(axEl, 0.8)
                let rawRole = axString(axEl, kAXRoleAttribute as String) ?? "AXUnknown"
                let subrole = axString(axEl, kAXSubroleAttribute as String)
                let password = (subrole == "AXSecureTextField")
                let title = password ? "" : (axString(axEl, kAXTitleAttribute as String) ?? "")
                let desc = password ? "" : (axString(axEl, kAXDescriptionAttribute as String) ?? "")
                let rawName = !title.isEmpty ? title : desc
                let automationId = axString(axEl, "AXIdentifier") ?? ""
                let enabled = axBool(axEl, kAXEnabledAttribute as String, default: true)
                let focused = axBool(axEl, kAXFocusedAttribute as String, default: false)
                let rect = axBounds(axEl)
                let rawActions = axActions(axEl)

                var valueStr = ""
                var valueReadable = false
                let valueSettable = isAttributeSettable(axEl, kAXValueAttribute as String)
                if !password, let rawVal = axAttribute(axEl, kAXValueAttribute as String) {
                    if let s = rawVal as? String {
                        valueStr = s
                        valueReadable = true
                    } else if let n = rawVal as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() {
                        valueStr = n.stringValue
                        valueReadable = true
                    }
                }

                var supportedActions: [String] = []
                if rawActions.contains(kAXPressAction as String) || rawActions.contains(kAXConfirmAction as String) || rawActions.contains(kAXPickAction as String) {
                    supportedActions.append("invoke")
                }
                if valueSettable || rawRole == "AXTextField" || rawRole == "AXTextArea" || rawRole == "AXSearchField" || rawRole == "AXComboBox" {
                    supportedActions.append("set_value")
                }
                if rawRole == "AXCheckBox" || rawRole == "AXRadioButton" {
                    supportedActions.append("toggle")
                }
                if rawRole == "AXRow" || rawRole == "AXMenuItem" || rawRole == "AXRadioButton" || isAttributeSettable(axEl, kAXSelectedAttribute as String) {
                    supportedActions.append("select")
                }
                if rawRole == "AXDisclosureTriangle" || isAttributeSettable(axEl, "AXDisclosing") {
                    supportedActions.append("expand")
                    supportedActions.append("collapse")
                }
                if rawRole == "AXScrollArea" && (axAttribute(axEl, kAXVerticalScrollBarAttribute as String) != nil || axAttribute(axEl, kAXHorizontalScrollBarAttribute as String) != nil) {
                    supportedActions.append("scroll")
                }
                if isAttributeSettable(axEl, kAXFocusedAttribute as String) {
                    supportedActions.append("focus")
                }
                if entry.isRoot {
                    supportedActions.append(contentsOf: ["restore", "minimize", "maximize"])
                }
                if backgroundTarget != nil {
                    supportedActions = supportedActions.filter { Self.backgroundActions.contains($0) }
                }

                // Prune empty non-interactive layout containers while traversing their children!
                let isEmptyLayoutGroup = !entry.isRoot
                    && !password
                    && Self.layoutContainerRoles.contains(rawRole)
                    && rawName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && valueStr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && automationId.isEmpty
                    && supportedActions.filter({ $0 != "focus" }).isEmpty

                var parentForChildren = entry.parentIndex
                if !isEmptyLayoutGroup {
                    let ref = "e\(nodes.count)"
                    let currentIdx = nodes.count
                    parentForChildren = currentIdx

                    let limit = min(4096, max(0, textBudget))
                    var truncatedFields: [String] = []
                    if !password && rawName.count > 512 {
                        truncatedFields.append("name")
                        gaps.insert("name_limit")
                    }
                    if automationId.count > 256 {
                        truncatedFields.append("automationId")
                        gaps.insert("automation_id_limit")
                    }
                    var displayValue = password ? "" : valueStr
                    if !password && displayValue.count > limit {
                        displayValue = String(displayValue.prefix(limit))
                        truncatedFields.append("text")
                        gaps.insert("text_limit")
                    }
                    textBudget = max(0, textBudget - displayValue.count)

                    let normalizedRole = normalizeRole(rawRole, subrole: subrole)
                    let boundsArr: Any = rect.map { [Double($0.origin.x), Double($0.origin.y), Double($0.width), Double($0.height)] } ?? NSNull()
                    let toggleState: Any = (rawRole == "AXCheckBox" || rawRole == "AXRadioButton")
                        ? ((axAttribute(axEl, kAXValueAttribute as String) as? Int) ?? 0)
                        : NSNull()
                    let selectedVal: Any = isAttributeSettable(axEl, kAXSelectedAttribute as String)
                        ? axBool(axEl, kAXSelectedAttribute as String)
                        : NSNull()

                    let stateDict: [String: Any] = [
                        "valueStatus": password ? "redacted" : (valueReadable ? "readable" : "unsupported"),
                        "valueEvidence": valueReadable ? "value" : "unconfirmed",
                        "readOnly": valueReadable ? !valueSettable : NSNull(),
                        "toggleStatus": (toggleState is Int) ? "readable" : "unsupported",
                        "toggle": toggleState,
                        "selectionStatus": (selectedVal is Bool) ? "readable" : "unsupported",
                        "selected": selectedVal,
                        "expandCollapseStatus": "unsupported",
                        "expanded": NSNull()
                    ]

                    let fp = ProtocolJson.sha256Hex("\(target.pid):\(normalizedRole):\(rawName.prefix(512)):\(automationId.prefix(256)):\(enabled):\(password ? "" : valueStr)")
                    elements[ref] = StoredElement(
                        axElement: axEl,
                        fingerprint: fp,
                        role: normalizedRole,
                        actions: supportedActions,
                        bounds: rect,
                        isRootWindow: entry.isRoot
                    )

                    nodes.append([
                        "reference": ref,
                        "parent": entry.parentIndex,
                        "role": normalizedRole,
                        "name": password ? "" : String(rawName.prefix(512)),
                        "automationId": String(automationId.prefix(256)),
                        "enabled": enabled,
                        "offscreen": false,
                        "password": password,
                        "focused": focused,
                        "text": displayValue,
                        "textStatus": password ? "redacted" : (truncatedFields.contains("text") ? "truncated" : (valueReadable ? "readable" : "unsupported")),
                        "textSource": valueReadable && !password ? "value" : "none",
                        "truncatedFields": truncatedFields,
                        "actions": supportedActions,
                        "bounds": boundsArr,
                        "state": stateDict,
                        "stateGaps": []
                    ])
                }

                if !password {
                    if entry.depth >= 24 {
                        gaps.insert("depth_limit")
                    } else if let children = axAttribute(axEl, kAXChildrenAttribute as String) as? [AXUIElement] {
                        var added = 0
                        for child in children {
                            if added >= 256 { gaps.insert("children_limit"); break }
                            if (queue.count - head) >= 1024 { gaps.insert("queue_limit"); break }
                            queue.append(QueueEntry(element: child, depth: entry.depth + 1, parentIndex: parentForChildren, isRoot: false))
                            added += 1
                        }
                    }
                }
            }
            if head < queue.count {
                if nodes.count >= 512 { gaps.insert("node_limit") }
                if !withinBudget() { gaps.insert("time_limit") }
            }
        }

        try checkControl()
        var imageObj: Any = NSNull()
        if wantScreenshot {
            imageObj = try captureWindowImage(target: target, format: format == "png" ? "png" : "jpeg")
            imageReady = true
        }
        try ProtocolJson.require(isWindowValid(target), "DESKTOP_WINDOW_CHANGED")
        selected = target
        selectedId = id
        observedAtNs = DispatchTime.now().uptimeNanoseconds

        return [
            "windowId": id,
            "version": version,
            "elements": nodes,
            "truncated": gaps.contains(where: { $0 != "uia_skipped" }),
            "gaps": gaps.sorted(),
            "image": imageObj
        ]
    }

    // MARK: - Single-Window Capture (ScreenCaptureKit on macOS 14+ / CGWindowListCreateImage fallback)

    private func captureViaScreenCaptureKit(windowId: CGWindowID) -> CGImage? {
        #if canImport(ScreenCaptureKit)
        if #available(macOS 14.0, *) {
            let semaphore = DispatchSemaphore(value: 0)
            var captured: CGImage?
            Task {
                defer { semaphore.signal() }
                guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false),
                      let scWin = content.windows.first(where: { $0.windowID == windowId }) else {
                    return
                }
                let filter = SCContentFilter(desktopIndependentWindow: scWin)
                let config = SCStreamConfiguration()
                let scale = NSScreen.main?.backingScaleFactor ?? 2.0
                config.width = max(1, Int((scWin.frame.width * scale).rounded()))
                config.height = max(1, Int((scWin.frame.height * scale).rounded()))
                config.showsCursor = false
                config.ignoreShadowsSingleWindow = true
                captured = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            }
            _ = semaphore.wait(timeout: .now() + .milliseconds(4500))
            return captured
        }
        #endif
        return nil
    }

    private func captureWindowImage(target: TargetWindow, format: String) throws -> [String: Any] {
        guard let beforeBounds = currentWindowBounds(target.windowNumber, expectedPid: target.pid) else {
            throw AutomationFault("DESKTOP_WINDOW_CHANGED")
        }
        var sourceName = "screencapturekit"
        var rawImage = captureViaScreenCaptureKit(windowId: target.windowNumber)
        if rawImage == nil {
            sourceName = "cgwindowlist"
            if let fn = cgWindowListCreateImageFn {
                let options: CGWindowImageOption = [.boundsIgnoreFraming]
                rawImage = fn(.null, .optionIncludingWindow, target.windowNumber, options)?.takeRetainedValue()
            }
        }
        guard let cgImage = rawImage, cgImage.width > 0, cgImage.height > 0 else {
            throw AutomationFault("DESKTOP_SCREENSHOT_UNAVAILABLE", cause: "CAPTURE_UNAVAILABLE")
        }
        guard let afterBounds = currentWindowBounds(target.windowNumber, expectedPid: target.pid),
              afterBounds.equalTo(beforeBounds) else {
            throw AutomationFault("DESKTOP_WINDOW_CHANGED", cause: "CAPTURE_WINDOW_CHANGED")
        }

        let srcW = cgImage.width
        let srcH = cgImage.height
        let scale = min(1.0, 1600.0 / Double(max(srcW, srcH)))
        let outW = max(1, Int((Double(srcW) * scale).rounded()))
        let outH = max(1, Int((Double(srcH) * scale).rounded()))

        let finalImage: CGImage
        if outW == srcW && outH == srcH {
            finalImage = cgImage
        } else {
            let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
            guard let ctx = CGContext(
                data: nil,
                width: outW,
                height: outH,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else {
                throw AutomationFault("DESKTOP_SCREENSHOT_UNAVAILABLE")
            }
            ctx.interpolationQuality = .high
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: outW, height: outH))
            guard let scaled = ctx.makeImage() else {
                throw AutomationFault("DESKTOP_SCREENSHOT_UNAVAILABLE")
            }
            finalImage = scaled
        }

        let encodedData = NSMutableData()
        let utType = format == "png" ? UTType.png.identifier : UTType.jpeg.identifier
        guard let dest = CGImageDestinationCreateWithData(encodedData as CFMutableData, utType as CFString, 1, nil) else {
            throw AutomationFault("DESKTOP_SCREENSHOT_UNAVAILABLE")
        }
        let props: [CFString: Any] = format == "png" ? [:] : [kCGImageDestinationLossyCompressionQuality: 0.9]
        CGImageDestinationAddImage(dest, finalImage, props as CFDictionary)
        guard CGImageDestinationFinalize(dest), encodedData.length > 0, encodedData.length <= 2_200_000 else {
            throw AutomationFault("DESKTOP_SCREENSHOT_TOO_LARGE")
        }

        let winX = Int(afterBounds.origin.x.rounded())
        let winY = Int(afterBounds.origin.y.rounded())
        let winW = max(1, Int(afterBounds.width.rounded()))
        let winH = max(1, Int(afterBounds.height.rounded()))

        imageBounds = afterBounds
        lastImageWidth = outW
        lastImageHeight = outH
        lastCaptureRect = CGRect(x: 0, y: 0, width: winW, height: winH)

        return [
            "mimeType": format == "png" ? "image/png" : "image/jpeg",
            "data": (encodedData as Data).base64EncodedString(),
            "width": outW,
            "height": outH,
            "windowX": winX,
            "windowY": winY,
            "windowWidth": winW,
            "windowHeight": winH,
            "captureRect": ["x": 0, "y": 0, "width": winW, "height": winH],
            "physicalPixelsAvailable": true,
            "coordinateInputAvailable": backgroundTarget == nil,
            "source": sourceName
        ]
    }

    // MARK: - Semantic AX & Interactive CGEvent Actions

    private func mapCoord(_ rawX: Int, _ rawY: Int, coordSpace: String) throws -> CGPoint {
        let winW = max(1.0, Double(imageBounds.width))
        let winH = max(1.0, Double(imageBounds.height))
        switch coordSpace {
        case "image":
            try ProtocolJson.require(lastImageWidth > 0 && lastImageHeight > 0, "DESKTOP_SCREENSHOT_REQUIRED")
            let rx = Double(lastCaptureRect.origin.x) + (Double(rawX) * Double(lastCaptureRect.width) / Double(lastImageWidth))
            let ry = Double(lastCaptureRect.origin.y) + (Double(rawY) * Double(lastCaptureRect.height) / Double(lastImageHeight))
            return CGPoint(x: imageBounds.origin.x + rx, y: imageBounds.origin.y + ry)
        case "normalized":
            try ProtocolJson.require(rawX >= 0 && rawX <= 1000 && rawY >= 0 && rawY <= 1000, "DESKTOP_BAD_REQUEST")
            let rx = Double(lastCaptureRect.origin.x) + (Double(rawX) * Double(lastCaptureRect.width) / 1000.0)
            let ry = Double(lastCaptureRect.origin.y) + (Double(rawY) * Double(lastCaptureRect.height) / 1000.0)
            return CGPoint(x: imageBounds.origin.x + rx, y: imageBounds.origin.y + ry)
        case "physical", "":
            try ProtocolJson.require(Double(rawX) >= 0 && Double(rawY) >= 0 && Double(rawX) < winW && Double(rawY) < winH, "DESKTOP_BAD_REQUEST")
            return CGPoint(x: imageBounds.origin.x + Double(rawX), y: imageBounds.origin.y + Double(rawY))
        default:
            throw AutomationFault("DESKTOP_BAD_REQUEST")
        }
    }

    private func activateWindow(_ target: TargetWindow) throws {
        if let app = NSRunningApplication(processIdentifier: target.pid) {
            if !app.isActive {
                _ = app.activate(options: [.activateIgnoringOtherApps])
            }
        }
        if let axWin = resolveAXWindow(for: target) {
            _ = AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)
        }
        let start = DispatchTime.now().uptimeNanoseconds
        while (DispatchTime.now().uptimeNanoseconds - start) / 1_000_000 < 350 {
            try checkControl()
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid { return }
            Thread.sleep(forTimeInterval: 0.01)
        }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != target.pid {
            throw AutomationFault("DESKTOP_FOCUS_REQUIRED", cause: "FOREGROUND_NOT_CONFIRMED")
        }
    }

    private func keyMapping(_ raw: String) throws -> (keyCode: CGKeyCode, modifierFlag: CGEventFlags?) {
        switch raw.uppercased() {
        case "CMD", "COMMAND", "META", "SUPER": return (55, .maskCommand)
        case "CTRL", "CONTROL": return (59, .maskControl)
        case "ALT", "OPTION": return (58, .maskAlternate)
        case "SHIFT": return (56, .maskShift)
        case "ENTER", "RETURN": return (36, nil)
        case "TAB": return (48, nil)
        case "SPACE": return (49, nil)
        case "BACKSPACE": return (51, nil)
        case "DELETE": return (117, nil)
        case "ESC", "ESCAPE": return (53, nil)
        case "LEFT": return (123, nil)
        case "RIGHT": return (124, nil)
        case "DOWN": return (125, nil)
        case "UP": return (126, nil)
        case "HOME": return (115, nil)
        case "END": return (119, nil)
        case "PAGEUP": return (116, nil)
        case "PAGEDOWN": return (121, nil)
        case "F1": return (122, nil)
        case "F2": return (120, nil)
        case "F3": return (99, nil)
        case "F4": return (118, nil)
        case "F5": return (96, nil)
        case "F6": return (97, nil)
        case "F7": return (98, nil)
        case "F8": return (100, nil)
        case "F9": return (101, nil)
        case "F10": return (109, nil)
        case "F11": return (103, nil)
        case "F12": return (111, nil)
        case "A": return (0, nil)
        case "S": return (1, nil)
        case "D": return (2, nil)
        case "F": return (3, nil)
        case "H": return (4, nil)
        case "G": return (5, nil)
        case "Z": return (6, nil)
        case "X": return (7, nil)
        case "C": return (8, nil)
        case "V": return (9, nil)
        case "B": return (11, nil)
        case "Q": return (12, nil)
        case "W": return (13, nil)
        case "E": return (14, nil)
        case "R": return (15, nil)
        case "Y": return (16, nil)
        case "T": return (17, nil)
        case "1": return (18, nil)
        case "2": return (19, nil)
        case "3": return (20, nil)
        case "4": return (21, nil)
        case "6": return (22, nil)
        case "5": return (23, nil)
        case "9": return (25, nil)
        case "7": return (26, nil)
        case "8": return (28, nil)
        case "0": return (29, nil)
        case "O": return (31, nil)
        case "U": return (32, nil)
        case "I": return (34, nil)
        case "P": return (35, nil)
        case "L": return (37, nil)
        case "J": return (38, nil)
        case "K": return (40, nil)
        case "N": return (45, nil)
        case "M": return (46, nil)
        default:
            throw AutomationFault("DESKTOP_KEY_UNSUPPORTED")
        }
    }

    private func validTypedText(_ value: String) -> Bool {
        if value.isEmpty || value.utf16.count > 512 { return false }
        let units = Array(value.utf16)
        var i = 0
        while i < units.count {
            let u = units[i]
            if u <= 0x1f || (u >= 0x7f && u <= 0x9f) { return false }
            if UTF16.isLeadSurrogate(u) {
                if i + 1 >= units.count || !UTF16.isTrailSurrogate(units[i + 1]) { return false }
                i += 2
                continue
            }
            if UTF16.isTrailSurrogate(u) { return false }
            i += 1
        }
        return true
    }

    private func postMarkedEvent(_ event: CGEvent?) throws {
        guard let event = event else { throw AutomationFault("DESKTOP_INPUT_FAILED") }
        event.setIntegerValueField(.eventSourceUserData, value: Int64(bitPattern: inputMarker))
        event.post(tap: .cghidEventTap)
    }

    private func performAction(_ params: [String: Any]) throws -> [String: Any] {
        try checkControl()
        var kind = try ProtocolJson.text(params, "kind")
        if kind == "hotkey" { kind = "press_key" }
        let observedVersion = try ProtocolJson.text(params, "version")
        try ProtocolJson.require(observedVersion.count == 32)

        if backgroundTarget != nil {
            try ProtocolJson.require(Self.backgroundActions.contains(kind), "DESKTOP_BACKGROUND_ACTION_DENIED")
        }
        guard hasFreshObservation, let target = selected, isWindowValid(target), observedVersion == version else {
            throw AutomationFault("DESKTOP_OBSERVATION_STALE")
        }

        let ref = try ProtocolJson.text(params, "ref")
        var storedElement: StoredElement? = nil
        if !ref.isEmpty {
            guard let found = elements[ref] else {
                throw AutomationFault("DESKTOP_ELEMENT_CHANGED")
            }
            storedElement = found
        }

        let isPhysical = ["click", "double_click", "move", "drag", "wheel", "type_text", "press_key"].contains(kind)
        if backgroundTarget != nil {
            try ProtocolJson.require(!isPhysical && selectedId == backgroundWindowId, "DESKTOP_BACKGROUND_ACTION_DENIED")
        }

        // Consume version BEFORE executing any action so uncertain outcomes cannot replay.
        version = ""

        if !isPhysical {
            guard let el = storedElement else {
                throw AutomationFault("DESKTOP_BAD_REQUEST")
            }
            let ax = el.axElement
            switch kind {
            case "invoke":
                let names = axActions(ax)
                let actionName: String
                if names.contains(kAXPressAction as String) { actionName = kAXPressAction as String }
                else if names.contains(kAXConfirmAction as String) { actionName = kAXConfirmAction as String }
                else if names.contains(kAXPickAction as String) { actionName = kAXPickAction as String }
                else if names.contains(kAXShowMenuAction as String) { actionName = kAXShowMenuAction as String }
                else { throw AutomationFault("DESKTOP_ACTION_UNSUPPORTED") }
                try ProtocolJson.require(AXUIElementPerformAction(ax, actionName as CFString) == .success, "DESKTOP_ACTION_FAILED")
            case "show_menu":
                try ProtocolJson.require(AXUIElementPerformAction(ax, kAXShowMenuAction as CFString) == .success, "DESKTOP_ACTION_FAILED")
            case "raise":
                try ProtocolJson.require(AXUIElementPerformAction(ax, kAXRaiseAction as CFString) == .success, "DESKTOP_ACTION_FAILED")
            case "set_value":
                let value = try ProtocolJson.text(params, "value")
                try ProtocolJson.require(value.count <= 16384)
                try ProtocolJson.require(isAttributeSettable(ax, kAXValueAttribute as String), "DESKTOP_ELEMENT_UNAVAILABLE")
                try ProtocolJson.require(AXUIElementSetAttributeValue(ax, kAXValueAttribute as CFString, value as CFTypeRef) == .success, "DESKTOP_ACTION_FAILED")
            case "toggle":
                try ProtocolJson.require(AXUIElementPerformAction(ax, kAXPressAction as CFString) == .success, "DESKTOP_ACTION_FAILED")
            case "select":
                if isAttributeSettable(ax, kAXSelectedAttribute as String) {
                    try ProtocolJson.require(AXUIElementSetAttributeValue(ax, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success, "DESKTOP_ACTION_FAILED")
                } else {
                    try ProtocolJson.require(AXUIElementPerformAction(ax, kAXPressAction as CFString) == .success, "DESKTOP_ACTION_FAILED")
                }
            case "expand", "collapse":
                let wantOpen = (kind == "expand")
                if isAttributeSettable(ax, "AXDisclosing") {
                    try ProtocolJson.require(AXUIElementSetAttributeValue(ax, "AXDisclosing" as CFString, wantOpen ? kCFBooleanTrue : kCFBooleanFalse) == .success, "DESKTOP_ACTION_FAILED")
                } else {
                    try ProtocolJson.require(AXUIElementPerformAction(ax, kAXPressAction as CFString) == .success, "DESKTOP_ACTION_FAILED")
                }
            case "scroll":
                let h = try ProtocolJson.number(params, "horizontal", fallback: 2)
                let v = try ProtocolJson.number(params, "vertical", fallback: 2)
                try ProtocolJson.require((0...4).contains(h) && (0...4).contains(v) && (h != 2 || v != 2))
                let applyBar = { (barAttr: String, amount: Int) throws in
                    guard amount != 2 else { return }
                    guard let barObj = self.axAttribute(ax, barAttr) else { throw AutomationFault("DESKTOP_ACTION_UNSUPPORTED") }
                    let bar = barObj as! AXUIElement
                    let current = (self.axAttribute(bar, kAXValueAttribute as String) as? Double) ?? 0.0
                    let delta: Double = amount == 0 ? -0.25 : amount == 1 ? -0.05 : amount == 3 ? 0.25 : 0.05
                    let next = min(1.0, max(0.0, current + delta))
                    try ProtocolJson.require(AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, next as CFNumber) == .success, "DESKTOP_ACTION_FAILED")
                }
                try applyBar(kAXHorizontalScrollBarAttribute as String, h)
                try applyBar(kAXVerticalScrollBarAttribute as String, v)
            case "focus":
                try ProtocolJson.require(AXUIElementSetAttributeValue(ax, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success, "DESKTOP_ACTION_FAILED")
            case "minimize":
                try ProtocolJson.require(el.isRootWindow, "DESKTOP_ACTION_UNSUPPORTED")
                try ProtocolJson.require(AXUIElementSetAttributeValue(ax, kAXMinimizedAttribute as CFString, kCFBooleanTrue) == .success, "DESKTOP_WINDOW_STATE_UNCONFIRMED")
            case "restore":
                try ProtocolJson.require(el.isRootWindow, "DESKTOP_ACTION_UNSUPPORTED")
                _ = AXUIElementSetAttributeValue(ax, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            case "maximize":
                try ProtocolJson.require(el.isRootWindow, "DESKTOP_ACTION_UNSUPPORTED")
                if let zoomBtn = axAttribute(ax, kAXZoomButtonAttribute as String) {
                    try ProtocolJson.require(AXUIElementPerformAction(zoomBtn as! AXUIElement, kAXPressAction as CFString) == .success, "DESKTOP_WINDOW_STATE_UNCONFIRMED")
                } else {
                    throw AutomationFault("DESKTOP_ACTION_UNSUPPORTED")
                }
            default:
                throw AutomationFault("DESKTOP_ACTION_UNSUPPORTED")
            }
            return ["executed": true, "requiresObservation": true]
        }

        // Interactive CGEvent actions
        try ProtocolJson.require(AXIsProcessTrusted(), "DESKTOP_INPUT_FAILED", cause: "ACCESSIBILITY_UNTRUSTED")
        try activateWindow(target)
        guard let eventSource = CGEventSource(stateID: .hidSystemState) else {
            throw AutomationFault("DESKTOP_INPUT_FAILED")
        }
        let coordSpace = try ProtocolJson.text(params, "coordSpace", fallback: "physical")

        if kind == "type_text" {
            let value = try ProtocolJson.text(params, "value")
            try ProtocolJson.require(validTypedText(value), "DESKTOP_BAD_REQUEST")
            if let el = storedElement {
                _ = AXUIElementSetAttributeValue(el.axElement, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            }
            for scalar in value.unicodeScalars {
                try checkControl()
                var utf16 = Array(String(scalar).utf16)
                let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true)
                down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
                let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false)
                up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
                try postMarkedEvent(down)
                try postMarkedEvent(up)
                Thread.sleep(forTimeInterval: 0.004)
            }
            return ["executed": true, "requiresObservation": true]
        }

        if kind == "press_key" {
            guard let rawKeys = params["keys"] as? [Any], !rawKeys.isEmpty, rawKeys.count <= 5 else {
                throw AutomationFault("DESKTOP_BAD_REQUEST")
            }
            let keyNames = try rawKeys.map { item -> String in
                guard let s = item as? String, !s.isEmpty, s.count <= 20 else { throw AutomationFault("DESKTOP_BAD_REQUEST") }
                return s
            }
            let mapped = try keyNames.map { try keyMapping($0) }
            try ProtocolJson.require(Set(mapped.map { $0.keyCode }).count == mapped.count, "DESKTOP_BAD_REQUEST")
            if let el = storedElement {
                _ = AXUIElementSetAttributeValue(el.axElement, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            }
            var pressedCodes: [(CGKeyCode, CGEventFlags)] = []
            var activeFlags: CGEventFlags = []
            defer {
                for (code, flagsBefore) in pressedCodes.reversed() {
                    if let up = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false) {
                        up.flags = flagsBefore
                        up.setIntegerValueField(.eventSourceUserData, value: Int64(bitPattern: inputMarker))
                        up.post(tap: .cghidEventTap)
                    }
                }
            }
            for (code, modFlag) in mapped {
                try checkControl()
                let flagsBefore = activeFlags
                if let modFlag = modFlag { activeFlags.insert(modFlag) }
                let down = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true)
                down?.flags = activeFlags
                try postMarkedEvent(down)
                pressedCodes.append((code, flagsBefore))
            }
            return ["executed": true, "requiresObservation": true]
        }

        // Pointer actions
        guard let currentBounds = currentWindowBounds(target.windowNumber, expectedPid: target.pid) else {
            throw AutomationFault("DESKTOP_WINDOW_CHANGED")
        }
        let startPoint: CGPoint
        if let el = storedElement {
            guard let rect = axBounds(el.axElement) ?? el.bounds else {
                throw AutomationFault("DESKTOP_ELEMENT_UNAVAILABLE")
            }
            startPoint = CGPoint(x: rect.midX, y: rect.midY)
        } else {
            try ProtocolJson.require(imageReady && currentBounds.equalTo(imageBounds), "DESKTOP_SCREENSHOT_REQUIRED")
            let rawX = try ProtocolJson.number(params, "x", fallback: -1)
            let rawY = try ProtocolJson.number(params, "y", fallback: -1)
            startPoint = try mapCoord(rawX, rawY, coordSpace: coordSpace)
        }

        let buttonStr = try ProtocolJson.text(params, "button", fallback: "left")
        let cgButton: CGMouseButton = buttonStr == "right" ? .right : buttonStr == "middle" ? .center : .left
        let downType: CGEventType = buttonStr == "right" ? .rightMouseDown : buttonStr == "middle" ? .otherMouseDown : .leftMouseDown
        let upType: CGEventType = buttonStr == "right" ? .rightMouseUp : buttonStr == "middle" ? .otherMouseUp : .leftMouseUp
        let dragType: CGEventType = buttonStr == "right" ? .rightMouseDragged : buttonStr == "middle" ? .otherMouseDragged : .leftMouseDragged

        try postMarkedEvent(CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: startPoint, mouseButton: .left))

        switch kind {
        case "move":
            break
        case "wheel":
            let dx = try ProtocolJson.number(params, "deltaX", fallback: 0)
            let dy = try ProtocolJson.number(params, "deltaY", fallback: 0)
            try ProtocolJson.require((dx != 0 || dy != 0) && abs(dx) <= 1200 && abs(dy) <= 1200, "DESKTOP_BAD_REQUEST")
            let wheel = CGEvent(scrollWheelEvent2Source: eventSource, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)
            try postMarkedEvent(wheel)
        case "drag":
            try ProtocolJson.require(imageReady && currentBounds.equalTo(imageBounds), "DESKTOP_SCREENSHOT_REQUIRED")
            let toRawX = try ProtocolJson.number(params, "toX", fallback: -1)
            let toRawY = try ProtocolJson.number(params, "toY", fallback: -1)
            let endPoint = try mapCoord(toRawX, toRawY, coordSpace: coordSpace)
            var held = false
            defer {
                if held, let up = CGEvent(mouseEventSource: eventSource, mouseType: upType, mouseCursorPosition: endPoint, mouseButton: cgButton) {
                    up.setIntegerValueField(.eventSourceUserData, value: Int64(bitPattern: inputMarker))
                    up.post(tap: .cghidEventTap)
                }
            }
            try postMarkedEvent(CGEvent(mouseEventSource: eventSource, mouseType: downType, mouseCursorPosition: startPoint, mouseButton: cgButton))
            held = true
            for step in 1...20 {
                try checkControl()
                let t = Double(step) / 20.0
                let pt = CGPoint(x: startPoint.x + (endPoint.x - startPoint.x) * t, y: startPoint.y + (endPoint.y - startPoint.y) * t)
                try postMarkedEvent(CGEvent(mouseEventSource: eventSource, mouseType: dragType, mouseCursorPosition: pt, mouseButton: cgButton))
                Thread.sleep(forTimeInterval: 0.01)
            }
            try postMarkedEvent(CGEvent(mouseEventSource: eventSource, mouseType: upType, mouseCursorPosition: endPoint, mouseButton: cgButton))
            held = false
        case "click", "double_click":
            let clicks = kind == "double_click" ? 2 : 1
            for clickNum in 1...clicks {
                let down = CGEvent(mouseEventSource: eventSource, mouseType: downType, mouseCursorPosition: startPoint, mouseButton: cgButton)
                down?.setIntegerValueField(.mouseEventClickState, value: Int64(clickNum))
                let up = CGEvent(mouseEventSource: eventSource, mouseType: upType, mouseCursorPosition: startPoint, mouseButton: cgButton)
                up?.setIntegerValueField(.mouseEventClickState, value: Int64(clickNum))
                try postMarkedEvent(down)
                try postMarkedEvent(up)
                if clickNum < clicks { Thread.sleep(forTimeInterval: 0.03) }
            }
        default:
            throw AutomationFault("DESKTOP_ACTION_UNSUPPORTED")
        }

        return ["executed": true, "requiresObservation": true]
    }
}

private func parseInputMarker(_ args: [String]) -> UInt64? {
    if args.count == 1 {
        var generated: UInt64 = 0
        repeat { generated = UInt64.random(in: 1...UInt64.max) } while generated == 0
        return generated
    }
    guard args.count == 3, args[1] == "--input-marker" else { return nil }
    let hex = args[2]
    guard hex.count == 16,
          hex.unicodeScalars.allSatisfy({ ($0.value >= 48 && $0.value <= 57) || ($0.value >= 97 && $0.value <= 102) }),
          let value = UInt64(hex, radix: 16),
          value != 0 else {
        return nil
    }
    return value
}

@main
struct ProfilePilotDesktopMacMain {
    static func main() {
        guard let marker = parseInputMarker(CommandLine.arguments) else {
            exit(2)
        }
        setvbuf(stdout, nil, _IOLBF, 0)

        let cancelFlag = AtomicCancelFlag()
        let queueSemaphore = DispatchSemaphore(value: 0)
        let queueCapacity = DispatchSemaphore(value: 16)
        let queueLock = NSLock()
        var queue: [Data?] = []

        let enqueue = { (item: Data?) -> Bool in
            queueCapacity.wait()
            queueLock.lock()
            queue.append(item)
            queueLock.unlock()
            queueSemaphore.signal()
            return item != nil
        }

        Thread.detachNewThread {
            while let line = readLine(strippingNewline: true) {
                let utf8 = Data(line.utf8)
                if utf8.count <= maxRequestBytes,
                   let obj = (try? JSONSerialization.jsonObject(with: utf8)) as? [String: Any],
                   obj.count == 1,
                   (obj["operation"] as? String) == "cancel" {
                    cancelFlag.cancel()
                    break
                }
                _ = enqueue(utf8.count <= maxRequestBytes ? utf8 : Data())
            }
            cancelFlag.cancel()
            _ = enqueue(nil)
        }

        let driver = MacDesktopDriver(inputMarker: marker, cancelFlag: cancelFlag)
        while true {
            queueSemaphore.wait()
            queueLock.lock()
            let item = queue.isEmpty ? nil : queue.removeFirst()
            queueLock.unlock()
            queueCapacity.signal()

            guard let rawData = item, !cancelFlag.isCancelled else { break }
            var id = ""
            var operation = ""
            let reply: String
            do {
                try ProtocolJson.require(!rawData.isEmpty)
                guard let req = (try? JSONSerialization.jsonObject(with: rawData)) as? [String: Any] else {
                    throw AutomationFault("DESKTOP_BAD_REQUEST")
                }
                try ProtocolJson.requireFields(req, "id,operation,params")
                id = try ProtocolJson.text(req, "id")
                operation = try ProtocolJson.text(req, "operation")
                guard let params = req["params"] as? [String: Any] else {
                    throw AutomationFault("DESKTOP_BAD_REQUEST")
                }
                let result = try driver.handle(operation: operation, params: params)
                reply = ProtocolJson.successReply(id: id, operation: operation, result: result)
            } catch {
                reply = ProtocolJson.errorReply(id: id, operation: operation, error: error)
            }
            FileHandle.standardOutput.write(Data((reply + "\n").utf8))
        }
        exit(0)
    }
}
