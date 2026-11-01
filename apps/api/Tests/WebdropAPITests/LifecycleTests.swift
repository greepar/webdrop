import Foundation
import Testing

@testable import WebdropAPI

private func memberships(_ fixture: Fixture, _ context: Context) async throws -> [JSON] {
    let response = try await fixture.request("GET", "session", context)
    if case .array(let values) = response.json["data"]["memberships"] {
        return values
    }
    Issue.record("Missing memberships")
    return []
}

@Test
func lifecycleLeaveCloseAndLostResponses() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let owner = try await fixture.user("life-owner")
    let member = try await fixture.user("life-member")
    let kicked = try await fixture.user("life-kicked")
    let (create, createKey) = try await fixture.proved(owner, code: "0042")
    let room = try await fixture.request("POST", "rooms", create, owner, key: createKey).json["data"]["room"]["id"]
        .string!
    let (join, joinKey) = try await fixture.proved(member, code: "0042", joining: true)
    _ = try await fixture.request("POST", "rooms/join", join, member, key: joinKey)
    let kickID = try await fixture.join(kicked)["membership"]["id"].string!
    let textKey = UUID().uuidString.lowercased()
    let text: JSON = .object(["text": .string("kept")])
    _ = try await fixture.request("POST", "rooms/\(room)/items", text, member, key: textKey)
    await expectError("OWNER_MUST_CLOSE") { _ = try await fixture.request("DELETE", "rooms/\(room)/members/me", owner) }
    await expectError("OWNER_REQUIRED") { _ = try await fixture.request("DELETE", "rooms/\(room)", member) }
    #expect(try await memberships(fixture, owner).count == 1)
    let cursor = try await fixture.request("GET", "rooms/\(room)", member).json["data"]["eventCursor"].string.flatMap(
        Int.init
    )!
    _ = try await fixture.request("DELETE", "rooms/\(room)/members/me", member)  // Treat response as lost.
    #expect(try await memberships(fixture, member).isEmpty)
    await expectError("NOT_FOUND") { _ = try await fixture.request("DELETE", "rooms/\(room)/members/me", member) }
    await expectError("NOT_FOUND") { _ = try await fixture.request("POST", "rooms/join", join, member, key: joinKey) }
    await expectError("NOT_FOUND") {
        _ = try await fixture.request("POST", "rooms/\(room)/items", text, member, key: textKey)
    }
    await expectError("NOT_FOUND") { try await fixture.store.subscribe(room: room, context: member) }
    await expectError("MEMBERSHIP_REVOKED") {
        _ = try await fixture.store.eventBatch(room: room, context: member, after: cursor)
    }
    _ = try await fixture.request("DELETE", "rooms/\(room)/members/\(kickID)", owner)
    #expect(try await memberships(fixture, kicked).isEmpty)
    await expectError("ROOM_UNAVAILABLE") { _ = try await fixture.join(kicked) }
    let events = try await fixture.store.eventBatch(room: room, context: owner, after: 0)
    #expect(events.events.filter { $0.type == "member.left" }.count == 2)
    _ = try await fixture.request("DELETE", "rooms/\(room)", owner)
    #expect(try await memberships(fixture, owner).isEmpty)
    await expectError("NOT_FOUND") { _ = try await fixture.request("DELETE", "rooms/\(room)", owner) }
    await expectError("NOT_FOUND") { _ = try await fixture.request("POST", "rooms", create, owner, key: createKey) }
    await expectError("NOT_FOUND") { try await fixture.store.subscribe(room: room, context: owner) }
}

@Test
func lifecycleSameSessionRecoveryAndNoAnonymousOwnership() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let owner = try await fixture.user("recover-owner")
    let member = try await fixture.user("recover-member")
    let room = try await fixture.room(owner)["room"]["id"].string!
    _ = try await fixture.join(member)
    _ = try await fixture.request(
        "PATCH",
        "rooms/\(room)",
        .object([
            "password": .string("secret"),
            "approvalRequired": .bool(true),
            "joinPolicy": .string("locked"),
        ]),
        owner
    )
    let before = try await memberships(fixture, owner).first!["membership"]["id"]
    fixture.clock.advance(100)
    let (restored, token) = try await fixture.store.createSession(
        .object([:]),
        source: owner.source,
        existing: owner.sessionHash
    )
    #expect(restored.status == 200)
    #expect(token == nil)
    #expect(try await memberships(fixture, owner).first!["membership"]["id"] == before)
    #expect(try await memberships(fixture, owner).first!["membership"]["role"] == .string("owner"))
    for context in [owner, member] {
        _ = try await fixture.request("GET", "rooms/\(room)", context)
        try await fixture.store.subscribe(room: room, context: context)
        await fixture.store.unsubscribe(context: context)
    }
    let state = await fixture.store.state
    #expect(state.rooms[room]?.members.count == 2)
    let stranger = try await fixture.user("lost-cookie")
    #expect(try await memberships(fixture, stranger).isEmpty)
    await expectError("NOT_FOUND") { _ = try await fixture.request("GET", "rooms/\(room)", stranger) }
    await expectError("NOT_FOUND") { _ = try await fixture.request("DELETE", "rooms/\(room)", stranger) }
    // Session expiry grants no old membership to the replacement anonymous session.
    fixture.clock.advance(fixture.settings.sessionSeconds)
    await expectError("SESSION_REQUIRED") { _ = try await fixture.request("GET", "session", owner) }
    let (replacement, newToken) = try await fixture.store.createSession(
        .object([:]),
        source: owner.source,
        existing: owner.sessionHash
    )
    #expect(replacement.status == 201)
    #expect(newToken != nil)
    #expect(replacement.json["data"]["deviceId"] != restored.json["data"]["deviceId"])
}

