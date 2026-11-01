import Foundation
import Vapor

struct BusinessRoutes: RouteCollection {
    let store: Store
    let settings: Settings

    private func makeContext(for request: Request) -> Context {
        Context(
            sessionHash: request.cookies["webdrop_session"].map { sha256Hex(Data($0.string.utf8)) },
            source: sha256Hex(Data((request.remoteAddress?.ipAddress ?? "unknown").utf8)),
            csrf: request.headers.first(name: "X-CSRF-Token"),
            key: request.headers.first(name: "Idempotency-Key")
        )
    }

    func validateOrigin(_ request: Request) throws {
        guard request.headers[.origin].count == 1,
            let origin = request.headers.first(name: .origin).flatMap(Settings.canonicalOrigin)
        else {
            throw APIError(403, "ORIGIN_FORBIDDEN", "Origin is not allowed")
        }
        let expectedOrigin = try requestOrigin(request)
        guard origin == expectedOrigin || settings.corsOrigins.contains(origin) else {
            throw APIError(403, "ORIGIN_FORBIDDEN", "Origin is not allowed")
        }
        if request.headers.first(name: "Sec-Fetch-Site") == "cross-site", !settings.corsOrigins.contains(origin) {
            throw APIError(403, "ORIGIN_FORBIDDEN", "Cross-site request denied")
        }
    }

    func requestOrigin(_ request: Request) throws -> String {
        guard request.headers[.host].count == 1, let host = request.headers.first(name: .host) else {
            throw APIError(400, "INVALID_INPUT", "A single valid Host header is required")
        }
        var scheme =
            settings.secureCookies || request.application.http.server.configuration.tlsConfiguration != nil
            ? "https" : "http"
        // Proxies must preserve Host and overwrite X-Forwarded-Proto; never use forwarded host/IP for authorization.
        if request.headers["X-Forwarded-Proto"].count == 1,
            let forwarded = request.headers.first(name: "X-Forwarded-Proto"), ["http", "https"].contains(forwarded)
        {
            scheme = forwarded
        }
        guard let origin = Settings.canonicalOrigin("\(scheme)://\(host)") else {
            throw APIError(400, "INVALID_INPUT", "Invalid Host header")
        }
        return origin
    }

    private func decodeJSONBody(_ request: Request) throws -> JSON {
        guard let data = request.body.data, data.readableBytes > 0 else {
            return .object([:])
        }
        guard request.headers.contentType == .json else {
            throw APIError(415, "JSON_REQUIRED", "Use application/json")
        }
        do {
            return try JSONDecoder().decode(JSON.self, from: Data(data.readableBytesView))
        } catch {
            throw APIError(400, "INVALID_JSON", "Malformed JSON")
        }
    }

    func boot(routes: any RoutesBuilder) throws {
        let api = routes.grouped("api", "v1")
        registerSessionRoutes(on: api)
        registerShareMetadataRoute(on: api)
        registerUploadRoute(on: api)
        registerDownloadRoutes(on: api, root: routes)
        registerEventRoute(on: api)
        registerJSONRoutes(on: api)
    }

    private func registerSessionRoutes(on api: any RoutesBuilder) {
        api.post("sessions") { request async throws -> Response in
            try validateOrigin(request)
            let context = makeContext(for: request)
            let (wire, token) = try await store.createSession(
                decodeJSONBody(request),
                source: context.source,
                existing: context.sessionHash
            )
            let response = try wire.response(origin: try requestOrigin(request))
            if let token {
                let responseOrigin = try requestOrigin(request)
                let isCrossOrigin =
                    request.headers.first(name: .origin).flatMap(Settings.canonicalOrigin)
                    != responseOrigin
                let crossSiteCookie = isCrossOrigin && responseOrigin.hasPrefix("https://")
                response.cookies["webdrop_session"] = .init(
                    string: token,
                    maxAge: Int(settings.sessionSeconds),
                    path: "/",
                    isSecure: settings.secureCookies || crossSiteCookie,
                    isHTTPOnly: true,
                    sameSite: crossSiteCookie ? HTTPCookies.SameSitePolicy.none : .strict
                )
            }
            return response
        }
    }

    private func registerShareMetadataRoute(on api: any RoutesBuilder) {
        api.get("shares", ":slug") { request async throws -> Response in
            let slug = try routeParameter("slug", in: request)
            let metadata = try await store.shareMetadata(slug, source: makeContext(for: request).source)
            return try metadata.response(origin: try requestOrigin(request))
        }
    }

