import AppKit
import ApplicationServices

enum CaptureError: Error { case budget }
func timestamp() -> String { ISO8601DateFormatter().string(from: Date()) }
func errorName(_ code: AXError) -> String {
    switch code {
    case .success: return "success"
    case .cannotComplete: return "cannotComplete"
    case .invalidUIElement: return "invalidUIElement"
    case .attributeUnsupported: return "attributeUnsupported"
    case .apiDisabled: return "apiDisabled"
    case .noValue: return "noValue"
    default: return "AXError(\(code.rawValue))"
    }
}

// Observation only: no AX actions, event posting, activation or System Events.
final class NativeCapture {
    var deadline = Date.distantFuture
    var reads: [[String: Any]] = []
    var incomplete = Set<String>()
    func read(_ element: AXUIElement, _ attribute: String, _ path: String) throws -> CFTypeRef? {
        guard Date() < deadline else { throw CaptureError.budget }
        var value: CFTypeRef?
        let began = Date()
        let code = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        reads.append(["path": path, "attribute": attribute, "code": Int(code.rawValue),
                      "error": errorName(code), "ms": Date().timeIntervalSince(began) * 1000])
        if [.cannotComplete, .invalidUIElement, .apiDisabled].contains(code) { incomplete.insert(errorName(code)) }
        return code == .success ? value : nil
    }
    func text(_ element: AXUIElement, _ attribute: String, _ path: String) throws -> String {
        (try read(element, attribute, path)) as? String ?? ""
    }
    func children(_ element: AXUIElement, _ path: String) throws -> [AXUIElement] {
        (try read(element, kAXChildrenAttribute, path)) as? [AXUIElement] ?? []
    }
    func rect(_ element: AXUIElement, _ path: String) throws -> Any {
        guard let p = try read(element, kAXPositionAttribute, path), CFGetTypeID(p) == AXValueGetTypeID(),
              let s = try read(element, kAXSizeAttribute, path), CFGetTypeID(s) == AXValueGetTypeID() else { return NSNull() }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size),
              point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite else { return NSNull() }
        return ["x": Double(point.x), "y": Double(point.y), "width": Double(size.width), "height": Double(size.height)]
    }
    func actions(_ element: AXUIElement, _ path: String) throws -> [String] {
        guard Date() < deadline else { throw CaptureError.budget }
        var result: CFArray?
        let began = Date(), code = AXUIElementCopyActionNames(element, &result)
        reads.append(["path": path, "attribute": "AXActions", "code": Int(code.rawValue),
                      "error": errorName(code), "ms": Date().timeIntervalSince(began) * 1000])
        if [.cannotComplete, .invalidUIElement, .apiDisabled].contains(code) { incomplete.insert(errorName(code)) }
        return result as? [String] ?? []
    }
    func capture(seconds: Double = 0.85) -> [String: Any] {
        let began = Date(); deadline = began.addingTimeInterval(seconds)
        reads = []; incomplete = []
        var result: [String: Any] = ["schema": 1, "tool": "capcut-ax", "at": timestamp(),
                                  "command": "state", "commandAttempted": false, "observationOnly": true,
                                  "trusted": AXIsProcessTrusted(), "windows": []]
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.lemon.lvoverseas")
        result["runningInstances"] = apps.count
        guard AXIsProcessTrusted(), apps.count == 1 else {
            result["ok"] = false; result["complete"] = false
            result["error"] = apps.count != 1 ? "Une seule instance de CapCut doit être ouverte." : "Accessibilité à autoriser pour cet outil."
            result["ms"] = Date().timeIntervalSince(began) * 1000
            return result
        }
        let app = apps[0], root = AXUIElementCreateApplication(app.processIdentifier)
        let timeoutCode = AXUIElementSetMessagingTimeout(root, 0.25)
        result["messagingTimeout"] = ["seconds": 0.25, "code": Int(timeoutCode.rawValue)]
        result["capcut"] = ["pid": Int(app.processIdentifier), "bundle": app.bundleIdentifier ?? "",
                            "path": app.bundleURL?.path ?? "", "version": app.bundleURL.flatMap { Bundle(url: $0)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String } ?? ""]
        result["frontmostPID"] = NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) as Any } ?? NSNull()
        var windows: [[String: Any]] = []
        var queues: [(AXUIElement, String, String?, Int, Int, String?, Bool)] = []
        var seen: [AXUIElement] = []
        var index = 0, nodeCount = 0
        do {
            let list = (try read(root, kAXWindowsAttribute, "application")) as? [AXUIElement] ?? []
            for (w, element) in list.enumerated() {
                let path = "window/\(w)"
                let frame = try rect(element, path)
                windows.append(["path": path, "title": try text(element, kAXTitleAttribute, path), "frame": frame, "nodes": []])
                queues.append((element, path, nil, 0, w, nil, false))
            }
            // Prefer the main-sized windows, retaining every window in the report.
            let areas: [Double] = windows.map { window in
                let frame = window["frame"] as? [String: Double] ?? [:]
                let width = frame["width"] ?? 0, height = frame["height"] ?? 0
                return width * height
            }
            queues.sort { areas[$0.4] > areas[$1.4] }
            while index < queues.count {
                guard Date() < deadline else { throw CaptureError.budget }
                if nodeCount >= 1500 { incomplete.insert("limite_noeuds"); break }
                let (element, path, parent, depth, w, knownRole, insideSheet) = queues[index]; index += 1
                if seen.contains(where: { CFEqual($0, element) }) { continue }
                seen.append(element)
                if depth > 18 { incomplete.insert("limite_profondeur"); continue }
                let role = try knownRole ?? text(element, kAXRoleAttribute, path)
                let description = try text(element, kAXDescriptionAttribute, path)
                let value = try read(element, kAXValueAttribute, path)
                var node: [String: Any] = ["path": path, "parent": parent.map { $0 as Any } ?? NSNull(), "role": role,
                    "identifier": try text(element, kAXIdentifierAttribute, path), "title": try text(element, kAXTitleAttribute, path),
                    "description": description, "value": (value as? String).map { $0 as Any } ?? (value as? NSNumber).map { $0 as Any } ?? NSNull(),
                    "frame": try rect(element, path), "actions": try actions(element, path),
                    "enabled": ((try read(element, kAXEnabledAttribute, path)) as? Bool).map { $0 as Any } ?? NSNull()]
                node["hidden"] = ((try read(element, "AXHidden", path)) as? Bool).map { $0 as Any } ?? NSNull()
                var nodes = windows[w]["nodes"] as? [[String: Any]] ?? []; nodes.append(node); windows[w]["nodes"] = nodes
                nodeCount += 1
                let children = try self.children(element, path)
                var modals: [(AXUIElement, String, String?, Int, Int, String?, Bool)] = []
                var others: [(AXUIElement, String, String?, Int, Int, String?, Bool)] = []
                for (c, child) in children.enumerated() {
                    let childPath = "\(path)/\(c)"
                    // Read direct children cheaply to put the native modal first.
                    let childRole = try text(child, kAXRoleAttribute, childPath)
                    let entry = (child, childPath, Optional(path), depth + 1, w, Optional(childRole), insideSheet || role == kAXSheetRole)
                    if childRole == kAXSheetRole { modals.append(entry) } else { others.append(entry) }
                }
                if role == kAXSheetRole || insideSheet {
                    queues.insert(contentsOf: modals + others, at: index)
                } else {
                    queues.insert(contentsOf: modals, at: index); queues.append(contentsOf: others)
                }
            }
        } catch { incomplete.insert(error is CaptureError ? "budget_lecture" : String(describing: error)) }
        result["windows"] = windows; result["reads"] = reads; result["nodesRead"] = nodeCount
        result["complete"] = incomplete.isEmpty; result["incompleteReasons"] = incomplete.sorted()
        result["ok"] = incomplete.isEmpty
        result["ms"] = Date().timeIntervalSince(began) * 1000
        return result
    }
}
