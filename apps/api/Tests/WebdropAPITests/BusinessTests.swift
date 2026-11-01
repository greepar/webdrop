import Foundation
import Testing
import VaporTesting
@testable import WebdropAPI

final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Double = 1_800_000_000
    func now() -> Double { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ seconds: Double) { lock.lock(); defer { lock.unlock() }; value += seconds }
}
struct Fixture {
    let settings: Settings
    let store: Store
    let clock = TestClock()
    init(maxDevices: Int = 10, memoryThreshold: Int = 0, memoryBudget: Int = 64) throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("webdrop-test-" + uid()).path
        var config = Settings(directory: dir, origins: ["http://localhost:5173"], secureCookies: false, publicOrigin: "http://localhost:5173")
        config.memoryFileBytes = memoryThreshold; config.memoryTotalBytes = memoryBudget
        config.baseBits = 4; config.maxBits = 10; config.maxDevices = maxDevices
        let clock = self.clock; config.now = { clock.now() }
        settings = config; store = try Store(settings: config)
    }
    func clean() { try? FileManager.default.removeItem(atPath: settings.directory) }
    func user(_ name: String) async throws -> Context {
        let (wire, token) = try await store.createSession(.object(["displayName": str(name)]), source: name, existing: nil)
        return Context(sessionHash: hash(token!), source: name, csrf: wire.json["data"]["csrfToken"].string, key: nil)
    }
    func request(_ method: String, _ path: String, _ body: JSON = .object([:]), _ c: Context, key: String? = nil) async throws -> WireResponse {
        var c = c; c.key = key
        return try await store.handle(method: method, path: path.split(separator: "/").map(String.init), body: body, context: c)
    }
    func proved(_ c: Context, code: String? = nil, joining: Bool = false, key: String = uid()) async throws -> (JSON, String) {
        var input: [String: JSON] = ["action": str(joining ? "room.join" : "room.create"), "idempotencyKey": str(key)]
        if let code { input["code"] = str(code) }
        let ch = try await request("POST", "pow/challenges", .object(input), c).json["data"]
        var nonce = 0
        while !validProof(input: ch["input"].string!, nonce: String(nonce), bits: ch["difficulty"].integer!) { nonce += 1 }
        var body: [String: JSON] = ["proof": .object(["challengeId": ch["challengeId"], "nonce": str(String(nonce))])]
        if let code { body["code"] = str(code) }
        return (.object(body), key)
    }
    func room(_ c: Context, code: String = "0042") async throws -> JSON {
        let (body, key) = try await proved(c, code: code)
        return try await request("POST", "rooms", body, c, key: key).json["data"]
    }
    func join(_ c: Context, code: String = "0042") async throws -> JSON {
        let (body, key) = try await proved(c, code: code, joining: true)
        return try await request("POST", "rooms/join", body, c, key: key).json["data"]
    }
}
func expectError(_ code: String, _ operation: () async throws -> Void) async {
    do { try await operation(); Issue.record("Expected \(code)") }
    catch let e as APIError { #expect(e.code == code) }
    catch { Issue.record("Unexpected error: \(error)") }
}

@Test func roomsPermissionsIdempotencyAndHistory() async throws {
    let f = try Fixture(); defer { f.clean() }
    let owner = try await f.user("owner"); let guest = try await f.user("guest")
    let (create, key) = try await f.proved(owner, code: "0042")
    let first = try await f.request("POST", "rooms", create, owner, key: key)
    let replay = try await f.request("POST", "rooms", create, owner, key: key)
    #expect(first.json == replay.json)
    let room = first.json["data"]["room"]["id"].string!
    #expect(first.json["data"]["room"]["code"] == str("0042"))
    let posted = try await f.request("POST", "rooms/\(room)/items", .object(["text": str("你好\nSwift")]), owner, key: "message-key").json["data"]
    let membership = try await f.join(guest)
    let history = try await f.request("GET", "rooms/\(room)/items", guest)
    if case .array(let items) = history.json["data"] { #expect(items.count == 1); #expect(items[0] == posted) } else { Issue.record("Missing list") }
    await expectError("OWNER_REQUIRED") { _ = try await f.request("DELETE", "rooms/\(room)", guest) }
    await expectError("FORBIDDEN") { _ = try await f.request("DELETE", "rooms/\(room)/items/\(posted["id"].string!)", guest) }
    await expectError("IDEMPOTENCY_CONFLICT") { _ = try await f.request("POST", "rooms/\(room)/items", .object(["text": str("changed")]), owner, key: "message-key") }
    let cursor = history.json["eventCursor"].string.flatMap(Int.init)!
    _ = try await f.request("DELETE", "rooms/\(room)/members/\(membership["membership"]["id"].string!)", owner)
    await expectError("NOT_FOUND") { _ = try await f.request("GET", "rooms/\(room)", guest) }
    await expectError("MEMBERSHIP_REVOKED") { _ = try await f.store.eventBatch(room: room, c: guest, after: cursor) }
    await expectError("ROOM_UNAVAILABLE") { _ = try await f.join(guest) }
}

@Test func powBindingReplayDifficultyAndCooldown() async throws {
    let f = try Fixture(); defer { f.clean() }
    let user = try await f.user("pow")
    let (body, key) = try await f.proved(user, code: "0042")
    var altered = body.object!; altered["code"] = str("0043")
    await expectError("POW_INVALID") { _ = try await f.request("POST", "rooms", .object(altered), user, key: key) }
    await expectError("POW_INVALID") { _ = try await f.request("POST", "rooms", body, user, key: key) }
    var difficulties: [Int] = []
    for _ in 0..<7 {
        let wire = try await f.request("POST", "pow/challenges", .object(["action": str("room.create"), "idempotencyKey": str(uid())]), user)
        difficulties.append(wire.json["data"]["difficulty"].integer!)
    }
    #expect(difficulties.last! > difficulties.first!)
    f.clock.advance(601)
    let ch = try await f.request("POST", "pow/challenges", .object(["action": str("room.create"), "idempotencyKey": str(uid())]), user)
    #expect(ch.json["data"]["difficulty"].integer == f.settings.baseBits)
    let (expired, expiredKey) = try await f.proved(user)
    f.clock.advance(121)
    await expectError("POW_INVALID") { _ = try await f.request("POST", "rooms", expired, user, key: expiredKey) }
}

@Test func capacityLockAndOwnerLeave() async throws {
    let f = try Fixture(maxDevices: 2); defer { f.clean() }
    let a = try await f.user("a"); let b = try await f.user("b"); let c = try await f.user("c")
    let room = try await f.room(a)["room"]["id"].string!
    _ = try await f.join(b)
    _ = try await f.join(b) // Reconnecting the same session must not consume a slot.
    await expectError("ROOM_FULL") { _ = try await f.join(c) }
    await expectError("OWNER_MUST_CLOSE") { _ = try await f.request("DELETE", "rooms/\(room)/members/me", a) }
    _ = try await f.request("DELETE", "rooms/\(room)/members/me", b)
    _ = try await f.request("PATCH", "rooms/\(room)", .object(["joinPolicy": str("locked")]), a)
    await expectError("ROOM_UNAVAILABLE") { _ = try await f.join(c) }
    let rotated = try await f.request("POST", "rooms/\(room)/code/rotate", .object([:]), a)
    #expect(rotated.json["data"]["code"] != str("0042"))
}

@Test func streamedUploadSharingRevocationAndExpiry() async throws {
    let f = try Fixture(); defer { f.clean() }
    let owner = try await f.user("files"); let room = try await f.room(owner)["room"]["id"].string!
    let bytes = Data("hello world".utf8)
    let upload = try await f.request("POST", "rooms/\(room)/uploads", .object(["filename": str("sample.txt"), "contentType": str("image/png"), "sizeBytes": num(bytes.count)]), owner, key: uid()).json["data"]["uploadId"].string!
    let ticket = try await f.store.beginUpload(upload, owner, length: bytes.count)
    let writer = try UploadWriter(path: ticket.path, expected: bytes.count)
    try await writer.write(bytes.prefix(5)); try await writer.write(bytes.dropFirst(5))
    let (sha, type, memory) = try await writer.finish()
    #expect(sha == digest(bytes)); #expect(type == "application/octet-stream")
    _ = try await f.store.finishUpload(ticket, c: owner, sha: sha, type: type, memory: memory)
    _ = try await f.request("POST", "uploads/\(upload)/complete", .object([:]), owner, key: uid())
    let link = try await f.request("POST", "assets/\(upload)/links", .object([:]), owner, key: uid()).json["data"]
    let downloaded = try await f.store.download(link["slug"].string!, c: owner, publicLink: true)
    #expect(try Data(contentsOf: URL(fileURLWithPath: downloaded.path)) == bytes)
    _ = try await f.request("DELETE", "rooms/\(room)", owner)
    await expectError("SHARE_EXPIRED") { _ = try await f.store.download(link["slug"].string!, c: owner, publicLink: true) }
    try await f.store.maintain()
    #expect(!FileManager.default.fileExists(atPath: downloaded.path))
}

@Test func idleExpiryAndPersistence() async throws {
    let f = try Fixture(); defer { f.clean() }
    let owner = try await f.user("expiry"); let room = try await f.room(owner)["room"]["id"].string!
    f.clock.advance(100)
    // Brief owner disconnection does not close the room.
    _ = try await f.request("GET", "rooms/\(room)", owner)
    f.clock.advance(1891)
    try await f.store.maintain()
    await expectError("NOT_FOUND") { _ = try await f.request("GET", "rooms/\(room)", owner) }
    let saved = try JSONDecoder().decode(State.self, from: Data(contentsOf: URL(fileURLWithPath: f.settings.directory + "/state.json")))
    #expect(saved.rooms[room]?.closed != nil)
    #expect(saved.sessions[owner.sessionHash!] != nil)
    #expect(throws: APIError.self) { _ = try Store(settings: f.settings) }
}

@Test func httpSessionCSRFAndErrorEnvelope() async throws {
    let f = try Fixture(); defer { f.clean() }
    try await withApp(configure: { app in
        app.middleware = .init()
        app.middleware.use(APIErrorMiddleware())
        try routes(app)
        try app.register(collection: BusinessRoutes(store: f.store, settings: f.settings))
    }) { app in
        try await app.testing().test(.POST, "/api/v1/sessions", beforeRequest: { req in
            req.headers.contentType = .json
            req.body = ByteBuffer(string: "{}")
        }, afterResponse: { response async throws in
            #expect(response.status == .forbidden)
            let j = try JSONDecoder().decode(JSON.self, from: Data(response.body.readableBytesView))
            #expect(j["error"]["code"] == str("ORIGIN_FORBIDDEN"))
        })
        try await app.testing().test(.GET, "/api/v1/capabilities") { response async throws in
            #expect(response.status == .ok)
            let j = try JSONDecoder().decode(JSON.self, from: Data(response.body.readableBytesView))
            #expect(j["data"]["heartbeatSeconds"] == num(2))
        }
        try await app.testing().test(.POST, "/api/v1/sessions", beforeRequest: { req in
            req.headers.contentType = .json
            req.headers.add(name: .origin, value: "http://localhost:5173")
            req.body = ByteBuffer(data: try JSON.object(["displayName": str(String(repeating: "界", count: 27))]).bytes())
        }, afterResponse: { response async throws in
            #expect(response.status == .badRequest)
            let j = try JSONDecoder().decode(JSON.self, from: Data(response.body.readableBytesView))
            #expect(j["error"]["code"] == str("INVALID_INPUT"))
        })
        try await app.testing().test(.POST, "/api/v1/sessions", beforeRequest: { req in
            req.headers.contentType = .json; req.headers.add(name: .origin, value: "http://localhost:5173")
            req.body = ByteBuffer(string: "{\"displayName\":\"Phone\"}")
        }, afterResponse: { response async throws in
            #expect(response.status == .created)
            #expect(response.headers.first(name: .setCookie)?.contains("HttpOnly") == true)
        })
    }
}
extension Fixture {
    func request(_ method: String, _ path: String, _ c: Context) async throws -> WireResponse {
        try await request(method, path, .object([:]), c)
    }
}

@Test func concurrentJoinAndProofConsumption() async throws {
    let f = try Fixture(maxDevices: 2); defer { f.clean() }
    let owner = try await f.user("concurrent-owner"); _ = try await f.room(owner)
    let a = try await f.user("a"); let b = try await f.user("b")
    let pa = try await f.proved(a, code: "0042", joining: true)
    let pb = try await f.proved(b, code: "0042", joining: true)
    let results = await withTaskGroup(of: String.self) { group in
        for (user, proved) in [(a, pa), (b, pb)] {
            group.addTask {
                do { _ = try await f.request("POST", "rooms/join", proved.0, user, key: proved.1); return "joined" }
                catch let error as APIError { return error.code }
                catch { return "unexpected" }
            }
        }
        var results: [String] = []; for await value in group { results.append(value) }; return results
    }
    #expect(results.sorted() == ["ROOM_FULL", "joined"])
    let c = try await f.user("replay")
    let proved = try await f.proved(c, code: "0043")
    let twins = await withTaskGroup(of: JSON.self) { group in
        for _ in 0..<2 { group.addTask { (try? await f.request("POST", "rooms", proved.0, c, key: proved.1).json) ?? .null } }
        var values: [JSON] = []; for await value in group { values.append(value) }; return values
    }
    #expect(twins[0] == twins[1]); #expect(twins[0] != .null)
}

@Test func uploadOverflowCancellationAndQuota() async throws {
    let f = try Fixture(); defer { f.clean() }
    let c = try await f.user("upload-failure"); let room = try await f.room(c)["room"]["id"].string!
    await expectError("FILE_TOO_LARGE") {
        _ = try await f.request("POST", "rooms/\(room)/uploads", .object(["filename": str("big.bin"), "sizeBytes": num(100_000_001), "contentType": str("application/octet-stream")]), c, key: uid())
    }
    let upload = try await f.request("POST", "rooms/\(room)/uploads", .object(["filename": str("a.txt"), "sizeBytes": num(3), "contentType": str("text/plain")]), c, key: uid()).json["data"]["uploadId"].string!
    let ticket = try await f.store.beginUpload(upload, c, length: 3)
    let writer = try UploadWriter(path: ticket.path, expected: 3)
    await expectError("FILE_TOO_LARGE") { try await writer.write(Data("1234".utf8)) }
    await writer.cancel(); try await f.store.failUpload(ticket)
    let retry = try await f.store.beginUpload(upload, c, length: 3)
    _ = try await f.request("DELETE", "uploads/\(upload)", c)
    await expectError("UPLOAD_CANCELLED") { try await f.store.validateUpload(retry, c: c) }
    try await f.store.maintain()
    #expect(!FileManager.default.fileExists(atPath: ticket.path))
}

@Test func diskSnapshotRestoresSessionsAndHistory() async throws {
    let f = try Fixture(); defer { f.clean() }
    let c = try await f.user("restore"); let room = try await f.room(c)["room"]["id"].string!
    let original = try await f.request("POST", "rooms/\(room)/items", .object(["text": str("persist me")]), c, key: uid())
    // A separately opened copy exercises the same loader without violating the live store's lock.
    var restoredSettings = f.settings; restoredSettings.directory += "-restored"
    defer { try? FileManager.default.removeItem(atPath: restoredSettings.directory) }
    try FileManager.default.createDirectory(atPath: restoredSettings.directory, withIntermediateDirectories: true)
    try FileManager.default.copyItem(atPath: f.settings.directory + "/state.json", toPath: restoredSettings.directory + "/state.json")
    let restored = try Store(settings: restoredSettings)
    let result = try await restored.handle(method: "GET", path: ["rooms", room, "items"], body: .object([:]), context: c)
    if case .array(let items) = result.json["data"] { #expect(items == [original.json["data"]]) }
    else { Issue.record("Missing restored items") }
}

@Test func sourceLimitSurvivesSessionResetAndOldChallenges() async throws {
    let f = try Fixture(); defer { f.clean() }
    let c = try await f.user("limited")
    let (old, key) = try await f.proved(c)
    for _ in 0..<3 { _ = try await f.request("POST", "pow/challenges", .object(["action": str("room.create"), "idempotencyKey": str(uid())]), c) }
    await expectError("POW_INVALID") { _ = try await f.request("POST", "rooms", old, c, key: key) }
    var reset = try await f.user("new-session"); reset.source = c.source
    let ch = try await f.request("POST", "pow/challenges", .object(["action": str("room.create"), "idempotencyKey": str(uid())]), reset)
    #expect(ch.json["data"]["difficulty"].integer! > f.settings.baseBits)
    for _ in 0..<19 { _ = try await f.request("POST", "pow/challenges", .object(["action": str("room.create"), "idempotencyKey": str(uid())]), reset) }
    await expectError("RATE_LIMITED") { _ = try await f.request("POST", "pow/challenges", .object(["action": str("room.create"), "idempotencyKey": str(uid())]), reset) }
}

@Test func eventReplayAndResync() async throws {
    let f = try Fixture(); defer { f.clean() }
    let c = try await f.user("events"); let room = try await f.room(c)["room"]["id"].string!
    let cursor = try await f.request("GET", "rooms/\(room)", c).json["data"]["eventCursor"].string.flatMap(Int.init)!
    _ = try await f.request("POST", "rooms/\(room)/items", .object(["text": str("new event")]), c, key: uid())
    let batch = try await f.store.eventBatch(room: room, c: c, after: cursor)
    #expect(batch.events.count == 1); #expect(batch.events.first?.type == "item.created")
    let invalid = try await f.store.eventBatch(room: room, c: c, after: 999999)
    #expect(invalid.resync)
    _ = try await f.request("DELETE", "rooms/\(room)", c)
    let closed = try await f.store.eventBatch(room: room, c: c, after: batch.cursor)
    #expect(closed.closed); #expect(closed.events.last?.type == "room.closed")
}

@Test func sharedPoWVectors() throws {
    struct Vector: Decodable { let input: String; let nonce: String; let difficulty: Int; let sha256: String?; let valid: Bool }
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let vectors = try JSONDecoder().decode([Vector].self, from: Data(contentsOf: root.appendingPathComponent("packages/contracts/pow-vectors.json")))
    for vector in vectors {
        #expect(validProof(input: vector.input, nonce: vector.nonce, bits: vector.difficulty) == vector.valid)
        if let sha = vector.sha256 { #expect(hash(vector.input + vector.nonce) == sha) }
    }
}

extension Fixture {
    func uploaded(_ c: Context, room: String, bytes: Data, filename: String = "sample.bin") async throws -> (String, UploadTicket) {
        let id = try await request("POST", "rooms/\(room)/uploads", .object(["filename": str(filename), "sizeBytes": num(bytes.count), "contentType": str("application/octet-stream")]), c, key: uid()).json["data"]["uploadId"].string!
        let ticket = try await store.beginUpload(id, c, length: bytes.count)
        let writer = try UploadWriter(path: ticket.path, expected: bytes.count, inMemory: ticket.upload.storage == "memory")
        try await writer.write(bytes)
        let (sha, type, memory) = try await writer.finish()
        _ = try await store.finishUpload(ticket, c: c, sha: sha, type: type, memory: memory)
        _ = try await request("POST", "uploads/\(id)/complete", .object([:]), c, key: uid())
        return (id, ticket)
    }
}

@Test func hybridStorageBudgetFallbackAndDeletion() async throws {
    let f = try Fixture(memoryThreshold: 8, memoryBudget: 10); defer { f.clean() }
    let c = try await f.user("hybrid"); let room = try await f.room(c)["room"]["id"].string!
    let small = Data("123456".utf8)
    let (first, ticket) = try await f.uploaded(c, room: room, bytes: small)
    #expect(ticket.upload.storage == "memory")
    #expect(!FileManager.default.fileExists(atPath: ticket.path))
    let file = try await f.store.download(first, c: c, publicLink: false)
    #expect(file.memory == small); #expect(file.path.isEmpty)
    let (second, fallback) = try await f.uploaded(c, room: room, bytes: small)
    #expect(fallback.upload.storage == "disk")
    #expect(try await f.store.download(second, c: c, publicLink: false).memory == nil)
    let (large, disk) = try await f.uploaded(c, room: room, bytes: Data(repeating: 1, count: 9), filename: "movie.mp4")
    #expect(disk.upload.storage == "disk")
    #expect(try await f.store.download(large, c: c, publicLink: false).size == 9)
    let status = try await f.request("GET", "uploads/\(first)", c).json["data"]
    #expect(status["status"] == str("ready"))
    _ = try await f.request("DELETE", "rooms/\(room)/items/\(status["itemId"].string!)", c)
    #expect(await f.store.memoryFiles.isEmpty)
    let (_, reused) = try await f.uploaded(c, room: room, bytes: small)
    #expect(reused.upload.storage == "memory")
    _ = try await f.request("DELETE", "rooms/\(room)", c)
    #expect(await f.store.memoryFiles.isEmpty)
}

@Test func memoryRestartInvalidatesLinksButDiskSurvives() async throws {
    let f = try Fixture(memoryThreshold: 8, memoryBudget: 100); defer { f.clean() }
    let c = try await f.user("restart"); let room = try await f.room(c)["room"]["id"].string!
    let text = try await f.request("POST", "rooms/\(room)/items", .object(["text": str("retained text")]), c, key: "retained-message")
    let (small, _) = try await f.uploaded(c, room: room, bytes: Data("temp".utf8))
    let (large, _) = try await f.uploaded(c, room: room, bytes: Data("durable-file".utf8))
    let link = try await f.request("POST", "assets/\(small)/links", .object([:]), c, key: uid()).json["data"]
    var settings = f.settings; settings.directory += "-copy"
    defer { try? FileManager.default.removeItem(atPath: settings.directory) }
    try FileManager.default.copyItem(atPath: f.settings.directory, toPath: settings.directory)
    let restarted = try Store(settings: settings)
    try await restarted.maintain()
    await expectError("SHARE_EXPIRED") { _ = try await restarted.shareMetadata(link["slug"].string!, source: c.source) }
    let disk = try await restarted.download(large, c: c, publicLink: false)
    #expect(try Data(contentsOf: URL(fileURLWithPath: disk.path)) == Data("durable-file".utf8))
    let list = try await restarted.handle(method: "GET", path: ["rooms", room, "items"], body: .object([:]), context: c)
    if case .array(let items) = list.json["data"] { #expect(items.count == 2); #expect(items[0]["asset"]["id"] == str(large)) }
    else { Issue.record("Missing item list") }
    #expect(await restarted.memoryFiles.isEmpty)
    var retry = c; retry.key = "retained-message"
    let cached = try await restarted.handle(method: "POST", path: ["rooms", room, "items"], body: .object(["text": str("retained text")]), context: retry)
    #expect(cached.json == text.json)
}

@Test func concurrentReservationsAndExpiredSubscriberCleanup() async throws {
    let f = try Fixture(memoryThreshold: 8, memoryBudget: 8); defer { f.clean() }
    let c = try await f.user("reserve"); let room = try await f.room(c)["room"]["id"].string!
    var ids: [String] = []
    for _ in 0..<2 {
        ids.append(try await f.request("POST", "rooms/\(room)/uploads", .object(["filename": str("x"), "sizeBytes": num(8), "contentType": str("application/octet-stream")]), c, key: uid()).json["data"]["uploadId"].string!)
    }
    let choices = try await withThrowingTaskGroup(of: UploadTicket.self) { group in
        for id in ids { group.addTask { try await f.store.beginUpload(id, c, length: 8) } }
        var tickets: [UploadTicket] = []; for try await t in group { tickets.append(t) }; return tickets
    }
    #expect(choices.filter { $0.upload.storage == "memory" }.count == 1)
    try await f.store.subscribe(room: room, c: c)
    f.clock.advance(604801)
    try await f.store.maintain()
    await f.store.unsubscribe(c: c)
    #expect(await f.store.subscriptions.isEmpty)
}

@Test func everyContractOperationHasRegisteredRoute() async throws {
    let f = try Fixture(); defer { f.clean() }
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let spec = try JSONDecoder().decode(JSON.self, from: Data(contentsOf: root.appendingPathComponent("packages/contracts/openapi.yaml")))
    try await withApp(configure: { app in
        try routes(app)
        try app.register(collection: BusinessRoutes(store: f.store, settings: f.settings))
    }) { app in
        let registered = Set(app.routes.all.map { route in
            let path = route.path.map { component -> String in
                let text = component.description
                return text.hasPrefix(":") ? "{" + text.dropFirst() + "}" : text
            }.filter { !$0.isEmpty }.joined(separator: "/")
            return route.method.rawValue + " /" + path
        })
        var documented = Set<String>()
        for (path, operations) in spec["paths"].object! {
            for method in operations.object!.keys {
                let effective = method == "head" ? "GET" : method.uppercased() // Vapor maps HEAD to GET.
                let key = effective + " " + path
                documented.insert(key)
                #expect(registered.contains(key), "Missing route: \(key)")
            }
        }
        #expect(registered == documented)
    }
}

@Test func utf8NamesChallengeKeysAndHeartbeatContract() async throws {
    let f = try Fixture(); defer { f.clean() }
    let name = String(repeating: "界", count: 26) + "ab" // Exactly 80 UTF-8 bytes.
    let owner = try await f.user(name)
    let session = try await f.request("GET", "session", owner)
    #expect(session.json["data"]["displayName"] == str(name))
    let capabilities = try await f.request("GET", "capabilities", owner)
    #expect(capabilities.json["data"]["heartbeatSeconds"] == num(2))
    for existing in [nil, owner.sessionHash] {
        await expectError("INVALID_INPUT") {
            _ = try await f.store.createSession(.object(["displayName": str(String(repeating: "界", count: 27))]), source: "boundary", existing: existing)
        }
    }
    for key in ["bad key!", "中文中文中文中文", "bad\nkey!"] {
        await expectError("INVALID_INPUT") {
            _ = try await f.request("POST", "pow/challenges", .object(["action": str("room.create"), "idempotencyKey": str(key)]), owner)
        }
    }
    _ = try await f.request("POST", "pow/challenges", .object(["action": str("room.create"), "idempotencyKey": str("valid-key-123")]), owner)
}

@Test func roomPasswordLifecycleAndIdempotency() async throws {
    let f = try Fixture(); defer { f.clean() }
    let owner = try await f.user("password-owner"); let guest = try await f.user("password-guest")
    let (proof, key) = try await f.proved(owner)
    var create = proof.object!; create["password"] = str("秘密 room 🔑")
    let created = try await f.request("POST", "rooms", .object(create), owner, key: key)
    let room = created.json["data"]["room"]["id"].string!
    let code = created.json["data"]["room"]["code"].string!
    #expect(created.json["data"]["room"]["hasPassword"] == .bool(true))
    #expect(try await f.request("POST", "rooms", .object(create), owner, key: key).json == created.json)
    var changed = create; changed["password"] = str("different")
    await expectError("IDEMPOTENCY_CONFLICT") { _ = try await f.request("POST", "rooms", .object(changed), owner, key: key) }
    for password in [nil, "wrong"] as [String?] {
        let (proof, key) = try await f.proved(guest, code: code, joining: true)
        var body = proof.object!; if let password { body["password"] = str(password) }
        await expectError("ROOM_PASSWORD_INVALID") { _ = try await f.request("POST", "rooms/join", .object(body), guest, key: key) }
        await expectError("POW_INVALID") { _ = try await f.request("POST", "rooms/join", .object(body), guest, key: key) }
    }
    let (joinProof, joinKey) = try await f.proved(guest, code: code, joining: true)
    var join = joinProof.object!; join["password"] = str("秘密 room 🔑")
    let joined = try await f.request("POST", "rooms/join", .object(join), guest, key: joinKey)
    await expectError("OWNER_REQUIRED") { _ = try await f.request("PATCH", "rooms/\(room)", .object(["password": .null]), guest) }
    // Invalid combined patch must not partially change joinPolicy.
    await expectError("INVALID_INPUT") { _ = try await f.request("PATCH", "rooms/\(room)", .object(["joinPolicy": str("locked"), "password": str("")]), owner) }
    #expect(try await f.request("GET", "rooms/\(room)", owner).json["data"]["joinPolicy"] == str("open"))
    _ = try await f.request("PATCH", "rooms/\(room)", .object(["password": str("replacement")]), owner)
    #expect(try await f.request("POST", "rooms/join", .object(join), guest, key: joinKey).json == joined.json)
    #expect(try await f.join(guest, code: code)["room"]["hasPassword"] == .bool(true))
    // Secrets never appear in wire events or plaintext on disk, including idempotency records.
    let batch = try await f.store.eventBatch(room: room, c: owner, after: 0)
    for event in batch.events {
        let wire = String(decoding: try event.json.bytes(), as: UTF8.self)
        #expect(!wire.contains("passwordHash")); #expect(!wire.contains("replacement"))
    }
    let disk = try String(contentsOfFile: f.settings.directory + "/state.json", encoding: .utf8)
    #expect(!disk.contains("秘密 room")); #expect(!disk.contains("replacement"))
    _ = try await f.request("PATCH", "rooms/\(room)", .object(["password": .null]), owner)
    #expect(try await f.request("GET", "rooms/\(room)", owner).json["data"]["hasPassword"] == .bool(false))
    let newcomer = try await f.user("password-newcomer")
    _ = try await f.join(newcomer, code: code)
}

@Test func passwordBoundsLockAndPersistence() async throws {
    let f = try Fixture(); defer { f.clean() }
    let owner = try await f.user("pw-persist"); let room = try await f.room(owner)["room"]["id"].string!
    for password in ["", String(repeating: "界", count: 25), "abc\0def"] {
        await expectError("INVALID_INPUT") { _ = try await f.request("PATCH", "rooms/\(room)", .object(["password": str(password)]), owner) }
    }
    _ = try await f.request("PATCH", "rooms/\(room)", .object(["password": str(String(repeating: "界", count: 24)), "joinPolicy": str("locked")]), owner)
    let guest = try await f.user("pw-locked")
    let (proof, key) = try await f.proved(guest, code: "0042", joining: true)
    var join = proof.object!; join["password"] = str(String(repeating: "界", count: 24))
    await expectError("ROOM_UNAVAILABLE") { _ = try await f.request("POST", "rooms/join", .object(join), guest, key: key) }
    let (freshProof, freshKey) = try await f.proved(guest, code: "0042", joining: true)
    join = freshProof.object!; join["password"] = str(String(repeating: "界", count: 24))
    var config = f.settings; config.directory += "-copy"
    defer { try? FileManager.default.removeItem(atPath: config.directory) }
    try FileManager.default.createDirectory(atPath: config.directory, withIntermediateDirectories: true)
    try FileManager.default.copyItem(atPath: f.settings.directory + "/state.json", toPath: config.directory + "/state.json")
    let restored = try Store(settings: config)
    let read = try await restored.handle(method: "GET", path: ["rooms", room], body: .object([:]), context: owner)
    #expect(read.json["data"]["hasPassword"] == .bool(true))
    _ = try await restored.handle(method: "PATCH", path: ["rooms", room], body: .object(["joinPolicy": str("open")]), context: owner)
    var c = guest; c.key = freshKey
    _ = try await restored.handle(method: "POST", path: ["rooms", "join"], body: .object(join), context: c)
    for _ in 0..<4 { _ = try await f.request("PATCH", "rooms/\(room)", .object(["password": .null]), owner) }
    await expectError("RATE_LIMITED") { _ = try await f.request("PATCH", "rooms/\(room)", .object(["password": .null]), owner) }
}

@Test func legacyRoomSnapshotsGainPasswordFlags() async throws {
    let f = try Fixture(); defer { f.clean() }
    let owner = try await f.user("legacy-password")
    let (proof, key) = try await f.proved(owner)
    let created = try await f.request("POST", "rooms", proof, owner, key: key)
    let room = created.json["data"]["room"]["id"].string!
    _ = try await f.request("PATCH", "rooms/\(room)", .object(["joinPolicy": str("locked")]), owner)
    func withoutFlags(_ value: JSON) -> JSON {
        switch value {
        case .object(let fields): return .object(fields.filter { $0.key != "hasPassword" && $0.key != "passwordHash" }.mapValues(withoutFlags))
        case .array(let values): return .array(values.map(withoutFlags))
        default: return value
        }
    }
    var config = f.settings; config.directory += "-legacy"
    defer { try? FileManager.default.removeItem(atPath: config.directory) }
    try FileManager.default.createDirectory(atPath: config.directory, withIntermediateDirectories: true)
    let snapshot = try JSONDecoder().decode(JSON.self, from: Data(contentsOf: URL(fileURLWithPath: f.settings.directory + "/state.json")))
    try withoutFlags(snapshot).bytes().write(to: URL(fileURLWithPath: config.directory + "/state.json"))
    let restored = try Store(settings: config)
    var c = owner; c.key = key
    let replay = try await restored.handle(method: "POST", path: ["rooms"], body: proof, context: c)
    #expect(replay.json["data"]["room"]["hasPassword"] == .bool(false))
    let events = try await restored.eventBatch(room: room, c: owner, after: 0)
    let updated = events.events.first { $0.type == "room.updated" }
    #expect(updated?.data["hasPassword"] == .bool(false))
}