@Test
func lifecycleLeaseBoundariesAndDeparture() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let owner = try await fixture.user("lease-owner")
    let member = try await fixture.user("lease-member")
    let room = try await fixture.room(owner)["room"]["id"].string!
    _ = try await fixture.join(member)
    fixture.clock.advance(1800)  // owner offline, other room tab remains active below timeout.
    _ = try await fixture.store.eventBatch(room: room, context: member, after: nil)
    #expect(try await memberships(fixture, owner).first!["membership"]["role"] == .string("owner"))
    // The last online member leaves; offline time starts NOW, not from the owner's old seen.
    _ = try await fixture.request("DELETE", "rooms/\(room)/members/me", member)
    fixture.clock.advance(1799)
    #expect(try await memberships(fixture, owner).count == 1)  // GET session must not refresh lease.
    fixture.clock.advance(1)
    // Failed access must still commit the automatic closure without maintenance().
    await expectError("NOT_FOUND") { _ = try await fixture.request("GET", "rooms/\(room)", owner) }
    let state = await fixture.store.state
    #expect(state.rooms[room]?.closed != nil)
    #expect(try await memberships(fixture, owner).isEmpty)
}

@Test
func lifecycleActiveTabAndExactIdleBoundary() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let owner = try await fixture.user("tab-owner")
    let room = try await fixture.room(owner)["room"]["id"].string!
    // One tab stops reading while the other refreshes the same session lease.
    fixture.clock.advance(1800)
    _ = try await fixture.store.eventBatch(room: room, context: owner, after: nil)
    fixture.clock.advance(1889)
    #expect(try await memberships(fixture, owner).count == 1)
    fixture.clock.advance(1)  // last seen + 90 seconds + 30 minutes
    #expect(try await memberships(fixture, owner).isEmpty)
}

@Test
func lifecycleClosureStreamsResourcesAndCache() async throws {
    for threshold in [0, 32] {
        let fixture = try Fixture(memoryThreshold: threshold)
        defer {
            fixture.clean()
        }
        let owner = try await fixture.user("close-resources-\(threshold)")
        let room = try await fixture.room(owner)["room"]["id"].string!
        let createKey = UUID().uuidString.lowercased()
        let completeKey = UUID().uuidString.lowercased()
        let linkKey = UUID().uuidString.lowercased()
        let input: JSON = .object([
            "filename": .string("life.bin"),
            "sizeBytes": .number(3),
            "contentType": .string("application/octet-stream"),
        ])
        let upload = try await fixture.request("POST", "rooms/\(room)/uploads", input, owner, key: createKey).json[
            "data"
        ][
            "uploadId"
        ].string!
        let ticket = try await fixture.store.beginUpload(upload, owner, length: 3)
        let writer = try UploadWriter(path: ticket.path, expected: 3, inMemory: threshold > 0)
        try await writer.write(Data([1, 2, 3]))
        let (checksum, type, memory) = try await writer.finish()
        _ = try await fixture.store.finishUpload(ticket, context: owner, checksum: checksum, type: type, memory: memory)
        _ = try await fixture.request("POST", "uploads/\(upload)/complete", .object([:]), owner, key: completeKey)
        let link = try await fixture.request("POST", "assets/\(upload)/links", .object([:]), owner, key: linkKey).json[
            "data"
        ]["slug"].string!
        try await fixture.store.subscribe(room: room, context: owner)
        // Cursor can lag past the retained event ring while an existing writer is busy.
        for i in 0..<257 {
            _ = try await fixture.request(
                "POST",
                "rooms/\(room)/items",
                .object(["text": .string("event \(i)")]),
                owner,
                key: UUID().uuidString.lowercased()
            )
        }
        _ = try await fixture.request("DELETE", "rooms/\(room)", owner)
        let terminal = try await fixture.store.eventBatch(room: room, context: owner, after: 0)
        #expect(terminal.closed)
        #expect(!terminal.resync)
        #expect(terminal.events.map(\.type) == ["room.closed"])
        #expect(terminal.events.first?.data == .object(["id": .string(room)]))
        await fixture.store.unsubscribe(context: owner)
        await expectError("NOT_FOUND") { try await fixture.store.subscribe(room: room, context: owner) }
        await expectError("NOT_FOUND") {
            _ = try await fixture.store.download(upload, context: owner, publicLink: false)
        }
        await expectError("SHARE_EXPIRED") {
            _ = try await fixture.store.download(link, context: owner, publicLink: true)
        }
        await expectError("NOT_FOUND") {
            _ = try await fixture.request("POST", "rooms/\(room)/uploads", input, owner, key: createKey)
        }
        await expectError("NOT_FOUND") {
            _ = try await fixture.request("POST", "uploads/\(upload)/complete", .object([:]), owner, key: completeKey)
        }
        await expectError("NOT_FOUND") {
            _ = try await fixture.request("POST", "assets/\(upload)/links", .object([:]), owner, key: linkKey)
        }
        #expect(await fixture.store.memoryFiles.isEmpty)
        try await fixture.store.maintain()
        #expect(try FileManager.default.contentsOfDirectory(atPath: fixture.settings.directory + "/files").isEmpty)
    }
}

