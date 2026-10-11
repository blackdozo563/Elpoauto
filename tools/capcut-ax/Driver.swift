import AppKit
import ApplicationServices

// The hands and eyes of ELPO's CapCut pilot. Three primitives, each answering one
// JSON object on stdout:
//
//   snapshot  reads CapCut's windows natively, the export sheet first, in the
//             format of the 11 Oct 2026 recording (tools/capcut-ax state).
//   press     AXPress on ONE allow-listed CapCut control, found again by its
//             automation label in a fresh read (no coordinates).
//   click     mouse click at a point ELPO computed from CapCut's own frame of a
//             named control; checked first: CapCut frontmost, point inside a CapCut
//             window and on a screen, element under the point owned by CapCut.
//
// The decisions (which screen is shown, which tile, whether the export is over)
// live in lib/capcut-screen.js and lib/capcut-pilot.js, where they are tested on the
// recording. "commandAttempted" tells whether anything was sent to CapCut.

let capcutBundleIdentifier = "com.lemon.lvoverseas"

struct DriverFailure: Error {
    let code: String
    let message: String
    var attempted = false
}

enum SnapshotScope { case all, sheet }

struct NodeInfo {
    let element: AXUIElement
    let path: String
    let parent: Int?
    let window: Int
    let inSheet: Bool
    let role: String
    let title: String
    let axDescription: String
    let identifier: String
    let text: String
    let number: Double?
    let frame: CGRect?
    let enabled: Bool?
    let actions: [String]

    var labels: [String] { [title, axDescription, identifier, text].filter { !$0.isEmpty } }
    func named(_ label: String) -> Bool { labels.contains(label) }
    func labelled(prefix: String) -> String? { labels.first { $0.hasPrefix(prefix) } }
}

struct WindowInfo {
    let element: AXUIElement
    let index: Int
    let title: String
    let frame: CGRect?
    // The EditPilot bubble (183×88), tooltips and toasts are never the page driven.
    var main: Bool { guard let f = frame else { return false }; return f.width >= 400 && f.height >= 300 }
    var area: Double { guard let f = frame else { return 0 }; return Double(f.width * f.height) }
}

struct CapCutSnapshot {
    var windows: [WindowInfo] = []
    var nodes: [NodeInfo] = []
    var incomplete = Set<String>()
    var sheetComplete = true
    var sheetsSeen = 0
    var ms: Double = 0
    var sheetNodes: [NodeInfo] { nodes.filter { $0.inSheet } }
}

func rectJSON(_ rect: CGRect?) -> Any {
    guard let r = rect, r.origin.x.isFinite, r.origin.y.isFinite, r.width.isFinite, r.height.isFinite else { return NSNull() }
    return ["x": Double(r.minX), "y": Double(r.minY), "width": Double(r.width), "height": Double(r.height)]
}

final class NativeReader {
    struct OutOfTime: Error {}
    let pid: pid_t
    let root: AXUIElement
    var deadline = Date.distantFuture
    var incomplete = Set<String>()
    var calls = 0
    var failures = 0
    // Roles whose announced actions matter to ELPO (AXPress); static texts have none
    // in CapCut 9.3.0, so they are not asked (one IPC call saved per node).
    let actionRoles: Set<String> = [kAXButtonRole, kAXCheckBoxRole, kAXScrollBarRole, "AXRadioButton", "AXPopUpButton", "AXMenuItem"]

