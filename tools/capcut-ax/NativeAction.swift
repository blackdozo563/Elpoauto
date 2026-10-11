import AppKit
import ApplicationServices

final class NativeAction {
    let capture = NativeCapture()
    var attempted = false
    var snapshot: Document = [:]
    func run(command: String, name: String?, directory: String?) -> Document {
        let began = Date()
        do {
            snapshot = capture.capture()
            _ = try actionPlan(snapshot, command: command, name: name, directory: directory)
            let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.lemon.lvoverseas")
            try require(apps.count == 1, "AX_PROCESS", "Instance CapCut non unique.")
            let app = apps[0]
            let version = app.bundleURL.flatMap { Bundle(url: $0)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String } ?? ""
            try require(version == "9.3.0" || version.hasPrefix("9.3.0."), "AX_VERSION", "Ce pilote est vérifié contre les relevés de CapCut 9.3.0.")
            app.activate(options: [.activateIgnoringOtherApps])
            let focusDeadline = Date().addingTimeInterval(2)
            while NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier && Date() < focusDeadline { Thread.sleep(forTimeInterval: 0.05) }
            try require(NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier, "AX_FOCUS", "CapCut n’est pas au premier plan.")
            // No cached coordinates survive activation or a new native capture.
            snapshot = capture.capture()
            let plan = try actionPlan(snapshot, command: command, name: name, directory: directory)
            guard let targetPath = plan["targetPath"] as? String, let element = capture.elements[targetPath],
                  let point = plan["point"] as? [String: Double], let x = point["x"], let y = point["y"] else { throw AXFailure("AX_CONTROL", "Contrôle natif perdu avant la commande.") }
            let method = plan["method"] as? String ?? ""
            let location = CGPoint(x: x, y: y)
            var events: [CGEvent] = []
            if method != "AXPress" {
                var screens = [CGDirectDisplayID](repeating: 0, count: 16), count: UInt32 = 0
                try require(CGGetActiveDisplayList(16, &screens, &count) == .success && screens.prefix(Int(count)).contains(where: { CGDisplayBounds($0).contains(location) }), "AX_COORDINATES", "Point natif hors de l’écran.")
                var hit: AXUIElement?
                let code = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &hit)
                try require(code == .success && hit != nil, "AX_HIT_TEST", "Hit-test natif illisible ; clic interdit.")
                var belongs = false, cursor = hit
                for _ in 0..<12 {
                    guard let current = cursor else { break }
                    if CFEqual(current, element) { belongs = true; break }
                    var parent: CFTypeRef?
                    guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parent) == .success,
                          let p = parent, CFGetTypeID(p) == AXUIElementGetTypeID() else { break }
                    cursor = (p as! AXUIElement)
                }
                try require(belongs, "AX_HIT_TEST", "Le contrôle sous les coordonnées n’est pas la cible native. Aucun clic envoyé.")
                let clicks = command == "open-project" ? 2 : 1
                for n in 1...clicks {
                    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
                        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: location, mouseButton: .left) else { throw AXFailure("AX_EVENT", "Événement souris impossible à préparer.") }
                        event.setIntegerValueField(.mouseEventClickState, value: Int64(n)); events.append(event)
                    }
                }
            }
            try require(NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier, "AX_FOCUS", "Le premier plan a changé. Aucune commande envoyée.")
            var ledger: URL?
            if command == "press-export" {
                guard let output = plan["outputPath"] as? String else { throw AXFailure("AX_OUTPUT", "Fichier annoncé illisible.") }
                try require(!FileManager.default.fileExists(atPath: output), "AX_OUTPUT_EXISTS", "Le fichier annoncé existe déjà. Aucun export ni remplacement envoyé.")
                let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("CapCutAX/Commandes", isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let token = "\(app.processIdentifier)-\(Int(app.launchDate?.timeIntervalSince1970 ?? 0))"
                let file = folder.appendingPathComponent(token + ".json")
                try require(!FileManager.default.fileExists(atPath: file.path), "AX_SECOND_COMMAND", "Une commande d’export a déjà été tentée dans cette instance. Aucun second clic.")
                try jsonData(["at": timestamp(), "pid": Int(app.processIdentifier), "outputPath": output, "commandAttempted": true, "resultUncertain": true], pretty: true).write(to: file, options: .withoutOverwriting)
                ledger = file
            }
            attempted = true
            var response: Document = ["ok": true, "command": command, "commandAttempted": true, "method": method, "plan": plan, "before": snapshot,
                                       "ms": Date().timeIntervalSince(began) * 1000, "encodingDetected": false, "exportFinished": false]
            if method == "AXPress" {
                let start = Date(), code = AXUIElementPerformAction(element, kAXPressAction as CFString)
                response["action"] = ["code": Int(code.rawValue), "error": errorName(code), "ms": Date().timeIntervalSince(start) * 1000]
                response["ok"] = code == .success
                if code != .success { response["code"] = "AX_ACTION_UNCERTAIN"; response["error"] = "AXPress a répondu \(errorName(code)). Aucun nouvel essai ni clic de secours." }
            } else {
                for (i,event) in events.enumerated() {
                    if i == 2 { Thread.sleep(forTimeInterval: 0.08) }
                    event.post(tap: .cghidEventTap)
                }
            }
            if let output = plan["outputPath"] { response["outputPath"] = output }
            response["ms"] = Date().timeIntervalSince(began) * 1000
            if let file = ledger { try jsonData(response, pretty: true).write(to: file, options: .atomic) }
            return response
        } catch {
            return ["ok": false, "command": command, "commandAttempted": attempted,
                    "code": (error as? AXFailure)?.code ?? "AX_ERROR", "error": String(describing: error),
                    "snapshot": snapshot, "ms": Date().timeIntervalSince(began) * 1000]
        }
    }
}
