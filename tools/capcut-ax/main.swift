import AppKit

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "record"
func option(_ key: String) -> String? {
    guard let index = args.firstIndex(of: key), index + 1 < args.count else { return nil }; return args[index + 1]
}
switch command {
case "open-project", "open-export", "press-export", "close-done":
    let name = command == "open-project" ? args.dropFirst().first : option("--name")
    let response = NativeAction().run(command: command, name: name, directory: option("--dir"))
    emit(response); if response["ok"] as? Bool != true { exit(2) }
case "--replay":
    do {
        guard args.count == 2 else { throw AXFailure("AX_REPLAY", "Fichier de relevés requis.") }
        let input = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[1]))) as! Document
        let frames = input["frames"] as! [Document]
        var results: [Document] = []
        for frame in frames {
            let state = nativeState(frame), page = state["page"] as? String ?? "unknown"
            let action = page == "home" ? "open-project" : page == "editor" ? "open-export" : page == "export-settings" ? "press-export" : page == "done" ? "close-done" : "none"
            var result: Document = ["index": frame["fixtureSourceIndex"] ?? frame["index"] ?? 0, "state": state]
            if action != "none" { result["plan"] = try actionPlan(frame, command: action, name: "LIYO", directory: "/Users/recording/Desktop") }
            results.append(result)
        }
        let settings = frames.first { $0["fixtureSourceIndex"] as? Int == 13 }!
        let plan = try actionPlan(settings, command: "press-export", name: "LIYO", directory: "/Users/recording/Desktop")
        let point = plan["point"] as! [String: Double]
        try require(point["x"] == 1028 && point["y"] == 711 && plan["method"] as? String == "AXPress", "AX_REPLAY", "Bouton final ou coordonnées Retina incorrects.")
        for (name, dir) in [("Autre", "/Users/recording/Desktop"), ("LIYO", "/tmp")] {
            var refused = false
            do { _ = try actionPlan(settings, command: "press-export", name: name, directory: dir) } catch { refused = true }
            try require(refused, "AX_REPLAY", "Nom ou dossier incorrect accepté.")
        }
        var partial = settings; partial["complete"] = false
        try require(nativeState(partial)["page"] as? String == "unknown", "AX_REPLAY", "Une lecture partielle confirme un état.")
        var refused = false
        do { _ = try actionPlan(partial, command: "press-export", name: "LIYO", directory: "/Users/recording/Desktop") } catch { refused = true }
        try require(refused, "AX_REPLAY", "Commande acceptée sur une lecture partielle.")
        emit(["ok": true, "results": results, "commandAttempted": false, "functionalProof": false])
    } catch { emit(["ok": false, "error": String(describing: error), "commandAttempted": false]); exit(1) }
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
    var snapshot = NativeCapture().capture(); snapshot["state"] = nativeState(snapshot); emit(snapshot)
case "record", "--smoke-ui":
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
    emit(["tool": "capcut-ax", "phase": "pilote_natif_sur_releves", "availableCommands": ["state", "open-project", "open-export", "press-export", "close-done", "record"], "commandAttempted": false])
default:
    emit(["ok": false, "command": command, "error": "Commande non implémentée avant les relevés du cycle manuel. Disponibles : state | record [--seconds N] [--output dossier]. Aucune commande envoyée à CapCut.", "commandAttempted": false]); exit(2)
}
