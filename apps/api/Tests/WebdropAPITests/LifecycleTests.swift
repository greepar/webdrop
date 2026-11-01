import Foundation
import Testing
@testable import WebdropAPI

private func memberships(_ f: Fixture, _ c: Context) async throws -> [JSON] {
    let response = try await f.request("GET", "session", c)
    if case .array(let values) = response.json["data"]["memberships"] { return values }
    Issue.record("Missing memberships"); return []
}

@Test func lifecycleLeaveCloseAndLostResponses() async throws {
    let f = try Fixture(); defer { f.clean() }
    let owner = try await f.user("life-owner"), member = try await f.user("life-member"), kicked = try await f.user("life-kicked")
    let (create, createKey) = try await f.proved(owner, code: "0042")
    let room = try await f.request("POST", "rooms", create, owner, key: createKey).json["data"]["room"]["id"].string!
    let (join, joinKey) = try await f.proved(member, code: "0042", joining: true)
    _ = try await f.request("POST", "rooms/join", join, member, key: joinKey)
    let kickID = try await f.join(kicked)["membership"]["id"].string!
    let textKey = uid(), text: JSON = .object(["text": str("kept")])
    _ = try await f.request("POST", "rooms/\(room)/items", text, member, key: textKey)
    await expectError("OWNER_MUST_CLOSE") { _ = try await f.request("DELETE", "rooms/\(room)/members/me", owner) }
    await expectError("OWNER_REQUIRED") { _ = try await f.request("DELETE", "rooms/\(room)", member) }
    #expect(try await memberships(f, owner).count == 1)
    let cursor = try await f.request("GET", "rooms/\(room)", member).json["data"]["eventCursor"].string.flatMap(Int.init)!
    _ = try await f.request("DELETE", "rooms/\(room)/members/me", member) // Treat response as lost.
    #expect(try await memberships(f, member).isEmpty)
    await expectError("NOT_FOUND") { _ = try await f.request("DELETE", "rooms/\(room)/members/me", member) }
    await expectError("NOT_FOUND") { _ = try await f.request("POST", "rooms/join", join, member, key: joinKey) }
    await expectError("NOT_FOUND") { _ = try await f.request("POST", "rooms/\(room)/items", text, member, key: textKey) }
    await expectError("NOT_FOUND") { try await f.store.subscribe(room: room, c: member) }
    await expectError("MEMBERSHIP_REVOKED") { _ = try await f.store.eventBatch(room: room, c: member, after: cursor) }
    _ = try await f.request("DELETE", "rooms/\(room)/members/\(kickID)", owner)
    #expect(try await memberships(f, kicked).isEmpty)
    await expectError("ROOM_UNAVAILABLE") { _ = try await f.join(kicked) }
    let events = try await f.store.eventBatch(room: room, c: owner, after: 0)
    #expect(events.events.filter { $0.type == "member.left" }.count == 2)
    _ = try await f.request("DELETE", "rooms/\(room)", owner)
    #expect(try await memberships(f, owner).isEmpty)
    await expectError("NOT_FOUND") { _ = try await f.request("DELETE", "rooms/\(room)", owner) }
    await expectError("NOT_FOUND") { _ = try await f.request("POST", "rooms", create, owner, key: createKey) }
    await expectError("NOT_FOUND") { try await f.store.subscribe(room: room, c: owner) }
}

@Test func lifecycleSameSessionRecoveryAndNoAnonymousOwnership() async throws {
    let f = try Fixture(); defer { f.clean() }
    let owner = try await f.user("recover-owner"), member = try await f.user("recover-member")
    let room = try await f.room(owner)["room"]["id"].string!
    _ = try await f.join(member)
    _ = try await f.request("PATCH", "rooms/\(room)", .object(["password": str("secret"), "approvalRequired": .bool(true), "joinPolicy": str("locked")]), owner)
    let before = try await memberships(f, owner).first!["membership"]["id"]
    f.clock.advance(100)
    let (restored, token) = try await f.store.createSession(.object([:]), source: owner.source, existing: owner.sessionHash)
    #expect(restored.status == 200); #expect(token == nil)
    #expect(try await memberships(f, owner).first!["membership"]["id"] == before)
    #expect(try await memberships(f, owner).first!["membership"]["role"] == str("owner"))
    for c in [owner, member] {
        _ = try await f.request("GET", "rooms/\(room)", c)
        try await f.store.subscribe(room: room, c: c); await f.store.unsubscribe(c: c)
    }
    let state = await f.store.state
    #expect(state.rooms[room]?.members.count == 2)
    let stranger = try await f.user("lost-cookie")
    #expect(try await memberships(f, stranger).isEmpty)
    await expectError("NOT_FOUND") { _ = try await f.request("GET", "rooms/\(room)", stranger) }
    await expectError("NOT_FOUND") { _ = try await f.request("DELETE", "rooms/\(room)", stranger) }
    // Session expiry grants no old membership to the replacement anonymous session.
    f.clock.advance(f.settings.sessionSeconds)
    await expectError("SESSION_REQUIRED") { _ = try await f.request("GET", "session", owner) }
    let (replacement, newToken) = try await f.store.createSession(.object([:]), source: owner.source, existing: owner.sessionHash)
    #expect(replacement.status == 201); #expect(newToken != nil)
    #expect(replacement.json["data"]["deviceId"] != restored.json["data"]["deviceId"])
}