    init(pid: pid_t) {
        self.pid = pid
        root = AXUIElementCreateApplication(pid)
        // A blocked CapCut answers no call: every call is bounded, the read is not.
        _ = AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
        _ = AXUIElementSetMessagingTimeout(root, 0.25)
    }
    func value(_ element: AXUIElement, _ attribute: String) throws -> CFTypeRef? {
        guard Date() < deadline else { throw OutOfTime() }
        var result: CFTypeRef?
        let code = AXUIElementCopyAttributeValue(element, attribute as CFString, &result)
        calls += 1
        if code == .cannotComplete || code == .invalidUIElement || code == .apiDisabled { incomplete.insert(errorName(code)); failures += 1 }
        return code == .success ? result : nil
    }
    func string(_ element: AXUIElement, _ attribute: String) throws -> String {
        (try value(element, attribute)) as? String ?? ""
    }
    func children(_ element: AXUIElement) throws -> [AXUIElement] {
        (try value(element, kAXChildrenAttribute)) as? [AXUIElement] ?? []
    }
    func frame(_ element: AXUIElement) throws -> CGRect? {
        guard let p = try value(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
              let s = try value(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size),
              point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite else { return nil }
        return CGRect(origin: point, size: size)
    }
    func actionNames(_ element: AXUIElement) throws -> [String] {
        guard Date() < deadline else { throw OutOfTime() }
        var names: CFArray?
        let code = AXUIElementCopyActionNames(element, &names)
        calls += 1
        if code == .cannotComplete || code == .invalidUIElement || code == .apiDisabled { incomplete.insert(errorName(code)); failures += 1 }
        return names as? [String] ?? []
    }
    func node(_ element: AXUIElement, path: String, parent: Int?, window: Int, inSheet: Bool, role known: String?) throws -> NodeInfo {
        let role = try known ?? string(element, kAXRoleAttribute)
        let raw = try value(element, kAXValueAttribute)
        var number: Double?
        if let n = raw as? NSNumber, !(raw is String) {
            let d = n.doubleValue
            if d.isFinite { number = d }
        }
        let enabled = (try value(element, kAXEnabledAttribute)) as? Bool
        return NodeInfo(element: element, path: path, parent: parent, window: window, inSheet: inSheet, role: role,
                        title: try string(element, kAXTitleAttribute),
                        axDescription: try string(element, kAXDescriptionAttribute),
                        identifier: try string(element, kAXIdentifierAttribute),
                        text: raw as? String ?? "", number: number, frame: try frame(element), enabled: enabled,
                        actions: actionRoles.contains(role) ? try actionNames(element) : [])
    }

    // One read of CapCut: windows largest first, and in each main window its modal
    // sheet (CapCut's export dialog) read completely before the editor's panels.
    func snapshot(scope: SnapshotScope, seconds: Double, maxNodes: Int) -> CapCutSnapshot {
        let began = Date()
        deadline = began.addingTimeInterval(seconds)
        incomplete = []
        var shot = CapCutSnapshot()
        var readingSheet = false
        do {
            let list = (try value(root, kAXWindowsAttribute)) as? [AXUIElement] ?? []
            for (index, element) in list.enumerated() {
                let f = try frame(element)
                shot.windows.append(WindowInfo(element: element, index: index, title: try string(element, kAXTitleAttribute), frame: f))
            }
            let order = shot.windows.filter { $0.main }.sorted { $0.area > $1.area }.map { $0.index }
            for w in order {
                let window = shot.windows[w]
                let path = "window/\(w)"
                let windowIndex = shot.nodes.count
                shot.nodes.append(try node(window.element, path: path, parent: nil, window: w, inSheet: false, role: kAXWindowRole))
                var sheets: [(AXUIElement, String)] = []
                var others: [(AXUIElement, String, String)] = []
                for (c, child) in try children(window.element).enumerated() {
                    let role = try string(child, kAXRoleAttribute)
                    if role == kAXSheetRole { sheets.append((child, "\(path)/\(c)")) } else { others.append((child, "\(path)/\(c)", role)) }
                }
                for (sheet, sheetPath) in sheets {
                    shot.sheetsSeen += 1
                    readingSheet = true
                    let failuresBefore = failures
                    // The export sheet holds about 25 controls; 600 means "not that sheet".
                    let sheetLimit = shot.nodes.count + 600
                    var queue: [(AXUIElement, String, Int?, Int, String?)] = [(sheet, sheetPath, windowIndex, 1, kAXSheetRole)]
                    var i = 0
                    while i < queue.count {
                        if shot.nodes.count >= sheetLimit { incomplete.insert("limite_noeuds_feuille"); break }
                        let (e, p, parent, depth, role) = queue[i]; i += 1
                        let n = try node(e, path: p, parent: parent, window: w, inSheet: true, role: role)
                        let index = shot.nodes.count
                        shot.nodes.append(n)
                        if depth < 10 { for (c, child) in try children(e).enumerated() { queue.append((child, "\(p)/\(c)", index, depth + 1, nil)) } }
                    }
                    // A sheet switching views (settings → progress) answers invalidUIElement
                    // mid-read: such a read is never trusted for a command.
                    if i < queue.count || failures != failuresBefore { shot.sheetComplete = false }
                    readingSheet = false
                }
                if scope == .sheet { continue }
                var queue: [(AXUIElement, String, Int?, Int, String?)] = others.map { ($0.0, $0.1, windowIndex, 1, $0.2) }
                var i = 0
                while i < queue.count {
                    if shot.nodes.count >= maxNodes { incomplete.insert("limite_noeuds"); break }
                    let (e, p, parent, depth, role) = queue[i]; i += 1
                    let n = try node(e, path: p, parent: parent, window: w, inSheet: false, role: role)
                    let index = shot.nodes.count
                    shot.nodes.append(n)
                    if depth < 6 { for (c, child) in try children(e).enumerated() { queue.append((child, "\(p)/\(c)", index, depth + 1, nil)) } }
                }
            }
        } catch is OutOfTime {
            incomplete.insert("budget_lecture")
            if readingSheet { shot.sheetComplete = false }
        } catch {
            incomplete.insert(String(describing: error))
            if readingSheet { shot.sheetComplete = false }
        }
        shot.incomplete = incomplete
        shot.ms = Date().timeIntervalSince(began) * 1000
        return shot
    }
}

func nodeJSON(_ n: NodeInfo, in shot: CapCutSnapshot) -> [String: Any] {
    var value: Any = NSNull()
    if !n.text.isEmpty { value = n.text } else if let d = n.number { value = d }
    return ["path": n.path, "parent": n.parent.map { shot.nodes[$0].path as Any } ?? NSNull(), "role": n.role,
            "title": n.title, "description": n.axDescription, "identifier": n.identifier, "value": value,
            "frame": rectJSON(n.frame), "enabled": n.enabled.map { $0 as Any } ?? NSNull(), "actions": n.actions,
            "sheet": n.inSheet]
}

// ---- CapCut process, focus and screens ------------------------------------------

func capcutApplications() -> [NSRunningApplication] {
    NSRunningApplication.runningApplications(withBundleIdentifier: capcutBundleIdentifier).filter { !$0.isTerminated }
}
func capcutVersion(_ app: NSRunningApplication) -> String {
    app.bundleURL.flatMap { Bundle(url: $0)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String } ?? ""
}
func connectCapCut() throws -> NSRunningApplication {
    guard AXIsProcessTrusted() else {
        throw DriverFailure(code: "NO_ACCESS", message: "Accessibilité refusée : autorise ElpoAiAutoCapcut dans Réglages Système → Confidentialité et sécurité → Accessibilité.")
    }
    let apps = capcutApplications()
    guard apps.count == 1 else {
        throw DriverFailure(code: apps.isEmpty ? "NOT_RUNNING" : "SEVERAL_INSTANCES",
                            message: apps.isEmpty ? "CapCut n’est pas ouvert." : "Plusieurs instances de CapCut sont ouvertes : n’en garde qu’une.")
    }
    return apps[0]
}
// Asked to the accessibility server itself: NSWorkspace's cached value is not
// refreshed in a command-line process that runs no event loop.
func focusedPid() -> pid_t? {
    var value: CFTypeRef?
    let code = AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &value)
    guard code == .success, let v = value, CFGetTypeID(v) == AXUIElementGetTypeID() else {
        // This attribute is absent in the user's real 0.7 diagnostic. Workspace
        // supplies the fallback; bringToFront pumps the run loop after activation.
        return NSWorkspace.shared.frontmostApplication?.processIdentifier
    }
    var pid: pid_t = 0
    guard AXUIElementGetPid(v as! AXUIElement, &pid) == .success else { return nil }
    return pid
}
func bringToFront(_ app: NSRunningApplication) -> Bool {
    if focusedPid() == app.processIdentifier { return true }
    _ = app.activate(options: [.activateIgnoringOtherApps])
    let until = Date().addingTimeInterval(3)
    while Date() < until {
        if focusedPid() == app.processIdentifier { return true }
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    return false
}
func displayBounds() -> [CGRect] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(16, &ids, &count) == .success else { return [] }
    return ids.prefix(Int(count)).map { CGDisplayBounds($0) }
}

