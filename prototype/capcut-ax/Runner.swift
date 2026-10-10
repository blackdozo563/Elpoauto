import AppKit
import ApplicationServices

final class PrototypeRunner {
    let report: Evidence
    let cancel: Cancellation
    let ledger: URL
    let expectedName: String
    let allowCoordinates: Bool
    let ax: NativeAX
    var command = SingleCommand()
    init(report: Evidence, cancel: Cancellation, ledger: URL, expectedName: String, allowCoordinates: Bool) {
        self.report = report; self.cancel = cancel; self.ledger = ledger
        self.expectedName = expectedName.precomposedStringWithCanonicalMapping
        self.allowCoordinates = allowCoordinates; ax = NativeAX(report: report, cancel: cancel)
    }
    func nameMatches(_ url: URL) -> Bool {
        let name = url.deletingPathExtension().lastPathComponent
            .replacingOccurrences(of: "\\s*\\([0-9]+\\)$", with: "", options: .regularExpression)
            .precomposedStringWithCanonicalMapping
        return !expectedName.isEmpty && name == expectedName
    }
    func pause(_ seconds: Double) throws {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until { try cancel.check(); Thread.sleep(forTimeInterval: 0.1) }
    }
    func run() {
        do { try execute() }
        catch {
            report.set("status", command.attempted ? "echec_ou_resultat_incertain_apres_commande" : "arrete_avant_commande")
            report.set("error", String(describing: error)); report.set("functionalProof", false)
            report.phase("arret", "\(error)", ["secondCommandForbidden": command.attempted,
                         "ledger": command.attempted ? ledger.path : "aucun"])
        }
        report.set("endedAt", Evidence.timestamp()); report.save()
    }
    private func execute() throws {
        guard AXIsProcessTrusted() else { throw PrototypeFailure.stopped("Autorise CapCut AX Prototype dans les réglages Accessibilité. L’autorisation d’ELPO ne s’applique pas à ce prototype autonome.") }
        guard !FileManager.default.fileExists(atPath: ledger.path) else {
            throw PrototypeFailure.stopped("Un test précédent a envoyé une commande sans preuve de fin. Nouveau clic bloqué. Vérifie CapCut avant de réinitialiser le verrou.")
        }
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.lemon.lvoverseas")
        guard apps.count == 1, let app = apps.first, let bundleURL = app.bundleURL else {
            throw PrototypeFailure.stopped("Une seule instance de CapCut doit être ouverte, sur sa feuille d’export.")
        }
        let version = Bundle(url: bundleURL)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "inconnue"
        report.set("capcut", ["pid": Int(app.processIdentifier), "bundle": app.bundleIdentifier ?? "", "version": version, "path": bundleURL.path])
        guard version == "9.3.0" || version.hasPrefix("9.3.0.") else {
            throw PrototypeFailure.stopped("Version CapCut relevée : \(version). Ce prototype cible 9.3.0 ; aucune commande envoyée.")
        }
        let application = AXUIElementCreateApplication(app.processIdentifier)
        let timeoutCode = AXUIElementSetMessagingTimeout(application, 0.8)
        report.set("messagingTimeout", ["seconds": 0.8, "code": Int(timeoutCode.rawValue)])
        var displayIDs = [CGDirectDisplayID](repeating: 0, count: 16), displayCount: UInt32 = 0
        guard CGGetActiveDisplayList(16, &displayIDs, &displayCount) == .success else { throw PrototypeFailure.stopped("Écrans macOS illisibles.") }
        let screens = displayIDs.prefix(Int(displayCount)).map { CGDisplayBounds($0) }
        report.set("displays", displayIDs.prefix(Int(displayCount)).map { id -> [String: Any] in
            var d: [String: Any] = ["id": id, "bounds": rectJSON(CGDisplayBounds(id))]
            if let mode = CGDisplayCopyDisplayMode(id) { d["pixelWidth"] = mode.pixelWidth; d["pixelHeight"] = mode.pixelHeight }
            return d
        })
        report.phase("reperage", "Recherche native de la feuille AXSheet de CapCut")
        let sheet = try ax.locateSheet(application)
        let first = ax.inspect(sheet, seconds: 20)
        _ = try finalButton(first)
        var target = try outputURL(first)
        guard nameMatches(target) else { throw PrototypeFailure.stopped("Le fichier annoncé ne correspond pas au projet attendu « \(expectedName) » : \(target.lastPathComponent).") }
        report.set("expectedName", expectedName); report.set("announcedOutput", target.path)

        // Activation is the only navigation operation: no window resizing, opening
        // a project, menu command or interaction with the export settings.
        DispatchQueue.main.sync { _ = app.activate(options: [.activateIgnoringOtherApps]) }
        let focusDeadline = Date().addingTimeInterval(3)
        while NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier {
            guard Date() < focusDeadline else { throw PrototypeFailure.stopped("CapCut n’est pas au premier plan ; aucune commande envoyée.") }
            try pause(0.1)
        }
        try pause(0.3)
        // Re-read after activation. The same sheet, button and output must still be
        // present; coordinates are never saved from an earlier session.
        let freshSheet = try ax.locateSheet(application)
        guard CFEqual(sheet, freshSheet) else { throw PrototypeFailure.stopped("La feuille a changé pendant la préparation ; aucune commande envoyée.") }
        let fresh = ax.inspect(freshSheet, seconds: 20)
        let button = try finalButton(fresh)
        guard try outputURL(fresh) == target else { throw PrototypeFailure.stopped("Le chemin de sortie a changé avant la commande.") }
        let folder = target.deletingLastPathComponent()
        var baseline: [String: FileStamp] = [:]
        for file in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] where nameMatches(file) && file.pathExtension.lowercased() == "mp4" {
            if let stamp = FileStamp.read(file) { baseline[file.path] = stamp }
        }
        var tempPrevious = encodingFiles(folder)
        let barsBefore = Dictionary(fresh.nodes.filter { $0.role == kAXProgressIndicatorRole }.map { ($0.path, $0.number ?? -1) }, uniquingKeysWith: { a, _ in a })
        report.set("button", button.json)
        report.set("baselineFile", baseline[target.path].map { $0.json as Any } ?? NSNull())
        var point: CGPoint?
        let usePress = button.actions.contains(kAXPressAction)
        if !usePress {
            guard allowCoordinates, let rect = button.rect,
                  let sheetRect = fresh.nodes.first?.rect else {
                throw PrototypeFailure.stopped("AXPress non disponible et clic par coordonnées impossible ou désactivé. Aucune commande envoyée.")
            }
            point = try validatedPoint(button: rect, sheet: sheetRect, screens: screens)
            var hit: AXUIElement?
            let hitCode = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point!.x), Float(point!.y), &hit)
            report.set("coordinateHitTest", ["code": Int(hitCode.rawValue), "error": axErrorName(hitCode)])
            var belongsToButton = false
            ax.deadline = Date().addingTimeInterval(3)
            if hitCode == .success {
                for _ in 0..<8 {
                    guard let current = hit else { break }
                    if CFEqual(current, button.element) { belongsToButton = true; break }
                    hit = (try ax.get(current, kAXParentAttribute, "coordinateHitTest")) as! AXUIElement?
                }
            }
            guard belongsToButton else { throw PrototypeFailure.stopped("Le contrôle situé sous les coordonnées n’est pas ExportOkBtn ; clic interdit.") }
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { throw PrototypeFailure.stopped("Le premier plan a changé avant la commande ; test arrêté.") }
        try cancel.check()
        // Persist uncertainty BEFORE any side effect, even if the AX call fails or
        // the process crashes. A subsequent launch cannot silently send a retry.
        let marker: [String: Any] = ["at": Evidence.timestamp(), "pid": Int(app.processIdentifier), "target": target.path, "report": report.url.path]
        let bytes = try JSONSerialization.data(withJSONObject: marker, options: .prettyPrinted)
        try bytes.write(to: ledger, options: .withoutOverwriting)
        try command.consume()
        report.set("commandAttempted", true)
        let sentAt = Date()
        report.phase("commande_tentee", usePress ? "Tentative unique AXPress sur ExportOkBtn" : "Clic unique sur les coordonnées natives validées de ExportOkBtn",
                     ["method": usePress ? "AXPress" : "CGEvent", "point": point.map { ["x": $0.x, "y": $0.y] as Any } ?? NSNull()])
        guard report.save() else { throw PrototypeFailure.stopped("Rapport impossible à enregistrer avant la commande ; clic interdit.") }
        if usePress {
            let start = Date(), code = AXUIElementPerformAction(button.element, kAXPressAction as CFString)
            report.set("commandResult", ["code": Int(code.rawValue), "error": axErrorName(code), "ms": Date().timeIntervalSince(start) * 1000,
                                        "acceptedByAPI": code == .success, "exportStartedNotYetProven": true])
            report.set("commandSentConfirmedByAPI", code == .success)
            report.phase(code == .success ? "commande_envoyee" : "commande_reponse_incertaine", "AXPress a répondu : \(axErrorName(code)). Observation sans second clic.")
        } else if let p = point {
            guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left) else {
                throw PrototypeFailure.stopped("Création des événements de clic impossible ; aucun nouvel essai automatique.")
            }
            down.post(tap: .cghidEventTap); Thread.sleep(forTimeInterval: 0.06); up.post(tap: .cghidEventTap)
            report.set("commandResult", ["eventsPosted": true, "exportStartedNotYetProven": true])
            report.phase("commande_envoyee", "Événements de clic envoyés. Le démarrage reste à prouver.")
        }

        var started = false, progressBelowMaximum = false, uiFinished = false
        var stableStamp: FileStamp?, stableSince = Date()
        let deadline = sentAt.addingTimeInterval(7200)
        while Date() < deadline {
            try cancel.check()
            guard !app.isTerminated else { throw PrototypeFailure.stopped("CapCut s’est arrêté pendant l’observation.") }
            let current = ax.inspect(freshSheet, detailed: false, seconds: 4)
            var encodingEvidence: [String: Any]?
            let temps = encodingFiles(folder)
            for (file, stamp) in temps where stamp.size > 0 && stamp.modified >= sentAt.timeIntervalSince1970 - 2 {
                if stamp != tempPrevious[file] { encodingEvidence = ["source": "fichier_temporaire_CapCut", "file": file, "stamp": stamp.json] }
            }
            tempPrevious = temps
            for n in current.nodes where n.role == kAXProgressIndicatorRole {
                if let v = n.number, v.isFinite, v > 0, barsBefore[n.path] != v {
                    encodingEvidence = ["source": "AXProgressIndicator", "path": n.path, "value": v, "maximum": n.maximum.map { $0 as Any } ?? NSNull()]
                    if let max = n.maximum, max > 0, v < max { progressBelowMaximum = true }
                    if let max = n.maximum, max > 0, v >= max, progressBelowMaximum { uiFinished = true }
                }
            }
            // CapCut may add (1) to an existing output name. Accept one newly
            // written file of the same project, not an arbitrary MP4 in Desktop.
            let finals = ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []).filter {
                guard nameMatches($0), $0.pathExtension.lowercased() == "mp4", let stamp = FileStamp.read($0) else { return false }
                return stamp.size > 0 && stamp.modified >= sentAt.timeIntervalSince1970 - 2 && stamp != baseline[$0.path]
            }
            guard finals.count <= 1 else { throw PrototypeFailure.stopped("Plusieurs fichiers nouveaux correspondent au projet ; résultat ambigu.") }
            if let file = finals.first {
                if target != file { target = file; report.set("observedOutput", file.path) }
                encodingEvidence = encodingEvidence ?? ["source": "ecriture_du_fichier_final", "file": file.path, "inferredFromWrittenMedia": true]
            }
            if let evidence = encodingEvidence {
                if !started {
                    started = true; report.set("encodingDetected", true)
                    report.phase("encodage_detecte", "Activité d’export détectée", evidence)
                }
                report.set("latestEncodingEvidence", evidence)
            }
            if uiFinished && !(reportFinishedFlag) {
                reportFinishedFlag = true; report.set("exportFinished", true)
                report.phase("export_termine", "La progression native a atteint son maximum après une valeur inférieure", ["source": "AXProgressIndicator"])
            }
            if let file = finals.first, let stamp = FileStamp.read(file) {
                if stamp != stableStamp { stableStamp = stamp; stableSince = Date() }
                if Date().timeIntervalSince(stableSince) >= 8, (try? mp4Structure(file)) != nil {
                    report.phase("validation_mp4", "Fichier final stable : décodage complet vidéo et audio", ["file": file.path, "stamp": stamp.json])
                    let validation = try validateMedia(file, cancel: cancel)
                    if !uiFinished {
                        report.phase("export_termine", "Fin établie par le fichier final stable et intégralement décodé ; fin de l’interface non observée",
                                     ["source": "fichier_final_decode", "capcutUICompletionObserved": false])
                    }
                    report.set("exportFinished", true); report.set("mp4Validated", true)
                    report.set("validation", validation); report.set("output", file.path)
                    report.set("capcutUICompletionObserved", uiFinished)
                    report.set("functionalProof", true); report.set("status", "export_reel_valide")
                    try FileManager.default.removeItem(at: ledger)
                    report.phase("mp4_valide", "Export réel validé : vidéo et audio intégralement décodés. Rapport enregistré.")
                    return
                }
            } else { stableStamp = nil; stableSince = Date() }
            if !started && Date().timeIntervalSince(sentAt) >= 120 {
                throw PrototypeFailure.stopped("Aucun encodage confirmé après 120 secondes. La commande peut avoir eu un effet : aucun second clic. Le rapport conserve les lectures natives.")
            }
            report.save(); try pause(2)
        }
        throw PrototypeFailure.stopped("Délai de deux heures dépassé. Aucun nouveau clic ni annulation envoyé à CapCut.")
    }
    private var reportFinishedFlag = false
}
