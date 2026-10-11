import AppKit
import ApplicationServices

func jsonData(_ value: [String: Any], pretty: Bool = false) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: pretty ? [.prettyPrinted, .sortedKeys] : [.sortedKeys])
}
func emit(_ value: [String: Any]) { if let bytes = try? jsonData(value), let text = String(data: bytes, encoding: .utf8) { print(text) } }

final class Recording {
    let folder: URL
    let seconds: Double
    let lock = NSLock()
    var stopped = false
    var completed: (URL?, String) -> Void = { _, _ in }
    var update: (String) -> Void = { _ in }
    init(parent: URL, seconds: Double) {
        self.seconds = seconds
        folder = parent.appendingPathComponent("capcut-record-\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString.prefix(8))", isDirectory: true)
    }
    func stop() { lock.lock(); stopped = true; lock.unlock() }
    func shouldStop() -> Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    func run() {
        let began = Date()
        var count = 0, partial = 0, durations: [Double] = []
        var error: String?
        var manifest: [String: Any] = ["schema": 1, "tool": "capcut-ax", "command": "record", "startedAt": timestamp(),
            "observationOnly": true, "commandAttempted": false, "functionalProof": false,
            "frames": "frames.jsonl", "target": ["capcut": "9.3.0", "architecture": "arm64", "language": "fr"],
            "environment": ["os": ProcessInfo.processInfo.operatingSystemVersionString, "preferredLanguages": Locale.preferredLanguages],
            "captureBudgetSeconds": 0.85, "messagingTimeoutSeconds": 0.25, "sampling": "un relevé par seconde, sans chevauchement", "maximumSeconds": seconds]
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try jsonData(manifest, pretty: true).write(to: folder.appendingPathComponent("record.json"), options: .atomic)
            let framesURL = folder.appendingPathComponent("frames.jsonl")
            guard FileManager.default.createFile(atPath: framesURL.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
            let handle = try FileHandle(forWritingTo: framesURL); defer { try? handle.close() }
            let capture = NativeCapture()
            while !shouldStop() && Date().timeIntervalSince(began) < seconds {
                let tick = Date()
                var frame = capture.capture(); frame["index"] = count
                frame["elapsedSeconds"] = tick.timeIntervalSince(began)
                var bytes = try jsonData(frame); bytes.append(10)
                try handle.write(contentsOf: bytes); try handle.synchronize()
                count += 1
                if !(frame["complete"] as? Bool ?? false) { partial += 1 }
                durations.append(frame["ms"] as? Double ?? 0)
                update("Enregistrement : \(count) relevés · \(Int(Date().timeIntervalSince(began))) s. Fais le cycle manuel dans CapCut, puis termine ici.")
                let next = tick.addingTimeInterval(1)
                while Date() < next && !shouldStop() { Thread.sleep(forTimeInterval: 0.05) }
            }
        } catch let failure { error = String(describing: failure) }
        manifest["endedAt"] = timestamp(); manifest["count"] = count; manifest["partialCount"] = partial
        manifest["durationSeconds"] = Date().timeIntervalSince(began)
        manifest["readDurationsMs"] = ["average": durations.isEmpty ? 0 : durations.reduce(0, +) / Double(durations.count), "maximum": durations.max() ?? 0]
        manifest["stoppedByUser"] = shouldStop()
        manifest["status"] = error == nil ? "releves_enregistres_sans_action" : "erreur_enregistrement"
        manifest["error"] = error.map { $0 as Any } ?? NSNull()
        do { try jsonData(manifest, pretty: true).write(to: folder.appendingPathComponent("record.json"), options: .atomic) }
        catch let failure { error = "Rapport final impossible à écrire : \(failure)" }
        var archive: URL?
        if error == nil {
            let zip = folder.appendingPathExtension("zip")
            do {
                let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
                process.arguments = ["-c", "-k", "--keepParent", folder.path, zip.path]
                process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
                try process.run(); process.waitUntilExit()
                guard process.terminationStatus == 0 else { throw CocoaError(.fileWriteUnknown) }
                archive = zip
            } catch let failure { error = "Relevés conservés, création du ZIP impossible : \(failure)" }
        }
        emit(["ok": error == nil, "command": "record", "folder": folder.path,
              "archive": archive.map { $0.path as Any } ?? NSNull(), "count": count,
              "error": error.map { $0 as Any } ?? NSNull(), "commandAttempted": false, "functionalProof": false])
        completed(archive ?? folder, error ?? "Enregistrement terminé. Envoie le ZIP des relevés ; aucune commande envoyée à CapCut.")
    }
}

