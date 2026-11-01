import Foundation
import Testing
import VaporTesting

@testable import WebdropAPI

final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Double = 1_800_000_000

    func now() -> Double {
        lock.lock()
        defer {
            lock.unlock()
        }
        return value
    }

    func advance(_ seconds: Double) {
        lock.lock()
        defer {
            lock.unlock()
        }
        value += seconds
    }
}

struct Fixture {
    let settings: Settings
    let store: Store
    let clock = TestClock()

    init(
        maxDevices: Int = 10,
        memoryThreshold: Int = 0,
        memoryBudget: Int = 64,
        maxRooms: Int = 500,
        maxOwnedRooms: Int = 5
    ) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "webdrop-test-" + UUID().uuidString.lowercased()
        ).path
        var config = Settings(
            directory: directory,

            secureCookies: false
        )
        config.maxRooms = maxRooms
        config.maxOwnedRooms = maxOwnedRooms
        config.memoryFileBytes = memoryThreshold
        config.memoryTotalBytes = memoryBudget
        config.baseBits = 4
        config.maxBits = 10
        config.maxDevices = maxDevices
        let clock = self.clock
        config.now = { clock.now() }
        settings = config
        store = try Store(settings: config)
    }

    func clean() {
        try? FileManager.default.removeItem(atPath: settings.directory)
    }

    func user(_ name: String) async throws -> Context {
        let (wire, token) = try await store.createSession(
            .object(["displayName": .string(name)]),
            source: name,
            existing: nil
        )
        return Context(
            sessionHash: sha256Hex(Data(try #require(token).utf8)),
            source: name,
            csrf: wire.json["data"]["csrfToken"].string,
            key: nil
        )
    }

    func request(
        _ method: String,
        _ path: String,
        _ body: JSON = .object([:]),
        _ context: Context,
        key: String? = nil
    ) async throws -> WireResponse {
        var context = context
        context.key = key
        return try await store.handle(
            method: method,
            path: path.split(separator: "/").map(String.init),
            body: body,
            context: context
        )
    }

    func proved(
        _ context: Context,
        code: String? = nil,
        joining: Bool = false,
        key: String = UUID().uuidString.lowercased()
    ) async throws -> (JSON, String) {
        var input: [String: JSON] = [
            "action": .string(joining ? "room.join" : "room.create"),
            "idempotencyKey": .string(key),
        ]
        if let code {
            input["code"] = .string(code)
        }
        let challenge = try await request("POST", "pow/challenges", .object(input), context).json["data"]
        var nonce = 0
        while !isValidProof(
            input: challenge["input"].string!,
            nonce: String(nonce),
            bits: challenge["difficulty"].integer!
        ) {
            nonce += 1
        }
        var body: [String: JSON] = [
            "proof": .object([
                "challengeId": challenge["challengeId"],
                "nonce": .string(String(nonce)),
            ])
        ]
        if let code {
            body["code"] = .string(code)
        }
        return (.object(body), key)
    }

    func room(_ context: Context, code: String = "0042") async throws -> JSON {
        let (body, key) = try await proved(context, code: code)
        return try await request("POST", "rooms", body, context, key: key).json["data"]
    }

    func join(_ context: Context, code: String = "0042") async throws -> JSON {
        let (body, key) = try await proved(context, code: code, joining: true)
        return try await request("POST", "rooms/join", body, context, key: key).json["data"]
    }
}

func expectError(_ code: String, _ operation: () async throws -> Void) async {
    do {
        try await operation()
        Issue.record("Expected \(code)")
    } catch let apiError as APIError {
        #expect(apiError.code == code)
    } catch {
        Issue.record("Unexpected error: \(error)")
    }
}

@Test
func roomsPermissionsIdempotencyAndHistory() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let owner = try await fixture.user("owner")
    let guest = try await fixture.user("guest")
    let (create, key) = try await fixture.proved(owner, code: "0042")
    let first = try await fixture.request("POST", "rooms", create, owner, key: key)
    let replay = try await fixture.request("POST", "rooms", create, owner, key: key)
    #expect(first.json == replay.json)
    let room = first.json["data"]["room"]["id"].string!
    #expect(first.json["data"]["room"]["code"] == .string("0042"))
    let posted = try await fixture.request(
        "POST",
        "rooms/\(room)/items",
        .object(["text": .string("你好\nSwift")]),
        owner,
        key: "message-key"
    ).json["data"]
    let membership = try await fixture.join(guest)
    let history = try await fixture.request("GET", "rooms/\(room)/items", guest)
    if case .array(let items) = history.json["data"] {
        #expect(items.count == 1)
        #expect(items[0] == posted)
    } else {
        Issue.record("Missing list")
    }
    await expectError("OWNER_REQUIRED") { _ = try await fixture.request("DELETE", "rooms/\(room)", guest) }
    await expectError("FORBIDDEN") {
        _ = try await fixture.request("DELETE", "rooms/\(room)/items/\(posted["id"].string!)", guest)
    }
    await expectError("IDEMPOTENCY_CONFLICT") {
        _ = try await fixture.request(
            "POST",
            "rooms/\(room)/items",
            .object(["text": .string("changed")]),
            owner,
            key: "message-key"
        )
    }
    let cursor = history.json["eventCursor"].string.flatMap(Int.init)!
    _ = try await fixture.request("DELETE", "rooms/\(room)/members/\(membership["membership"]["id"].string!)", owner)
    await expectError("NOT_FOUND") { _ = try await fixture.request("GET", "rooms/\(room)", guest) }
    await expectError("MEMBERSHIP_REVOKED") {
        _ = try await fixture.store.eventBatch(room: room, context: guest, after: cursor)
    }
    await expectError("ROOM_UNAVAILABLE") { _ = try await fixture.join(guest) }
}

