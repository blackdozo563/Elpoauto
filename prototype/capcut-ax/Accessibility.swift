import AppKit
import ApplicationServices

func axErrorName(_ error: AXError) -> String {
    switch error {
    case .success: return "success"
    case .apiDisabled: return "apiDisabled"
    case .cannotComplete: return "cannotComplete"
    case .attributeUnsupported: return "attributeUnsupported"
    case .actionUnsupported: return "actionUnsupported"
    case .invalidUIElement: return "invalidUIElement"
    case .noValue: return "noValue"
    default: return "AXError(\(error.rawValue))"
    }
}
func rectJSON(_ rect: CGRect) -> [String: Double] {
    ["x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)]
}

struct AXNode {
    let element: AXUIElement
    let path: String
    let parent: Int?
    let role: String
    let identifier: String
    let title: String
    let description: String
    let text: String
    let number: Double?
    let maximum: Double?
    let enabled: Bool?
    let hidden: Bool?
    let rect: CGRect?
    let actions: [String]
    func matches(_ id: String) -> Bool { [identifier, title, description].contains(id) }
    var json: [String: Any] {
        ["path": path, "parent": parent.map { $0 as Any } ?? NSNull(), "role": role,
         "identifier": identifier, "title": title, "description": description, "value": text,
         "numericValue": number.map { $0 as Any } ?? NSNull(), "maximum": maximum.map { $0 as Any } ?? NSNull(),
         "enabled": enabled.map { $0 as Any } ?? NSNull(), "hidden": hidden.map { $0 as Any } ?? NSNull(),
         "rect": rect.map { rectJSON($0) as Any } ?? NSNull(), "actions": actions]
    }
}
struct AXSnapshot {
    let nodes: [AXNode]
    let complete: Bool
    let ms: Double
    var json: [String: Any] { ["at": Evidence.timestamp(), "complete": complete, "ms": ms, "nodes": nodes.map { $0.json }] }
}

// Exact AXDescription recorded on CapCut 9.3.0 during a real export. This
// machine identifier is not the localized text shown on screen.
func capcutExportPercent(role: String, description: String) -> Double? {
    guard role == kAXStaticTextRole,
          description.range(of: "^ExportProgress:[0-9]+(?:\\.[0-9]+)?%$", options: .regularExpression) != nil,
          let percent = Double(description.dropFirst("ExportProgress:".count).dropLast()),
          percent.isFinite, (0...100).contains(percent) else { return nil }
    return percent
}

final class NativeAX {
    let report: Evidence
    let cancel: Cancellation
    var deadline = Date.distantFuture
    init(report: Evidence, cancel: Cancellation) { self.report = report; self.cancel = cancel }
    func get(_ element: AXUIElement, _ attribute: String, _ path: String) throws -> CFTypeRef? {
        try cancel.check()
        guard Date() < deadline else { throw PrototypeFailure.stopped("Budget de lecture native dépassé : \(path), \(attribute).") }
        var value: CFTypeRef?
        let start = Date()
        let code = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        report.read(["at": Evidence.timestamp(), "path": path, "attribute": attribute,
                     "code": Int(code.rawValue), "error": axErrorName(code), "ms": Date().timeIntervalSince(start) * 1000])
        if [kAXChildrenAttribute, kAXWindowsAttribute, kAXRoleAttribute].contains(attribute),
           [.cannotComplete, .invalidUIElement, .apiDisabled].contains(code) {
            throw PrototypeFailure.stopped("Lecture structurelle \(attribute) : \(axErrorName(code)), \(path).")
        }
        return code == .success ? value : nil
    }
    func string(_ element: AXUIElement, _ key: String, _ path: String) throws -> String {
        (try get(element, key, path)) as? String ?? ""
    }
    func children(_ element: AXUIElement, _ path: String) throws -> [AXUIElement] {
        (try get(element, kAXChildrenAttribute, path)) as? [AXUIElement] ?? []
    }
    func rectangle(_ element: AXUIElement, _ path: String) throws -> CGRect? {
        guard let p = try get(element, kAXPositionAttribute, path), CFGetTypeID(p) == AXValueGetTypeID(),
              let s = try get(element, kAXSizeAttribute, path), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size),
              point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite,
              size.width > 0, size.height > 0 else { return nil }
        return CGRect(origin: point, size: size)
    }
    func actionNames(_ element: AXUIElement, _ path: String) throws -> [String] {
        try cancel.check()
        var names: CFArray?
        let start = Date(), code = AXUIElementCopyActionNames(element, &names)
        report.read(["at": Evidence.timestamp(), "path": path, "attribute": "AXActions",
                     "code": Int(code.rawValue), "error": axErrorName(code), "ms": Date().timeIntervalSince(start) * 1000])
        return names as? [String] ?? []
    }
    func inspect(_ sheet: AXUIElement, detailed: Bool = true, seconds: Double = 15) -> AXSnapshot {
        let start = Date(); deadline = start.addingTimeInterval(seconds)
        var nodes: [AXNode] = [], queue: [(AXUIElement, String, Int?, Int)] = [(sheet, "sheet", nil, 0)]
        var index = 0, complete = true
        do {
            while index < queue.count {
                try cancel.check()
                if nodes.count >= 3000 { complete = false; break }
                let (e, path, parent, depth) = queue[index]; index += 1
                if depth > 24 { complete = false; continue }
                let role = try string(e, kAXRoleAttribute, path)
                let id = try string(e, kAXIdentifierAttribute, path)
                let desc = try string(e, kAXDescriptionAttribute, path)
                let title = try string(e, kAXTitleAttribute, path)
                let value = try get(e, kAXValueAttribute, path)
                let num = value as? NSNumber
                let node = AXNode(element: e, path: path, parent: parent, role: role, identifier: id,
                                  title: title, description: desc, text: value as? String ?? "",
                                  number: num?.doubleValue,
                                  maximum: role == kAXProgressIndicatorRole ? ((try get(e, kAXMaxValueAttribute, path)) as? NSNumber)?.doubleValue : nil,
                                  enabled: (try get(e, kAXEnabledAttribute, path)) as? Bool,
                                  hidden: (try get(e, "AXHidden", path)) as? Bool,
                                  rect: detailed ? try rectangle(e, path) : nil,
                                  actions: detailed ? try actionNames(e, path) : [])
                let n = nodes.count; nodes.append(node)
                let childList = try children(e, path)
                for (i, child) in childList.enumerated() {
                    // Some providers expose the same element through cyclic paths.
                    if CFEqual(child, e) || queue.contains(where: { CFEqual($0.0, child) }) { continue }
                    queue.append((child, "\(path)/\(i)", n, depth + 1))
                }
            }
        } catch {
            complete = false
            report.phase("lecture_partielle", "Lecture native interrompue : \(error)", ["nodesRead": nodes.count])
        }
        let snapshot = AXSnapshot(nodes: nodes, complete: complete, ms: Date().timeIntervalSince(start) * 1000)
        report.snapshot(snapshot.json)
        return snapshot
    }
    func locateSheet(_ app: AXUIElement) throws -> AXUIElement {
        deadline = Date().addingTimeInterval(15)
        let windows = (try get(app, kAXWindowsAttribute, "application")) as? [AXUIElement] ?? []
        var sheets: [AXUIElement] = []
        for (i, window) in windows.enumerated() {
            let path = "window/\(i)"
            let title = try string(window, kAXTitleAttribute, path)
            let frame = try rectangle(window, path)
            report.phase("fenetre", "Fenêtre CapCut relevée", ["title": title, "rect": frame.map { rectJSON($0) as Any } ?? NSNull()])
            if let frame = frame, frame.width < 400 || frame.height < 300 { continue }
            if try string(window, kAXRoleAttribute, path) == kAXSheetRole { sheets.append(window); continue }
            // Native AXChildren is the supported public attribute. System Events'
            // 'sheets' collection is not an exported native kAXSheetsAttribute.
            // Stop at the modal branch, never inventory the editor's timeline.
            var queue = try children(window, path).map { ($0, 1) }, index = 0
            while index < queue.count && index < 120 {
                let (child, depth) = queue[index]; index += 1
                if try string(child, kAXRoleAttribute, "\(path)/child/\(index)") == kAXSheetRole { sheets.append(child); break }
                if depth < 3 { queue.append(contentsOf: try children(child, path).map { ($0, depth + 1) }) }
            }
        }
        var unique: [AXUIElement] = []
        for s in sheets where !unique.contains(where: { CFEqual($0, s) }) { unique.append(s) }
        guard unique.count == 1 else {
            throw PrototypeFailure.stopped("\(unique.count) feuille(s) AXSheet trouvée(s). Une seule feuille d’export doit être ouverte ; aucune commande envoyée.")
        }
        return unique[0]
    }
}

