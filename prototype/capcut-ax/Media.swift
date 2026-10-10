import Foundation
import AVFoundation
import CoreVideo
import AudioToolbox

struct FileStamp: Equatable {
    let size: UInt64
    let modified: Double
    let inode: UInt64
    static func read(_ url: URL) -> FileStamp? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: url.path),
              a[.type] as? FileAttributeType == .typeRegular else { return nil }
        return FileStamp(size: (a[.size] as? NSNumber)?.uint64Value ?? 0,
                         modified: (a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0,
                         inode: (a[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0)
    }
    var json: [String: Any] { ["size": size, "modified": modified, "inode": inode] }
}

// Checks complete top-level ISO BMFF boxes, not a text search for 'moov'.
// A moov atom plus all declared bytes is a prerequisite, never the final proof.
func mp4Structure(_ url: URL) throws -> [String: Any] {
    let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
    let length = try handle.seekToEnd(); try handle.seek(toOffset: 0)
    var offset: UInt64 = 0, boxes: [String] = []
    func integer(_ bytes: Data) -> UInt64 { bytes.reduce(UInt64(0)) { ($0 << 8) | UInt64($1) } }
    while offset < length {
        guard length - offset >= 8 else { throw PrototypeFailure.stopped("MP4 tronqué : en-tête incomplet.") }
        try handle.seek(toOffset: offset)
        let head = try handle.read(upToCount: 8) ?? Data()
        guard head.count == 8 else { throw PrototypeFailure.stopped("MP4 tronqué : lecture incomplète.") }
        var size = integer(head.prefix(4)); var header: UInt64 = 8
        let type = String(data: head.suffix(4), encoding: .ascii) ?? "?"
        if size == 1 {
            let extended = try handle.read(upToCount: 8) ?? Data()
            guard extended.count == 8 else { throw PrototypeFailure.stopped("MP4 tronqué : taille étendue absente.") }
            size = integer(extended); header = 16
        } else if size == 0 { size = length - offset }
        guard size >= header, size <= length - offset else { throw PrototypeFailure.stopped("MP4 tronqué : atome \(type) incomplet.") }
        boxes.append(type); offset += size
        if boxes.count > 10000 { throw PrototypeFailure.stopped("Trop d’atomes MP4 ; structure refusée.") }
    }
    guard length > 0, boxes.contains("ftyp"), boxes.contains("moov"), boxes.contains("mdat") else {
        throw PrototypeFailure.stopped("MP4 non finalisé : ftyp, moov ou mdat absent.")
    }
    return ["bytes": length, "boxes": boxes, "completeBoxes": true]
}

// Decode the complete video and audio with macOS' own codecs. Metadata or file
// stability alone cannot validate the produced media.
func validateMedia(_ url: URL, cancel: Cancellation, timeout: Double = 1800) throws -> [String: Any] {
    let start = Date(), before = FileStamp.read(url)
    let structure = try mp4Structure(url)
    let asset = AVURLAsset(url: url)
    let duration = CMTimeGetSeconds(asset.duration)
    let videos = asset.tracks(withMediaType: .video), audios = asset.tracks(withMediaType: .audio)
    guard asset.isPlayable, duration.isFinite, duration > 0, videos.count == 1 else {
        throw PrototypeFailure.stopped("Vidéo non lisible, durée invalide ou nombre de pistes vidéo inattendu.")
    }
    let reader = try AVAssetReader(asset: asset)
    let tracks = videos + audios
    var outputs: [AVAssetReaderTrackOutput] = []
    for track in tracks {
        let settings: [String: Any] = track.mediaType == .video
            ? [kCVPixelBufferPixelFormatTypeKey as String: NSNumber(value: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)]
            : [AVFormatIDKey: NSNumber(value: kAudioFormatLinearPCM)]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw PrototypeFailure.stopped("Piste non décodable par AVFoundation.") }
        reader.add(output); outputs.append(output)
    }
    guard reader.startReading() else { throw PrototypeFailure.stopped("Décodage impossible : \(reader.error?.localizedDescription ?? "erreur inconnue").") }
    var active = Set(outputs.indices), counts = Array(repeating: 0, count: outputs.count)
    var ends = Array(repeating: 0.0, count: outputs.count)
    do {
        while !active.isEmpty {
            try cancel.check()
            guard Date().timeIntervalSince(start) < timeout else { throw PrototypeFailure.stopped("Délai du décodage complet dépassé.") }
            autoreleasepool {
                for i in Array(active) {
                    guard let sample = outputs[i].copyNextSampleBuffer() else { active.remove(i); continue }
                    if CMSampleBufferIsValid(sample) {
                        counts[i] += 1
                        let t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
                        let d = CMTimeGetSeconds(CMSampleBufferGetDuration(sample))
                        if t.isFinite { ends[i] = max(ends[i], t + (d.isFinite && d > 0 ? d : 0)) }
                    }
                }
            }
        }
    } catch { reader.cancelReading(); throw error }
    guard reader.status == .completed, counts.allSatisfy({ $0 > 0 }), ends[0] >= duration - 0.5 else {
        throw PrototypeFailure.stopped("Décodage incomplet : \(reader.error?.localizedDescription ?? "fin de piste prématurée").")
    }
    guard before == FileStamp.read(url) else { throw PrototypeFailure.stopped("Le fichier a changé pendant la validation ; aucune preuve de fin.") }
    return ["structure": structure, "durationSeconds": duration, "videoTracks": videos.count,
            "audioTracks": audios.count, "decodedSamples": counts, "lastSampleEnds": ends,
            "allTracksDecoded": true, "unchangedDuringValidation": true,
            "validationMs": Date().timeIntervalSince(start) * 1000]
}

func encodingFiles(_ directory: URL) -> [String: FileStamp] {
    let fm = FileManager.default
    let dirs = (try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
    var files: [String: FileStamp] = [:]
    for dir in dirs where dir.lastPathComponent.range(of: "^\\.__capcut_export_temp_folder_[0-9]+__$", options: .regularExpression) != nil {
        for file in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] where file.pathExtension.lowercased() == "mp4" {
            if let stamp = FileStamp.read(file) { files[file.path] = stamp }
        }
    }
    return files
}

func outputURL(_ snapshot: AXSnapshot) throws -> URL {
    var paths = Set<String>()
    for n in snapshot.nodes {
        for text in [n.text, n.title, n.description] where text.hasPrefix("/") && text.lowercased().hasSuffix(".mp4") {
            paths.insert(text.precomposedStringWithCanonicalMapping)
        }
    }
    guard paths.count == 1, let path = paths.first else {
        throw PrototypeFailure.stopped("\(paths.count) chemin(s) MP4 complet(s) exposé(s) dans la feuille. Aucun chemin de sortie inventé ; aucune commande envoyée.")
    }
    return URL(fileURLWithPath: path)
}