@Test
func powBindingReplayDifficultyAndCooldown() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let user = try await fixture.user("pow")
    let (body, key) = try await fixture.proved(user, code: "0042")
    var altered = body.object!
    altered["code"] = .string("0043")
    await expectError("POW_INVALID") {
        _ = try await fixture.request("POST", "rooms", .object(altered), user, key: key)
    }
    await expectError("POW_INVALID") { _ = try await fixture.request("POST", "rooms", body, user, key: key) }
    var difficulties: [Int] = []
    for _ in 0..<7 {
        let wire = try await fixture.request(
            "POST",
            "pow/challenges",
            .object([
                "action": .string("room.create"),
                "idempotencyKey": .string(UUID().uuidString.lowercased()),
            ]),
            user
        )
        difficulties.append(wire.json["data"]["difficulty"].integer!)
    }
    #expect(difficulties.last! > difficulties.first!)
    fixture.clock.advance(601)
    let challenge = try await fixture.request(
        "POST",
        "pow/challenges",
        .object([
            "action": .string("room.create"),
            "idempotencyKey": .string(UUID().uuidString.lowercased()),
        ]),
        user
    )
    #expect(challenge.json["data"]["difficulty"].integer == fixture.settings.baseBits)
    let (expired, expiredKey) = try await fixture.proved(user)
    fixture.clock.advance(121)
    await expectError("POW_INVALID") { _ = try await fixture.request("POST", "rooms", expired, user, key: expiredKey) }
}

@Test
func capacityLockAndOwnerLeave() async throws {
    let fixture = try Fixture(maxDevices: 2)
    defer {
        fixture.clean()
    }
    let firstUser = try await fixture.user("a")
    let secondUser = try await fixture.user("b")
    let context = try await fixture.user("c")
    let room = try await fixture.room(firstUser)["room"]["id"].string!
    _ = try await fixture.join(secondUser)
    _ = try await fixture.join(secondUser)  // Reconnecting the same session must not consume a slot.
    await expectError("ROOM_FULL") { _ = try await fixture.join(context) }
    await expectError("OWNER_MUST_CLOSE") {
        _ = try await fixture.request("DELETE", "rooms/\(room)/members/me", firstUser)
    }
    _ = try await fixture.request("DELETE", "rooms/\(room)/members/me", secondUser)
    _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["joinPolicy": .string("locked")]), firstUser)
    await expectError("ROOM_UNAVAILABLE") { _ = try await fixture.join(context) }
    let rotated = try await fixture.request("POST", "rooms/\(room)/code/rotate", .object([:]), firstUser)
    #expect(rotated.json["data"]["code"] != .string("0042"))
}

@Test
func streamedUploadSharingRevocationAndExpiry() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let owner = try await fixture.user("files")
    let room = try await fixture.room(owner)["room"]["id"].string!
    let bytes = Data("hello world".utf8)
    let upload = try await fixture.request(
        "POST",
        "rooms/\(room)/uploads",
        .object([
            "filename": .string("sample.txt"),
            "contentType": .string("image/png"),
            "sizeBytes": .number(Double(bytes.count)),
        ]),
        owner,
        key: UUID().uuidString.lowercased()
    ).json["data"]["uploadId"].string!
    let ticket = try await fixture.store.beginUpload(upload, owner, length: bytes.count)
    let writer = try UploadWriter(path: ticket.path, expected: bytes.count)
    try await writer.write(bytes.prefix(5))
    try await writer.write(bytes.dropFirst(5))
    let (checksum, type, memory) = try await writer.finish()
    #expect(checksum == sha256Hex(bytes))
    #expect(type == "application/octet-stream")
    _ = try await fixture.store.finishUpload(ticket, context: owner, checksum: checksum, type: type, memory: memory)
    _ = try await fixture.request(
        "POST",
        "uploads/\(upload)/complete",
        .object([:]),
        owner,
        key: UUID().uuidString.lowercased()
    )
    let link = try await fixture.request(
        "POST",
        "assets/\(upload)/links",
        .object([:]),
        owner,
        key: UUID().uuidString.lowercased()
    ).json[
        "data"
    ]
    let downloaded = try await fixture.store.download(link["slug"].string!, context: owner, publicLink: true)
    #expect(try Data(contentsOf: URL(fileURLWithPath: downloaded.path)) == bytes)
    _ = try await fixture.request("DELETE", "rooms/\(room)", owner)
    await expectError("SHARE_EXPIRED") {
        _ = try await fixture.store.download(link["slug"].string!, context: owner, publicLink: true)
    }
    try await fixture.store.maintain()
    #expect(!FileManager.default.fileExists(atPath: downloaded.path))
}

