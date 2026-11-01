import Foundation
import Vapor

extension Store {
    func itemJSON(_ item: Item) -> JSON {
        .object([
            "id": .string(item.id),
            "roomId": .string(item.room),
            "senderMemberId": .string(item.sender),
            "createdAt": jsonTimestamp(item.created),
            "kind": .string(item.asset == nil ? "text" : "asset"),
            "text": item.text.map(JSON.string) ?? .null,
            "asset": item.asset.flatMap { state.uploads[$0]?.json } ?? .null,
        ])
    }

    func page(_ values: [JSON], ids: [String], query: [String: String]) throws -> WireResponse {
        let rawLimit = query["limit"] ?? "30"
        guard let limit = Int(rawLimit), (1...100).contains(limit) else {
            throw APIError(400, "INVALID_INPUT", "limit must be 1...100")
        }
        var start = 0
        if let cursor = query["cursor"] {
            guard let index = ids.firstIndex(of: cursor) else {
                throw APIError(400, "CURSOR_INVALID", "Refresh the list")
            }
            start = index + 1
        }
        let end = min(start + limit, values.count)
        return WireResponse(
            json: .object([
                "data": .array(Array(values[start..<end])),
                "page": .object(["nextCursor": end < values.count ? .string(ids[end - 1]) : .null]),
            ])
        )
    }

    func dispatch(
        _ method: String,
        _ path: [String],
        _ body: JSON,
        _ currentSession: Session,
        _ context: Context,
        _ query: [String: String]
    ) throws -> WireResponse {
        if method == "POST", path == ["rooms"] || path == ["rooms", "join"] {
            return try createOrJoinRoom(path, body, currentSession, context)
        }
        if path.count >= 3, path[0] == "rooms", path[2] == "join-requests" {
            return try handleJoinRequest(method, path, body, currentSession)
        }
        if path.first == "rooms", path.count >= 2 {
            return try handleRoom(method, path, body, currentSession, query)
        }
        if path.first == "uploads", path.count >= 2 {
            return try handleUpload(method, path, body, currentSession)
        }
        if path.count == 3 && path.first == "assets" && path[2] == "links" && method == "POST" {
            return try createShareLink(path, body, currentSession)
        }
        if path.count == 2 && path.first == "links" && method == "DELETE" {
            return try revokeShareLink(path, currentSession)
        }
        throw APIError(404, "NOT_FOUND", "Route not found")
    }