// A successful AX call is only a command result, never proof of an export.
// Refuse the side effect if another app has taken focus since the fresh read.
func pressInForeground(pid: pid_t, focus: () -> pid_t?, perform: () -> AXError) throws -> AXError {
    guard focus() == pid else {
        throw DriverFailure(code: "NOT_FRONTMOST", message: "CapCut n’est plus au premier plan. Aucun AXPress envoyé.")
    }
    return perform()
}

// ---- Pure rules, shared with lib/capcut-screen.js and checked by --self-test -----

func folded(_ s: String) -> String {
    s.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}
// CapCut names the file after the project, and adds "(1)" when that file exists. A
// project may itself be called "0920 (1)": both readings are accepted.
func targetMatches(path: String, name: String) -> Bool {
    let expected = folded(name)
    guard !expected.isEmpty else { return false }
    var base = (path as NSString).lastPathComponent
    let ext = (base as NSString).pathExtension
    if !ext.isEmpty { base = String(base.dropLast(ext.count + 1)) }
    let file = folded(base)
    if file == expected { return true }
    let stripped = file.replacingOccurrences(of: "\\s*\\([0-9]+\\)$", with: "", options: .regularExpression)
    return stripped == expected
}
func isOutputPath(_ s: String) -> Bool {
    s.hasPrefix("/") && s.range(of: "\\.(mp4|mov|m4v)$", options: [.regularExpression, .caseInsensitive]) != nil
}
// Controls ELPO may press, and the sheet view each belongs to. Nothing else is ever
// pressed: not « Partager » (publish_pc_btn), not the export progress's cancel button.
let pressableControls: [String: String] = [
    "ExportOkBtn": "settings",        // « Exporter » of the export settings: starts the export
    "automationcancel": "settings",   // « Annuler » of the settings view: no export running
    "automationcloseBtn": "done",     // « Fermer » of the end-of-export panel
]
func sheetView(_ sheet: [NodeInfo]) -> String {
    if sheet.contains(where: { $0.named("ExportOkBtn") }) { return "settings" }
    if sheet.contains(where: { $0.labelled(prefix: "ExportProgress:") != nil }) { return "exporting" }
    if sheet.contains(where: { $0.named("automationcloseBtn") || $0.named("publish_pc_btn") || $0.named("automationopenFolderBtn") }) { return "done" }
    return sheet.isEmpty ? "none" : "other"
}
// A click point must lie on a screen and inside a main CapCut window. CapCut draws
// its own title bar: the editor's « Exporter » (MainWindowTitleBarExportBtn, centre
// y 64 in a window starting at y 46) sits in it, so no title-bar margin is applied.
func pointAllowed(_ point: CGPoint, windows: [CGRect], screens: [CGRect]) -> Bool {
    guard point.x.isFinite, point.y.isFinite else { return false }
    guard screens.contains(where: { $0.contains(point) }) else { return false }
    return windows.contains { w in w.width >= 400 && w.height >= 300 && point.x >= w.minX + 2 && point.x <= w.maxX - 2 && point.y >= w.minY + 2 && point.y <= w.maxY - 2 }
}