@Test
func mediaTypeSniffingCoversInlineFormats() {
    func ftyp(_ brand: String) -> Data {
        var data = Data([0, 0, 0, 32])
        data.append(Data("ftyp".utf8))
        data.append(Data(brand.utf8))
        return data
    }
    #expect(mediaType(ftyp("iso4")) == "video/mp4")
    #expect(mediaType(ftyp("isom")) == "video/mp4")
    #expect(mediaType(ftyp("M4A ")) == "audio/mp4")
    #expect(mediaType(ftyp("qt  ")) == "video/quicktime")
    #expect(mediaType(Data("ID3\u{03}\u{00}".utf8)) == "audio/mpeg")
    #expect(mediaType(Data([0xFF, 0xFB, 0x90, 0x64])) == "audio/mpeg")
    #expect(mediaType(Data("RIFF".utf8) + Data([0, 0, 0, 0]) + Data("WAVE".utf8)) == "audio/wav")
    #expect(mediaType(Data("OggS".utf8)) == "audio/ogg")
    #expect(mediaType(Data("fLaC".utf8)) == "audio/flac")
    #expect(mediaType(Data([0x1A, 0x45, 0xDF, 0xA3])) == "video/webm")
    #expect(mediaType(Data("hello world".utf8)) == "application/octet-stream")
    #expect(mediaType(Data("<svg xmlns='http://www.w3.org/2000/svg'></svg>".utf8)) == "application/octet-stream")
}

@Test
func restartRetypesLegacyMediaUploads() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        "webdrop-test-" + UUID().uuidString.lowercased()
    ).path
    try FileManager.default.createDirectory(atPath: directory + "/files", withIntermediateDirectories: true)
    defer {
        try? FileManager.default.removeItem(atPath: directory)
    }
    var config = Settings(
        directory: directory,

        secureCookies: false
    )
    config.memoryFileBytes = 0
    let bytes = Data([0, 0, 0, 32]) + Data("ftypiso4".utf8) + Data(repeating: 0, count: 16)
    try bytes.write(to: URL(fileURLWithPath: directory + "/files/asset"))
    var state = State()
    var upload = Upload(
        id: "asset",
        room: "room",
        device: "device",
        member: "member",
        filename: "clip.mp4",
        size: bytes.count,
        declaredType: "video/mp4",
        created: 1,
        expires: 2
    )
    upload.type = "application/octet-stream"
    upload.status = "ready"
    upload.storage = "disk"
    state.uploads["asset"] = upload
    try JSONEncoder().encode(state).write(to: URL(fileURLWithPath: directory + "/state.json"))
    _ = try Store(settings: config)
    let saved = try JSONDecoder().decode(
        State.self,
        from: Data(contentsOf: URL(fileURLWithPath: directory + "/state.json"))
    )
    #expect(saved.uploads["asset"]?.type == "video/mp4")
}

@Test
func idleExpiryAndPersistence() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let owner = try await fixture.user("expiry")
    let room = try await fixture.room(owner)["room"]["id"].string!
    fixture.clock.advance(100)
    // Brief owner disconnection does not close the room.
    _ = try await fixture.request("GET", "rooms/\(room)", owner)
    fixture.clock.advance(1891)
    try await fixture.store.maintain()
    await expectError("NOT_FOUND") { _ = try await fixture.request("GET", "rooms/\(room)", owner) }
    let saved = try JSONDecoder().decode(
        State.self,
        from: Data(contentsOf: URL(fileURLWithPath: fixture.settings.directory + "/state.json"))
    )
    #expect(saved.rooms[room]?.closed != nil)
    #expect(saved.sessions[owner.sessionHash!] != nil)
    #expect(throws: APIError.self) { _ = try Store(settings: fixture.settings) }
}

@Test
func httpSessionCSRFAndErrorEnvelope() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    try await withApp(configure: { application in
        application.middleware = .init()
        application.middleware.use(APIErrorMiddleware())
        try routes(application)
        try application.register(collection: BusinessRoutes(store: fixture.store, settings: fixture.settings))
    }) { application in
        try await application.testing().test(
            .POST,
            "/api/v1/sessions",
            beforeRequest: { req in
                req.headers.contentType = .json
                req.body = ByteBuffer(string: "{}")
            },
            afterResponse: { response async throws in
                #expect(response.status == .forbidden)
                let payload = try JSONDecoder().decode(JSON.self, from: Data(response.body.readableBytesView))
                #expect(payload["error"]["code"] == .string("ORIGIN_FORBIDDEN"))
            }
        )
        try await application.testing().test(
            .GET,
            "/api/v1/capabilities",
            beforeRequest: { $0.headers.replaceOrAdd(name: .host, value: "localhost:5173") }
        ) { response async throws in
            #expect(response.status == .ok)
            let payload = try JSONDecoder().decode(JSON.self, from: Data(response.body.readableBytesView))
            #expect(payload["data"]["heartbeatSeconds"] == .number(2))
        }
        try await application.testing().test(
            .POST,
            "/api/v1/sessions",
            beforeRequest: { req in
                req.headers.contentType = .json
                req.headers.add(name: .origin, value: "http://localhost:5173")
                req.headers.replaceOrAdd(name: .host, value: "localhost:5173")
                req.body = ByteBuffer(
                    data: try JSON.object(["displayName": .string(String(repeating: "界", count: 27))]).encodedData()
                )
            },
            afterResponse: { response async throws in
                #expect(response.status == .badRequest)
                let payload = try JSONDecoder().decode(JSON.self, from: Data(response.body.readableBytesView))
                #expect(payload["error"]["code"] == .string("INVALID_INPUT"))
            }
        )
        try await application.testing().test(
            .POST,
            "/api/v1/sessions",
            beforeRequest: { req in
                req.headers.contentType = .json
                req.headers.add(name: .origin, value: "http://localhost:5173")
                req.headers.replaceOrAdd(name: .host, value: "localhost:5173")
                req.body = ByteBuffer(string: "{\"displayName\":\"Phone\"}")
            },
            afterResponse: { response async throws in
                #expect(response.status == .created)
                #expect(response.headers.first(name: .setCookie)?.contains("HttpOnly") == true)
            }
        )
    }
}