final class RecorderApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let parent: URL
    let seconds: Double
    var window: NSWindow!
    var recorder: Recording?
    var running = false
    var resultURL: URL?
    let status = NSTextField(wrappingLabelWithString: "Autorise cet enregistreur, puis démarre l’enregistrement avant le cycle manuel dans CapCut.")
    let start = NSButton(title: "Démarrer l’enregistrement", target: nil, action: nil)
    let finish = NSButton(title: "Terminer l’enregistrement", target: nil, action: nil)
    let show = NSButton(title: "Afficher le ZIP à envoyer", target: nil, action: nil)
    init(parent: URL, seconds: Double) { self.parent = parent; self.seconds = seconds }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 15, y: 510, width: 490, height: 340), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "capcut-ax record — observation seulement"; window.delegate = self
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14
        let title = NSTextField(labelWithString: "Cycle manuel · projet de 5 secondes")
        title.font = .boldSystemFont(ofSize: 18)
        let instructions = NSTextField(wrappingLabelWithString: "Accueil → ouvrir le projet → ouvrir les réglages d’export → Exporter → attendre la fin → fermer le résultat. L’enregistreur ne clique jamais dans CapCut. Tu peux réduire cette fenêtre pendant le cycle.")
        let authorize = NSButton(title: "Autoriser l’Accessibilité de capcut-ax", target: self, action: #selector(permission))
        for view in [title, instructions, status, authorize, start, finish, show] as [NSView] { stack.addArrangedSubview(view) }
        stack.translatesAutoresizingMaskIntoConstraints = false; window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 18), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -18), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 18)])
        start.target = self; start.action = #selector(begin)
        finish.target = self; finish.action = #selector(end)
        show.target = self; show.action = #selector(reveal)
        finish.isEnabled = false; show.isEnabled = false
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        if !CommandLine.arguments.contains("--smoke-ui") {
            emit(["ok": true, "command": "record", "event": "pret", "outputRoot": parent.path,
                  "observationOnly": true, "commandAttempted": false, "requiresStart": true])
        }
        if CommandLine.arguments.contains("--smoke-ui") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                emit(["uiLoaded": true, "commandAttempted": false]); NSApp.terminate(nil)
            }
        }
    }
    @objc func permission() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }
    @objc func begin() {
        guard !running, recorder == nil else { return }
        guard AXIsProcessTrusted() else { status.stringValue = "Active capcut-ax dans Accessibilité, puis reviens démarrer l’enregistrement."; return }
        let recording = Recording(parent: parent, seconds: seconds); recorder = recording
        emit(["ok": true, "command": "record", "event": "demarrage", "folder": recording.folder.path,
              "observationOnly": true, "commandAttempted": false])
        running = true; start.isEnabled = false; finish.isEnabled = true
        recording.update = { [weak self] message in DispatchQueue.main.async { self?.status.stringValue = message } }
        recording.completed = { [weak self] url, message in DispatchQueue.main.async {
            guard let self = self else { return }
            self.running = false; self.finish.isEnabled = false; self.resultURL = url
            self.show.isEnabled = url != nil; self.status.stringValue = message
        } }
        DispatchQueue.global(qos: .userInitiated).async { recording.run() }
    }
    @objc func end() { recorder?.stop(); finish.isEnabled = false; status.stringValue = "Écriture des relevés et préparation du ZIP…" }
    @objc func reveal() { if let url = resultURL { NSWorkspace.shared.activateFileViewerSelecting([url]) } }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if running { end(); return false }; return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if running { end(); return .terminateCancel }; return .terminateNow
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