// ---- Commands ---------------------------------------------------------------------

func baseResult(_ command: String) -> [String: Any] {
    ["schema": 2, "tool": "capcut-ax", "command": command, "at": timestamp(), "commandAttempted": false]
}
func failureResult(_ command: String, _ failure: DriverFailure, extra: [String: Any] = [:]) -> [String: Any] {
    var r = baseResult(command)
    for (k, v) in extra { r[k] = v }
    r["ok"] = false; r["code"] = failure.code; r["message"] = failure.message
    r["commandAttempted"] = failure.attempted || (extra["commandAttempted"] as? Bool ?? false)
    return r
}

func snapshotCommand(scope: SnapshotScope, seconds: Double) -> [String: Any] {
    var r = baseResult("snapshot")
    r["scope"] = scope == .sheet ? "sheet" : "all"
    let trusted = AXIsProcessTrusted()
    let apps = capcutApplications()
    r["trusted"] = trusted; r["runningInstances"] = apps.count
    guard trusted, apps.count == 1 else {
        r["ok"] = false; r["complete"] = false; r["sheetComplete"] = false; r["windows"] = [Any]()
        r["code"] = !trusted ? "NO_ACCESS" : apps.isEmpty ? "NOT_RUNNING" : "SEVERAL_INSTANCES"
        r["message"] = !trusted ? "Accessibilité refusée pour ElpoAiAutoCapcut." : apps.isEmpty ? "CapCut n’est pas ouvert." : "Plusieurs instances de CapCut sont ouvertes."
        return r
    }
    let app = apps[0]
    let reader = NativeReader(pid: app.processIdentifier)
    let shot = reader.snapshot(scope: scope, seconds: max(0.5, min(seconds, 15)), maxNodes: 2500)
    let focused = focusedPid()
    r["capcut"] = ["pid": Int(app.processIdentifier), "version": capcutVersion(app), "path": app.bundleURL?.path ?? ""]
    r["focusedPID"] = focused.map { Int($0) as Any } ?? NSNull()
    r["frontmost"] = focused == app.processIdentifier
    r["windows"] = shot.windows.map { w -> [String: Any] in
        ["path": "window/\(w.index)", "title": w.title, "frame": rectJSON(w.frame), "main": w.main,
         "nodes": shot.nodes.filter { $0.window == w.index }.map { nodeJSON($0, in: shot) }]
    }
    r["nodesRead"] = shot.nodes.count
    r["sheetsSeen"] = shot.sheetsSeen
    r["sheetComplete"] = shot.sheetComplete
    r["complete"] = shot.incomplete.isEmpty
    r["incompleteReasons"] = shot.incomplete.sorted()
    r["calls"] = reader.calls
    r["ms"] = shot.ms
    r["ok"] = shot.incomplete.isEmpty
    return r
}