extension Fixture {
    func request(_ method: String, _ path: String, _ context: Context) async throws -> WireResponse {
        try await request(method, path, .object([:]), context)
    }
}

@Test
func concurrentJoinAndProofConsumption() async throws {
    let fixture = try Fixture(maxDevices: 2)
    defer {
        fixture.clean()
    }
    let owner = try await fixture.user("concurrent-owner")
    _ = try await fixture.room(owner)
    let firstUser = try await fixture.user("a")
    let secondUser = try await fixture.user("b")
    let firstProof = try await fixture.proved(firstUser, code: "0042", joining: true)
    let secondProof = try await fixture.proved(secondUser, code: "0042", joining: true)
    let results = await withTaskGroup(of: String.self) { group in
        for (user, proved) in [(firstUser, firstProof), (secondUser, secondProof)] {
            group.addTask {
                do {
                    _ = try await fixture.request("POST", "rooms/join", proved.0, user, key: proved.1)
                    return "joined"
                } catch let error as APIError {
                    return error.code
                } catch {
                    return "unexpected"
                }
            }
        }
        var results: [String] = []
        for await value in group {
            results.append(value)
        }
        return results
    }
    #expect(results.sorted() == ["ROOM_FULL", "joined"])
    let context = try await fixture.user("replay")
    let proved = try await fixture.proved(context, code: "0043")
    let twins = await withTaskGroup(of: JSON.self) { group in
        for _ in 0..<2 {
            group.addTask {
                (try? await fixture.request("POST", "rooms", proved.0, context, key: proved.1).json) ?? .null
            }
        }
        var values: [JSON] = []
        for await value in group {
            values.append(value)
        }
        return values
    }
    #expect(twins[0] == twins[1])
    #expect(twins[0] != .null)
}

@Test
func uploadOverflowCancellationAndQuota() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let context = try await fixture.user("upload-failure")
    let room = try await fixture.room(context)["room"]["id"].string!
    await expectError("FILE_TOO_LARGE") {
        _ = try await fixture.request(
            "POST",
            "rooms/\(room)/uploads",
            .object([
                "filename": .string("big.bin"),
                "sizeBytes": .number(100_000_001),
                "contentType": .string("application/octet-stream"),
            ]),
            context,
            key: UUID().uuidString.lowercased()
        )
    }
    let upload = try await fixture.request(
        "POST",
        "rooms/\(room)/uploads",
        .object([
            "filename": .string("a.txt"),
            "sizeBytes": .number(3),
            "contentType": .string("text/plain"),
        ]),
        context,
        key: UUID().uuidString.lowercased()
    ).json["data"]["uploadId"].string!
    let ticket = try await fixture.store.beginUpload(upload, context, length: 3)
    let writer = try UploadWriter(path: ticket.path, expected: 3)
    await expectError("FILE_TOO_LARGE") { try await writer.write(Data("1234".utf8)) }
    await writer.cancel()
    try await fixture.store.failUpload(ticket)
    let retry = try await fixture.store.beginUpload(upload, context, length: 3)
    _ = try await fixture.request("DELETE", "uploads/\(upload)", context)
    await expectError("UPLOAD_CANCELLED") { try await fixture.store.validateUpload(retry, context: context) }
    try await fixture.store.maintain()
    #expect(!FileManager.default.fileExists(atPath: ticket.path))
}

@Test
func diskSnapshotRestoresSessionsAndHistory() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let context = try await fixture.user("restore")
    let room = try await fixture.room(context)["room"]["id"].string!
    let original = try await fixture.request(
        "POST",
        "rooms/\(room)/items",
        .object(["text": .string("persist me")]),
        context,
        key: UUID().uuidString.lowercased()
    )
    // A separately opened copy exercises the same loader without violating the live store's lock.
    var restoredSettings = fixture.settings
    restoredSettings.directory += "-restored"
    defer {
        try? FileManager.default.removeItem(atPath: restoredSettings.directory)
    }
    try FileManager.default.createDirectory(atPath: restoredSettings.directory, withIntermediateDirectories: true)
    try FileManager.default.copyItem(
        atPath: fixture.settings.directory + "/state.json",
        toPath: restoredSettings.directory + "/state.json"
    )
    let restored = try Store(settings: restoredSettings)
    let result = try await restored.handle(
        method: "GET",
        path: ["rooms", room, "items"],
        body: .object([:]),
        context: context
    )
    if case .array(let items) = result.json["data"] {
        #expect(items == [original.json["data"]])
    } else {
        Issue.record("Missing restored items")
    }
}

@Test
func sourceLimitSurvivesSessionResetAndOldChallenges() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let context = try await fixture.user("limited")
    let (old, key) = try await fixture.proved(context)
    for _ in 0..<3 {
        _ = try await fixture.request(
            "POST",
            "pow/challenges",
            .object([
                "action": .string("room.create"),
                "idempotencyKey": .string(UUID().uuidString.lowercased()),
            ]),
            context
        )
    }
    await expectError("POW_INVALID") { _ = try await fixture.request("POST", "rooms", old, context, key: key) }
    var reset = try await fixture.user("new-session")
    reset.source = context.source
    let challenge = try await fixture.request(
        "POST",
        "pow/challenges",
        .object([
            "action": .string("room.create"),
            "idempotencyKey": .string(UUID().uuidString.lowercased()),
        ]),
        reset
    )
    #expect(challenge.json["data"]["difficulty"].integer! > fixture.settings.baseBits)
    for _ in 0..<19 {
        _ = try await fixture.request(
            "POST",
            "pow/challenges",
            .object([
                "action": .string("room.create"),
                "idempotencyKey": .string(UUID().uuidString.lowercased()),
            ]),
            reset
        )
    }
    await expectError("RATE_LIMITED") {
        _ = try await fixture.request(
            "POST",
            "pow/challenges",
            .object([
                "action": .string("room.create"),
                "idempotencyKey": .string(UUID().uuidString.lowercased()),
            ]),
            reset
        )
    }
}

