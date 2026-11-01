import Crypto
import Foundation
import Vapor

struct UploadTicket: Sendable {
    let upload: Upload
    let attempt: String
    let path: String
}

struct Download: Sendable {
    let path: String
    let filename: String
    let type: String
    let size: Int
    var memory: Data? = nil
}

struct EventBatch: Sendable {
    let events: [Event]
    let cursor: Int
    let resync: Bool
    let closed: Bool
}

struct EventWaiter {
    let room: String
    let continuation: CheckedContinuation<Void, Never>
    let timeout: Task<Void, Never>
}

extension Store {
    // MARK: - Uploads

    func beginUpload(_ id: String, _ context: Context, length: Int?) throws -> UploadTicket {
        try transaction {
            sweep()
            _ = try limit("global", max: 3000)
            let currentSession = try session(context, write: true)
            guard var upload = state.uploads[id] else {
                throw APIError(404, "NOT_FOUND", "Upload not found")
            }
            _ = try member(upload.room, currentSession.id)
            guard upload.device == currentSession.id else {
                throw APIError(403, "FORBIDDEN", "Upload owner required")
            }
            _ = try limit("upload:" + context.source, max: 30)
            guard ["pending", "failed"].contains(upload.status), upload.expires > now else {
                throw APIError(409, "UPLOAD_STATE", "Upload is not writable")
            }
            if let length, length != upload.size {
                throw APIError(400, "SIZE_MISMATCH", "Content-Length differs from declared size")
            }
            guard state.uploads.values.filter({ $0.status == "uploading" }).count < 20 else {
                throw APIError(429, "UPLOAD_BUSY", "Retry later", retryAfter: 10)
            }
            let reserved = state.uploads.values.filter {
                $0.storage == "memory" && ["uploading", "uploaded", "ready"].contains($0.status)
            }.reduce(0) { $0 + $1.size }
            upload.storage =
                upload.size <= settings.memoryFileBytes && upload.size <= settings.memoryTotalBytes - reserved
                ? "memory" : "disk"
            let attempt = UUID().uuidString.lowercased()
            upload.attempt = attempt
            upload.status = "uploading"
            state.uploads[id] = upload
            emit(upload.room, "upload.updated", upload.json)
            return UploadTicket(upload: upload, attempt: attempt, path: files + "/" + id + "." + attempt + ".part")
        }
    }

    func validateUpload(_ ticket: UploadTicket, context: Context) throws {
        let currentSession = try session(context, write: true)
        guard let upload = state.uploads[ticket.upload.id], upload.attempt == ticket.attempt,
            upload.status == "uploading",
            upload.expires > now
        else {
            throw APIError(409, "UPLOAD_CANCELLED", "Upload is no longer active")
        }
        _ = try member(upload.room, currentSession.id)
    }

    func finishUpload(
        _ ticket: UploadTicket,
        context: Context,
        checksum: String,
        type: String,
        memory: Data? = nil
    ) throws -> WireResponse {
        try transaction {
            try validateUpload(ticket, context: context)
            if ticket.upload.storage == "memory" {
                guard let memory, memory.count == ticket.upload.size else {
                    throw APIError(400, "SIZE_MISMATCH", "Incomplete memory upload")
                }
                memoryFiles[ticket.upload.id] = memory
            } else {
                let destination = files + "/" + ticket.upload.id
                if FileManager.default.fileExists(atPath: destination) {
                    try FileManager.default.removeItem(atPath: destination)
                }
                try FileManager.default.moveItem(atPath: ticket.path, toPath: destination)
            }
            state.uploads[ticket.upload.id]?.status = "uploaded"
            state.uploads[ticket.upload.id]?.sha256 = checksum
            state.uploads[ticket.upload.id]?.type = resolvedMediaType(type, declared: ticket.upload.declaredType)
            emit(ticket.upload.room, "upload.updated", state.uploads[ticket.upload.id]!.json)
            return dataResponse(state.uploads[ticket.upload.id]!.json)
        }
    }

    func failUpload(_ ticket: UploadTicket) throws {
        try transaction {
            if state.uploads[ticket.upload.id]?.attempt == ticket.attempt
                && state.uploads[ticket.upload.id]?.status == "uploading"
            {
                state.uploads[ticket.upload.id]?.status = "failed"
                emit(ticket.upload.room, "upload.updated", state.uploads[ticket.upload.id]!.json)
            }
        }
    }

    // MARK: - Downloads

