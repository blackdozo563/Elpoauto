import Foundation

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "record"
func option(_ key: String) -> String? {
    guard let index = args.firstIndex(of: key), index + 1 < args.count else { return nil }
    return args[index + 1]
}
// One JSON answer, then an exit status ELPO can also read: 0 done, 3 refused before
// anything was sent to CapCut, 4 sent but the outcome is uncertain.
func finish(_ result: [String: Any]) -> Never {
    emit(result)
    if result["ok"] as? Bool == true { exit(0) }
    exit(result["commandAttempted"] as? Bool == true ? 4 : 3)
}

switch command {
case "--record-self-test":
    recordSelfTest()
case "state":
    // Full observation, as in the recordings: every node and every AX read.
    emit(NativeCapture().capture())
case "snapshot":
    finish(snapshotCommand(scope: option("--scope") == "sheet" ? .sheet : .all, seconds: Double(option("--budget") ?? "") ?? 3))
case "press":
    finish(pressCommand(label: option("--label") ?? "", expectName: option("--expect-name"), mouse: args.contains("--mouse")))
case "click":
    finish(clickCommand(x: Double(option("--x") ?? "") ?? .nan, y: Double(option("--y") ?? "") ?? .nan,
                        double: args.contains("--double"), expect: option("--expect") ?? "", strict: args.contains("--strict")))
case "--self-test":
    finish(driverSelfTest())
case "record", "--smoke-ui":
    runRecorder(arguments: args)
case "--version":
    emit(["tool": "capcut-ax", "schema": 2, "phase": "pilote_natif",
          "exportMethod": "CGEvent-validated-single",
          "exportHitPolicy": "same-button-or-same-sheet-ExportDialog",
          "availableCommands": ["snapshot", "press", "click", "state", "record", "--self-test"],
          "pressable": pressableControls.keys.sorted(), "commandAttempted": false])
default:
    finish(["ok": false, "command": command, "code": "UNKNOWN_COMMAND",
            "message": "Commande inconnue. Disponibles : snapshot [--scope sheet] [--budget s] | press --label L [--expect-name N] | click --x X --y Y --expect L [--double] [--strict] | state | record. Aucune commande envoyée à CapCut.",
            "commandAttempted": false])
}