@Test
func eventReplayAndResync() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let context = try await fixture.user("events")
    let room = try await fixture.room(context)["room"]["id"].string!
    let cursor = try await fixture.request("GET", "rooms/\(room)", context).json["data"]["eventCursor"].string.flatMap(
        Int.init
    )!
    _ = try await fixture.request(
        "POST",
        "rooms/\(room)/items",
        .object(["text": .string("new event")]),
        context,
        key: UUID().uuidString.lowercased()
    )
    let batch = try await fixture.store.eventBatch(room: room, context: context, after: cursor)
    #expect(batch.events.count == 1)
    #expect(batch.events.first?.type == "item.created")
    let invalid = try await fixture.store.eventBatch(room: room, context: context, after: 999999)
    #expect(invalid.resync)
    _ = try await fixture.request("DELETE", "rooms/\(room)", context)
    let closed = try await fixture.store.eventBatch(room: room, context: context, after: batch.cursor)
    #expect(closed.closed)
    #expect(closed.events.last?.type == "room.closed")
}

@Test
func sharedPoWVectors() throws {
    struct Vector: Decodable {
        let input: String
        let nonce: String
        let difficulty: Int
        let sha256: String?
        let valid: Bool
    }
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 {
        root.deleteLastPathComponent()
    }
    let vectors = try JSONDecoder().decode(
        [Vector].self,
        from: Data(contentsOf: root.appendingPathComponent("packages/contracts/pow-vectors.json"))
    )
    for vector in vectors {
        #expect(isValidProof(input: vector.input, nonce: vector.nonce, bits: vector.difficulty) == vector.valid)
        if let checksum = vector.sha256 {
            #expect(sha256Hex(Data((vector.input + vector.nonce).utf8)) == checksum)
        }
    }
}

extension Fixture {
    func uploaded(
        _ context: Context,
        room: String,
        bytes: Data,
        filename: String = "sample.bin"
    ) async throws -> (String, UploadTicket) {
        let id = try await request(
            "POST",
            "rooms/\(room)/uploads",
            .object([
                "filename": .string(filename),
                "sizeBytes": .number(Double(bytes.count)),
                "contentType": .string("application/octet-stream"),
            ]),
            context,
            key: UUID().uuidString.lowercased()
        ).json["data"]["uploadId"].string!
        let ticket = try await store.beginUpload(id, context, length: bytes.count)
        let writer = try UploadWriter(
            path: ticket.path,
            expected: bytes.count,
            inMemory: ticket.upload.storage == "memory"
        )
        try await writer.write(bytes)
        let (checksum, type, memory) = try await writer.finish()
        _ = try await store.finishUpload(ticket, context: context, checksum: checksum, type: type, memory: memory)
        _ = try await request(
            "POST",
            "uploads/\(id)/complete",
            .object([:]),
            context,
            key: UUID().uuidString.lowercased()
        )
        return (id, ticket)
    }
}

@Test
func hybridStorageBudgetFallbackAndDeletion() async throws {
    let fixture = try Fixture(memoryThreshold: 8, memoryBudget: 10)
    defer {
        fixture.clean()
    }
    let context = try await fixture.user("hybrid")
    let room = try await fixture.room(context)["room"]["id"].string!
    let small = Data("123456".utf8)
    let (first, ticket) = try await fixture.uploaded(context, room: room, bytes: small)
    #expect(ticket.upload.storage == "memory")
    #expect(!FileManager.default.fileExists(atPath: ticket.path))
    let file = try await fixture.store.download(first, context: context, publicLink: false)
    #expect(file.memory == small)
    #expect(file.path.isEmpty)
    let (second, fallback) = try await fixture.uploaded(context, room: room, bytes: small)
    #expect(fallback.upload.storage == "disk")
    #expect(try await fixture.store.download(second, context: context, publicLink: false).memory == nil)
    let (large, disk) = try await fixture.uploaded(
        context,
        room: room,
        bytes: Data(repeating: 1, count: 9),
        filename: "movie.mp4"
    )
    #expect(disk.upload.storage == "disk")
    #expect(try await fixture.store.download(large, context: context, publicLink: false).size == 9)
    let status = try await fixture.request("GET", "uploads/\(first)", context).json["data"]
    #expect(status["status"] == .string("ready"))
    _ = try await fixture.request("DELETE", "rooms/\(room)/items/\(status["itemId"].string!)", context)
    #expect(await fixture.store.memoryFiles.isEmpty)
    let (_, reused) = try await fixture.uploaded(context, room: room, bytes: small)
    #expect(reused.upload.storage == "memory")
    _ = try await fixture.request("DELETE", "rooms/\(room)", context)
    #expect(await fixture.store.memoryFiles.isEmpty)
}

