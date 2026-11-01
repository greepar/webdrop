import Foundation
import Vapor
#if os(Linux)
import Glibc
#else
import Darwin
#endif

final class StoreLock: @unchecked Sendable {
    let descriptor: Int32
    init(path: String) throws {
        descriptor = open(path, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0 else { throw APIError(500, "STORAGE_ERROR", "Cannot open storage lock") }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { close(descriptor); throw APIError(500, "STORAGE_LOCKED", "DATA_DIR is already in use") }
    }
    deinit { flock(descriptor, LOCK_UN); close(descriptor) }
}

actor Store {
    let settings: Settings
    let lock: StoreLock
    var state: State
    var memoryFiles: [String: Data] = [:]
    var subscriptions: [String: Int] = [:]
    var now: Double { settings.now() }
    var files: String { settings.directory + "/files" }

    init(settings: Settings) throws {
        self.settings = settings
        try FileManager.default.createDirectory(atPath: settings.directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        lock = try StoreLock(path: settings.directory + "/process.lock")
        try FileManager.default.createDirectory(atPath: settings.directory + "/files", withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = URL(fileURLWithPath: settings.directory + "/state.json")
        if FileManager.default.fileExists(atPath: url.path) {
            state = try JSONDecoder().decode(State.self, from: Data(contentsOf: url))
            guard state.schema == 1 else { throw APIError(500, "STORAGE_VERSION", "Unsupported state schema") }
        } else { state = State() }
        for id in state.rooms.keys {
            var room = state.rooms[id]!
            room.events = room.events.map { event in
                var event = event; event.data = migrateRoomPasswordFlag(event.data); return event
            }
            state.rooms[id] = room
        }
        for key in state.idem.keys {
            var record = state.idem[key]!
            record.response.json = migrateRoomPasswordFlag(record.response.json)
            state.idem[key] = record
        }
        // Memory bytes are intentionally ephemeral. Invalidate their references on restart.
        let lost = state.uploads.values.filter { $0.storage == "memory" && ["uploading", "uploaded", "ready"].contains($0.status) }
        let lostIDs = Set(lost.map(\.id))
        for upload in lost {
            state.uploads[upload.id]?.status = "expired"
            if let item = upload.item {
                state.items.removeValue(forKey: item)
                if var room = state.rooms[upload.room] {
                    room.sequence += 1
                    room.events.append(Event(id: room.sequence, type: "item.deleted", room: room.id, time: settings.now(), data: .object(["id": str(item)])))
                    room.events = Array(room.events.suffix(256)); state.rooms[room.id] = room
                }
            }
            for key in state.links.keys where state.links[key]?.asset == upload.id { state.links[key]?.revoked = settings.now() }
        }
        state.idem = state.idem.filter { entry in
            let data = entry.value.response.json["data"]
            let assetID = data["uploadId"].string ?? data["assetId"].string ?? data["asset"]["id"].string
            return !lostIDs.contains(assetID ?? "")
        }
        // A restarted process cannot resume an interrupted body stream.
        for (id, var upload) in state.uploads where upload.status == "uploading" {
            upload.status = "failed"; upload.attempt = nil; state.uploads[id] = upload
        }
    }

    func persist() throws {
        let data = try JSONEncoder().encode(state)
        let path = settings.directory + "/state.json"
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }
    func transaction<T>(_ operation: () throws -> T) throws -> T {
        let before = state; let beforeMemory = memoryFiles; let beforeSubscriptions = subscriptions
        do {
            let result = try operation(); try persist()
            memoryFiles = memoryFiles.filter { ["uploaded", "ready"].contains(state.uploads[$0.key]?.status ?? "") }
            return result
        }
        catch {
            let originalError = error
            let buckets = state.buckets; let challenges = state.challenges
            state = before; memoryFiles = beforeMemory; subscriptions = beforeSubscriptions
            // Failure must not undo abuse accounting or resurrect consumed proofs.
            state.buckets = buckets; state.challenges = challenges
            try persist()
            throw originalError
        }
    }
    func limit(_ key: String, max: Int, window: Double = 60) throws -> Int {
        var bucket = state.buckets[key] ?? Bucket(start: now, count: 0)
        if now - bucket.start >= window { bucket = Bucket(start: now, count: 0) }
        guard bucket.count < max else {
            state.buckets[key] = bucket
            throw APIError(429, "RATE_LIMITED", "Please wait before retrying", retryAfter: Swift.max(1, Int(ceil(window - (now - bucket.start)))))
        }
        bucket.count += 1; state.buckets[key] = bucket
        return bucket.count
    }
    func session(_ c: Context, write: Bool = false) throws -> Session {
        guard let token = c.sessionHash, let s = state.sessions[token], s.expires > now else { throw APIError(401, "SESSION_REQUIRED", "Create or restore a session") }
        if write, c.csrf != s.csrf { throw APIError(403, "CSRF_INVALID", "Invalid CSRF token") }
        return s
    }
    func member(_ roomID: String, _ device: String, owner: Bool = false, touch: Bool = true) throws -> Member {
        guard var room = state.rooms[roomID], room.closed == nil, var m = room.members[device] else { throw APIError(404, "NOT_FOUND", "Resource not found") }
        if owner && m.role != "owner" { throw APIError(403, "OWNER_REQUIRED", "Owner permission required") }
        if touch {
            let wasOffline = now - m.seen >= settings.leaseSeconds
            m.seen = now; room.members[device] = m; room.idleSince = nil; state.rooms[roomID] = room
            if wasOffline { emit(roomID, "member.updated", m.json(now: now, lease: settings.leaseSeconds)) }
        }
        return m
    }
    func emit(_ roomID: String, _ type: String, _ data: JSON) {
        guard var room = state.rooms[roomID] else { return }
        room.sequence += 1
        room.events.append(Event(id: room.sequence, type: type, room: roomID, time: now, data: data))
        room.events = Array(room.events.suffix(256)); state.rooms[roomID] = room
    }
    func closeRoom(_ id: String) {
        guard state.rooms[id]?.closed == nil else { return }
        emit(id, "room.closed", .object(["id": str(id)]))
        state.rooms[id]?.closed = now
        for (key, _) in state.links where state.links[key]?.room == id { state.links[key]?.revoked = now }
        for (key, _) in state.uploads where state.uploads[key]?.room == id { state.uploads[key]?.status = "expired" }
        state.items = state.items.filter { $0.value.room != id }
    }
    func sweep() {
        state.sessions = state.sessions.filter { $0.value.expires > now }
        state.challenges = state.challenges.filter { $0.value.expires > now }
        state.idem = state.idem.filter { $0.value.expires > now }
        state.buckets = state.buckets.filter { now - $0.value.start < 3600 }
        for (id, var room) in state.rooms where room.closed == nil {
            let latest = room.members.values.map(\.seen).max() ?? (room.idleSince ?? room.created) - settings.leaseSeconds
            if now - latest >= settings.leaseSeconds {
                if room.idleSince == nil { room.idleSince = latest + settings.leaseSeconds; state.rooms[id] = room }
                if now >= (room.idleSince ?? now) + settings.idleSeconds { closeRoom(id) }
            }
        }
        for (id, upload) in state.uploads where upload.status != "ready" && upload.expires <= now { state.uploads[id]?.status = "expired" }
        for (id, link) in state.links where link.revoked == nil && link.expires <= now { state.links[id]?.revoked = now }
        // Keep bounded tombstones for terminal status / stale links, then discard them.
        let oldRooms = Set(state.rooms.values.filter { ($0.closed ?? .greatestFiniteMagnitude) < now - 86400 }.map(\.id))
        state.rooms = state.rooms.filter { !oldRooms.contains($0.key) }
        state.uploads = state.uploads.filter { !oldRooms.contains($0.value.room) && ($0.value.status == "ready" || $0.value.expires > now - 86400) }
        state.links = state.links.filter { !oldRooms.contains($0.value.room) && ($0.value.revoked ?? .greatestFiniteMagnitude) > now - 86400 }
    }
    func collectFiles() {
        let kept = Set(state.uploads.values.flatMap { u -> [String] in
            guard u.storage != "memory" else { return [] }
            if u.status == "ready" || u.status == "uploaded" { return [u.id] }
            if u.status == "uploading", let a = u.attempt { return [u.id + "." + a + ".part"] }
            return []
        })
        for name in (try? FileManager.default.contentsOfDirectory(atPath: files)) ?? [] where !kept.contains(name) {
            try? FileManager.default.removeItem(atPath: files + "/" + name)
        }
    }
    func maintain() throws { try transaction { sweep() }; collectFiles() }

    func handle(method: String, path: [String], body: JSON, context c: Context, query: [String: String] = [:]) throws -> WireResponse {
        try transaction {
            sweep()
            _ = try limit("global", max: 3000)
            _ = try limit("source:" + c.source, max: 600)
            if path == ["capabilities"] && method == "GET" {
                return dataResponse(.object(["roomCodeLength": num(settings.codeLength), "allowedRoomCodeLengths": .array([num(settings.codeLength)]), "maxDevices": num(settings.maxDevices), "maxFileBytes": num(settings.maxFileBytes), "roomQuotaBytes": num(settings.roomBytes), "roomIdleSeconds": num(Int(settings.idleSeconds)), "linkDefaultSeconds": num(86400), "heartbeatSeconds": num(2)]))
            }
            let s = try session(c, write: method != "GET")
            if path == ["session"] && method == "GET" {
                return dataResponse(.object(["deviceId": str(s.id), "displayName": str(s.name), "csrfToken": str(s.csrf), "memberships": .array(state.rooms.values.filter { $0.closed == nil && $0.members[s.id] != nil }.map { .object(["room": $0.json(idle: settings.idleSeconds), "membership": $0.members[s.id]!.json(now: now, lease: settings.leaseSeconds)]) })]))
            }
            if path == ["pow", "challenges"] && method == "POST" { return try challenge(body, s, c) }
            let needsKey = method == "POST" && (path == ["rooms"] || path == ["rooms", "join"] || path.last == "items" || path.last == "uploads" || path.last == "complete" || path.last == "links")
            var identity: String?; var fingerprint = ""
            let passwordOperation = method == "POST" && (path == ["rooms"] || path == ["rooms", "join"])
            let password = try passwordOperation ? roomPassword(body) : nil
            if needsKey {
                guard let key = c.key, (8...128).contains(key.count), key.utf8.allSatisfy({ $0 >= 33 && $0 < 127 }) else { throw APIError(400, "IDEMPOTENCY_REQUIRED", "Provide an 8–128 character Idempotency-Key") }
                identity = s.id + ":" + path.joined(separator: "/") + ":" + key
                var payload = body.object ?? [:]; payload.removeValue(forKey: "proof")
                if passwordOperation { payload.removeValue(forKey: "password") }
                fingerprint = digest(try JSON.object(payload).bytes())
                if let prior = state.idem[identity!] {
                    guard try prior.fingerprint == fingerprint && passwordMatches(password, prior.passwordHash) else { throw APIError(409, "IDEMPOTENCY_CONFLICT", "Key was used with different input") }
                    if let room = prior.room { _ = try member(room, s.id) }
                    if prior.response.status == 202 {
                        let roomID = prior.response.json["data"]["roomId"].string ?? ""
                        guard state.rooms[roomID]?.closed == nil, state.rooms[roomID] != nil, state.rooms[roomID]?.banned.contains(s.id) == false else { throw APIError(404, "NOT_FOUND", "Room not found") }
                    }
                    return prior.response
                }
            }
            let response = try dispatch(method, path, body, s, c, query)
            if let identity {
                guard state.idem.count < 20000 else { throw APIError(429, "CAPACITY", "Retry later", retryAfter: 60) }
                let room = response.json["data"]["room"]["id"].string
                    ?? (path.first == "rooms" && path.count > 2 ? path[1] : nil)
                    ?? (path.count > 1 && ["assets", "uploads"].contains(path[0]) ? state.uploads[path[1]]?.room : nil)
                state.idem[identity] = Idempotent(fingerprint: fingerprint, response: response, expires: now + 86400, room: room, passwordHash: try password.map { try Bcrypt.hash($0, cost: 10) })
            }
            return response
        }
    }
    func createSession(_ body: JSON, source: String, existing: String?) throws -> (WireResponse, String?) {
        try transaction {
            sweep(); _ = try limit("global", max: 3000); _ = try limit("sessions:" + source, max: 20, window: 600)
            try body.only(["displayName"])
            let name = body["displayName"] == .null ? "Device" : try body.required("displayName", max: 80)
            if let existing, let s = state.sessions[existing], s.expires > now {
                return (dataResponse(.object(["deviceId": str(s.id), "displayName": str(s.name), "csrfToken": str(s.csrf)])), nil)
            }
            guard state.sessions.count < 10000 else { throw APIError(503, "CAPACITY", "Session capacity reached") }
            let token = randomToken(); let s = Session(id: uid(), csrf: randomToken(), name: name, expires: now + settings.sessionSeconds)
            state.sessions[hash(token)] = s
            return (dataResponse(.object(["deviceId": str(s.id), "displayName": str(s.name), "csrfToken": str(s.csrf)]), status: 201), token)
        }
    }
    func challenge(_ body: JSON, _ s: Session, _ c: Context) throws -> WireResponse {
        try body.only(["action", "code", "idempotencyKey"])
        let action = try body.required("action"); let key = try body.required("idempotencyKey", max: 128)
        guard ["room.create", "room.join"].contains(action), key.count >= 8, key.utf8.allSatisfy({ $0 >= 33 && $0 < 127 }) else { throw APIError(400, "INVALID_INPUT", "Invalid action or idempotency key") }
        let code = body["code"].string
        if action == "room.join" || body["code"] != .null { try validateCode(code) }
        let sourceAttempts = try limit("pow:" + c.source, max: 30, window: 600)
        let deviceAttempts = try limit("pow-device:" + s.id, max: 20, window: 600)
        guard state.challenges.count < 5000 else { throw APIError(429, "CAPACITY", "Retry later", retryAfter: 60) }
        let bits = min(settings.maxBits, settings.baseBits + (max(sourceAttempts, deviceAttempts) - 1) / 3)
        let id = uid(); let salt = randomToken()
        let input = "webdrop-pow-v1:\(id):\(salt):"
        let ch = Challenge(id: id, device: s.id, source: c.source, action: action, code: code, key: key, bits: bits, input: input, expires: now + settings.challengeSeconds)
        state.challenges[id] = ch
        return dataResponse(.object(["challengeId": str(id), "version": num(1), "algorithm": str("sha256-leading-zero-bits"), "difficulty": num(bits), "input": str(input), "expiresAt": iso(ch.expires)]), status: 201)
    }
    func proof(_ body: JSON, action: String, s: Session, c: Context) throws {
        _ = try limit("attempt:" + c.source, max: 30, window: 600)
        let p = body["proof"]; try p.only(["challengeId", "nonce"])
        let id = try p.required("challengeId"); let nonce = try p.required("nonce", max: 64)
        guard let ch = state.challenges[id], ch.device == s.id else { throw APIError(400, "POW_INVALID", "Invalid or expired proof") }
        // Consume even failed attempts. This prevents cheap nonce-testing through the verifier.
        state.challenges.removeValue(forKey: id)
        let recent = state.buckets["pow:" + c.source]
        let currentCount = recent.map { now - $0.start < 600 ? $0.count : 1 } ?? 1
        let currentBits = min(settings.maxBits, settings.baseBits + (max(1, currentCount) - 1) / 3)
        guard ch.bits >= currentBits, ch.expires > now, ch.source == c.source, ch.action == action, ch.code == body["code"].string, ch.key == c.key,
              validProof(input: ch.input, nonce: nonce, bits: ch.bits) else { throw APIError(400, "POW_INVALID", "Invalid or expired proof") }
    }
    func validateCode(_ code: String?) throws {
        guard let code, code.count == settings.codeLength, code.utf8.allSatisfy({ (48...57).contains($0) }) else { throw APIError(400, "INVALID_CODE", "Invalid room code format") }
    }
    func newCode() throws -> String {
        let active = Set(state.rooms.values.filter { $0.closed == nil }.map(\.code))
        for _ in 0..<100 {
            let code = (0..<settings.codeLength).map { _ in String(Int.random(in: 0...9)) }.joined()
            if !active.contains(code) { return code }
        }
        throw APIError(503, "CODE_CAPACITY", "Unable to allocate room code")
    }
}

private func migrateRoomPasswordFlag(_ value: JSON) -> JSON {
    switch value {
    case .object(var fields):
        if fields["ownerMemberId"] != nil && fields["joinPolicy"] != nil && fields["hasPassword"] == nil { fields["hasPassword"] = .bool(false) }
        if fields["ownerMemberId"] != nil && fields["joinPolicy"] != nil && fields["approvalRequired"] == nil { fields["approvalRequired"] = .bool(false) }
        return .object(fields.mapValues(migrateRoomPasswordFlag))
    case .array(let values): return .array(values.map(migrateRoomPasswordFlag))
    default: return value
    }
}
