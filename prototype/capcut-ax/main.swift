import AppKit
import ApplicationServices

let args = CommandLine.arguments
if args.contains("--version") { print("CapCut AX Prototype 1 — preuve réelle requise"); exit(0) }
if args.contains("--self-test") {
    do {
        var command = SingleCommand(); try command.consume()
        do { try command.consume(); fatalError("La deuxième commande a été acceptée") } catch {}
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let sheet = CGRect(x: 360, y: 126, width: 720, height: 695)
        let point = try validatedPoint(button: CGRect(x: 992, y: 741, width: 72, height: 28), sheet: sheet, screens: [screen])
        precondition(point == CGPoint(x: 1028, y: 755))
        do { _ = try validatedPoint(button: CGRect(x: 10, y: 10, width: 72, height: 28), sheet: sheet, screens: [screen]); fatalError("Point extérieur accepté") } catch {}
        print("{\"checks\":[\"commande unique\",\"coordonnées Retina en points\",\"point extérieur refusé\"],\"functionalProof\":false,\"capcutExercised\":false}")
        exit(0)
    } catch { fputs("\(error)\n", stderr); exit(1) }
}
if let index = args.firstIndex(of: "--verify-mp4"), index + 1 < args.count {
    do {
        let result = try validateMedia(URL(fileURLWithPath: args[index + 1]), cancel: Cancellation())
        let bytes = try JSONSerialization.data(withJSONObject: ["validation": result, "functionalProof": false, "capcutExercised": false], options: .prettyPrinted)
        print(String(data: bytes, encoding: .utf8)!); exit(0)
    } catch { fputs("\(error)\n", stderr); exit(1) }
}