@Test
func memoryRestartInvalidatesLinksButDiskSurvives() async throws {
    let fixture = try Fixture(memoryThreshold: 8, memoryBudget: 100)
    defer {
        fixture.clean()
    }
    let context = try await fixture.user("restart")
    let room = try await fixture.room(context)["room"]["id"].string!
    let text = try await fixture.request(
        "POST",
        "rooms/\(room)/items",
        .object(["text": .string("retained text")]),
        context,
        key: "retained-message"
    )
    let (small, _) = try await fixture.uploaded(context, room: room, bytes: Data("temp".utf8))
    let (large, _) = try await fixture.uploaded(context, room: room, bytes: Data("durable-file".utf8))
    let link = try await fixture.request(
        "POST",
        "assets/\(small)/links",
        .object([:]),
        context,
        key: UUID().uuidString.lowercased()
    ).json[
        "data"
    ]
    var settings = fixture.settings
    settings.directory += "-copy"
    defer {
        try? FileManager.default.removeItem(atPath: settings.directory)
    }
    try FileManager.default.copyItem(atPath: fixture.settings.directory, toPath: settings.directory)
    let restarted = try Store(settings: settings)
    try await restarted.maintain()
    await expectError("SHARE_EXPIRED") {
        _ = try await restarted.shareMetadata(link["slug"].string!, source: context.source)
    }
    let disk = try await restarted.download(large, context: context, publicLink: false)
    #expect(try Data(contentsOf: URL(fileURLWithPath: disk.path)) == Data("durable-file".utf8))
    let list = try await restarted.handle(
        method: "GET",
        path: ["rooms", room, "items"],
        body: .object([:]),
        context: context
    )
    if case .array(let items) = list.json["data"] {
        #expect(items.count == 2)
        #expect(items[0]["asset"]["id"] == .string(large))
    } else {
        Issue.record("Missing item list")
    }
    #expect(await restarted.memoryFiles.isEmpty)
    var retry = context
    retry.key = "retained-message"
    let cached = try await restarted.handle(
        method: "POST",
        path: ["rooms", room, "items"],
        body: .object(["text": .string("retained text")]),
        context: retry
    )
    #expect(cached.json == text.json)
}

@Test
func concurrentReservationsAndExpiredSubscriberCleanup() async throws {
    let fixture = try Fixture(memoryThreshold: 8, memoryBudget: 8)
    defer {
        fixture.clean()
    }
    let context = try await fixture.user("reserve")
    let room = try await fixture.room(context)["room"]["id"].string!
    var ids: [String] = []
    for _ in 0..<2 {
        ids.append(
            try await fixture.request(
                "POST",
                "rooms/\(room)/uploads",
                .object([
                    "filename": .string("x"),
                    "sizeBytes": .number(8),
                    "contentType": .string("application/octet-stream"),
                ]),
                context,
                key: UUID().uuidString.lowercased()
            ).json["data"]["uploadId"].string!
        )
    }
    let choices = try await withThrowingTaskGroup(of: UploadTicket.self) { group in
        for id in ids {
            group.addTask { try await fixture.store.beginUpload(id, context, length: 8) }
        }
        var tickets: [UploadTicket] = []
        for try await t in group {
            tickets.append(t)
        }
        return tickets
    }
    #expect(choices.filter { $0.upload.storage == "memory" }.count == 1)
    try await fixture.store.subscribe(room: room, context: context)
    fixture.clock.advance(604801)
    try await fixture.store.maintain()
    await fixture.store.unsubscribe(context: context)
    #expect(await fixture.store.subscriptions.isEmpty)
}

@Test
func everyContractOperationHasRegisteredRoute() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 {
        root.deleteLastPathComponent()
    }
    let spec = try JSONDecoder().decode(
        JSON.self,
        from: Data(contentsOf: root.appendingPathComponent("packages/contracts/openapi.yaml"))
    )
    try await withApp(configure: { application in
        try routes(application)
        try application.register(collection: BusinessRoutes(store: fixture.store, settings: fixture.settings))
    }) { application in
        let registered = Set(
            application.routes.all.map { route in
                let path = route.path.map { component -> String in
                    let text = component.description
                    return text.hasPrefix(":") ? "{" + text.dropFirst() + "}" : text
                }.filter { !$0.isEmpty }.joined(separator: "/")
                return route.method.rawValue + " /" + path
            }
        )
        var documented = Set<String>()
        for (path, operations) in spec["paths"].object! {
            for method in operations.object!.keys {
                let effective = method == "head" ? "GET" : method.uppercased()  // Vapor maps HEAD to GET.
                let key = effective + " " + path
                documented.insert(key)
                #expect(registered.contains(key), "Missing route: \(key)")
            }
        }
        #expect(registered == documented)
    }
}

@Test
func utf8NamesChallengeKeysAndHeartbeatContract() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let name = String(repeating: "界", count: 26) + "ab"  // Exactly 80 UTF-8 bytes.
    let owner = try await fixture.user(name)
    let session = try await fixture.request("GET", "session", owner)
    #expect(session.json["data"]["displayName"] == .string(name))
    let capabilities = try await fixture.request("GET", "capabilities", owner)
    #expect(capabilities.json["data"]["heartbeatSeconds"] == .number(2))
    for existing in [nil, owner.sessionHash] {
        await expectError("INVALID_INPUT") {
            _ = try await fixture.store.createSession(
                .object(["displayName": .string(String(repeating: "界", count: 27))]),
                source: "boundary",
                existing: existing
            )
        }
    }
    for key in ["bad key!", "中文中文中文中文", "bad\nkey!"] {
        await expectError("INVALID_INPUT") {
            _ = try await fixture.request(
                "POST",
                "pow/challenges",
                .object([
                    "action": .string("room.create"),
                    "idempotencyKey": .string(key),
                ]),
                owner
            )
        }
    }
    _ = try await fixture.request(
        "POST",
        "pow/challenges",
        .object([
            "action": .string("room.create"),
            "idempotencyKey": .string("valid-key-123"),
        ]),
        owner
    )
}