func finalButton(_ snapshot: AXSnapshot) throws -> AXNode {
    let matches = snapshot.nodes.enumerated().filter { $0.element.matches("ExportOkBtn") }
    var candidates: [AXNode] = []
    for (index, node) in matches {
        if node.role == kAXButtonRole { candidates.append(node) }
        else if let p = node.parent, snapshot.nodes[p].role == kAXButtonRole { candidates.append(snapshot.nodes[p]) }
        else if node.actions.contains(kAXPressAction) || node.role == kAXStaticTextRole { candidates.append(snapshot.nodes[index]) }
    }
    var unique: [AXNode] = []
    for n in candidates where !unique.contains(where: { CFEqual($0.element, n.element) }) { unique.append(n) }
    guard unique.count == 1, unique[0].enabled == true, unique[0].hidden != true else {
        throw PrototypeFailure.stopped("ExportOkBtn : \(unique.count) cible(s) actionnable(s), bouton absent, ambigu ou non activé. Aucun clic envoyé. Le rapport détaille les lectures natives.")
    }
    return unique[0]
}

func validatedPoint(button: CGRect, sheet: CGRect, screens: [CGRect]) throws -> CGPoint {
    let point = CGPoint(x: button.midX, y: button.midY)
    guard button.width > 0, button.height > 0, point.x.isFinite, point.y.isFinite,
          sheet.contains(point), sheet.intersection(button).width >= button.width * 0.8,
          sheet.intersection(button).height >= button.height * 0.8,
          screens.contains(where: { $0.contains(point) }) else {
        throw PrototypeFailure.stopped("Coordonnées hors de la feuille ou de l’écran : clic interdit.")
    }
    return point
}