func pressCommand(label: String, expectName: String?, mouse: Bool = false) -> [String: Any] {
    var r = baseResult("press")
    r["label"] = label
    do {
        guard let view = pressableControls[label] else {
            throw DriverFailure(code: "LABEL_REFUSED", message: "« \(label) » ne fait pas partie des commandes autorisées (ExportOkBtn, automationcancel, automationcloseBtn).")
        }
        guard !mouse || label == "ExportOkBtn" || label == "automationcloseBtn" else {
            throw DriverFailure(code: "LABEL_REFUSED", message: "Le clic souris dans la feuille est réservé à Exporter et Fermer.")
        }
        let app = try connectCapCut()
        r["focusedPIDBeforeActivation"] = focusedPid().map { Int($0) as Any } ?? NSNull()
        guard bringToFront(app) else {
            throw DriverFailure(code: "NOT_FRONTMOST", message: "CapCut n’a pas pu passer au premier plan. Aucun AXPress envoyé.")
        }
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.3))
        r["focusedPID"] = focusedPid().map { Int($0) as Any } ?? NSNull()
        r["capcutPID"] = Int(app.processIdentifier)
        // Locate the sheet and its control again AFTER activation, as in the
        // standalone prototype. Never reuse a background AX element.
        let reader = NativeReader(pid: app.processIdentifier)
        let shot = reader.snapshot(scope: .sheet, seconds: 4, maxNodes: 50)
        guard shot.sheetsSeen == 1 else {
            throw DriverFailure(code: shot.sheetsSeen == 0 ? "NO_SHEET" : "SEVERAL_SHEETS", message: "\(shot.sheetsSeen) feuille(s) CapCut ouverte(s) : la commande « \(label) » demande exactement la feuille d’export.")
        }
        guard shot.sheetComplete else {
            throw DriverFailure(code: "SHEET_UNREADABLE", message: "La feuille d’export n’a pas pu être lue entièrement (\(shot.incomplete.sorted().joined(separator: ", "))). Aucune commande envoyée.")
        }
        let sheet = shot.sheetNodes
        let shown = sheetView(sheet)
        r["view"] = shown
        guard shown == view else {
            throw DriverFailure(code: "WRONG_VIEW", message: "La feuille CapCut affiche « \(shown) » alors que « \(label) » appartient à « \(view) ». Aucune commande envoyée.")
        }
        if label == "ExportOkBtn" {
            guard let name = expectName, !folded(name).isEmpty else {
                throw DriverFailure(code: "NAME_REQUIRED", message: "Le nom du projet attendu est obligatoire pour lancer un export.")
            }
            let targets = Set(sheet.flatMap { $0.labels }.filter { isOutputPath($0) })
            guard targets.count == 1, let target = targets.first else {
                throw DriverFailure(code: "TARGET_UNREADABLE", message: "\(targets.count) chemin(s) de sortie lu(s) dans la feuille d’export : le projet ne peut pas être confirmé. Aucun export envoyé.")
            }
            r["target"] = target
            guard targetMatches(path: target, name: name) else {
                throw DriverFailure(code: "TARGET_MISMATCH", message: "CapCut s’apprête à exporter « \((target as NSString).lastPathComponent) » et non « \(name) ». Aucun export envoyé.")
            }
        }
        var candidates: [NodeInfo] = []
        for n in sheet where n.named(label) {
            if n.role == kAXButtonRole || n.role == kAXCheckBoxRole { candidates.append(n) }
            else if let p = n.parent, shot.nodes[p].role == kAXButtonRole { candidates.append(shot.nodes[p]) }
        }
        var unique: [NodeInfo] = []
        for c in candidates where !unique.contains(where: { CFEqual($0.element, c.element) }) { unique.append(c) }
        guard unique.count == 1, let button = unique.first else {
            throw DriverFailure(code: "CONTROL_AMBIGUOUS", message: "\(unique.count) bouton(s) « \(label) » trouvé(s) dans la feuille. Aucune commande envoyée.")
        }
        r["control"] = ["role": button.role, "frame": rectJSON(button.frame), "actions": button.actions]
        guard button.enabled != false else {
            throw DriverFailure(code: "CONTROL_DISABLED", message: "Le bouton « \(label) » est désactivé dans CapCut. Aucune commande envoyée.")
        }
        if mouse {
            // The user's two real reports show successful AXPress with no effect.
            // Choose ONE native mouse command instead; never AXPress then click.
            guard let rect = button.frame, let sheetNode = sheet.first(where: { $0.role == kAXSheetRole }), let sheetRect = sheetNode.frame,
                  let point = exportClickPoint(button: rect, sheet: sheetRect, windows: shot.windows.compactMap { $0.main ? $0.frame : nil }, screens: displayBounds()) else {
                throw DriverFailure(code: "POINT_INVALID", message: "Le cadre natif de « \(label) » n’est pas entièrement dans la feuille et la fenêtre visibles. Aucun clic envoyé.")
            }
            r["method"] = "CGEvent"
            r["point"] = ["x": Double(point.x), "y": Double(point.y)]
            var hit: AXUIElement?
            let hitCode = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit)
            r["hitResult"] = errorName(hitCode)
            reader.deadline = Date().addingTimeInterval(2)
            var chain: [[String: Any]] = []
            var verified = false
            var containerHit = false
            var verification = "none"
            var current = hit
            if hitCode == .success {
                for _ in 0..<10 {
                    guard let node = current else { break }
                    var owner: pid_t = 0
                    guard AXUIElementGetPid(node, &owner) == .success, owner == app.processIdentifier else { break }
                    let role = try reader.string(node, kAXRoleAttribute)
                    let description = try reader.string(node, kAXDescriptionAttribute)
                    let frame = try reader.frame(node)
                    chain.append(["role": role, "identifier": try reader.string(node, kAXIdentifierAttribute), "title": try reader.string(node, kAXTitleAttribute), "description": description, "frame": rectJSON(frame)])
                    if chain.count == 1 {
                        // On the real Mac, hit-testing this button returns the
                        // sheet-wide static ExportDialog, not the AXButton.
                        // Require that exact element in our complete native read,
                        // and later its exact AXSheet ancestor. Never accept a
                        // bare window, an arbitrary label or another button.
                        let sameContainer = sheet.contains { $0.role == kAXStaticTextRole && $0.axDescription == "ExportDialog" && CFEqual($0.element, node) }
                        containerHit = observedExportContainer(role: role, description: description, frame: frame, button: rect, sameElement: sameContainer)
                    }
                    if CFEqual(node, button.element) { verified = true; verification = "exact-button"; break }
                    if containerHit && CFEqual(node, sheetNode.element) { verified = true; verification = "same-sheet-ExportDialog"; break }
                    guard let parent = try reader.value(node, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
                    current = (parent as! AXUIElement)
                }
            }
            r["hitChain"] = chain; r["hitVerified"] = verified; r["hitVerification"] = verification
            guard verified else {
                throw DriverFailure(code: "HIT_MISMATCH", message: "Le contrôle sous le centre natif n’est pas « \(label) » dans sa feuille. Aucun clic envoyé.")
            }
            // Re-read after the hit-test: the same sheet, unique button, frame and
            // announced path must still be present before preparing any event.
            let fresh = reader.snapshot(scope: .sheet, seconds: 3, maxNodes: 50)
            let freshButtons = fresh.sheetNodes.filter { $0.role == kAXButtonRole && $0.named(label) }
            let freshTargets = Set(fresh.sheetNodes.flatMap { $0.labels }.filter { isOutputPath($0) })
            let sameOutput = label != "ExportOkBtn" || (freshTargets.count == 1 && freshTargets.first == (r["target"] as? String))
            guard fresh.sheetsSeen == 1, fresh.sheetComplete, sheetView(fresh.sheetNodes) == view,
                  fresh.sheetNodes.contains(where: { $0.role == kAXSheetRole && CFEqual($0.element, sheetNode.element) }),
                  freshButtons.count == 1, let freshButton = freshButtons.first,
                  CFEqual(freshButton.element, button.element), freshButton.frame == button.frame, freshButton.enabled != false,
                  sameOutput else {
                throw DriverFailure(code: "TARGET_CHANGED", message: "La feuille, le bouton ou le fichier annoncé a changé avant le clic. Aucun clic envoyé.")
            }
            guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
                  let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
                throw DriverFailure(code: "EVENT_FAILED", message: "Événement souris impossible à créer. Aucun clic envoyé.")
            }
            down.setIntegerValueField(.mouseEventClickState, value: 1)
            up.setIntegerValueField(.mouseEventClickState, value: 1)
            // Consume the command only at the last moment; no retry after posting.
            guard focusedPid() == app.processIdentifier else {
                throw DriverFailure(code: "NOT_FRONTMOST", message: "Le premier plan a changé avant le clic. Aucun clic envoyé.")
            }
            r["commandAttempted"] = true
            move.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.12)
            // Once mouseDown is posted, always post mouseUp; never leave it held.
            guard focusedPid() == app.processIdentifier else {
                throw DriverFailure(code: "CLICK_UNCERTAIN", message: "Le premier plan a changé après le déplacement souris. Aucun bouton souris envoyé ; commande non répétée.", attempted: true)
            }
            down.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.05)
            up.post(tap: .cghidEventTap)
            r["ok"] = true
            r["clickPosted"] = true
            return r
        }
        r["method"] = "AXPress"
        guard button.actions.contains(kAXPressAction) else {
            throw DriverFailure(code: "NO_PRESS", message: "Le bouton « \(label) » n’annonce pas AXPress. Aucune commande envoyée.")
        }
        // CapCut answers the press only once its handler has run (the export starts in
        // it): the 0.25 s read timeout would report a received press as a failure.
        _ = AXUIElementSetMessagingTimeout(button.element, 6)
        let began = Date()
        let code = try pressInForeground(pid: app.processIdentifier, focus: focusedPid) {
            r["commandAttempted"] = true
            return AXUIElementPerformAction(button.element, kAXPressAction as CFString)
        }
        r["pressResult"] = errorName(code)
        r["pressMs"] = Date().timeIntervalSince(began) * 1000
        guard code == .success else {
            throw DriverFailure(code: "PRESS_UNCERTAIN", message: "AXPress sur « \(label) » a répondu \(errorName(code)) : la commande a peut-être été reçue. Aucun nouvel essai automatique.", attempted: true)
        }
        r["ok"] = true
        return r
    } catch let failure as DriverFailure {
        return failureResult("press", failure, extra: r)
    } catch {
        return failureResult("press", DriverFailure(code: "DRIVER_ERROR", message: String(describing: error)), extra: r)
    }
}