@Test
func lifecycleConcurrentLeaveAndCloseApproval() async throws {
    let fixture = try Fixture()
    defer {
        fixture.clean()
    }
    let owner = try await fixture.user("race-owner")
    let guest = try await fixture.user("race-guest")
    let applicant = try await fixture.user("race-applicant")
    let room = try await fixture.room(owner)["room"]["id"].string!
    _ = try await fixture.join(guest)
    let results = await withTaskGroup(of: Int.self, returning: [Int].self) { group in
        for _ in 0..<2 {
            group.addTask {
                do {
                    return try await fixture.request("DELETE", "rooms/\(room)/members/me", guest).status
                } catch let error as APIError {
                    return error.status
                } catch {
                    Issue.record("Unexpected \(error)")
                    return 500
                }
            }
        }
        var values: [Int] = []
        for await value in group {
            values.append(value)
        }
        return values.sorted()
    }
    #expect(results == [204, 404])
    _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["approvalRequired": .bool(true)]), owner)
    let (proof, key) = try await fixture.proved(applicant, code: "0042", joining: true)
    let pending = try await fixture.request("POST", "rooms/join", proof, applicant, key: key)
    let path = "rooms/\(room)/join-requests/\(pending.json["data"]["request"]["id"].string!)"
    fixture.clock.advance(100)  // owner offline does not auto approve.
    #expect(try await fixture.request("GET", path, applicant).json["data"]["status"] == .string("pending"))
    await expectError("NOT_FOUND") { _ = try await fixture.request("GET", "rooms/\(room)", applicant) }
    let races = await withTaskGroup(of: String.self, returning: [String].self) { group in
        for action in ["close", "close", "approve"] {
            group.addTask {
                do {
                    let response = try await fixture.request(
                        action == "close" ? "DELETE" : "POST",
                        action == "close" ? "rooms/\(room)" : path + "/approve",
                        owner
                    )
                    return "\(action):\(response.status)"
                } catch let error as APIError {
                    return "\(action):\(error.status)"
                } catch {
                    Issue.record("Unexpected \(error)")
                    return "error"
                }
            }
        }
        var values: [String] = []
        for await value in group {
            values.append(value)
        }
        return values
    }
    #expect(races.filter { $0 == "close:204" }.count == 1)
    #expect(races.filter { $0 == "close:404" }.count == 1)
    #expect(races.contains("approve:200") || races.contains("approve:404"))
    #expect(try await memberships(fixture, applicant).isEmpty)
    await expectError("NOT_FOUND") { _ = try await fixture.request("GET", path, applicant) }
    await expectError("NOT_FOUND") { _ = try await fixture.request("POST", path + "/approve", owner) }
    await expectError("NOT_FOUND") { _ = try await fixture.request("POST", "rooms/join", proof, applicant, key: key) }
    await expectError("NOT_FOUND") { _ = try await fixture.request("GET", "rooms/\(room)", applicant) }
}

@Test
func lifecycleApprovalPollingTouchesOnlyActualMembers() async throws {
    for ownerPolls in [false, true] {
        let fixture = try Fixture()
        defer {
            fixture.clean()
        }
        let owner = try await fixture.user("poll-owner")
        let applicant = try await fixture.user("poll-applicant")
        let room = try await fixture.room(owner)["room"]["id"].string!
        _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["approvalRequired": .bool(true)]), owner)
        let (body, key) = try await fixture.proved(applicant, code: "0042", joining: true)
        let pending = try await fixture.request("POST", "rooms/join", body, applicant, key: key)
        let path = "rooms/\(room)/join-requests/\(pending.json["data"]["request"]["id"].string!)"
        fixture.clock.advance(550)
        #expect(
            try await fixture.request("GET", path, ownerPolls ? owner : applicant).json["data"]["status"]
                == .string("pending")
        )
        fixture.clock.advance(1340)  // Original owner's last seen + 90 + 1800.
        #expect(try await memberships(fixture, owner).count == (ownerPolls ? 1 : 0))
        if ownerPolls {
            fixture.clock.advance(550)
            #expect(try await memberships(fixture, owner).isEmpty)
        }
        #expect(try await memberships(fixture, applicant).isEmpty)
    }
}