@Test func lifecycleLeaseBoundariesAndDeparture() async throws {
    let f = try Fixture(); defer { f.clean() }
    let owner = try await f.user("lease-owner"), member = try await f.user("lease-member")
    let room = try await f.room(owner)["room"]["id"].string!
    _ = try await f.join(member)
    f.clock.advance(1800) // owner offline, other room tab remains active below timeout.
    _ = try await f.store.eventBatch(room: room, c: member, after: nil)
    #expect(try await memberships(f, owner).first!["membership"]["role"] == str("owner"))
    // The last online member leaves; offline time starts NOW, not from the owner's old seen.
    _ = try await f.request("DELETE", "rooms/\(room)/members/me", member)
    f.clock.advance(1799)
    #expect(try await memberships(f, owner).count == 1) // GET session must not refresh lease.
    f.clock.advance(1)
    // Failed access must still commit the automatic closure without maintenance().
    await expectError("NOT_FOUND") { _ = try await f.request("GET", "rooms/\(room)", owner) }
    let state = await f.store.state
    #expect(state.rooms[room]?.closed != nil)
    #expect(try await memberships(f, owner).isEmpty)
}

@Test func lifecycleActiveTabAndExactIdleBoundary() async throws {
    let f = try Fixture(); defer { f.clean() }
    let owner = try await f.user("tab-owner")
    let room = try await f.room(owner)["room"]["id"].string!
    // One tab stops reading while the other refreshes the same session lease.
    f.clock.advance(1800)
    _ = try await f.store.eventBatch(room: room, c: owner, after: nil)
    f.clock.advance(1889)
    #expect(try await memberships(f, owner).count == 1)
    f.clock.advance(1) // last seen + 90 seconds + 30 minutes
    #expect(try await memberships(f, owner).isEmpty)
}

@Test func lifecycleClosureStreamsResourcesAndCache() async throws {
    for threshold in [0, 32] {
        let f = try Fixture(memoryThreshold: threshold); defer { f.clean() }
        let owner = try await f.user("close-resources-\(threshold)")
        let room = try await f.room(owner)["room"]["id"].string!
        let createKey = uid(), completeKey = uid(), linkKey = uid()
        let input: JSON = .object(["filename": str("life.bin"), "sizeBytes": num(3), "contentType": str("application/octet-stream")])
        let upload = try await f.request("POST", "rooms/\(room)/uploads", input, owner, key: createKey).json["data"]["uploadId"].string!
        let ticket = try await f.store.beginUpload(upload, owner, length: 3)
        let writer = try UploadWriter(path: ticket.path, expected: 3, inMemory: threshold > 0)
        try await writer.write(Data([1, 2, 3]))
        let (sha, type, memory) = try await writer.finish()
        _ = try await f.store.finishUpload(ticket, c: owner, sha: sha, type: type, memory: memory)
        _ = try await f.request("POST", "uploads/\(upload)/complete", .object([:]), owner, key: completeKey)
        let link = try await f.request("POST", "assets/\(upload)/links", .object([:]), owner, key: linkKey).json["data"]["slug"].string!
        try await f.store.subscribe(room: room, c: owner)
        // Cursor can lag past the retained event ring while an existing writer is busy.
        for i in 0..<257 { _ = try await f.request("POST", "rooms/\(room)/items", .object(["text": str("event \(i)")]), owner, key: uid()) }
        _ = try await f.request("DELETE", "rooms/\(room)", owner)
        let terminal = try await f.store.eventBatch(room: room, c: owner, after: 0)
        #expect(terminal.closed); #expect(!terminal.resync)
        #expect(terminal.events.map(\.type) == ["room.closed"])
        #expect(terminal.events.first?.data == .object(["id": str(room)]))
        await f.store.unsubscribe(c: owner)
        await expectError("NOT_FOUND") { try await f.store.subscribe(room: room, c: owner) }
        await expectError("NOT_FOUND") { _ = try await f.store.download(upload, c: owner, publicLink: false) }
        await expectError("SHARE_EXPIRED") { _ = try await f.store.download(link, c: owner, publicLink: true) }
        await expectError("NOT_FOUND") { _ = try await f.request("POST", "rooms/\(room)/uploads", input, owner, key: createKey) }
        await expectError("NOT_FOUND") { _ = try await f.request("POST", "uploads/\(upload)/complete", .object([:]), owner, key: completeKey) }
        await expectError("NOT_FOUND") { _ = try await f.request("POST", "assets/\(upload)/links", .object([:]), owner, key: linkKey) }
        #expect(await f.store.memoryFiles.isEmpty)
        try await f.store.maintain()
        #expect(try FileManager.default.contentsOfDirectory(atPath: f.settings.directory + "/files").isEmpty)
    }
}

