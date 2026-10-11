import AppKit

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "record"
switch command {
case "--record-self-test":
    // Technical verification of file writing and ZIP finalization only. No
    // CapCut actions, and no claim of a functional export.
    let parent = FileManager.default.temporaryDirectory.appendingPathComponent("capcut-record-self-test-\(UUID().uuidString)")
    let recording = Recording(parent: parent, seconds: 2)
    recording.run()
    do {
        let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: recording.folder.appendingPathComponent("record.json"))) as! [String: Any]
        let lines = try String(contentsOf: recording.folder.appendingPathComponent("frames.jsonl"), encoding: .utf8).split(separator: "\n")
        guard manifest["status"] as? String == "releves_enregistres_sans_action",
              manifest["count"] as? Int == lines.count, lines.count > 0,
              FileManager.default.fileExists(atPath: recording.folder.appendingPathExtension("zip").path) else { exit(1) }
        for (index, line) in lines.enumerated() {
            let frame = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
            guard frame["index"] as? Int == index, frame["observationOnly"] as? Bool == true,
                  frame["commandAttempted"] as? Bool == false else { exit(1) }
        }
        try FileManager.default.removeItem(at: parent)
    } catch { fputs("\(error)\n", stderr); exit(1) }
case "state":
    emit(NativeCapture().capture())
case "record", "--smoke-ui":
    func option(_ key: String) -> String? {
        guard let index = args.firstIndex(of: key), index + 1 < args.count else { return nil }; return args[index + 1]
    }
    let seconds = Double(option("--seconds") ?? "180") ?? 0
    guard seconds >= 10, seconds <= 1800 else {
        emit(["ok": false, "error": "--seconds doit être entre 10 et 1800.", "commandAttempted": false]); exit(2)
    }
    let defaultParent = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("CapCutAX/Enregistrements", isDirectory: true)
    let parent = option("--output").map { URL(fileURLWithPath: $0, isDirectory: true) } ?? defaultParent
    let application = NSApplication.shared, delegate = RecorderApp(parent: parent, seconds: seconds)
    application.setActivationPolicy(.regular); application.delegate = delegate
    let menu = NSMenu(), submenu = NSMenu(), item = NSMenuItem()
    submenu.addItem(withTitle: "Quitter capcut-ax", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    item.submenu = submenu; menu.addItem(item); application.mainMenu = menu
    application.run()
case "--version":
    emit(["tool": "capcut-ax", "phase": "releves_avant_refonte", "availableCommands": ["state", "record"], "commandAttempted": false])
default:
    emit(["ok": false, "command": command, "error": "Commande non implémentée avant les relevés du cycle manuel. Disponibles : state | record [--seconds N] [--output dossier]. Aucune commande envoyée à CapCut.", "commandAttempted": false]); exit(2)
}
