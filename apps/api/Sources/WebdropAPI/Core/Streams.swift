import Foundation
import Vapor
import Crypto

struct UploadTicket: Sendable { let upload: Upload; let attempt: String; let path: String }
struct Download: Sendable { let path: String; let filename: String; let type: String; let size: Int; var memory: Data? = nil }
struct EventBatch: Sendable { let events: [Event]; let cursor: Int; let resync: Bool; let closed: Bool }

extension Store {
    func beginUpload(_ id: String, _ c: Context, length: Int?) throws -> UploadTicket {
        try transaction {
            sweep(); _ = try limit("global", max: 3000); let s = try session(c, write: true)
            guard var upload = state.uploads[id] else { throw APIError(404, "NOT_FOUND", "Upload not found") }
            _ = try member(upload.room, s.id)
            guard upload.device == s.id else { throw APIError(403, "FORBIDDEN", "Upload owner required") }
            _ = try limit("upload:" + c.source, max: 30)
            guard ["pending", "failed"].contains(upload.status), upload.expires > now else { throw APIError(409, "UPLOAD_STATE", "Upload is not writable") }
            if let length, length != upload.size { throw APIError(400, "SIZE_MISMATCH", "Content-Length differs from declared size") }
            guard state.uploads.values.filter({ $0.status == "uploading" }).count < 20 else { throw APIError(429, "UPLOAD_BUSY", "Retry later", retryAfter: 10) }
            let reserved = state.uploads.values.filter { $0.storage == "memory" && ["uploading", "uploaded", "ready"].contains($0.status) }.reduce(0) { $0 + $1.size }
            upload.storage = upload.size <= settings.memoryFileBytes && upload.size <= settings.memoryTotalBytes - reserved ? "memory" : "disk"
            let attempt = uid(); upload.attempt = attempt; upload.status = "uploading"; state.uploads[id] = upload
            emit(upload.room, "upload.updated", upload.json)
            return UploadTicket(upload: upload, attempt: attempt, path: files + "/" + id + "." + attempt + ".part")
        }
    }
    func validateUpload(_ ticket: UploadTicket, c: Context) throws {
        let s = try session(c, write: true)
        guard let u = state.uploads[ticket.upload.id], u.attempt == ticket.attempt, u.status == "uploading", u.expires > now else { throw APIError(409, "UPLOAD_CANCELLED", "Upload is no longer active") }
        _ = try member(u.room, s.id)
    }
    func finishUpload(_ ticket: UploadTicket, c: Context, sha: String, type: String, memory: Data? = nil) throws -> WireResponse {
        try transaction {
            try validateUpload(ticket, c: c)
            if ticket.upload.storage == "memory" {
                guard let memory, memory.count == ticket.upload.size else { throw APIError(400, "SIZE_MISMATCH", "Incomplete memory upload") }
                memoryFiles[ticket.upload.id] = memory
            } else {
                let dest = files + "/" + ticket.upload.id
                if FileManager.default.fileExists(atPath: dest) { try FileManager.default.removeItem(atPath: dest) }
                try FileManager.default.moveItem(atPath: ticket.path, toPath: dest)
            }
            state.uploads[ticket.upload.id]?.status = "uploaded"
            state.uploads[ticket.upload.id]?.sha256 = sha
            state.uploads[ticket.upload.id]?.type = type
            emit(ticket.upload.room, "upload.updated", state.uploads[ticket.upload.id]!.json)
            return dataResponse(state.uploads[ticket.upload.id]!.json)
        }
    }
    func failUpload(_ ticket: UploadTicket) throws {
        try transaction {
            if state.uploads[ticket.upload.id]?.attempt == ticket.attempt && state.uploads[ticket.upload.id]?.status == "uploading" {
                state.uploads[ticket.upload.id]?.status = "failed"
                emit(ticket.upload.room, "upload.updated", state.uploads[ticket.upload.id]!.json)
            }
        }
    }
    func download(_ id: String, c: Context, publicLink: Bool) throws -> Download {
        try transaction {
            sweep(); _ = try limit("global", max: 3000)
            let u: Upload
            if publicLink { u = try share(id, source: c.source) }
            else {
                let s = try session(c)
                guard let asset = state.uploads[id], asset.status == "ready" else { throw APIError(404, "NOT_FOUND", "Asset not found") }
                _ = try member(asset.room, s.id); _ = try limit("download:" + c.source, max: 120); u = asset
            }
            if u.storage == "memory" {
                guard let bytes = memoryFiles[u.id] else { throw APIError(410, "ASSET_EXPIRED", "Temporary file has expired") }
                return Download(path: "", filename: u.filename, type: u.type, size: u.size, memory: bytes)
            }
            return Download(path: files + "/" + u.id, filename: u.filename, type: u.type, size: u.size)
        }
    }
    func subscribe(room: String, c: Context) throws {
        try transaction {
            sweep(); _ = try limit("global", max: 3000); _ = try limit("subscribe:" + c.source, max: 60); let s = try session(c); _ = try member(room, s.id)
            guard (subscriptions[c.sessionHash!] ?? 0) < 3, subscriptions.values.reduce(0, +) < 200 else { throw APIError(429, "STREAM_LIMIT", "Too many event streams", retryAfter: 10) }
            subscriptions[c.sessionHash!, default: 0] += 1
        }
    }
    func unsubscribe(c: Context) {
        if let h = c.sessionHash {
            let remaining = max(0, (subscriptions[h] ?? 0) - 1)
            subscriptions[h] = remaining == 0 ? nil : remaining
        }
    }
    func eventBatch(room id: String, c: Context, after cursor: Int?) throws -> EventBatch {
        try transaction {
            sweep(); let s = try session(c)
            guard let room = state.rooms[id], room.members[s.id] != nil else { throw APIError(403, "MEMBERSHIP_REVOKED", "Membership revoked") }
            if room.closed == nil { _ = try member(id, s.id) }
            let latest = state.rooms[id]!
            let after = cursor ?? latest.sequence
            if after > latest.sequence || after < (latest.events.first?.id ?? 1) - 1 {
                return EventBatch(events: [], cursor: latest.sequence, resync: true, closed: latest.closed != nil)
            }
            return EventBatch(events: latest.events.filter { $0.id > after }, cursor: latest.sequence, resync: false, closed: latest.closed != nil)
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
        if inMemory { handle = nil; memory = Data(); return }
        guard FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw APIError(500, "STORAGE_ERROR", "Cannot create upload") }
        handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
    }
    func write(_ data: Data) throws {
        guard !closed else { throw APIError(409, "UPLOAD_STATE", "Upload is closed") }
        guard data.count <= expected - count else { throw APIError(413, "FILE_TOO_LARGE", "Body exceeds declared size") }
        if prefix.count < 512 { prefix.append(data.prefix(512 - prefix.count)) }
        if handle == nil { memory?.append(data) } else { try handle?.write(contentsOf: data) }; hasher.update(data: data); count += data.count
    }
    func finish() throws -> (String, String, Data?) {
        guard count == expected else { throw APIError(400, "SIZE_MISMATCH", "Body length differs from declared size") }
        try handle?.synchronize(); try handle?.close(); closed = true
        return (hasher.finalize().map { String(format: "%02x", $0) }.joined(), mediaType(prefix), memory)
    }
    func cancel() { if !closed { try? handle?.close(); memory = nil; closed = true } }
    private func mediaType(_ d: Data) -> String {
        let b = Array(d)
        if b.starts(with: [137,80,78,71,13,10,26,10]) { return "image/png" }
        if b.starts(with: [255,216,255]) { return "image/jpeg" }
        if d.starts(with: Data("GIF87a".utf8)) || d.starts(with: Data("GIF89a".utf8)) { return "image/gif" }
        if b.count >= 12, String(bytes: b[0..<4], encoding: .ascii) == "RIFF", String(bytes: b[8..<12], encoding: .ascii) == "WEBP" { return "image/webp" }
        // Inline only well-known media signatures; all other content is an attachment.
        if b.count >= 12, String(bytes: b[4..<8], encoding: .ascii) == "ftyp", ["isom", "iso2", "mp41", "mp42", "avc1", "M4V "].contains(String(bytes: b[8..<12], encoding: .ascii) ?? "") { return "video/mp4" }
        return "application/octet-stream"
    }
}