// AX coordinates and CGEvent coordinates are macOS points, including on Retina.
// No multiplication by scaleFactor; the complete button must belong to its sheet.
func exportClickPoint(button: CGRect, sheet: CGRect, windows: [CGRect], screens: [CGRect]) -> CGPoint? {
    guard [button.minX, button.minY, button.width, button.height, sheet.minX, sheet.minY, sheet.width, sheet.height].allSatisfy({ $0.isFinite }),
          button.width > 4, button.height > 4, sheet.contains(button), windows.contains(where: { $0.contains(button) }) else { return nil }
    let point = CGPoint(x: button.midX, y: button.midY)
    return pointAllowed(point, windows: windows, screens: screens) ? point : nil
}

// Restricted fallback for the exact hit-test behaviour recorded on CapCut 9.3.0.
// The caller separately verifies ownership and the identical AXSheet ancestor.
func observedExportContainer(role: String, description: String, frame: CGRect?, button: CGRect, sameElement: Bool) -> Bool {
    guard sameElement, role == kAXStaticTextRole, description == "ExportDialog", let frame = frame,
          [frame.minX, frame.minY, frame.width, frame.height].allSatisfy({ $0.isFinite }) else { return false }
    return frame.contains(button)
}

func clickCommand(x: Double, y: Double, double: Bool, expect: String, strict: Bool) -> [String: Any] {
    var r = baseResult("click")
    r["point"] = ["x": x, "y": y]
    r["expect"] = expect
    r["double"] = double
    do {
        guard !expect.isEmpty else { throw DriverFailure(code: "EXPECT_REQUIRED", message: "Le contrôle attendu sous le point est obligatoire.") }
        guard x.isFinite, y.isFinite else { throw DriverFailure(code: "POINT_INVALID", message: "Point de clic invalide.") }
        let point = CGPoint(x: x, y: y)
        let app = try connectCapCut()
        let reader = NativeReader(pid: app.processIdentifier)
        let shot = reader.snapshot(scope: .sheet, seconds: 3, maxNodes: 10)
        guard pointAllowed(point, windows: shot.windows.compactMap { $0.main ? $0.frame : nil }, screens: displayBounds()) else {
            throw DriverFailure(code: "POINT_OUTSIDE_CAPCUT", message: "Le point (\(Int(x)), \(Int(y))) n’est pas dans une fenêtre CapCut visible. Aucun clic envoyé.")
        }
        // A modal sheet absorbs clicks meant for the page behind it.
        guard shot.sheetsSeen == 0 else {
            throw DriverFailure(code: "SHEET_OPEN", message: "Une feuille CapCut est ouverte : aucun clic sur la page derrière elle.")
        }
        guard bringToFront(app) else {
            throw DriverFailure(code: "NOT_FRONTMOST", message: "CapCut n’a pas pu passer au premier plan. Aucun clic envoyé.")
        }
        // CapCut may be busy for a moment (cannotComplete): the question is asked again.
        var hit: AXUIElement?
        var hitCode = AXError.cannotComplete
        for attempt in 0..<4 {
            if attempt > 0 { Thread.sleep(forTimeInterval: 0.25) }
            hit = nil
            hitCode = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &hit)
            if hitCode == .success, hit != nil { break }
        }
        guard hitCode == .success, let element = hit else {
            throw DriverFailure(code: "HIT_TEST_FAILED", message: "macOS ne dit pas ce qui se trouve sous le point (\(errorName(hitCode))). Aucun clic envoyé.")
        }
        var owner: pid_t = 0
        guard AXUIElementGetPid(element, &owner) == .success, owner == app.processIdentifier else {
            throw DriverFailure(code: "HIT_OTHER_APP", message: "Une autre application couvre CapCut à cet endroit. Aucun clic envoyé.")
        }
        reader.deadline = Date().addingTimeInterval(2)
        var chain: [[String: Any]] = []
        var verified = false
        var current: AXUIElement? = element
        for _ in 0..<8 {
            guard let c = current else { break }
            let labels = [try reader.string(c, kAXTitleAttribute), try reader.string(c, kAXDescriptionAttribute),
                          try reader.string(c, kAXIdentifierAttribute), (try reader.value(c, kAXValueAttribute)) as? String ?? ""].filter { !$0.isEmpty }
            chain.append(["role": try reader.string(c, kAXRoleAttribute), "labels": labels])
            if labels.contains(where: { $0 == expect || $0.hasPrefix(expect) }) { verified = true; break }
            guard let parent = try reader.value(c, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
            current = (parent as! AXUIElement)
        }
        r["hitChain"] = chain
        r["hitVerified"] = verified
        if strict && !verified {
            throw DriverFailure(code: "HIT_MISMATCH", message: "Le contrôle sous le point n’est pas « \(expect) ». Aucun clic envoyé.")
        }
        guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
            throw DriverFailure(code: "EVENT_FAILED", message: "Événement souris impossible à créer. Aucun clic envoyé.")
        }
        var events: [(CGEvent, CGEvent)] = []
        for state in (double ? [1, 2] : [1]) {
            guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
                throw DriverFailure(code: "EVENT_FAILED", message: "Événement souris impossible à créer. Aucun clic envoyé.")
            }
            down.setIntegerValueField(.mouseEventClickState, value: Int64(state))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(state))
            events.append((down, up))
        }
        r["commandAttempted"] = true
        move.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.12)
        for (index, pair) in events.enumerated() {
            if index > 0 { Thread.sleep(forTimeInterval: 0.08) }
            pair.0.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.05)
            pair.1.post(tap: .cghidEventTap)
        }
        r["ok"] = true
        return r
    } catch let failure as DriverFailure {
        return failureResult("click", failure, extra: r)
    } catch {
        return failureResult("click", DriverFailure(code: "DRIVER_ERROR", message: String(describing: error), attempted: r["commandAttempted"] as? Bool ?? false), extra: r)
    }
}

