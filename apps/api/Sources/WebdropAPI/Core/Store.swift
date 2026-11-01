import Foundation
import Vapor

#if os(Windows)
import WinSDK
#elseif canImport(Musl)
import Musl
#elseif canImport(Glibc)
import Glibc
#else
import Darwin
#endif

// The descriptor is immutable; the lock is released only when its owner is deinitialized.
final class StoreLock: @unchecked Sendable {
    #if os(Windows)
    let descriptor: HANDLE
    #else
    let descriptor: Int32
    #endif

    init(path: String) throws {
        #if os(Windows)
        let handle = path.withCString(encodedAs: UTF16.self) { pointer in
            CreateFileW(
                pointer,
                DWORD(GENERIC_READ | GENERIC_WRITE),
                0,
                nil,
                DWORD(OPEN_ALWAYS),
                DWORD(FILE_ATTRIBUTE_NORMAL),
                nil
            )
        }
        guard let handle, handle != INVALID_HANDLE_VALUE else {
            let code = GetLastError() == ERROR_SHARING_VIOLATION ? "STORAGE_LOCKED" : "STORAGE_ERROR"
            throw APIError(500, code, "Cannot acquire the DATA_DIR process lock")
        }
        descriptor = handle
        #else
        descriptor = open(path, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0 else {
            throw APIError(500, "STORAGE_ERROR", "Cannot open storage lock")
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            throw APIError(500, "STORAGE_LOCKED", "DATA_DIR is already in use")
        }
        #endif
    }

    deinit {
        #if os(Windows)
        CloseHandle(descriptor)
        #else
        flock(descriptor, LOCK_UN)
        close(descriptor)
        #endif
    }
}

actor Store {
    let settings: Settings
    let lock: StoreLock
    var state: State
    var memoryFiles: [String: Data] = [:]
    var subscriptions: [String: Int] = [:]
    var isStopping = false
    var eventWaiters: [UUID: EventWaiter] = [:]

    var now: Double {
        settings.now()
    }

    var files: String {
        settings.directory + "/files"
    }

    // MARK: - Persistence and transactions

    init(settings: Settings) throws {
        self.settings = settings
        try FileManager.default.createDirectory(
            atPath: settings.directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        lock = try StoreLock(path: settings.directory + "/process.lock")
        try FileManager.default.createDirectory(
            atPath: settings.directory + "/files",
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let url = URL(fileURLWithPath: settings.directory + "/state.json")
        if FileManager.default.fileExists(atPath: url.path) {
            state = try JSONDecoder().decode(State.self, from: Data(contentsOf: url))
            guard state.schema == 1 else {
                throw APIError(500, "STORAGE_VERSION", "Unsupported state schema")
            }
        } else {
            state = State()
        }
        for id in state.rooms.keys {
            var room = state.rooms[id]!
            room.events = room.events.map { event in
                var event = event
                event.data = migrateRoomPasswordFlag(event.data)
                return event
            }
            state.rooms[id] = room
        }
        for key in state.idem.keys {
            var record = state.idem[key]!
            record.response.json = migrateRoomPasswordFlag(record.response.json)
            state.idem[key] = record
        }
        // Memory bytes are intentionally ephemeral. Invalidate their references on restart.
        let lost = state.uploads.values.filter {
            $0.storage == "memory" && ["uploading", "uploaded", "ready"].contains($0.status)
        }
        let lostIDs = Set(lost.map(\.id))
        for upload in lost {
            state.uploads[upload.id]?.status = "expired"
            if let item = upload.item {
                state.items.removeValue(forKey: item)
                if var room = state.rooms[upload.room] {
                    room.sequence += 1
                    room.events.append(
                        Event(
                            id: room.sequence,
                            type: "item.deleted",
                            room: room.id,
                            time: settings.now(),
                            data: .object(["id": .string(item)])
                        )
                    )
                    room.events = Array(room.events.suffix(256))
                    state.rooms[room.id] = room
                }
            }
            for key in state.links.keys where state.links[key]?.asset == upload.id {
                state.links[key]?.revoked = settings.now()
            }
        }
        state.idem = state.idem.filter { entry in
            let data = entry.value.response.json["data"]
            let assetID = data["uploadId"].string ?? data["assetId"].string ?? data["asset"]["id"].string
            return !lostIDs.contains(assetID ?? "")
        }
        // A restarted process cannot resume an interrupted body stream.
        for (id, var upload) in state.uploads where upload.status == "uploading" {
            upload.status = "failed"
            upload.attempt = nil
            state.uploads[id] = upload
        }
        // Snapshots written before the media table covered audio or newer MP4 brands still carry
        // application/octet-stream. Re-detect their stored prefix so they become previewable.
        var retyped = false
        for (id, upload) in state.uploads
        where upload.type == "application/octet-stream" && upload.storage != "memory"
            && ["uploaded", "ready"].contains(upload.status)
        {
            guard let handle = FileHandle(forReadingAtPath: settings.directory + "/files/" + id),
                let prefix = try? handle.read(upToCount: 512), !prefix.isEmpty
            else {
                continue
            }
            try? handle.close()
            let detected = mediaType(prefix)
            if detected != "application/octet-stream" {
                state.uploads[id]?.type = detected
                retyped = true
            }
        }
        for (id, upload) in state.uploads where ["uploaded", "ready"].contains(upload.status) {
            let corrected = resolvedMediaType(upload.type, declared: upload.declaredType)
            if corrected != upload.type {
                state.uploads[id]?.type = corrected
                retyped = true
            }
        }
        if retyped {
            let path = settings.directory + "/state.json"
            try JSONEncoder().encode(state).write(to: URL(fileURLWithPath: path), options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
        }
    }

    func persist() throws {
        let data = try JSONEncoder().encode(state)
        let path = settings.directory + "/state.json"
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }

    func transaction<T>(_ operation: () throws -> T) throws -> T {
        // Expiry is independent of the requested operation: a later authorization
        // failure must not resurrect a closed room or its resources.
        sweep()
        memoryFiles = memoryFiles.filter { ["uploaded", "ready"].contains(state.uploads[$0.key]?.status ?? "") }
        let before = state
        let beforeMemory = memoryFiles
        let beforeSubscriptions = subscriptions
        do {
            let result = try operation()
            try persist()
            memoryFiles = memoryFiles.filter { ["uploaded", "ready"].contains(state.uploads[$0.key]?.status ?? "") }
            return result
        } catch {
            let originalError = error
            let buckets = state.buckets
            let challenges = state.challenges
            state = before
            memoryFiles = beforeMemory
            subscriptions = beforeSubscriptions
            // Failure must not undo abuse accounting or resurrect consumed proofs.
            state.buckets = buckets
            state.challenges = challenges
            try persist()
            throw originalError
        }
    }

    // MARK: - Authorization and rate limits

    func limit(_ key: String, max: Int, window: Double = 60) throws -> Int {
        var bucket = state.buckets[key] ?? Bucket(start: now, count: 0)
        if now - bucket.start >= window {
            bucket = Bucket(start: now, count: 0)
        }
        guard bucket.count < max else {
            state.buckets[key] = bucket
            throw APIError(
                429,
                "RATE_LIMITED",
                "Please wait before retrying",
                retryAfter: Swift.max(1, Int(ceil(window - (now - bucket.start))))
            )
        }
        bucket.count += 1
        state.buckets[key] = bucket
        return bucket.count
    }

    func session(_ context: Context, write: Bool = false) throws -> Session {
        guard let token = context.sessionHash, let currentSession = state.sessions[token], currentSession.expires > now
        else {
            throw APIError(401, "SESSION_REQUIRED", "Create or restore a session")
        }
        if write, context.csrf != currentSession.csrf {
            throw APIError(403, "CSRF_INVALID", "Invalid CSRF token")
        }
        return currentSession
    }

    func member(_ roomID: String, _ device: String, owner: Bool = false, touch: Bool = true) throws -> Member {
        guard var room = state.rooms[roomID], room.closed == nil, var membership = room.members[device] else {
            throw APIError(404, "NOT_FOUND", "Resource not found")
        }
        if owner && membership.role != "owner" {
            throw APIError(403, "OWNER_REQUIRED", "Owner permission required")
        }
        if touch {
            let wasOffline = now - membership.seen >= settings.leaseSeconds
            membership.seen = now
            room.members[device] = membership
            room.idleSince = nil
            state.rooms[roomID] = room
            if wasOffline {
                emit(roomID, "member.updated", membership.json(now: now, lease: settings.leaseSeconds))
            }
        }
        return membership
    }

    // MARK: - Room lifecycle and cleanup

    func emit(_ roomID: String, _ type: String, _ data: JSON) {
        guard var room = state.rooms[roomID] else {
            return
        }
        room.sequence += 1
        room.events.append(Event(id: room.sequence, type: type, room: roomID, time: now, data: data))
        room.events = Array(room.events.suffix(256))
        state.rooms[roomID] = room
        for id in eventWaiters.filter({ $0.value.room == roomID }).keys {
            resumeEventWaiter(id)
        }
    }

    func closeRoom(_ id: String) {
        guard state.rooms[id]?.closed == nil else {
            return
        }
        emit(id, "room.closed", .object(["id": .string(id)]))
        state.rooms[id]?.closed = now
        for (key, _) in state.links where state.links[key]?.room == id {
            state.links[key]?.revoked = now
        }
        for (key, _) in state.uploads where state.uploads[key]?.room == id {
            state.uploads[key]?.status = "expired"
        }
        state.items = state.items.filter { $0.value.room != id }
    }

    func sweep() {
        state.sessions = state.sessions.filter { $0.value.expires > now }
        state.challenges = state.challenges.filter { $0.value.expires > now }
        state.idem = state.idem.filter { $0.value.expires > now }
        state.buckets = state.buckets.filter { now - $0.value.start < 3600 }
        for (id, var room) in state.rooms where room.closed == nil {
            let latest =
                room.members.values.map(\.seen).max() ?? (room.idleSince ?? room.created) - settings.leaseSeconds
            if now - latest >= settings.leaseSeconds {
                if room.idleSince == nil {
                    room.idleSince = latest + settings.leaseSeconds
                    state.rooms[id] = room
                }
                if now >= (room.idleSince ?? now) + settings.idleSeconds {
                    closeRoom(id)
                }
            }
        }
        for (roomID, room) in state.rooms where room.closed == nil {
            for (requestID, var request) in room.joinRequests ?? [:]
            where request.status == "pending" && request.expires <= now {
                request.status = "expired"
                state.rooms[roomID]?.joinRequests?[requestID] = request
                emit(roomID, "join-request.updated", request.json)
            }
        }
        for (id, upload) in state.uploads where upload.status != "ready" && upload.expires <= now {
            state.uploads[id]?.status = "expired"
        }
        for (id, link) in state.links where link.revoked == nil && link.expires <= now {
            state.links[id]?.revoked = now
        }
        // Keep bounded tombstones for terminal status / stale links, then discard them.
        let oldRooms = Set(
            state.rooms.values.filter { ($0.closed ?? .greatestFiniteMagnitude) < now - 86400 }.map(\.id)
        )
        state.rooms = state.rooms.filter { !oldRooms.contains($0.key) }
        state.uploads = state.uploads.filter {
            !oldRooms.contains($0.value.room) && ($0.value.status == "ready" || $0.value.expires > now - 86400)
        }
        state.links = state.links.filter {
            !oldRooms.contains($0.value.room) && ($0.value.revoked ?? .greatestFiniteMagnitude) > now - 86400
        }
    }

    func collectFiles() {
        let kept = Set(
            state.uploads.values.flatMap { upload -> [String] in
                guard upload.storage != "memory" else {
                    return []
                }
                if upload.status == "ready" || upload.status == "uploaded" {
                    return [upload.id]
                }
                if upload.status == "uploading", let attempt = upload.attempt {
                    return [upload.id + "." + attempt + ".part"]
                }
                return []
            }
        )
        for name in (try? FileManager.default.contentsOfDirectory(atPath: files)) ?? [] where !kept.contains(name) {
            try? FileManager.default.removeItem(atPath: files + "/" + name)
        }
    }

    func maintain() throws {
        try transaction { sweep() }
        collectFiles()
    }

    // MARK: - Request dispatch and idempotency

    func handle(
        method: String,
        path: [String],
        body: JSON,
        context: Context,
        query: [String: String] = [:]
    ) throws -> WireResponse {
        try transaction {
            sweep()
            _ = try limit("global", max: 3000)
            _ = try limit("source:" + context.source, max: 600)
            if path == ["capabilities"] && method == "GET" {
                return dataResponse(
                    .object([
                        "roomCodeLength": .number(Double(settings.codeLength)),
                        "allowedRoomCodeLengths": .array([.number(Double(settings.codeLength))]),
                        "maxDevices": .number(Double(settings.maxDevices)),
                        "maxRooms": .number(Double(settings.maxRooms)),
                        "maxOwnedRooms": .number(Double(settings.maxOwnedRooms)),
                        "maxFileBytes": .number(Double(settings.maxFileBytes)),
                        "roomQuotaBytes": .number(Double(settings.roomBytes)),
                        "roomIdleSeconds": .number(Double(Int(settings.idleSeconds))),
                        "linkDefaultSeconds": .number(86400),
                        "heartbeatSeconds": .number(2),
                    ])
                )
            }
            if path == ["room-capacity"] && method == "GET" {
                let active = state.rooms.values.filter { $0.closed == nil }
                let codeCapacity = (0..<settings.codeLength).reduce(1) { result, _ in result * 10 }
                let occupiedCodes = Set(
                    active.filter {
                        $0.code.count == settings.codeLength && $0.code.utf8.allSatisfy({ (48...57).contains($0) })
                    }.map(\.code)
                ).count
                let availableCodes = max(0, codeCapacity - occupiedCodes)
                return dataResponse(
                    .object([
                        "maxRooms": .number(Double(settings.maxRooms)),
                        "activeRooms": .number(Double(active.count)),
                        "availableRooms": .number(
                            Double(min(max(0, settings.maxRooms - active.count), availableCodes))
                        ),
                        "maxOwnedRooms": .number(Double(settings.maxOwnedRooms)),
                        "roomCodeLength": .number(Double(settings.codeLength)),
                        "codeCapacity": .number(Double(codeCapacity)),
                        "occupiedCodes": .number(Double(occupiedCodes)),
                        "availableCodes": .number(Double(availableCodes)),
                    ])
                )
            }
            var currentSession = try session(context, write: method != "GET")
            if path == ["session"] && method == "PATCH" {
                try body.validateFields(["displayName"])
                currentSession.name = try body.requiredString("displayName", maxBytes: 80)
                state.sessions[context.sessionHash!] = currentSession
            }
            if path == ["session"] && ["GET", "PATCH"].contains(method) {
                return dataResponse(
                    .object([
                        "deviceId": .string(currentSession.id),
                        "displayName": .string(currentSession.name),
                        "csrfToken": .string(currentSession.csrf),
                        "memberships": .array(
                            state.rooms.values.filter { $0.closed == nil && $0.members[currentSession.id] != nil }.map {
                                .object([
                                    "room": $0.json(idle: settings.idleSeconds),
                                    "membership": $0.members[currentSession.id]!.json(
                                        now: now,
                                        lease: settings.leaseSeconds
                                    ),
                                ])
                            }
                        ),
                    ])
                )
            }
            if path == ["pow", "challenges"] && method == "POST" {
                return try challenge(body, currentSession, context)
            }
            let needsKey =
                method == "POST"
                && (path == ["rooms"] || path == ["rooms", "join"] || path.last == "items" || path.last == "uploads"
                    || path.last == "complete" || path.last == "links")
            var identity: String?
            var fingerprint = ""
            let passwordOperation = method == "POST" && (path == ["rooms"] || path == ["rooms", "join"])
            let password = try passwordOperation ? roomPassword(body) : nil
            if needsKey {
                guard let key = context.key, (8...128).contains(key.count),
                    key.utf8.allSatisfy({ $0 >= 33 && $0 < 127 })
                else {
                    throw APIError(400, "IDEMPOTENCY_REQUIRED", "Provide an 8–128 character Idempotency-Key")
                }
                identity = currentSession.id + ":" + path.joined(separator: "/") + ":" + key
                var payload = body.object ?? [:]
                payload.removeValue(forKey: "proof")
                if passwordOperation {
                    payload.removeValue(forKey: "password")
                }
                fingerprint = sha256Hex(try JSON.object(payload).encodedData())
                if let prior = state.idem[identity!] {
                    guard try prior.fingerprint == fingerprint && passwordMatches(password, prior.passwordHash) else {
                        throw APIError(409, "IDEMPOTENCY_CONFLICT", "Key was used with different input")
                    }
                    if let room = prior.room {
                        _ = try member(room, currentSession.id)
                    }
                    if prior.response.status == 202 {
                        let roomID = prior.response.json["data"]["roomId"].string ?? ""
                        guard state.rooms[roomID]?.closed == nil, state.rooms[roomID] != nil,
                            state.rooms[roomID]?.banned.contains(currentSession.id) == false
                        else {
                            throw APIError(404, "NOT_FOUND", "Room not found")
                        }
                    }
                    return prior.response
                }
            }
            let response = try dispatch(method, path, body, currentSession, context, query)
            if let identity {
                guard state.idem.count < 20000 else {
                    throw APIError(429, "CAPACITY", "Retry later", retryAfter: 60)
                }
                let room =
                    response.json["data"]["room"]["id"].string
                    ?? (path.first == "rooms" && path.count > 2 ? path[1] : nil)
                    ?? (path.count > 1 && ["assets", "uploads"].contains(path[0]) ? state.uploads[path[1]]?.room : nil)
                state.idem[identity] = Idempotent(
                    fingerprint: fingerprint,
                    response: response,
                    expires: now + 86400,
                    room: room,
                    passwordHash: try password.map { try Bcrypt.hash($0, cost: 10) }
                )
            }
            return response
        }
    }

    // MARK: - Sessions and proof of work

    func createSession(_ body: JSON, source: String, existing: String?) throws -> (WireResponse, String?) {
        try transaction {
            sweep()
            _ = try limit("global", max: 3000)
            _ = try limit("sessions:" + source, max: 20, window: 600)
            try body.validateFields(["displayName"])
            let name = body["displayName"] == .null ? "Device" : try body.requiredString("displayName", maxBytes: 80)
            if let existing, let currentSession = state.sessions[existing], currentSession.expires > now {
                return (
                    dataResponse(
                        .object([
                            "deviceId": .string(currentSession.id),
                            "displayName": .string(currentSession.name),
                            "csrfToken": .string(currentSession.csrf),
                        ])
                    ), nil
                )
            }
            guard state.sessions.count < 10000 else {
                throw APIError(503, "CAPACITY", "Session capacity reached")
            }
            let token = randomToken()
            let currentSession = Session(
                id: UUID().uuidString.lowercased(),
                csrf: randomToken(),
                name: name,
                expires: now + settings.sessionSeconds
            )
            state.sessions[sha256Hex(Data(token.utf8))] = currentSession
            return (
                dataResponse(
                    .object([
                        "deviceId": .string(currentSession.id),
                        "displayName": .string(currentSession.name),
                        "csrfToken": .string(currentSession.csrf),
                    ]),
                    status: 201
                ), token
            )
        }
    }

    func challenge(_ body: JSON, _ currentSession: Session, _ context: Context) throws -> WireResponse {
        try body.validateFields(["action", "code", "idempotencyKey"])
        let action = try body.requiredString("action")
        let key = try body.requiredString("idempotencyKey", maxBytes: 128)
        guard ["room.create", "room.join"].contains(action), key.count >= 8,
            key.utf8.allSatisfy({ $0 >= 33 && $0 < 127 })
        else {
            throw APIError(400, "INVALID_INPUT", "Invalid action or idempotency key")
        }
        let code = body["code"].string
        if action == "room.join" || body["code"] != .null {
            try validateCode(code)
        }
        let sourceAttempts = try limit("pow:" + context.source, max: 30, window: 600)
        let deviceAttempts = try limit("pow-device:" + currentSession.id, max: 20, window: 600)
        guard state.challenges.count < 5000 else {
            throw APIError(429, "CAPACITY", "Retry later", retryAfter: 60)
        }
        let bits = min(settings.maxBits, settings.baseBits + (max(sourceAttempts, deviceAttempts) - 1) / 3)
        let id = UUID().uuidString.lowercased()
        let salt = randomToken()
        let input = "webdrop-pow-v1:\(id):\(salt):"
        let challenge = Challenge(
            id: id,
            device: currentSession.id,
            source: context.source,
            action: action,
            code: code,
            key: key,
            bits: bits,
            input: input,
            expires: now + settings.challengeSeconds
        )
        state.challenges[id] = challenge
        return dataResponse(
            .object([
                "challengeId": .string(id),
                "version": .number(1),
                "algorithm": .string("sha256-leading-zero-bits"),
                "difficulty": .number(Double(bits)),
                "input": .string(input),
                "expiresAt": jsonTimestamp(challenge.expires),
            ]),
            status: 201
        )
    }

    func proof(_ body: JSON, action: String, currentSession: Session, context: Context) throws {
        _ = try limit("attempt:" + context.source, max: 30, window: 600)
        let proofPayload = body["proof"]
        try proofPayload.validateFields(["challengeId", "nonce"])
        let id = try proofPayload.requiredString("challengeId")
        let nonce = try proofPayload.requiredString("nonce", maxBytes: 64)
        guard let challenge = state.challenges[id], challenge.device == currentSession.id else {
            throw APIError(400, "POW_INVALID", "Invalid or expired proof")
        }
        // Consume even failed attempts. This prevents cheap nonce-testing through the verifier.
        state.challenges.removeValue(forKey: id)
        let recent = state.buckets["pow:" + context.source]
        let currentCount = recent.map { now - $0.start < 600 ? $0.count : 1 } ?? 1
        let currentBits = min(settings.maxBits, settings.baseBits + (max(1, currentCount) - 1) / 3)
        guard challenge.bits >= currentBits, challenge.expires > now, challenge.source == context.source,
            challenge.action == action,
            challenge.code == body["code"].string, challenge.key == context.key,
            isValidProof(input: challenge.input, nonce: nonce, bits: challenge.bits)
        else {
            throw APIError(400, "POW_INVALID", "Invalid or expired proof")
        }
    }

    func validateCode(_ code: String?) throws {
        guard let code, code.count == settings.codeLength, code.utf8.allSatisfy({ (48...57).contains($0) }) else {
            throw APIError(400, "INVALID_CODE", "Invalid room code format")
        }
    }

    func newCode() throws -> String {
        let active = Set(state.rooms.values.filter { $0.closed == nil }.map(\.code))
        for _ in 0..<100 {
            let code = (0..<settings.codeLength).map { _ in String(Int.random(in: 0...9)) }.joined()
            if !active.contains(code) {
                return code
            }
        }
        throw APIError(503, "CODE_CAPACITY", "Unable to allocate room code")
    }
}

private func migrateRoomPasswordFlag(_ value: JSON) -> JSON {
    switch value {
    case .object(var fields):
        if fields["ownerMemberId"] != nil && fields["joinPolicy"] != nil && fields["hasPassword"] == nil {
            fields["hasPassword"] = .bool(false)
        }
        if fields["ownerMemberId"] != nil && fields["joinPolicy"] != nil && fields["approvalRequired"] == nil {
            fields["approvalRequired"] = .bool(false)
        }
        return .object(fields.mapValues(migrateRoomPasswordFlag))
    case .array(let values):
        return .array(values.map(migrateRoomPasswordFlag))
    default:
        return value
    }
}