    private func createOrJoinRoom(
        _ path: [String],
        _ body: JSON,
        _ currentSession: Session,
        _ context: Context
    ) throws -> WireResponse {
        try body.validateFields(
            path.count == 2 ? ["code", "proof", "password"] : ["code", "proof", "password", "approvalRequired"]
        )
        let password = try roomPassword(body)
        let joining = path.count == 2
        if joining || body["code"] != .null {
            try validateCode(body["code"].string)
        }
        try proof(
            body,
            action: joining ? "room.join" : "room.create",
            currentSession: currentSession,
            context: context
        )
        if joining {
            guard
                var room = state.rooms.values.first(where: { $0.code == body["code"].string && $0.closed == nil }),
                !room.banned.contains(currentSession.id)
            else {
                throw APIError(404, "ROOM_UNAVAILABLE", "Room cannot be joined")
            }
            if let existing = room.members[currentSession.id] {
                _ = try member(room.id, currentSession.id)
                return dataResponse(
                    .object([
                        "room": room.json(idle: settings.idleSeconds),
                        "membership": existing.json(now: now, lease: settings.leaseSeconds),
                    ])
                )
            }
            guard !room.locked else {
                throw APIError(404, "ROOM_UNAVAILABLE", "Room cannot be joined")
            }
            if let passwordHash = room.passwordHash {
                guard try passwordMatches(password, passwordHash) else {
                    throw APIError(403, "ROOM_PASSWORD_INVALID", "Room password is missing or incorrect")
                }
            }
            if room.approvalRequired == true {
                var requests = room.joinRequests ?? [:]
                requests = requests.filter { $0.value.expires > now }
                if let existing = requests.values.first(where: {
                    $0.device == currentSession.id && $0.status == "pending"
                }) {
                    return dataResponse(
                        .object([
                            "roomId": .string(room.id),
                            "request": existing.json,
                        ]),
                        status: 202
                    )
                }
                guard requests.values.filter({ $0.status != "withdrawn" }).count < 100 else {
                    throw APIError(429, "JOIN_REQUEST_LIMIT", "Too many join requests", retryAfter: 60)
                }
                let request = JoinRequest(
                    id: UUID().uuidString.lowercased(),
                    device: currentSession.id,
                    name: currentSession.name,
                    created: now,
                    expires: now + 600,
                    status: "pending"
                )
                requests[request.id] = request
                room.joinRequests = requests
                state.rooms[room.id] = room
                emit(room.id, "join-request.created", request.json)
                return dataResponse(
                    .object([
                        "roomId": .string(room.id),
                        "request": request.json,
                    ]),
                    status: 202
                )
            }
            guard room.members.count < settings.maxDevices else {
                throw APIError(409, "ROOM_FULL", "Room is full")
            }
            let membership = Member(
                id: UUID().uuidString.lowercased(),
                device: currentSession.id,
                name: currentSession.name,
                role: "member",
                joined: now,
                seen: now
            )
            room.members[currentSession.id] = membership
            room.idleSince = nil
            state.rooms[room.id] = room
            emit(room.id, "member.joined", membership.json(now: now, lease: settings.leaseSeconds))
            return dataResponse(
                .object([
                    "room": room.json(idle: settings.idleSeconds),
                    "membership": membership.json(now: now, lease: settings.leaseSeconds),
                ]),
                status: 201
            )
        }
        _ = try limit("create:" + context.source, max: 10, window: 3600)
        guard state.rooms.values.filter({ $0.closed == nil }).count < settings.maxRooms,
            state.rooms.values.filter({ $0.closed == nil && $0.members[currentSession.id]?.role == "owner" }).count
                < settings.maxOwnedRooms
        else {
            throw APIError(429, "ROOM_CAPACITY", "Room limit reached", retryAfter: 60)
        }
        let code = try body["code"].string ?? newCode()
        guard !state.rooms.values.contains(where: { $0.closed == nil && $0.code == code }) else {
            throw APIError(409, "CODE_TAKEN", "Room code is in use")
        }
        let membership = Member(
            id: UUID().uuidString.lowercased(),
            device: currentSession.id,
            name: currentSession.name,
            role: "owner",
            joined: now,
            seen: now
        )
        var room = Room(
            id: UUID().uuidString.lowercased(),
            code: code,
            owner: membership.id,
            created: now,
            members: [currentSession.id: membership]
        )
        if let value = body.object?["approvalRequired"] {
            guard case .bool(let required) = value else {
                throw APIError(400, "INVALID_INPUT", "approvalRequired must be boolean")
            }
            room.approvalRequired = required
        }
        room.passwordHash = try password.map { try Bcrypt.hash($0, cost: 10) }
        state.rooms[room.id] = room
        emit(room.id, "member.joined", membership.json(now: now, lease: settings.leaseSeconds))
        return dataResponse(
            .object([
                "room": room.json(idle: settings.idleSeconds),
                "membership": membership.json(now: now, lease: settings.leaseSeconds),
            ]),
            status: 201
        )
    }