@Test
func roomPasswordLifecycleAndIdempotency() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let owner = try await fixture.user("password-owner")
    let guest = try await fixture.user("password-guest")
    let (proof, key) = try await fixture.proved(owner)
    var create = proof.object!
    create["password"] = .string("秘密 room 🔑")
    let created = try await fixture.request("POST", "rooms", .object(create), owner, key: key)
    let room = created.json["data"]["room"]["id"].string!
    let code = created.json["data"]["room"]["code"].string!
    #expect(created.json["data"]["room"]["hasPassword"] == .bool(true))
    #expect(try await fixture.request("POST", "rooms", .object(create), owner, key: key).json == created.json)
    var changed = create
    changed["password"] = .string("different")
    await expectError("IDEMPOTENCY_CONFLICT") {
        _ = try await fixture.request("POST", "rooms", .object(changed), owner, key: key)
    }
    for password in [nil, "wrong"] as [String?] {
        let (proof, key) = try await fixture.proved(guest, code: code, joining: true)
        var body = proof.object!
        if let password {
            body["password"] = .string(password)
        }
        await expectError("ROOM_PASSWORD_INVALID") {
            _ = try await fixture.request("POST", "rooms/join", .object(body), guest, key: key)
        }
        await expectError("POW_INVALID") {
            _ = try await fixture.request("POST", "rooms/join", .object(body), guest, key: key)
        }
    }
    let (joinProof, joinKey) = try await fixture.proved(guest, code: code, joining: true)
    var join = joinProof.object!
    join["password"] = .string("秘密 room 🔑")
    let joined = try await fixture.request("POST", "rooms/join", .object(join), guest, key: joinKey)
    await expectError("OWNER_REQUIRED") {
        _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["password": .null]), guest)
    }
    // Invalid combined patch must not partially change joinPolicy.
    await expectError("INVALID_INPUT") {
        _ = try await fixture.request(
            "PATCH",
            "rooms/\(room)",
            .object([
                "joinPolicy": .string("locked"),
                "password": .string(""),
            ]),
            owner
        )
    }
    #expect(try await fixture.request("GET", "rooms/\(room)", owner).json["data"]["joinPolicy"] == .string("open"))
    _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["password": .string("replacement")]), owner)
    #expect(try await fixture.request("POST", "rooms/join", .object(join), guest, key: joinKey).json == joined.json)
    #expect(try await fixture.join(guest, code: code)["room"]["hasPassword"] == .bool(true))
    // Secrets never appear in wire events or plaintext on disk, including idempotency records.
    let batch = try await fixture.store.eventBatch(room: room, context: owner, after: 0)
    for event in batch.events {
        let wire = String(decoding: try event.json.encodedData(), as: UTF8.self)
        #expect(!wire.contains("passwordHash"))
        #expect(!wire.contains("replacement"))
    }
    let disk = try String(contentsOfFile: fixture.settings.directory + "/state.json", encoding: .utf8)
    #expect(!disk.contains("秘密 room"))
    #expect(!disk.contains("replacement"))
    _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["password": .null]), owner)
    #expect(try await fixture.request("GET", "rooms/\(room)", owner).json["data"]["hasPassword"] == .bool(false))
    let newcomer = try await fixture.user("password-newcomer")
    _ = try await fixture.join(newcomer, code: code)
}

@Test
func passwordBoundsLockAndPersistence() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let owner = try await fixture.user("pw-persist")
    let room = try await fixture.room(owner)["room"]["id"].string!
    for password in ["", String(repeating: "界", count: 25), "abc\0def"] {
        await expectError("INVALID_INPUT") {
            _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["password": .string(password)]), owner)
        }
    }
    _ = try await fixture.request(
        "PATCH",
        "rooms/\(room)",
        .object([
            "password": .string(String(repeating: "界", count: 24)),
            "joinPolicy": .string("locked"),
        ]),
        owner
    )
    let guest = try await fixture.user("pw-locked")
    let (proof, key) = try await fixture.proved(guest, code: "0042", joining: true)
    var join = proof.object!
    join["password"] = .string(String(repeating: "界", count: 24))
    await expectError("ROOM_UNAVAILABLE") {
        _ = try await fixture.request("POST", "rooms/join", .object(join), guest, key: key)
    }
    let (freshProof, freshKey) = try await fixture.proved(guest, code: "0042", joining: true)
    join = freshProof.object!
    join["password"] = .string(String(repeating: "界", count: 24))
    var config = fixture.settings
    config.directory += "-copy"
    defer {
        try? FileManager.default.removeItem(atPath: config.directory)
    }
    try FileManager.default.createDirectory(atPath: config.directory, withIntermediateDirectories: true)
    try FileManager.default.copyItem(
        atPath: fixture.settings.directory + "/state.json",
        toPath: config.directory + "/state.json"
    )
    let restored = try Store(settings: config)
    let read = try await restored.handle(method: "GET", path: ["rooms", room], body: .object([:]), context: owner)
    #expect(read.json["data"]["hasPassword"] == .bool(true))
    _ = try await restored.handle(
        method: "PATCH",
        path: ["rooms", room],
        body: .object(["joinPolicy": .string("open")]),
        context: owner
    )
    var context = guest
    context.key = freshKey
    _ = try await restored.handle(method: "POST", path: ["rooms", "join"], body: .object(join), context: context)
    for _ in 0..<4 {
        _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["password": .null]), owner)
    }
    await expectError("RATE_LIMITED") {
        _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["password": .null]), owner)
    }
}