final class PrototypeApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    let status = NSTextField(wrappingLabelWithString: "Ouvre le projet dans CapCut, puis sa feuille d’export. Le test ne navigue pas dans les projets.")
    let expected = NSTextField(string: "TESTO")
    let start = NSButton(title: "Lancer le test d’export", target: nil, action: nil)
    let permission = NSButton(title: "Autoriser ce prototype", target: nil, action: nil)
    let chooseFolder = NSButton(title: "Choisir le dossier d’export déjà configuré dans CapCut", target: nil, action: nil)
    let stop = NSButton(title: "Arrêter l’observation", target: nil, action: nil)
    let reveal = NSButton(title: "Afficher le rapport JSON", target: nil, action: nil)
    let reset = NSButton(title: "Réinitialiser le verrou après vérification dans CapCut", target: nil, action: nil)
    let fallback = NSButton(checkboxWithTitle: "Permettre le clic validé si AXPress n’est pas disponible", target: nil, action: nil)
    var running = false, attemptedInProcess = false
    var cancellation: Cancellation?
    var reportURL: URL?
    var authorizedFolder: URL?
    let ledgerDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ElpoCapcutAXPrototype", isDirectory: true)
    var ledger: URL { ledgerDirectory.appendingPathComponent("commande-en-attente.json") }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 650, height: 610), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "CapCut AX Prototype — test natif du bouton final"; window.center(); window.delegate = self
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        let heading = NSTextField(labelWithString: "CapCut 9.3.0 · prototype autonome ARM64")
        heading.font = .boldSystemFont(ofSize: 18)
        let explanation = NSTextField(wrappingLabelWithString: "Un seul Exporter sera envoyé. Ensuite le prototype observe CapCut et décode intégralement la vidéo produite. Aucune fermeture, annulation ou seconde commande n’est envoyée à CapCut.")
        let nameRow = NSStackView(views: [NSTextField(labelWithString: "Projet attendu :"), expected]); nameRow.orientation = .horizontal
        expected.widthAnchor.constraint(equalToConstant: 350).isActive = true
        fallback.state = .on
        let views: [NSView] = [heading, explanation, nameRow, fallback, status, permission, chooseFolder, start, stop, reveal, reset]
        for view in views { stack.addArrangedSubview(view) }
        stack.translatesAutoresizingMaskIntoConstraints = false; window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 20), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -20), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 20)])
        for (button, selector) in [(permission, #selector(authorize)), (chooseFolder, #selector(selectFolder)), (start, #selector(begin)), (stop, #selector(stopObserving)), (reveal, #selector(showReport)), (reset, #selector(resetLedger))] { button.target = self; button.action = selector }
        stop.isEnabled = false; reveal.isEnabled = false
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        if FileManager.default.fileExists(atPath: ledger.path) { status.stringValue = "Une commande précédente est sans preuve de fin. Nouveau test bloqué : vérifie d’abord CapCut." }
        if args.contains("--smoke-ui") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                print("{\"uiLoaded\":true,\"commandAttempted\":false,\"functionalProof\":false}"); NSApp.terminate(nil)
            }
        }
    }
    @objc func authorize() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
        status.stringValue = "Active CapCut AX Prototype dans Accessibilité, puis reviens lancer le test. Cette app a sa propre autorisation."
    }
    @objc func begin() {
        guard !running, !attemptedInProcess else { return }
        guard AXIsProcessTrusted() else { status.stringValue = "Autorise d’abord CapCut AX Prototype dans Accessibilité."; return }
        guard let authorizedFolder = authorizedFolder else { status.stringValue = "Choisis d’abord le dossier d’export de CapCut pour accorder son accès avant le test."; return }
        do {
            try FileManager.default.createDirectory(at: ledgerDirectory, withIntermediateDirectories: true)
            guard !FileManager.default.fileExists(atPath: ledger.path) else { status.stringValue = "Verrou actif : aucune nouvelle commande autorisée."; return }
            let directory = ledgerDirectory.appendingPathComponent("Rapports", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("capcut-ax-\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString.prefix(8)).json")
            let report = Evidence(url: url)
            report.update = { [weak self] message in DispatchQueue.main.async { self?.status.stringValue = message } }
            guard report.save() else { throw PrototypeFailure.stopped("Le rapport ne peut pas être enregistré sur le Bureau.") }
            reportURL = url; reveal.isEnabled = true
            let cancel = Cancellation(); cancellation = cancel
            let runner = PrototypeRunner(report: report, cancel: cancel, ledger: ledger, expectedName: expected.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), allowCoordinates: fallback.state == .on, authorizedFolder: authorizedFolder)
            running = true; start.isEnabled = false; expected.isEnabled = false; fallback.isEnabled = false; permission.isEnabled = false; chooseFolder.isEnabled = false; reset.isEnabled = false; stop.isEnabled = true
            DispatchQueue.global(qos: .userInitiated).async {
                runner.run()
                DispatchQueue.main.async {
                    self.running = false; self.attemptedInProcess = runner.command.attempted
                    self.stop.isEnabled = false; self.permission.isEnabled = true
                    self.chooseFolder.isEnabled = !runner.command.attempted
                    // A command consumes this process' test authorization permanently.
                    self.start.isEnabled = !runner.command.attempted
                    self.expected.isEnabled = !runner.command.attempted; self.fallback.isEnabled = !runner.command.attempted
                    self.reset.isEnabled = FileManager.default.fileExists(atPath: self.ledger.path)
                }
            }
        } catch { status.stringValue = String(describing: error) }
    }
    @objc func stopObserving() { cancellation?.stop(); status.stringValue = "Arrêt de l’observation demandé. CapCut continue son éventuel export." }
    @objc func selectFolder() {
        guard !running else { return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.allowsMultipleSelection = false; panel.prompt = "Autoriser ce dossier"
        panel.message = "Choisis le dossier déjà indiqué dans la feuille d’export CapCut. Le prototype ne modifie pas ce réglage."
        if panel.runModal() == .OK, let folder = panel.url {
            do {
                // The system picker grants user-selected folder access before Run,
                // including Desktop's privacy protection. No post-click TCC dialog.
                _ = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
                authorizedFolder = folder; chooseFolder.title = "Dossier autorisé : \(folder.path)"
                status.stringValue = "Dossier accessible. Vérifie le projet attendu et lance le test."
            } catch { status.stringValue = "Dossier inaccessible : \(error)" }
        }
    }
    @objc func showReport() { if let url = reportURL { NSWorkspace.shared.activateFileViewerSelecting([url]) } }
    @objc func resetLedger() {
        guard !running else { return }
        let alert = NSAlert(); alert.messageText = "As-tu vérifié CapCut ?"
        alert.informativeText = "Réinitialise seulement si aucun export n’est en cours et si la feuille de réglages est de nouveau prête. Le prototype ne peut pas déduire cela d’une ancienne lecture incertaine."
        alert.addButton(withTitle: "Annuler"); alert.addButton(withTitle: "J’ai vérifié : réinitialiser")
        if alert.runModal() == .alertSecondButtonReturn {
            do { if FileManager.default.fileExists(atPath: ledger.path) { try FileManager.default.removeItem(at: ledger) }; status.stringValue = "Verrou réinitialisé. Si ce processus a déjà envoyé une commande, quitte et rouvre le prototype avant un nouveau test." }
            catch { status.stringValue = "Verrou non réinitialisé : \(error)" }
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if running { status.stringValue = "Le test est en cours. Utilise Arrêter l’observation si nécessaire."; return false }
        return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let application = NSApplication.shared
let delegate = PrototypeApp()
application.setActivationPolicy(.regular)
application.delegate = delegate
let menu = NSMenu(), applicationMenu = NSMenu(), item = NSMenuItem()
applicationMenu.addItem(withTitle: "Quitter CapCut AX Prototype", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
item.submenu = applicationMenu; menu.addItem(item); application.mainMenu = menu
application.run()
