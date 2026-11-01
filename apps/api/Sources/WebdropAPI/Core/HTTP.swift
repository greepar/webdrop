import Foundation
import Vapor

struct BusinessRoutes: RouteCollection {
    let store: Store
    let settings: Settings
    func context(_ req: Request) -> Context {
        Context(sessionHash: req.cookies["webdrop_session"].map { hash($0.string) }, source: hash(req.remoteAddress?.ipAddress ?? "unknown"), csrf: req.headers.first(name: "X-CSRF-Token"), key: req.headers.first(name: "Idempotency-Key"))
    }
    func checkOrigin(_ req: Request) throws {
        guard let origin = req.headers.first(name: .origin), settings.origins.contains(origin) else { throw APIError(403, "ORIGIN_FORBIDDEN", "Origin is not allowed") }
        if req.headers.first(name: "Sec-Fetch-Site") == "cross-site" { throw APIError(403, "ORIGIN_FORBIDDEN", "Cross-site request denied") }
    }
    func body(_ req: Request) throws -> JSON {
        guard let data = req.body.data, data.readableBytes > 0 else { return .object([:]) }
        guard req.headers.contentType == .json else { throw APIError(415, "JSON_REQUIRED", "Use application/json") }
        do { return try JSONDecoder().decode(JSON.self, from: Data(data.readableBytesView)) }
        catch { throw APIError(400, "INVALID_JSON", "Malformed JSON") }
    }
    func boot(routes: any RoutesBuilder) throws {
        let api = routes.grouped("api", "v1")
        api.post("sessions") { req async throws -> Response in
            try checkOrigin(req)
            let c = context(req)
            let (wire, token) = try await store.createSession(body(req), source: c.source, existing: c.sessionHash)
            let response = try wire.response()
            if let token {
                response.cookies["webdrop_session"] = .init(string: token, maxAge: Int(settings.sessionSeconds), path: "/", isSecure: settings.secureCookies, isHTTPOnly: true, sameSite: .strict)
            }
            return response
        }
        api.get("shares", ":slug") { req async throws -> Response in
            try await store.shareMetadata(req.parameters.get("slug")!, source: context(req).source).response()
        }
        api.on(.PUT, "uploads", ":uploadId", "content", body: .stream) { req async throws -> Response in
            try checkOrigin(req)
            let c = context(req)
            let rawLength = req.headers.first(name: .contentLength)
            let length = rawLength.flatMap(Int.init)
            if rawLength != nil && (length == nil || length! < 0) { throw APIError(400, "INVALID_INPUT", "Invalid Content-Length") }
            let ticket = try await store.beginUpload(req.parameters.get("uploadId")!, c, length: length)
            do {
                let writer = try UploadWriter(path: ticket.path, expected: ticket.upload.size, inMemory: ticket.upload.storage == "memory")
                do {
                    for try await chunk in req.body {
                        try await store.validateUpload(ticket, c: c)
                        try await writer.write(Data(chunk.readableBytesView))
                    }
                    let (sha, type, memory) = try await writer.finish()
                    return try await store.finishUpload(ticket, c: c, sha: sha, type: type, memory: memory).response()
                } catch { await writer.cancel(); throw error }
            } catch {
                try? FileManager.default.removeItem(atPath: ticket.path)
                try await store.failUpload(ticket)
                throw error
            }
        }
        api.get("assets", ":assetId", "content") { req async throws -> Response in
            let file = try await store.download(req.parameters.get("assetId")!, c: context(req), publicLink: false)
            return try await downloadResponse(req, file)
        }
        routes.get("d", ":slug") { req async throws -> Response in
            let file = try await store.download(req.parameters.get("slug")!, c: context(req), publicLink: true)
            return try await downloadResponse(req, file)
        }
        api.get("rooms", ":roomId", "events") { req async throws -> Response in
            let room = req.parameters.get("roomId")!; let c = context(req)
            let raw = req.headers.first(name: "Last-Event-ID") ?? req.query[String.self, at: "cursor"]
            let cursor = raw.flatMap(Int.init)
            if raw != nil && (cursor == nil || cursor! < 0) { throw APIError(400, "CURSOR_INVALID", "Invalid event cursor") }
            try await store.subscribe(room: room, c: c)
            let initial: EventBatch
            do { initial = try await store.eventBatch(room: room, c: c, after: cursor) }
            catch { await store.unsubscribe(c: c); throw error }
            let response = Response(headers: ["Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no"])
            response.body = .init(managedAsyncStream: { writer in
                do {
                    var batch = initial
                    var previous = cursor
                    for _ in 0..<60 {
                        if batch.resync {
                            try await writer.write(.buffer(ByteBuffer(string: "event: resync.required\ndata: {\"eventCursor\":\"\(batch.cursor)\"}\n\n")))
                            break
                        }
                        for event in batch.events {
                            let json = String(decoding: try event.json.bytes(), as: UTF8.self)
                            try await writer.write(.buffer(ByteBuffer(string: "id: \(event.id)\nevent: \(event.type)\ndata: \(json)\n\n")))
                        }
                        previous = batch.cursor
                        try await writer.write(.buffer(ByteBuffer(string: "id: \(batch.cursor)\nevent: heartbeat\ndata: {\"eventCursor\":\"\(batch.cursor)\"}\n\n")))
                        if batch.closed { break }
                        try await Task.sleep(for: .seconds(2))
                        batch = try await store.eventBatch(room: room, c: c, after: previous)
                    }
                    await store.unsubscribe(c: c)
                } catch {
                    await store.unsubscribe(c: c)
                    // Revocation / expiry terminates the stream; reconnect is subject to authorization.
                    if error is APIError { return }
                    throw error
                }
            })
            return response
        }
        // Explicit JSON routes keep unknown endpoints and methods outside the dispatcher.
        let definitions: [(HTTPMethod, [PathComponent])] = [
            (.GET, ["rooms", ":roomId", "join-requests"]),
            (.GET, ["rooms", ":roomId", "join-requests", ":requestId"]),
            (.POST, ["rooms", ":roomId", "join-requests", ":requestId", "approve"]),
            (.POST, ["rooms", ":roomId", "join-requests", ":requestId", "reject"]),
            (.GET, ["capabilities"]), (.GET, ["session"]), (.POST, ["pow", "challenges"]),
            (.POST, ["rooms"]), (.POST, ["rooms", "join"]), (.GET, ["rooms", ":roomId"]),
            (.PATCH, ["rooms", ":roomId"]), (.DELETE, ["rooms", ":roomId"]),
            (.POST, ["rooms", ":roomId", "code", "rotate"]), (.GET, ["rooms", ":roomId", "members"]),
            (.DELETE, ["rooms", ":roomId", "members", ":memberId"]),
            (.GET, ["rooms", ":roomId", "items"]), (.POST, ["rooms", ":roomId", "items"]),
            (.DELETE, ["rooms", ":roomId", "items", ":itemId"]),
            (.POST, ["rooms", ":roomId", "uploads"]), (.DELETE, ["uploads", ":uploadId"]),
            (.GET, ["uploads", ":uploadId"]), (.POST, ["uploads", ":uploadId", "complete"]), (.POST, ["assets", ":assetId", "links"]),
            (.GET, ["rooms", ":roomId", "links"]), (.DELETE, ["links", ":linkId"])
        ]
        for (method, path) in definitions {
            api.on(method, path, body: .collect(maxSize: "64kb")) { req async throws -> Response in
                if method != .GET { try checkOrigin(req) }
                let payload = try body(req)
                let parts = req.url.path.split(separator: "/").dropFirst(2).map(String.init)
                var query: [String: String] = [:]
                for key in ["limit", "cursor"] { query[key] = req.query[String.self, at: key] }
                return try await store.handle(method: method.rawValue, path: parts, body: payload, context: context(req), query: query).response()
            }
        }
    }
    func downloadResponse(_ req: Request, _ file: Download) async throws -> Response {
        var start = 0; var end = file.size - 1; var partial = false
        if let raw = req.headers.first(name: .range) {
            guard raw.hasPrefix("bytes="), !raw.contains(",") else { return invalidRange(file.size) }
            let pair = raw.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
            guard pair.count == 2 else { return invalidRange(file.size) }
            if pair[0].isEmpty {
                guard let suffix = Int(pair[1]), suffix > 0 else { return invalidRange(file.size) }
                start = max(0, file.size - suffix)
            } else {
                guard let first = Int(pair[0]), first >= 0, first < file.size else { return invalidRange(file.size) }
                start = first
                if !pair[1].isEmpty { guard let last = Int(pair[1]), last >= start else { return invalidRange(file.size) }; end = min(last, file.size - 1) }
            }
            partial = true
        }
        let count = end - start + 1
        let response = Response(status: partial ? .partialContent : .ok)
        response.headers.replaceOrAdd(name: .contentType, value: file.type)
        response.headers.replaceOrAdd(name: .contentLength, value: String(count))
        response.headers.replaceOrAdd(name: .acceptRanges, value: "bytes")
        response.headers.replaceOrAdd(name: .cacheControl, value: "no-store")
        response.headers.replaceOrAdd(name: "X-Content-Type-Options", value: "nosniff")
        response.headers.replaceOrAdd(name: "Content-Security-Policy", value: "default-src 'none'; sandbox")
        let disposition = file.type == "application/octet-stream" ? "attachment" : "inline"
        let filename = file.filename.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "file"
        response.headers.replaceOrAdd(name: .contentDisposition, value: "\(disposition); filename=\"download\"; filename*=UTF-8''\(filename)")
        if partial { response.headers.replaceOrAdd(name: .contentRange, value: "bytes \(start)-\(end)/\(file.size)") }
        if req.method != .HEAD, let memory = file.memory {
            response.body = .init(data: memory.subdata(in: start..<(end + 1)))
        } else if req.method != .HEAD {
            let offset = Int64(start)
            response.body = .init(managedAsyncStream: { writer in
                let chunks = try await req.fileio.readFile(at: file.path, chunkSize: 65536, offset: offset, byteCount: count)
                do { for try await chunk in chunks { try await writer.write(.buffer(chunk)) } }
                catch { try? await chunks.closeHandle(); throw error }
            }, count: count)
        }
        return response
    }
    func invalidRange(_ size: Int) -> Response {
        Response(status: .rangeNotSatisfiable, headers: ["Content-Range": "bytes */\(size)", "Cache-Control": "no-store"])
    }
}
