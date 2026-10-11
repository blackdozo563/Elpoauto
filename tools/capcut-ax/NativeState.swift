import AppKit

typealias Document = [String: Any]
struct AXFailure: Error, CustomStringConvertible {
    let code: String
    let description: String
    init(_ code: String, _ message: String) { self.code = code; description = message }
}
func require(_ condition: Bool, _ code: String, _ message: String) throws {
    if !condition { throw AXFailure(code, message) }
}
func hasID(_ node: Document, _ id: String) -> Bool {
    ["identifier", "title", "description"].contains { node[$0] as? String == id }
}
func frameRect(_ node: Document) -> CGRect? {
    guard let f = node["frame"] as? [String: Double], let x = f["x"], let y = f["y"], let w = f["width"], let h = f["height"],
          [x,y,w,h].allSatisfy({ $0.isFinite }), w > 0, h > 0 else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}
func mainWindows(_ snapshot: Document) -> [Document] {
    (snapshot["windows"] as? [Document] ?? []).filter { w in
        guard let f = frameRect(w) else { return false }; return f.width >= 400 && f.height >= 300
    }
}
func nativeState(_ snapshot: Document) -> Document {
    var state: Document = ["page": "unknown", "percent": NSNull(), "outputPath": NSNull()]
    guard snapshot["complete"] as? Bool == true, snapshot["trusted"] as? Bool == true else { return state }
    if snapshot["runningInstances"] as? Int == 0 { state["page"] = "closed"; return state }
    let windows = mainWindows(snapshot)
    guard windows.count == 1 else { return state }
    let window = windows[0], nodes = window["nodes"] as? [Document] ?? []
    let sheets = nodes.filter { $0["role"] as? String == "AXSheet" }
    state["windowPath"] = window["path"]
    if sheets.count == 1, let sheetPath = sheets[0]["path"] as? String {
        let children = nodes.filter { ($0["path"] as? String ?? "").hasPrefix(sheetPath + "/") }
        let button = { (id: String) in children.filter { $0["role"] as? String == "AXButton" && hasID($0,id) } }
        state["sheetPath"] = sheetPath
        if button("ExportOkBtn").count == 1 && children.contains(where: { hasID($0, "ExportPathInput") }) {
            state["page"] = "export-settings"
            let paths = Set(children.flatMap { n in ["description","value"].compactMap { n[$0] as? String } }.filter {
                $0.hasPrefix("/") && $0.lowercased().hasSuffix(".mp4")
            }.map { $0.precomposedStringWithCanonicalMapping })
            if paths.count == 1 { state["outputPath"] = paths.first }
        } else if button("automationcloseBtn").count == 1 && button("automationopenFolderBtn").count == 1 {
            state["page"] = "done"
        } else {
            let percents = Set(children.compactMap { n -> Double? in
                guard n["role"] as? String == "AXStaticText", let d = n["description"] as? String,
                      d.range(of: "^ExportProgress:[0-9]+(?:\\.[0-9]+)?%$", options: .regularExpression) != nil,
                      let p = Double(d.dropFirst("ExportProgress:".count).dropLast()), (0...100).contains(p) else { return nil }
                return p
            })
            if percents.count == 1 { state["page"] = "encoding"; state["percent"] = percents.first }
        }
    } else if sheets.isEmpty {
        if nodes.contains(where: { hasID($0,"HomePageDraft") }) { state["page"] = "home" }
        else if nodes.contains(where: { hasID($0,"MainWindowTitleBarExportBtn") }) { state["page"] = "editor" }
    }
    return state
}