    func download(_ id: String, context: Context, publicLink: Bool) throws -> Download {
        try transaction {
            sweep()
            _ = try limit("global", max: 3000)
            let upload: Upload
            if publicLink {
                upload = try share(id, source: context.source)
            } else {
                let currentSession = try session(context)
                guard let asset = state.uploads[id], asset.status == "ready" else {
                    throw APIError(404, "NOT_FOUND", "Asset not found")
                }
                _ = try member(asset.room, currentSession.id)
                _ = try limit("download:" + context.source, max: 120)
                upload = asset
            }
            if upload.storage == "memory" {
                guard let bytes = memoryFiles[upload.id] else {
                    throw APIError(410, "ASSET_EXPIRED", "Temporary file has expired")
                }
                return Download(
                    path: "",
                    filename: upload.filename,
                    type: upload.type,
                    size: upload.size,
                    memory: bytes
                )
            }
            return Download(
                path: files + "/" + upload.id,
                filename: upload.filename,
                type: upload.type,
                size: upload.size
            )
        }
    }

    // MARK: - Event subscriptions

    func waitForEvent(room: String, after cursor: Int, timeout duration: Duration = .seconds(2)) async {
        let id = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !isStopping, !Task.isCancelled, (state.rooms[room]?.sequence ?? cursor) <= cursor else {
                    continuation.resume()
                    return
                }
                let timeout = Task {
                    do {
                        try await Task.sleep(for: duration)
                        resumeEventWaiter(id)
                    } catch {}
                }
                eventWaiters[id] = EventWaiter(room: room, continuation: continuation, timeout: timeout)
            }
        } onCancel: {
            Task { await self.resumeEventWaiter(id) }
        }
    }

    func resumeEventWaiter(_ id: UUID) {
        guard let waiter = eventWaiters.removeValue(forKey: id) else { return }
        waiter.timeout.cancel()
        waiter.continuation.resume()
    }

    func stopStreaming() {
        isStopping = true
        for id in Array(eventWaiters.keys) { resumeEventWaiter(id) }
    }

    func subscribe(room: String, context: Context) throws {
        try transaction {
            sweep()
            _ = try limit("global", max: 3000)
            _ = try limit("subscribe:" + context.source, max: 60)
            let currentSession = try session(context)
            _ = try member(room, currentSession.id)
            guard (subscriptions[context.sessionHash!] ?? 0) < 3, subscriptions.values.reduce(0, +) < 200 else {
                throw APIError(429, "STREAM_LIMIT", "Too many event streams", retryAfter: 10)
            }
            subscriptions[context.sessionHash!, default: 0] += 1
        }
    }

    func unsubscribe(context: Context) {
        if let sessionHash = context.sessionHash {
            let remaining = max(0, (subscriptions[sessionHash] ?? 0) - 1)
            subscriptions[sessionHash] = remaining == 0 ? nil : remaining
        }
    }

    func eventBatch(room id: String, context: Context, after cursor: Int?) throws -> EventBatch {
        try transaction {
            sweep()
            let currentSession = try session(context)
            guard let room = state.rooms[id], room.members[currentSession.id] != nil else {
                throw APIError(403, "MEMBERSHIP_REVOKED", "Membership revoked")
            }
            if room.closed == nil {
                _ = try member(id, currentSession.id)
            }
            let latest = state.rooms[id]!
            // Existing streams must receive the terminal event even if replay has
            // overflowed. New subscriptions still fail member() after closure.
            if latest.closed != nil {
                return EventBatch(
                    events: latest.events.filter { $0.type == "room.closed" },
                    cursor: latest.sequence,
                    resync: false,
                    closed: true
                )
            }
            let after = cursor ?? latest.sequence
            if after > latest.sequence || after < (latest.events.first?.id ?? 1) - 1 {
                return EventBatch(events: [], cursor: latest.sequence, resync: true, closed: latest.closed != nil)
            }
            return EventBatch(
                events: latest.events.filter { $0.id > after },
                cursor: latest.sequence,
                resync: false,
                closed: latest.closed != nil
            )
        }
    }
}