@Test func lifecycleConcurrentLeaveAndCloseApproval() async throws {
    let f = try Fixture(); defer { f.clean() }
    let owner = try await f.user("race-owner"), guest = try await f.user("race-guest"), applicant = try await f.user("race-applicant")
    let room = try await f.room(owner)["room"]["id"].string!
    _ = try await f.join(guest)
    let results = await withTaskGroup(of: Int.self, returning: [Int].self) { group in
        for _ in 0..<2 { group.addTask {
            do { return try await f.request("DELETE", "rooms/\(room)/members/me", guest).status }
            catch let error as APIError { return error.status } catch { Issue.record("Unexpected \(error)"); return 500 }
        } }
        var values: [Int] = []; for await value in group { values.append(value) }; return values.sorted()
    }
    #expect(results == [204, 404])
    _ = try await f.request("PATCH", "rooms/\(room)", .object(["approvalRequired": .bool(true)]), owner)
    let (proof, key) = try await f.proved(applicant, code: "0042", joining: true)
    let pending = try await f.request("POST", "rooms/join", proof, applicant, key: key)
    let path = "rooms/\(room)/join-requests/\(pending.json["data"]["request"]["id"].string!)"
    f.clock.advance(100) // owner offline does not auto approve.
    #expect(try await f.request("GET", path, applicant).json["data"]["status"] == str("pending"))
    await expectError("NOT_FOUND") { _ = try await f.request("GET", "rooms/\(room)", applicant) }
    let races = await withTaskGroup(of: String.self, returning: [String].self) { group in
        for action in ["close", "close", "approve"] { group.addTask {
            do {
                let response = try await f.request(action == "close" ? "DELETE" : "POST", action == "close" ? "rooms/\(room)" : path + "/approve", owner)
                return "\(action):\(response.status)"
            } catch let error as APIError { return "\(action):\(error.status)" }
            catch { Issue.record("Unexpected \(error)"); return "error" }
        } }
        var values: [String] = []; for await value in group { values.append(value) }; return values
    }
    #expect(races.filter { $0 == "close:204" }.count == 1)
    #expect(races.filter { $0 == "close:404" }.count == 1)
    #expect(races.contains("approve:200") || races.contains("approve:404"))
    #expect(try await memberships(f, applicant).isEmpty)
    await expectError("NOT_FOUND") { _ = try await f.request("GET", path, applicant) }
    await expectError("NOT_FOUND") { _ = try await f.request("POST", path + "/approve", owner) }
    await expectError("NOT_FOUND") { _ = try await f.request("POST", "rooms/join", proof, applicant, key: key) }
    await expectError("NOT_FOUND") { _ = try await f.request("GET", "rooms/\(room)", applicant) }
}

@Test func lifecycleApprovalPollingTouchesOnlyActualMembers() async throws {
    for ownerPolls in [false, true] {
        let f = try Fixture(); defer { f.clean() }
        let owner = try await f.user("poll-owner"), applicant = try await f.user("poll-applicant")
        let room = try await f.room(owner)["room"]["id"].string!
        _ = try await f.request("PATCH", "rooms/\(room)", .object(["approvalRequired": .bool(true)]), owner)
        let (body, key) = try await f.proved(applicant, code: "0042", joining: true)
        let pending = try await f.request("POST", "rooms/join", body, applicant, key: key)
        let path = "rooms/\(room)/join-requests/\(pending.json["data"]["request"]["id"].string!)"
        f.clock.advance(550)
        #expect(try await f.request("GET", path, ownerPolls ? owner : applicant).json["data"]["status"] == str("pending"))
        f.clock.advance(1340) // Original owner's last seen + 90 + 1800.
        #expect(try await memberships(f, owner).count == (ownerPolls ? 1 : 0))
        if ownerPolls {
            f.clock.advance(550)
            #expect(try await memberships(f, owner).isEmpty)
        }
        #expect(try await memberships(f, applicant).isEmpty)
    }
}