    private func registerUploadRoute(on api: any RoutesBuilder) {
        api.on(.PUT, "uploads", ":uploadId", "content", body: .stream) { request async throws -> Response in
            try validateOrigin(request)
            let context = makeContext(for: request)
            let rawLength = request.headers.first(name: .contentLength)
            let length: Int?
            if let rawLength {
                guard let parsedLength = Int(rawLength), parsedLength >= 0 else {
                    throw APIError(400, "INVALID_INPUT", "Invalid Content-Length")
                }
                length = parsedLength
            } else {
                length = nil
            }
            let uploadID = try routeParameter("uploadId", in: request)
            let ticket = try await store.beginUpload(uploadID, context, length: length)
            do {
                let writer = try UploadWriter(
                    path: ticket.path,
                    expected: ticket.upload.size,
                    inMemory: ticket.upload.storage == "memory"
                )
                do {
                    for try await chunk in request.body {
                        try await store.validateUpload(ticket, context: context)
                        try await writer.write(Data(chunk.readableBytesView))
                    }
                    let (checksum, type, memory) = try await writer.finish()
                    return try await store.finishUpload(
                        ticket,
                        context: context,
                        checksum: checksum,
                        type: type,
                        memory: memory
                    ).response(origin: try requestOrigin(request))
                } catch {
                    await writer.cancel()
                    throw error
                }
            } catch {
                try? FileManager.default.removeItem(atPath: ticket.path)
                try await store.failUpload(ticket)
                throw error
            }
        }
    }

    private func registerDownloadRoutes(on api: any RoutesBuilder, root: any RoutesBuilder) {
        api.get("assets", ":assetId", "content") { request async throws -> Response in
            let assetID = try routeParameter("assetId", in: request)
            let file = try await store.download(
                assetID,
                context: makeContext(for: request),
                publicLink: false
            )
            return try await downloadResponse(request, file)
        }
        root.get("d", ":slug") { request async throws -> Response in
            let slug = try routeParameter("slug", in: request)
            let file = try await store.download(
                slug,
                context: makeContext(for: request),
                publicLink: true
            )
            return try await downloadResponse(request, file)
        }
    }

    private func registerEventRoute(on api: any RoutesBuilder) {
        api.get("rooms", ":roomId", "events") { request async throws -> Response in
            let roomID = try routeParameter("roomId", in: request)
            let context = makeContext(for: request)
            let rawCursor = request.headers.first(name: "Last-Event-ID") ?? request.query[String.self, at: "cursor"]
            let cursor: Int?
            if let rawCursor {
                guard let parsedCursor = Int(rawCursor), parsedCursor >= 0 else {
                    throw APIError(400, "CURSOR_INVALID", "Invalid event cursor")
                }
                cursor = parsedCursor
            } else {
                cursor = nil
            }
            try await store.subscribe(room: roomID, context: context)
            let initial: EventBatch
            do {
                initial = try await store.eventBatch(room: roomID, context: context, after: cursor)
            } catch {
                await store.unsubscribe(context: context)
                throw error
            }
            let response = Response(headers: [
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
            ])
            response.body = .init(managedAsyncStream: { writer in
                do {
                    var batch = initial
                    var previous = cursor
                    let deadline = ContinuousClock.now + .seconds(120)
                    while ContinuousClock.now < deadline {
                        if await store.isStopping { break }
                        try Task.checkCancellation()
                        let cursorPayload: JSON = .object(["eventCursor": .string(String(batch.cursor))])
                        if batch.resync {
                            let frame = try encodeSSEEvent(type: "resync.required", data: cursorPayload)
                            try await writer.write(.buffer(frame))
                            break
                        }
                        for event in batch.events {
                            let frame = try encodeSSEEvent(type: event.type, id: event.id, data: event.json)
                            try await writer.write(.buffer(frame))
                        }
                        previous = batch.cursor
                        let heartbeat = try encodeSSEEvent(type: "heartbeat", id: batch.cursor, data: cursorPayload)
                        try await writer.write(.buffer(heartbeat))
                        if batch.closed {
                            break
                        }
                        await store.waitForEvent(
                            room: roomID,
                            after: batch.cursor,
                            timeout: min(.seconds(2), ContinuousClock.now.duration(to: deadline))
                        )
                        if await store.isStopping { break }
                        batch = try await store.eventBatch(room: roomID, context: context, after: previous)
                    }
                    await store.unsubscribe(context: context)
                } catch {
                    await store.unsubscribe(context: context)
                    // Revocation / expiry terminates the stream; reconnect is subject to authorization.
                    if error is APIError || error is CancellationError {
                        return
                    }
                    throw error
                }
            })
            return response
        }
    }

