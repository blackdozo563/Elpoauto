import Foundation

enum PrototypeFailure: Error, CustomStringConvertible {
    case stopped(String)
    var description: String { switch self { case .stopped(let message): return message } }
}

final class Cancellation {
    private let lock = NSLock()
    private var value = false
    func stop() { lock.lock(); value = true; lock.unlock() }
    func check() throws {
        lock.lock(); let stopped = value; lock.unlock()
        if stopped { throw PrototypeFailure.stopped("Observation interrompue. Aucune commande d’annulation envoyée à CapCut.") }
    }
}

final class Evidence {
    let url: URL
    private var phases: [[String: Any]] = []
    private var reads: [[String: Any]] = []
    private var snapshots: [[String: Any]] = []
    private var aggregates: [String: [String: Double]] = [:]
    private var dropped = 0
    private var fields: [String: Any] = [:]
    var update: (String) -> Void = { _ in }
    init(url: URL) {
        self.url = url
        fields = ["schema": 1, "prototype": "capcut-ax-swift-1", "startedAt": Self.timestamp(),
                  "functionalProof": false, "status": "en_cours", "commandAttempted": false,
                  "encodingDetected": false, "exportFinished": false, "mp4Validated": false,
                  "environment": ["os": ProcessInfo.processInfo.operatingSystemVersionString,
                                  "architecture": "arm64", "targetCapCut": "9.3.0", "targetLanguage": "fr",
                                  "systemLocale": Locale.current.identifier, "preferredLanguages": Locale.preferredLanguages]]
    }
    static func timestamp() -> String { ISO8601DateFormatter().string(from: Date()) }
    func set(_ key: String, _ value: Any) { fields[key] = value }
    func phase(_ name: String, _ message: String, _ details: [String: Any] = [:]) {
        phases.append(["at": Self.timestamp(), "phase": name, "message": message, "details": details])
        update(message); save()
    }
    func read(_ record: [String: Any]) {
        let key = record["attribute"] as? String ?? "actions"
        var s = aggregates[key] ?? ["count": 0, "errors": 0, "ms": 0, "maxMs": 0]
        let ms = record["ms"] as? Double ?? 0
        s["count", default: 0] += 1; s["ms", default: 0] += ms
        s["maxMs"] = max(s["maxMs"] ?? 0, ms)
        if (record["code"] as? Int ?? 0) != 0 { s["errors", default: 0] += 1 }
        aggregates[key] = s
        if reads.count < 30000 { reads.append(record) } else { dropped += 1 }
    }
    func snapshot(_ value: [String: Any]) {
        snapshots.append(value)
        // Keep the initial evidence and recent monitoring snapshots, explicitly.
        if snapshots.count > 14 { snapshots.remove(at: 2) }
    }
    @discardableResult func save() -> Bool {
        var document = fields
        document["phases"] = phases; document["reads"] = reads
        document["readStatistics"] = aggregates; document["omittedReadDetails"] = dropped
        document["snapshots"] = snapshots; document["snapshotRetention"] = "deux premiers et douze derniers"
        do {
            let bytes = try JSONSerialization.data(withJSONObject: document, options: [.prettyPrinted, .sortedKeys])
            try bytes.write(to: url, options: .atomic)
            return true
        } catch { update("Impossible d’écrire le rapport : \(error)"); return false }
    }
}

// A attempted command consumes the sole authorization, including an AX error.
// There is deliberately no transition from 'attempted' back to 'ready'.
struct SingleCommand {
    private(set) var attempted = false
    mutating func consume() throws {
        guard !attempted else { throw PrototypeFailure.stopped("Deuxième commande interdite : le premier export peut avoir démarré.") }
        attempted = true
    }
}