// Pure checks only: no CapCut, no event, no accessibility call.
func driverSelfTest() -> [String: Any] {
    var failures: [String] = []
    func expect(_ ok: Bool, _ what: String) { if !ok { failures.append(what) } }
    expect(targetMatches(path: "/Users/demo/Desktop/LIYO.mp4", name: "LIYO"), "nom exact")
    expect(targetMatches(path: "/Users/demo/Desktop/TESTO(1).mp4", name: "TESTO"), "suffixe (1)")
    expect(targetMatches(path: "/Users/demo/Desktop/0920 (1).mp4", name: "0920 (1)"), "projet nommé avec (1)")
    expect(targetMatches(path: "/Users/demo/Desktop/0920 (1)(1).mp4", name: "0920 (1)"), "projet (1) exporté deux fois")
    expect(!targetMatches(path: "/Users/demo/Desktop/TESTO.mp4", name: "TEST"), "TEST n’est pas TESTO")
    expect(!targetMatches(path: "/Users/demo/Desktop/LIYO.mp4", name: ""), "nom vide refusé")
    expect(isOutputPath("/Users/demo/Desktop/LIYO.mp4") && isOutputPath("/a/B.MOV") && !isOutputPath("LIYO.mp4") && !isOutputPath("/a/b.mp4 x"), "chemin de sortie")
    expect(pressableControls["publish_pc_btn"] == nil && pressableControls["MainWindowTitleBarExportBtn"] == nil, "liste blanche des boutons")
    let window = CGRect(x: 80, y: 46, width: 1280, height: 720), screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let exportButton = CGRect(x: 992, y: 697, width: 72, height: 28)
    let closeButton = CGRect(x: 912, y: 685, width: 72, height: 22)
    let sheet = CGRect(x: 360, y: 82, width: 720, height: 663)
    let container = CGRect(x: 360, y: 75, width: 720, height: 663)
    expect(observedExportContainer(role: kAXStaticTextRole, description: "ExportDialog", frame: container, button: exportButton, sameElement: true), "fond ExportDialog du relevé réel")
    expect(!observedExportContainer(role: kAXWindowRole, description: "ExportDialog", frame: container, button: exportButton, sameElement: true), "fenêtre seule refusée")
    expect(!observedExportContainer(role: kAXStaticTextRole, description: "ExportDialog", frame: container, button: exportButton, sameElement: false), "autre élément homonyme refusé")
    expect(!observedExportContainer(role: kAXButtonRole, description: "automationcancel", frame: container, button: exportButton, sameElement: true), "autre bouton refusé")
    expect(!observedExportContainer(role: kAXStaticTextRole, description: "ExportDialog", frame: CGRect(x: 0, y: 0, width: 100, height: 100), button: exportButton, sameElement: true), "fond ne couvrant pas Exporter refusé")
    expect(exportClickPoint(button: exportButton, sheet: sheet, windows: [window], screens: [screen]) == CGPoint(x: 1028, y: 711), "bouton du relevé réel, points Retina sans mise à l’échelle")
    expect(exportClickPoint(button: closeButton, sheet: sheet, windows: [window], screens: [screen]) == CGPoint(x: 948, y: 696), "bouton Fermer du lot réel, points Retina")
    expect(exportClickPoint(button: exportButton.offsetBy(dx: 200, dy: 0), sheet: sheet, windows: [window], screens: [screen]) == nil, "bouton hors feuille refusé")
    expect(exportClickPoint(button: exportButton, sheet: sheet, windows: [window], screens: [CGRect(x: 0, y: 0, width: 900, height: 600)]) == nil, "point hors écran refusé")
    expect(pointAllowed(CGPoint(x: 1309, y: 64), windows: [window], screens: [screen]), "bouton Exporter de l’éditeur")
    expect(!pointAllowed(CGPoint(x: 1309, y: 47), windows: [window], screens: [screen]), "bord de fenêtre refusé")
    expect(!pointAllowed(CGPoint(x: 1400, y: 64), windows: [window], screens: [screen]), "hors fenêtre refusé")
    expect(!pointAllowed(CGPoint(x: 100, y: 100), windows: [CGRect(x: 1185, y: 690, width: 183, height: 88)], screens: [screen]), "bulle EditPilot ignorée")
    var sends = 0
    for pid in [nil, pid_t(2)] as [pid_t?] {
        do {
            _ = try pressInForeground(pid: 1, focus: { pid }) { sends += 1; return .success }
            expect(false, "AXPress doit refuser un premier plan absent ou différent")
        } catch let error as DriverFailure { expect(error.code == "NOT_FRONTMOST" && !error.attempted, "refus avant AXPress") }
        catch { expect(false, "erreur de premier plan explicite") }
    }
    expect(sends == 0, "aucun envoi hors premier plan")
    do {
        let code = try pressInForeground(pid: 1, focus: { 1 }) { sends += 1; return .cannotComplete }
        expect(code == .cannotComplete && sends == 1, "réponse incertaine conservée, un seul envoi")
    } catch { expect(false, "commande au premier plan") }
    var r = baseResult("--self-test")
    r["ok"] = failures.isEmpty
    r["failures"] = failures
    r["capcutExercised"] = false
    return r
}