    private func registerJSONRoutes(on api: any RoutesBuilder) {
        // Explicit JSON routes keep unknown endpoints and methods outside the dispatcher.
        let definitions: [(HTTPMethod, [PathComponent])] = [
            (.GET, ["rooms", ":roomId", "join-requests"]),
            (.GET, ["rooms", ":roomId", "join-requests", ":requestId"]),
            (.DELETE, ["rooms", ":roomId", "join-requests", ":requestId"]),
            (.POST, ["rooms", ":roomId", "join-requests", ":requestId", "approve"]),
            (.POST, ["rooms", ":roomId", "join-requests", ":requestId", "reject"]),
            (.GET, ["capabilities"]),
            (.GET, ["room-capacity"]),
            (.GET, ["session"]),
            (.PATCH, ["session"]),
            (.POST, ["pow", "challenges"]),
            (.POST, ["rooms"]),
            (.POST, ["rooms", "join"]),
            (.GET, ["rooms", ":roomId"]),
            (.PATCH, ["rooms", ":roomId"]),
            (.DELETE, ["rooms", ":roomId"]),
            (.POST, ["rooms", ":roomId", "code", "rotate"]),
            (.GET, ["rooms", ":roomId", "members"]),
            (.DELETE, ["rooms", ":roomId", "members", ":memberId"]),
            (.GET, ["rooms", ":roomId", "items"]),
            (.POST, ["rooms", ":roomId", "items"]),
            (.DELETE, ["rooms", ":roomId", "items", ":itemId"]),
            (.POST, ["rooms", ":roomId", "uploads"]),
            (.DELETE, ["uploads", ":uploadId"]),
            (.GET, ["uploads", ":uploadId"]),
            (.POST, ["uploads", ":uploadId", "complete"]),
            (.POST, ["assets", ":assetId", "links"]),
            (.GET, ["rooms", ":roomId", "links"]),
            (.DELETE, ["links", ":linkId"]),
        ]
        for (method, path) in definitions {
            api.on(method, path, body: .collect(maxSize: "64kb")) { request async throws -> Response in
                if method != .GET {
                    try validateOrigin(request)
                }
                let payload = try decodeJSONBody(request)
                let parts = request.url.path.split(separator: "/").dropFirst(2).map(String.init)
                var query: [String: String] = [:]
                for key in ["limit", "cursor"] {
                    query[key] = request.query[String.self, at: key]
                }
                return try await store.handle(
                    method: method.rawValue,
                    path: parts,
                    body: payload,
                    context: makeContext(for: request),
                    query: query
                ).response(origin: try requestOrigin(request))
            }
        }
    }

    private func routeParameter(_ name: String, in request: Request) throws -> String {
        guard let value = request.parameters.get(name) else {
            throw APIError(404, "NOT_FOUND", "Route not found")
        }
        return value
    }

    private func encodeSSEEvent(type: String, id: Int? = nil, data: JSON) throws -> ByteBuffer {
        var fields: [String] = []
        if let id {
            fields.append("id: \(id)")
        }
        fields.append("event: \(type)")
        let payload = String(decoding: try data.encodedData(), as: UTF8.self)
        fields.append("data: \(payload)")
        return ByteBuffer(string: fields.joined(separator: "\n") + "\n\n")
    }

    private func downloadResponse(_ request: Request, _ file: Download) async throws -> Response {
        var start = 0
        var end = file.size - 1
        var partial = false
        if let raw = request.headers.first(name: .range) {
            guard raw.hasPrefix("bytes="), !raw.contains(",") else {
                return invalidRange(file.size)
            }
            let pair = raw.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
            guard pair.count == 2 else {
                return invalidRange(file.size)
            }
            if pair[0].isEmpty {
                guard let suffix = Int(pair[1]), suffix > 0 else {
                    return invalidRange(file.size)
                }
                start = max(0, file.size - suffix)
            } else {
                guard let first = Int(pair[0]), first >= 0, first < file.size else {
                    return invalidRange(file.size)
                }
                start = first
                if !pair[1].isEmpty {
                    guard let last = Int(pair[1]), last >= start else {
                        return invalidRange(file.size)
                    }
                    end = min(last, file.size - 1)
                }
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
        response.headers.replaceOrAdd(
            name: .contentDisposition,
            value: "\(disposition); filename=\"download\"; filename*=UTF-8''\(filename)"
        )
        if partial {
            response.headers.replaceOrAdd(name: .contentRange, value: "bytes \(start)-\(end)/\(file.size)")
        }
        if request.method != .HEAD, let memory = file.memory {
            response.body = .init(data: memory.subdata(in: start..<(end + 1)))
        } else if request.method != .HEAD {
            let offset = Int64(start)
            response.body = .init(
                managedAsyncStream: { writer in
                    let chunks = try await request.fileio.readFile(
                        at: file.path,
                        chunkSize: 65536,
                        offset: offset,
                        byteCount: count
                    )
                    do {
                        for try await chunk in chunks {
                            try await writer.write(.buffer(chunk))
                        }
                    } catch {
                        try? await chunks.closeHandle()
                        throw error
                    }
                },
                count: count
            )
        }
        return response
    }

    private func invalidRange(_ size: Int) -> Response {
        Response(
            status: .rangeNotSatisfiable,
            headers: [
                "Content-Range": "bytes */\(size)",
                "Cache-Control": "no-store",
            ]
        )
    }
}