@Test
func legacyRoomSnapshotsGainPasswordFlags() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let owner = try await fixture.user("legacy-password")
    let (proof, key) = try await fixture.proved(owner)
    let created = try await fixture.request("POST", "rooms", proof, owner, key: key)
    let room = created.json["data"]["room"]["id"].string!
    _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["joinPolicy": .string("locked")]), owner)
    func withoutFlags(_ value: JSON) -> JSON {
        switch value {
        case .object(let fields):
            return .object(
                fields.filter { $0.key != "hasPassword" && $0.key != "passwordHash" }.mapValues(withoutFlags)
            )
        case .array(let values):
            return .array(values.map(withoutFlags))
        default:
            return value
        }
    }
    var config = fixture.settings
    config.directory += "-legacy"
    defer {
        try? FileManager.default.removeItem(atPath: config.directory)
    }
    try FileManager.default.createDirectory(atPath: config.directory, withIntermediateDirectories: true)
    let snapshot = try JSONDecoder().decode(
        JSON.self,
        from: Data(contentsOf: URL(fileURLWithPath: fixture.settings.directory + "/state.json"))
    )
    try withoutFlags(snapshot).encodedData().write(to: URL(fileURLWithPath: config.directory + "/state.json"))
    let restored = try Store(settings: config)
    var context = owner
    context.key = key
    let replay = try await restored.handle(method: "POST", path: ["rooms"], body: proof, context: context)
    #expect(replay.json["data"]["room"]["hasPassword"] == .bool(false))
    let events = try await restored.eventBatch(room: room, context: owner, after: 0)
    let updated = events.events.first { $0.type == "room.updated" }
    #expect(updated?.data["hasPassword"] == .bool(false))
}

@Test
func ownerApprovalGatesMembership() async throws {
    let fixture = try Fixture(maxDevices: 2)
    defer {
        fixture.clean()
    }
    let owner = try await fixture.user("approval-owner")
    let guest = try await fixture.user("approval-guest")
    let other = try await fixture.user("approval-other")
    let room = try await fixture.room(owner)["room"]["id"].string!
    _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["approvalRequired": .bool(true)]), owner)
    let (body, key) = try await fixture.proved(guest, code: "0042", joining: true)
    let pending = try await fixture.request("POST", "rooms/join", body, guest, key: key)
    #expect(pending.status == 202)
    let id = pending.json["data"]["request"]["id"].string!
    let path = "rooms/\(room)/join-requests/\(id)"
    let (againBody, againKey) = try await fixture.proved(guest, code: "0042", joining: true)
    let again = try await fixture.request("POST", "rooms/join", againBody, guest, key: againKey)
    #expect(again.json["data"]["request"]["id"] == .string(id))
    await expectError("NOT_FOUND") { _ = try await fixture.request("GET", "rooms/\(room)", guest) }
    await expectError("NOT_FOUND") { _ = try await fixture.request("GET", path, other) }
    await expectError("NOT_FOUND") { _ = try await fixture.request("POST", path + "/approve", guest) }
    #expect(try await fixture.request("GET", path, guest).json["data"]["status"] == .string("pending"))
    _ = try await fixture.request("POST", path + "/approve", owner)
    _ = try await fixture.request("POST", path + "/approve", owner)
    #expect(try await fixture.request("GET", path, guest).json["data"]["status"] == .string("approved"))
    _ = try await fixture.request("GET", "rooms/\(room)", guest)
    await expectError("JOIN_REQUEST_STATE") { _ = try await fixture.request("POST", path + "/reject", owner) }
    let (otherBody, otherKey) = try await fixture.proved(other, code: "0042", joining: true)
    let otherPending = try await fixture.request("POST", "rooms/join", otherBody, other, key: otherKey)
    let otherPath = "rooms/\(room)/join-requests/\(otherPending.json["data"]["request"]["id"].string!)"
    await expectError("ROOM_FULL") { _ = try await fixture.request("POST", otherPath + "/approve", owner) }
    _ = try await fixture.request("POST", otherPath + "/reject", owner)
    #expect(try await fixture.request("GET", otherPath, other).json["data"]["status"] == .string("rejected"))
    let (retryBody, retryKey) = try await fixture.proved(other, code: "0042", joining: true)
    let retry = try await fixture.request("POST", "rooms/join", retryBody, other, key: retryKey)
    let retryPath = "rooms/\(room)/join-requests/\(retry.json["data"]["request"]["id"].string!)"
    fixture.clock.advance(601)
    #expect(try await fixture.request("GET", retryPath, other).json["data"]["status"] == .string("expired"))
    await expectError("JOIN_REQUEST_STATE") { _ = try await fixture.request("POST", retryPath + "/approve", owner) }
}

@Test
func audioOnlyContainerPreservesDeclaredSubtype() {
    #expect(resolvedMediaType("video/webm", declared: "audio/webm;codecs=opus") == "audio/webm")
    #expect(resolvedMediaType("video/mp4", declared: "audio/mp4") == "audio/mp4")
    #expect(resolvedMediaType("video/webm", declared: "video/webm") == "video/webm")
    #expect(resolvedMediaType("application/octet-stream", declared: "audio/webm") == "application/octet-stream")
    #expect(resolvedMediaType("video/mp4", declared: "audio/webm") == "video/mp4")
}