    private func handleJoinRequest(
        _ method: String,
        _ path: [String],
        _ body: JSON,
        _ currentSession: Session
    ) throws -> WireResponse {
        guard var room = state.rooms[path[1]], room.closed == nil else {
            throw APIError(404, "NOT_FOUND", "Room not found")
        }
        let owner = room.members[currentSession.id]?.role == "owner"
        if method == "GET", path.count == 3 {
            _ = try member(room.id, currentSession.id, owner: true)
            let requests = (room.joinRequests ?? [:]).values.filter { $0.expires > now && $0.status == "pending" }
                .sorted { $0.created < $1.created }
            return dataResponse(.array(requests.map(\.json)))
        }
        guard path.count >= 4, var request = room.joinRequests?[path[3]],
            owner || request.device == currentSession.id
        else {
            throw APIError(404, "NOT_FOUND", "Request not found")
        }
        if method == "GET", path.count == 4 {
            // Only actual members refresh presence; pending applicants cannot
            // keep an otherwise abandoned room alive by polling.
            if room.members[currentSession.id] != nil {
                _ = try member(room.id, currentSession.id)
            }
            return dataResponse(request.json)
        }
        if method == "DELETE", path.count == 4 {
            try body.validateFields([])
            guard request.status == "pending", request.expires > now else {
                throw APIError(409, "JOIN_REQUEST_STATE", "Request is no longer pending")
            }
            guard request.device == currentSession.id else {
                throw APIError(403, "FORBIDDEN", "Only the applicant can withdraw")
            }
            request.status = "withdrawn"
            state.rooms[room.id]?.joinRequests?[request.id] = request
            emit(room.id, "join-request.updated", request.json)
            return WireResponse(status: 204)
        }
        guard method == "POST", path.count == 5, ["approve", "reject"].contains(path[4]) else {
            throw APIError(404, "NOT_FOUND", "Route not found")
        }
        _ = try member(room.id, currentSession.id, owner: true)
        try body.validateFields([])
        room = state.rooms[room.id]!
        let desired = path[4] == "approve" ? "approved" : "rejected"
        if request.status == desired {
            return dataResponse(request.json)
        }
        guard request.status == "pending", request.expires > now else {
            throw APIError(409, "JOIN_REQUEST_STATE", "Request is no longer pending")
        }
        if desired == "approved" {
            guard !room.locked, !room.banned.contains(request.device) else {
                throw APIError(409, "JOIN_REQUEST_STATE", "Room is locked or requester revoked")
            }
            guard state.sessions.values.contains(where: { $0.id == request.device && $0.expires > now }) else {
                throw APIError(409, "JOIN_REQUEST_STATE", "Requester session expired")
            }
            if room.members[request.device] == nil {
                guard room.members.count < settings.maxDevices else {
                    throw APIError(409, "ROOM_FULL", "Room is full")
                }
                let membership = Member(
                    id: UUID().uuidString.lowercased(),
                    device: request.device,
                    name: request.name,
                    role: "member",
                    joined: now,
                    seen: now
                )
                room.members[request.device] = membership
                room.idleSince = nil
                state.rooms[room.id] = room
                emit(room.id, "member.joined", membership.json(now: now, lease: settings.leaseSeconds))
            }
        }
        request.status = desired
        state.rooms[room.id]?.joinRequests?[request.id] = request
        emit(room.id, "join-request.updated", request.json)
        return dataResponse(request.json)
    }