// Plans are pure, replayable against the real AX captures. No visible-text
// guessing, calibration, shortcut or screen-scale multiplication.
func actionPlan(_ snapshot: Document, command: String, name: String?, directory: String?) throws -> Document {
    let state = nativeState(snapshot)
    let expected = command == "open-project" ? "home" : command == "open-export" ? "editor" : command == "press-export" ? "export-settings" : "done"
    try require(state["page"] as? String == expected, "AX_STATE", "État attendu : \(expected) ; état relevé : \(state["page"] ?? "unknown"). Aucune commande envoyée.")
    let window = mainWindows(snapshot)[0], nodes = window["nodes"] as? [Document] ?? []
    var scope = nodes
    if let sheet = state["sheetPath"] as? String { scope = nodes.filter { ($0["path"] as? String ?? "").hasPrefix(sheet + "/") } }
    var target: Document?
    if command == "open-project" {
        let tiles = nodes.filter { hasID($0,"HomePageDraft") && $0["role"] as? String == "AXStaticText" && frameRect($0) != nil }
        let titles = nodes.filter { n in
            guard let d = n["description"] as? String, let r = frameRect(n) else { return false }
            return d.hasPrefix("HomePageDraftTitle:") && r.height <= 30
        }
        try require(name?.isEmpty == false, "AX_NAME", "Nom du projet requis.")
        let named = titles.filter { ($0["description"] as? String)?.precomposedStringWithCanonicalMapping == "HomePageDraftTitle:" + name!.precomposedStringWithCanonicalMapping }
        if !titles.isEmpty {
            try require(named.count == 1, "CAPCUT_TILE", "Titre natif exact du projet absent ou ambigu. Aucun clic envoyé.")
            let titleFrame = frameRect(named[0])!
            let matches = tiles.filter { frameRect($0)!.contains(titleFrame) }
            try require(matches.count == 1, "CAPCUT_TILE", "Le titre ne correspond pas à une vignette native unique. Aucun clic sur le titre.")
            target = matches[0]
        } else {
            // bumpProject places this project first while CapCut is closed. The
            // export's announced filename will confirm identity before AXPress.
            let visible = tiles.filter { frameRect($0)!.intersection(frameRect(window)!).height >= 40 }
            target = visible.sorted { a,b in
                let fa = frameRect(a)!, fb = frameRect(b)!
                return fa.minY != fb.minY ? fa.minY < fb.minY : fa.minX < fb.minX
            }.first
        }
    } else {
        let id = command == "open-export" ? "MainWindowTitleBarExportBtn" : command == "press-export" ? "ExportOkBtn" : "automationcloseBtn"
        let matches = scope.filter { hasID($0,id) }
        let buttons = matches.filter { $0["role"] as? String == "AXButton" }
        let choices = buttons.isEmpty ? matches.filter { $0["role"] as? String == "AXStaticText" } : buttons
        try require(choices.count == 1, "AX_CONTROL", "Contrôle natif \(id) absent ou ambigu.")
        target = choices[0]
    }
    guard let node = target, let targetRect = frameRect(node), let bounds = frameRect(window) else { throw AXFailure("AX_CONTROL", "Contrôle natif sans cadre exploitable.") }
    try require(node["enabled"] as? Bool == true && node["hidden"] as? Bool != true, "AX_CONTROL", "Contrôle masqué ou non activable.")
    var area = targetRect.intersection(bounds)
    if let sheet = state["sheetPath"] as? String, let container = nodes.first(where: { $0["path"] as? String == sheet }), let rect = frameRect(container) { area = area.intersection(rect) }
    try require(!area.isNull && area.width >= (command == "open-project" ? 40 : 1) && area.height >= (command == "open-project" ? 40 : 1), "AX_COORDINATES", "Contrôle hors de la fenêtre native.")
    var plan: Document = ["command": command, "targetPath": node["path"] ?? "", "target": node,
                         "point": ["x": Double(area.midX), "y": Double(area.midY)], "doubleClick": command == "open-project",
                         "method": (node["actions"] as? [String] ?? []).contains("AXPress") ? "AXPress" : "native-hit-tested-click"]
    if command == "press-export" {
        guard let output = state["outputPath"] as? String, let name = name, let dir = directory else { throw AXFailure("AX_OUTPUT", "Nom, dossier et fichier MP4 annoncé requis.") }
        let url = URL(fileURLWithPath: output)
        let stem = url.deletingPathExtension().lastPathComponent.replacingOccurrences(of: "\\s*\\([0-9]+\\)$", with: "", options: .regularExpression)
        try require(stem == name.precomposedStringWithCanonicalMapping, "AX_IDENTITY", "Le fichier annoncé ne correspond pas au projet attendu.")
        let expectedDir = URL(fileURLWithPath: dir).resolvingSymlinksInPath().path.precomposedStringWithCanonicalMapping
        try require(url.deletingLastPathComponent().resolvingSymlinksInPath().path.precomposedStringWithCanonicalMapping == expectedDir, "AX_OUTPUT", "Le dossier annoncé diffère du dossier demandé. Aucun changement des réglages de CapCut.")
        plan["outputPath"] = output
    }
    return plan
}