// Small payloads use reserved bounded RAM; large payloads stream to disk outside the event loop.
actor UploadWriter {
    let handle: FileHandle?
    var memory: Data?
    let expected: Int
    var count = 0
    var prefix = Data()
    var hasher = SHA256()
    var closed = false

    init(path: String, expected: Int, inMemory: Bool = false) throws {
        self.expected = expected
        if inMemory {
            handle = nil
            memory = Data()
            return
        }
        guard FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw APIError(500, "STORAGE_ERROR", "Cannot create upload")
        }
        handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
    }

    func write(_ data: Data) throws {
        guard !closed else {
            throw APIError(409, "UPLOAD_STATE", "Upload is closed")
        }
        guard data.count <= expected - count else {
            throw APIError(413, "FILE_TOO_LARGE", "Body exceeds declared size")
        }
        if prefix.count < 512 {
            prefix.append(data.prefix(512 - prefix.count))
        }
        if handle == nil {
            memory?.append(data)
        } else {
            try handle?.write(contentsOf: data)
        }
        hasher.update(data: data)
        count += data.count
    }

    func finish() throws -> (String, String, Data?) {
        guard count == expected else {
            throw APIError(400, "SIZE_MISMATCH", "Body length differs from declared size")
        }
        try handle?.synchronize()
        try handle?.close()
        closed = true
        return (hasher.finalize().map { String(format: "%02x", $0) }.joined(), mediaType(prefix), memory)
    }

    func cancel() {
        if !closed {
            try? handle?.close()
            memory = nil
            closed = true
        }
    }
}

// Inline only signatures the browser can display safely. HTML/SVG stay attachments even when the
// client declares an image type, so this table is deliberately limited to binary media containers.
func mediaType(_ data: Data) -> String {
    let bytes = Array(data.prefix(64))
    func ascii(_ offset: Int, _ length: Int) -> String? {
        guard bytes.count >= offset + length else {
            return nil
        }
        return String(bytes: bytes[offset..<(offset + length)], encoding: .ascii)
    }
    if bytes.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) {
        return "image/png"
    }
    if bytes.starts(with: [255, 216, 255]) {
        return "image/jpeg"
    }
    if ascii(0, 6) == "GIF87a" || ascii(0, 6) == "GIF89a" {
        return "image/gif"
    }
    if ascii(0, 4) == "RIFF" {
        switch ascii(8, 4) {
        case "WEBP":
            return "image/webp"
        case "WAVE":
            return "audio/wav"
        default:
            break
        }
    }
    // MP3 starts with an ID3v2 tag or a raw MPEG audio frame. Verify version/layer/bitrate/sample
    // bits so arbitrary files beginning with 0xFF are not mislabelled.
    if ascii(0, 3) == "ID3" {
        return "audio/mpeg"
    }
    if bytes.count >= 4, bytes[0] == 0xFF, bytes[1] & 0xE0 == 0xE0 {
        let version = (bytes[1] >> 3) & 0x03
        let layer = (bytes[1] >> 1) & 0x03
        let bitrate = (bytes[2] >> 4) & 0x0F
        let sampleRate = (bytes[2] >> 2) & 0x03
        if version != 1, layer != 0, bitrate != 0x0F, sampleRate != 3 {
            return "audio/mpeg"
        }
    }
    if ascii(0, 4) == "OggS" {
        return "audio/ogg"
    }
    if ascii(0, 4) == "fLaC" {
        return "audio/flac"
    }
    if ascii(0, 4) == "FORM", ["AIFF", "AIFC"].contains(ascii(8, 4)) {
        return "audio/aiff"
    }
    if bytes.starts(with: [0x1A, 0x45, 0xDF, 0xA3]) {
        return "video/webm"
    }
    if ascii(4, 4) == "ftyp" {
        let brand = ascii(8, 4)
        if brand == "qt  " {
            return "video/quicktime"
        }
        if ["M4A ", "M4B ", "M4P "].contains(brand) {
            return "audio/mp4"
        }
        // ISO base media covers most recorders/phones; accept the common minor brands too.
        if [
            "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "mp71",
            "avc1", "dash", "M4V ", "M4VH", "M4VP", "MSNV", "F4V ", "mmp4",
            "av01", "hev1", "hvc1",
        ].contains(brand) {
            return "video/mp4"
        }
    }
    return "application/octet-stream"
}

// Container signatures cannot distinguish audio-only tracks. Preserve the audio subtype only
// when it agrees with a verified binary media container; unknown bytes remain attachments.
func resolvedMediaType(_ detected: String, declared: String) -> String {
    let base = declared.split(separator: ";", maxSplits: 1).first.map(String.init)?.lowercased()
    if detected == "video/webm", base == "audio/webm" {
        return "audio/webm"
    }
    if detected == "video/mp4", base == "audio/mp4" {
        return "audio/mp4"
    }
    return detected
}
