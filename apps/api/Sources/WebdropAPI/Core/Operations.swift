import Foundation
import Vapor

extension Store {
    func itemJSON(_ i: Item) -> JSON {
        .object(["id": str(i.id), "roomId": str(i.room), "senderMemberId": str(i.sender), "createdAt": iso(i.created), "kind": str(i.asset == nil ? "text" : "asset"), "text": i.text.map(str) ?? .null, "asset": i.asset.flatMap { state.uploads[$0]?.json } ?? .null])
    }
    func page(_ values: [JSON], ids: [String], query: [String: String]) throws -> WireResponse {
        let rawLimit = query["limit"] ?? "30"
        guard let limit = Int(rawLimit), (1...100).contains(limit) else { throw APIError(400, "INVALID_INPUT", "limit must be 1...100") }
        var start = 0
        if let cursor = query["cursor"] {
            guard let index = ids.firstIndex(of: cursor) else { throw APIError(400, "CURSOR_INVALID", "Refresh the list") }
            start = index + 1
        }
        let end = min(start + limit, values.count)
        return WireResponse(json: .object(["data": .array(Array(values[start..<end])), "page": .object(["nextCursor": end < values.count ? str(ids[end - 1]) : .null])]))
    }
    func dispatch(_ method: String, _ path: [String], _ body: JSON, _ s: Session, _ c: Context, _ query: [String: String]) throws -> WireResponse {
        if method == "POST", path == ["rooms"] || path == ["rooms", "join"] {
            try body.only(["code", "proof", "password"])
            let password = try roomPassword(body)
            let joining = path.count == 2
            if joining || body["code"] != .null { try validateCode(body["code"].string) }
            try proof(body, action: joining ? "room.join" : "room.create", s: s, c: c)
            if joining {
                guard var room = state.rooms.values.first(where: { $0.code == body["code"].string && $0.closed == nil }), !room.banned.contains(s.id) else { throw APIError(404, "ROOM_UNAVAILABLE", "Room cannot be joined") }
                if let existing = room.members[s.id] {
                    _ = try member(room.id, s.id)
                    return dataResponse(.object(["room": room.json(idle: settings.idleSeconds), "membership": existing.json(now: now, lease: settings.leaseSeconds)]))
                }
                guard !room.locked else { throw APIError(404, "ROOM_UNAVAILABLE", "Room cannot be joined") }
                if let passwordHash = room.passwordHash {
                    guard try passwordMatches(password, passwordHash) else { throw APIError(403, "ROOM_PASSWORD_INVALID", "Room password is missing or incorrect") }
                }
                guard room.members.count < settings.maxDevices else { throw APIError(409, "ROOM_FULL", "Room is full") }
                let m = Member(id: uid(), device: s.id, name: s.name, role: "member", joined: now, seen: now)
                room.members[s.id] = m; room.idleSince = nil; state.rooms[room.id] = room
                emit(room.id, "member.joined", m.json(now: now, lease: settings.leaseSeconds))
                return dataResponse(.object(["room": room.json(idle: settings.idleSeconds), "membership": m.json(now: now, lease: settings.leaseSeconds)]), status: 201)
            }
            _ = try limit("create:" + c.source, max: 10, window: 3600)
            guard state.rooms.values.filter({ $0.closed == nil }).count < settings.maxRooms,
                  state.rooms.values.filter({ $0.closed == nil && $0.members[s.id]?.role == "owner" }).count < 5 else { throw APIError(429, "ROOM_CAPACITY", "Room limit reached", retryAfter: 60) }
            let code = try body["code"].string ?? newCode()
            guard !state.rooms.values.contains(where: { $0.closed == nil && $0.code == code }) else { throw APIError(409, "CODE_TAKEN", "Room code is in use") }
            let m = Member(id: uid(), device: s.id, name: s.name, role: "owner", joined: now, seen: now)
            var room = Room(id: uid(), code: code, owner: m.id, created: now, members: [s.id: m])
            room.passwordHash = try password.map { try Bcrypt.hash($0, cost: 10) }
            state.rooms[room.id] = room
            emit(room.id, "member.joined", m.json(now: now, lease: settings.leaseSeconds))
            return dataResponse(.object(["room": room.json(idle: settings.idleSeconds), "membership": m.json(now: now, lease: settings.leaseSeconds)]), status: 201)
        }
        if path.first == "rooms", path.count >= 2 {
            let id = path[1]; let m = try member(id, s.id)
            if path.count == 2 {
                if method == "GET" {
                    var info = state.rooms[id]!.json(idle: settings.idleSeconds).object!
                    info["eventCursor"] = str(String(state.rooms[id]!.sequence))
                    return dataResponse(.object(info))
                }
                if method == "PATCH" {
                    _ = try member(id, s.id, owner: true); try body.only(["joinPolicy", "password"])
                    guard let fields = body.object, !fields.isEmpty else { throw APIError(400, "INVALID_INPUT", "Provide joinPolicy or password") }
                    if fields["joinPolicy"] != nil {
                        let policy = try body.required("joinPolicy")
                        guard ["open", "locked"].contains(policy) else { throw APIError(400, "INVALID_INPUT", "Invalid join policy") }
                        state.rooms[id]?.locked = policy == "locked"
                    }
                    if fields["password"] != nil {
                        let password = try roomPassword(body)
                        _ = try limit("password:" + id, max: 5, window: 600)
                        state.rooms[id]?.passwordHash = try password.map { try Bcrypt.hash($0, cost: 10) }
                    }
                    emit(id, "room.updated", state.rooms[id]!.json(idle: settings.idleSeconds))
                    return dataResponse(state.rooms[id]!.json(idle: settings.idleSeconds))
                }
                if method == "DELETE" { _ = try member(id, s.id, owner: true); closeRoom(id); return WireResponse(status: 204) }
            }
            if path.count == 4, path[2...] == ["code", "rotate"], method == "POST" {
                _ = try member(id, s.id, owner: true); try body.only([])
                _ = try limit("rotate:" + id, max: 5, window: 600)
                let replacement = try newCode()
                state.rooms[id]?.code = replacement
                emit(id, "room.updated", state.rooms[id]!.json(idle: settings.idleSeconds))
                return dataResponse(state.rooms[id]!.json(idle: settings.idleSeconds))
            }
            if path.count == 3 && path[2] == "members" && method == "GET" {
                let members = state.rooms[id]!.members.values.sorted { $0.id < $1.id }
                var response = try page(members.map { $0.json(now: now, lease: settings.leaseSeconds) }, ids: members.map(\.id), query: query)
                response.json = withCursor(response.json, room: id)
                return response
            }
            if path.count == 4 && path[2] == "members" && method == "DELETE" {
                let target: Member
                if path[3] == "me" { target = m }
                else {
                    _ = try member(id, s.id, owner: true)
                    guard let found = state.rooms[id]?.members.values.first(where: { $0.id == path[3] }) else { throw APIError(404, "NOT_FOUND", "Member not found") }
                    target = found
                }
                guard target.role != "owner" else { throw APIError(409, "OWNER_MUST_CLOSE", "Close the room before leaving") }
                state.rooms[id]?.members.removeValue(forKey: target.device)
                if path[3] != "me" { state.rooms[id]?.banned.insert(target.device) }
                emit(id, "member.left", .object(["id": str(target.id)]))
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
                    try body.only(["text"]); let text = try body.required("text", max: 32768)
                    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw APIError(400, "INVALID_INPUT", "Text must not be blank") }
                    try itemCapacity(id)
                    let roomTextBytes = state.items.values.filter { $0.room == id }.reduce(0) { $0 + ($1.text?.utf8.count ?? 0) }
                    let allTextBytes = state.items.values.reduce(0) { $0 + ($1.text?.utf8.count ?? 0) }
                    guard roomTextBytes + text.utf8.count <= 1_000_000, allTextBytes + text.utf8.count <= 16_000_000 else { throw APIError(409, "TEXT_QUOTA", "Text storage quota exceeded") }
                    let item = Item(id: uid(), room: id, sender: m.id, created: now, sequence: state.rooms[id]!.sequence + 1, text: text)
                    state.items[item.id] = item; emit(id, "item.created", itemJSON(item))
                    return dataResponse(itemJSON(item), status: 201)
                }
            }
            if path.count == 4 && path[2] == "items" && method == "DELETE" {
                guard let item = state.items[path[3]], item.room == id else { throw APIError(404, "NOT_FOUND", "Item not found") }
                guard item.sender == m.id || m.role == "owner" else { throw APIError(403, "FORBIDDEN", "Cannot delete another member's item") }
                state.items.removeValue(forKey: item.id)
                if let asset = item.asset {
                    state.uploads[asset]?.status = "cancelled"
                    for key in state.links.keys where state.links[key]?.asset == asset { state.links[key]?.revoked = now }
                }
                emit(id, "item.deleted", .object(["id": str(item.id)])); return WireResponse(status: 204)
            }
            if path.count == 3 && path[2] == "uploads" && method == "POST" { return try createUpload(body, id, s, m) }
            if path.count == 3 && path[2] == "links" && method == "GET" {
                let links = state.links.values.filter { $0.room == id && ($0.creator == s.id || m.role == "owner") }.sorted { $0.id < $1.id }
                return try page(links.map { $0.json(origin: settings.publicOrigin) }, ids: links.map(\.id), query: query)
            }
        }
        if path.first == "uploads", path.count >= 2 {
            guard var upload = state.uploads[path[1]] else { throw APIError(404, "NOT_FOUND", "Upload not found") }
            let m = try member(upload.room, s.id)
            if method == "GET" && path.count == 2 {
                guard upload.device == s.id || m.role == "owner" else { throw APIError(403, "FORBIDDEN", "Cannot inspect this upload") }
                var status = upload.json.object!
                status["expiresAt"] = iso(upload.expires)
                status["itemId"] = upload.item.map(str) ?? .null
                return dataResponse(.object(status))
            }
            if method == "DELETE" && path.count == 2 {
                guard upload.device == s.id || m.role == "owner" else { throw APIError(403, "FORBIDDEN", "Cannot cancel this upload") }
                guard upload.status != "ready" else { throw APIError(409, "UPLOAD_READY", "Delete the room item instead") }
                upload.status = "cancelled"; state.uploads[upload.id] = upload
                emit(upload.room, "upload.updated", upload.json); return WireResponse(status: 204)
            }
            if method == "POST" && path.count == 3 && path[2] == "complete" {
                try body.only([])
                guard upload.device == s.id else { throw APIError(403, "FORBIDDEN", "Upload owner required") }
                if upload.status == "ready", let item = upload.item.flatMap({ state.items[$0] }) { return dataResponse(itemJSON(item)) }
                guard upload.status == "uploaded", upload.expires > now else { throw APIError(409, "UPLOAD_INCOMPLETE", "Upload must finish before completion") }
                try itemCapacity(upload.room)
                let item = Item(id: uid(), room: upload.room, sender: upload.member, created: now, sequence: state.rooms[upload.room]!.sequence + 1, asset: upload.id)
                upload.status = "ready"; upload.item = item.id; state.uploads[upload.id] = upload; state.items[item.id] = item
                emit(upload.room, "upload.updated", upload.json); emit(upload.room, "item.created", itemJSON(item))
                return dataResponse(itemJSON(item), status: 201)
            }
        }
        if path.count == 3 && path.first == "assets" && path[2] == "links" && method == "POST" {
            try body.only(["expiresAt"])
            guard let asset = state.uploads[path[1]], asset.status == "ready" else { throw APIError(404, "NOT_FOUND", "Asset not found") }
            let m = try member(asset.room, s.id)
            guard asset.device == s.id || m.role == "owner" else { throw APIError(403, "FORBIDDEN", "Cannot share this asset") }
            let expires: Double
            if body["expiresAt"] == .null { expires = now + 86400 }
            else { guard let date = body["expiresAt"].string.flatMap(timestamp), date > now + 60, date <= now + 86400 else { throw APIError(400, "INVALID_INPUT", "Expiry must be between one minute and 24 hours") }; expires = date }
            guard state.links.values.filter({ $0.room == asset.room && $0.revoked == nil }).count < 100 else { throw APIError(409, "LINK_LIMIT", "Room link limit reached") }
            let words = ["mint", "lake", "pine", "moon", "sand", "fern", "bird", "snow", "dawn", "leaf", "wave", "star", "rain", "hill", "rose", "wind"]
            let alphabet = Array("23456789abcdefghjkmnpqrstuvwxyz")
            var slug: String
            repeat { slug = words.randomElement()! + "-" + words.randomElement()! + "-" + String((0..<6).map { _ in alphabet.randomElement()! }) } while state.links.values.contains(where: { $0.slug == slug })
            let link = ShareLink(id: uid(), asset: asset.id, room: asset.room, creator: s.id, slug: slug, expires: expires)
            state.links[link.id] = link
            return dataResponse(link.json(origin: settings.publicOrigin), status: 201)
        }
        if path.count == 2 && path.first == "links" && method == "DELETE" {
            guard let link = state.links[path[1]] else { throw APIError(404, "NOT_FOUND", "Link not found") }
            let m = try member(link.room, s.id)
            guard link.creator == s.id || m.role == "owner" else { throw APIError(403, "FORBIDDEN", "Cannot revoke this link") }
            state.links[link.id]?.revoked = now; return WireResponse(status: 204)
        }
        throw APIError(404, "NOT_FOUND", "Route not found")
    }
    func withCursor(_ json: JSON, room: String) -> JSON {
        var object = json.object!; object["eventCursor"] = str(String(state.rooms[room]!.sequence)); return .object(object)
    }
    func itemCapacity(_ room: String) throws {
        guard state.items.values.filter({ $0.room == room }).count < settings.maxItems else { throw APIError(409, "ITEM_LIMIT", "Room item limit reached") }
    }
    func createUpload(_ body: JSON, _ room: String, _ s: Session, _ m: Member) throws -> WireResponse {
        try body.only(["filename", "sizeBytes", "contentType"])
        let filename = try body.required("filename", max: 240)
        guard !filename.contains("/"), !filename.contains("\\"), !filename.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }), filename != ".", filename != ".." else { throw APIError(400, "INVALID_INPUT", "Invalid filename") }
        guard let size = body["sizeBytes"].integer, size > 0 else { throw APIError(400, "INVALID_INPUT", "sizeBytes must be positive") }
        guard size <= settings.maxFileBytes else { throw APIError(413, "FILE_TOO_LARGE", "File exceeds configured limit") }
        let type = try body.required("contentType", max: 128)
        guard type.utf8.allSatisfy({ $0 > 32 && $0 < 127 }), type.contains("/") else { throw APIError(400, "INVALID_INPUT", "Invalid contentType") }
        let live = state.uploads.values.filter { ["pending", "uploading", "uploaded", "ready", "failed"].contains($0.status) }
        guard live.filter({ $0.room == room }).reduce(0, { $0 + $1.size }) + size <= settings.roomBytes,
              live.reduce(0, { $0 + $1.size }) + size <= settings.totalBytes,
              live.filter({ $0.room == room }).count < 200 else { throw APIError(409, "QUOTA_EXCEEDED", "Storage quota exceeded") }
        let upload = Upload(id: uid(), room: room, device: s.id, member: m.id, filename: filename, size: size, declaredType: type, created: now, expires: now + settings.uploadSeconds)
        state.uploads[upload.id] = upload
        return dataResponse(.object(["uploadId": str(upload.id), "uploadUrl": str("/api/v1/uploads/" + upload.id + "/content"), "expiresAt": iso(upload.expires), "status": str(upload.status)]), status: 201)
    }
    func share(_ slug: String, source: String) throws -> Upload {
        _ = try limit("public:" + source, max: 120)
        guard let link = state.links.values.first(where: { $0.slug == slug }) else { throw APIError(404, "NOT_FOUND", "Share not found") }
        guard link.expires > now, link.revoked == nil, state.rooms[link.room]?.closed == nil,
              let asset = state.uploads[link.asset], asset.status == "ready" else { throw APIError(410, "SHARE_EXPIRED", "Share expired or revoked") }
        return asset
    }
    func shareMetadata(_ slug: String, source: String) throws -> WireResponse {
        try transaction {
            sweep(); _ = try limit("global", max: 3000); let asset = try share(slug, source: source)
            let link = state.links.values.first { $0.slug == slug }!
            return dataResponse(.object(["asset": asset.json, "expiresAt": iso(link.expires), "contentUrl": str(settings.publicOrigin + "/d/" + slug)]))
        }
    }
}