    private func handleRoom(
        _ method: String,
        _ path: [String],
        _ body: JSON,
        _ currentSession: Session,
        _ query: [String: String]
    ) throws -> WireResponse {
        let id = path[1]
        let membership = try member(id, currentSession.id)
        if path.count == 2 {
            if method == "GET" {
                var info = state.rooms[id]!.json(idle: settings.idleSeconds).object!
                info["eventCursor"] = .string(String(state.rooms[id]!.sequence))
                return dataResponse(.object(info))
            }
            if method == "PATCH" {
                _ = try member(id, currentSession.id, owner: true)
                try body.validateFields(["joinPolicy", "password", "approvalRequired"])
                guard let fields = body.object, !fields.isEmpty else {
                    throw APIError(400, "INVALID_INPUT", "Provide joinPolicy or password")
                }
                if fields["joinPolicy"] != nil {
                    let policy = try body.requiredString("joinPolicy")
                    guard ["open", "locked"].contains(policy) else {
                        throw APIError(400, "INVALID_INPUT", "Invalid join policy")
                    }
                    state.rooms[id]?.locked = policy == "locked"
                }
                if let value = fields["approvalRequired"] {
                    guard case .bool(let required) = value else {
                        throw APIError(400, "INVALID_INPUT", "approvalRequired must be boolean")
                    }
                    state.rooms[id]?.approvalRequired = required
                }
                if fields["password"] != nil {
                    let password = try roomPassword(body)
                    _ = try limit("password:" + id, max: 5, window: 600)
                    state.rooms[id]?.passwordHash = try password.map { try Bcrypt.hash($0, cost: 10) }
                }
                emit(id, "room.updated", state.rooms[id]!.json(idle: settings.idleSeconds))
                return dataResponse(state.rooms[id]!.json(idle: settings.idleSeconds))
            }
            if method == "DELETE" {
                _ = try member(id, currentSession.id, owner: true)
                closeRoom(id)
                return WireResponse(status: 204)
            }
        }
        if path.count == 4, path[2...] == ["code", "rotate"], method == "POST" {
            _ = try member(id, currentSession.id, owner: true)
            try body.validateFields([])
            _ = try limit("rotate:" + id, max: 5, window: 600)
            let replacement = try newCode()
            state.rooms[id]?.code = replacement
            emit(id, "room.updated", state.rooms[id]!.json(idle: settings.idleSeconds))
            return dataResponse(state.rooms[id]!.json(idle: settings.idleSeconds))
        }
        if path.count == 3 && path[2] == "members" && method == "GET" {
            let members = state.rooms[id]!.members.values.sorted { $0.id < $1.id }
            var response = try page(
                members.map { $0.json(now: now, lease: settings.leaseSeconds) },
                ids: members.map(\.id),
                query: query
            )
            response.json = withCursor(response.json, room: id)
            return response
        }
        if path.count == 4 && path[2] == "members" && method == "DELETE" {
            let target: Member
            if path[3] == "me" {
                target = membership
            } else {
                _ = try member(id, currentSession.id, owner: true)
                guard let found = state.rooms[id]?.members.values.first(where: { $0.id == path[3] }) else {
                    throw APIError(404, "NOT_FOUND", "Member not found")
                }
                target = found
            }
            guard target.role != "owner" else {
                throw APIError(409, "OWNER_MUST_CLOSE", "Close the room before leaving")
            }
            state.rooms[id]?.members.removeValue(forKey: target.device)
            // A departing online member kept the room active until this moment.
            if state.rooms[id]!.members.values.allSatisfy({ now - $0.seen >= settings.leaseSeconds }) {
                state.rooms[id]?.idleSince = now
            }
            if path[3] != "me" {
                state.rooms[id]?.banned.insert(target.device)
            }
            emit(id, "member.left", .object(["id": .string(target.id)]))
            return WireResponse(status: 204)
        }
        if path.count == 3 && path[2] == "items" {
            if method == "GET" {
                let items = state.items.values.filter { $0.room == id }.sorted { $0.sequence > $1.sequence }
                var response = try page(items.map(itemJSON), ids: items.map(\.id), query: query)
                response.json = withCursor(response.json, room: id)
                return response
            }
            if method == "POST" {
                try body.validateFields(["text"])
                let text = try body.requiredString("text", maxBytes: 32768)
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw APIError(400, "INVALID_INPUT", "Text must not be blank")
                }
                try itemCapacity(id)
                let roomTextBytes = state.items.values.filter { $0.room == id }.reduce(0) {
                    $0 + ($1.text?.utf8.count ?? 0)
                }
                let allTextBytes = state.items.values.reduce(0) { $0 + ($1.text?.utf8.count ?? 0) }
                guard roomTextBytes + text.utf8.count <= 1_000_000, allTextBytes + text.utf8.count <= 16_000_000
                else {
                    throw APIError(409, "TEXT_QUOTA", "Text storage quota exceeded")
                }
                let item = Item(
                    id: UUID().uuidString.lowercased(),
                    room: id,
                    sender: membership.id,
                    created: now,
                    sequence: state.rooms[id]!.sequence + 1,
                    text: text
                )
                state.items[item.id] = item
                emit(id, "item.created", itemJSON(item))
                return dataResponse(itemJSON(item), status: 201)
            }
        }
        if path.count == 4 && path[2] == "items" && method == "DELETE" {
            guard let item = state.items[path[3]], item.room == id else {
                throw APIError(404, "NOT_FOUND", "Item not found")
            }
            guard item.sender == membership.id || membership.role == "owner" else {
                throw APIError(403, "FORBIDDEN", "Cannot delete another member's item")
            }
            state.items.removeValue(forKey: item.id)
            if let asset = item.asset {
                state.uploads[asset]?.status = "cancelled"
                for key in state.links.keys where state.links[key]?.asset == asset {
                    state.links[key]?.revoked = now
                }
            }
            emit(id, "item.deleted", .object(["id": .string(item.id)]))
            return WireResponse(status: 204)
        }
        if path.count == 3 && path[2] == "uploads" && method == "POST" {
            return try createUpload(body, id, currentSession, membership)
        }
        if path.count == 3 && path[2] == "links" && method == "GET" {
            let links = state.links.values.filter {
                $0.room == id && ($0.creator == currentSession.id || membership.role == "owner")
            }
            .sorted { $0.id < $1.id }
            return try page(
                links.map { $0.json() },
                ids: links.map(\.id),
                query: query
            )
        }
        throw APIError(404, "NOT_FOUND", "Route not found")
    }

    private func handleUpload(
        _ method: String,
        _ path: [String],
        _ body: JSON,
        _ currentSession: Session
    ) throws -> WireResponse {
        guard var upload = state.uploads[path[1]] else {
            throw APIError(404, "NOT_FOUND", "Upload not found")
        }
        let membership = try member(upload.room, currentSession.id)
        if method == "GET" && path.count == 2 {
            guard upload.device == currentSession.id || membership.role == "owner" else {
                throw APIError(403, "FORBIDDEN", "Cannot inspect this upload")
            }
            var status = upload.json.object!
            status["expiresAt"] = jsonTimestamp(upload.expires)
            status["itemId"] = upload.item.map(JSON.string) ?? .null
            return dataResponse(.object(status))
        }
        if method == "DELETE" && path.count == 2 {
            guard upload.device == currentSession.id || membership.role == "owner" else {
                throw APIError(403, "FORBIDDEN", "Cannot cancel this upload")
            }
            guard upload.status != "ready" else {
                throw APIError(409, "UPLOAD_READY", "Delete the room item instead")
            }
            upload.status = "cancelled"
            state.uploads[upload.id] = upload
            emit(upload.room, "upload.updated", upload.json)
            return WireResponse(status: 204)
        }
        if method == "POST" && path.count == 3 && path[2] == "complete" {
            try body.validateFields([])
            guard upload.device == currentSession.id else {
                throw APIError(403, "FORBIDDEN", "Upload owner required")
            }
            if upload.status == "ready", let item = upload.item.flatMap({ state.items[$0] }) {
                return dataResponse(itemJSON(item))
            }
            guard upload.status == "uploaded", upload.expires > now else {
                throw APIError(409, "UPLOAD_INCOMPLETE", "Upload must finish before completion")
            }
            try itemCapacity(upload.room)
            let item = Item(
                id: UUID().uuidString.lowercased(),
                room: upload.room,
                sender: upload.member,
                created: now,
                sequence: state.rooms[upload.room]!.sequence + 1,
                asset: upload.id
            )
            upload.status = "ready"
            upload.item = item.id
            state.uploads[upload.id] = upload
            state.items[item.id] = item
            emit(upload.room, "upload.updated", upload.json)
            emit(upload.room, "item.created", itemJSON(item))
            return dataResponse(itemJSON(item), status: 201)
        }
        throw APIError(404, "NOT_FOUND", "Route not found")
    }

    private func createShareLink(_ path: [String], _ body: JSON, _ currentSession: Session) throws -> WireResponse {
        try body.validateFields(["expiresAt"])
        guard let asset = state.uploads[path[1]], asset.status == "ready" else {
            throw APIError(404, "NOT_FOUND", "Asset not found")
        }
        let membership = try member(asset.room, currentSession.id)
        guard asset.device == currentSession.id || membership.role == "owner" else {
            throw APIError(403, "FORBIDDEN", "Cannot share this asset")
        }
        let expires: Double
        if body["expiresAt"] == .null {
            expires = now + 86400
        } else {
            guard
                let date = body["expiresAt"].string.flatMap({
                    ISO8601DateFormatter().date(from: $0)?.timeIntervalSince1970
                }), date > now + 60, date <= now + 86400
            else {
                throw APIError(400, "INVALID_INPUT", "Expiry must be between one minute and 24 hours")
            }
            expires = date
        }
        guard state.links.values.filter({ $0.room == asset.room && $0.revoked == nil }).count < 100 else {
            throw APIError(409, "LINK_LIMIT", "Room link limit reached")
        }
        let words = [
            "mint", "lake", "pine", "moon", "sand", "fern", "bird", "snow", "dawn", "leaf", "wave", "star", "rain",
            "hill", "rose", "wind",
        ]
        let alphabet = Array("23456789abcdefghjkmnpqrstuvwxyz")
        var slug: String
        repeat {
            slug =
                words.randomElement()! + "-" + words.randomElement()! + "-"
                + String((0..<6).map { _ in alphabet.randomElement()! })
        } while state.links.values.contains(where: { $0.slug == slug })
        let link = ShareLink(
            id: UUID().uuidString.lowercased(),
            asset: asset.id,
            room: asset.room,
            creator: currentSession.id,
            slug: slug,
            expires: expires
        )
        state.links[link.id] = link
        return dataResponse(link.json(), status: 201)
    }

    private func revokeShareLink(_ path: [String], _ currentSession: Session) throws -> WireResponse {
        guard let link = state.links[path[1]] else {
            throw APIError(404, "NOT_FOUND", "Link not found")
        }
        let membership = try member(link.room, currentSession.id)
        guard link.creator == currentSession.id || membership.role == "owner" else {
            throw APIError(403, "FORBIDDEN", "Cannot revoke this link")
        }
        state.links[link.id]?.revoked = now
        return WireResponse(status: 204)
    }

    func withCursor(_ json: JSON, room: String) -> JSON {
        var object = json.object!
        object["eventCursor"] = .string(String(state.rooms[room]!.sequence))
        return .object(object)
    }

    func itemCapacity(_ room: String) throws {
        guard state.items.values.filter({ $0.room == room }).count < settings.maxItems else {
            throw APIError(409, "ITEM_LIMIT", "Room item limit reached")
        }
    }

    func createUpload(
        _ body: JSON,
        _ room: String,
        _ currentSession: Session,
        _ membership: Member
    ) throws -> WireResponse {
        try body.validateFields(["filename", "sizeBytes", "contentType"])
        let filename = try body.requiredString("filename", maxBytes: 240)
        guard !filename.contains("/"), !filename.contains("\\"),
            !filename.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }), filename != ".",
            filename != ".."
        else {
            throw APIError(400, "INVALID_INPUT", "Invalid filename")
        }
        guard let size = body["sizeBytes"].integer, size > 0 else {
            throw APIError(400, "INVALID_INPUT", "sizeBytes must be positive")
        }
        guard size <= settings.maxFileBytes else {
            throw APIError(413, "FILE_TOO_LARGE", "File exceeds configured limit")
        }
        let type = try body.requiredString("contentType", maxBytes: 128)
        guard type.utf8.allSatisfy({ $0 > 32 && $0 < 127 }), type.contains("/") else {
            throw APIError(400, "INVALID_INPUT", "Invalid contentType")
        }
        let live = state.uploads.values.filter {
            ["pending", "uploading", "uploaded", "ready", "failed"].contains($0.status)
        }
        guard live.filter({ $0.room == room }).reduce(0, { $0 + $1.size }) + size <= settings.roomBytes,
            live.reduce(0, { $0 + $1.size }) + size <= settings.totalBytes,
            live.filter({ $0.room == room }).count < 200
        else {
            throw APIError(409, "QUOTA_EXCEEDED", "Storage quota exceeded")
        }
        let upload = Upload(
            id: UUID().uuidString.lowercased(),
            room: room,
            device: currentSession.id,
            member: membership.id,
            filename: filename,
            size: size,
            declaredType: type,
            created: now,
            expires: now + settings.uploadSeconds
        )
        state.uploads[upload.id] = upload
        return dataResponse(
            .object([
                "uploadId": .string(upload.id),
                "uploadUrl": .string("/api/v1/uploads/" + upload.id + "/content"),
                "expiresAt": jsonTimestamp(upload.expires),
                "status": .string(upload.status),
            ]),
            status: 201
        )
    }

    func share(_ slug: String, source: String) throws -> Upload {
        _ = try limit("public:" + source, max: 120)
        guard let link = state.links.values.first(where: { $0.slug == slug }) else {
            throw APIError(404, "NOT_FOUND", "Share not found")
        }
        guard link.expires > now, link.revoked == nil, state.rooms[link.room]?.closed == nil,
            let asset = state.uploads[link.asset], asset.status == "ready"
        else {
            throw APIError(410, "SHARE_EXPIRED", "Share expired or revoked")
        }
        return asset
    }

    func shareMetadata(_ slug: String, source: String) throws -> WireResponse {
        try transaction {
            sweep()
            _ = try limit("global", max: 3000)
            let asset = try share(slug, source: source)
            let link = state.links.values.first { $0.slug == slug }!
            return dataResponse(
                .object([
                    "asset": asset.json,
                    "expiresAt": jsonTimestamp(link.expires),
                    "contentUrl": .string("/d/" + slug),
                ])
            )
        }
    }
}
