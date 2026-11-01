import Foundation
import Testing

@testable import WebdropAPI

@Test
func approvalEventsAreDeduplicatedAndVisibleOnlyToMembers() async throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    let owner = try await fixture.user("event-owner")
    let member = try await fixture.user("event-member")
    let applicant = try await fixture.user("event-applicant")
    let room = try await fixture.room(owner)["room"]["id"].string!
    _ = try await fixture.join(member)
    _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["approvalRequired": .bool(true)]), owner)
    let cursor = try await fixture.store.eventBatch(room: room, context: owner, after: nil).cursor
    let (proof, key) = try await fixture.proved(applicant, code: "0042", joining: true)
    let pending = try await fixture.request("POST", "rooms/join", proof, applicant, key: key).json["data"]["request"]
    _ = try await fixture.request("POST", "rooms/join", proof, applicant, key: key)
    let (retry, retryKey) = try await fixture.proved(applicant, code: "0042", joining: true)
    _ = try await fixture.request("POST", "rooms/join", retry, applicant, key: retryKey)
    let created = try await fixture.store.eventBatch(room: room, context: owner, after: cursor)
    #expect(created.events.filter { $0.type == "join-request.created" }.map(\.data) == [pending])
    #expect(
        try await fixture.store.eventBatch(room: room, context: member, after: cursor).events.map(\.json)
            == created.events.map(\.json)
    )
    await expectError("NOT_FOUND") { try await fixture.store.subscribe(room: room, context: applicant) }
    await expectError("MEMBERSHIP_REVOKED") {
        _ = try await fixture.store.eventBatch(room: room, context: applicant, after: cursor)
    }
    let path = "rooms/\(room)/join-requests/\(pending["id"].string!)"
    let approved = try await fixture.request("POST", path + "/approve", owner).json["data"]
    _ = try await fixture.request("POST", path + "/approve", owner)
    let updated = try await fixture.store.eventBatch(room: room, context: owner, after: created.cursor)
    #expect(updated.events.filter { $0.type == "join-request.updated" }.map(\.data) == [approved])
    #expect(approved["status"] == .string("approved"))
    #expect(try await fixture.request("GET", path, applicant).json["data"] == approved)
}

@Test
func approvalRejectionExpiryAndClosureEmitOnlyRealTransitions() async throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    let owner = try await fixture.user("expiry-owner")
    let rejectedUser = try await fixture.user("rejected-user")
    let expiredUser = try await fixture.user("expired-user")
    let room = try await fixture.room(owner)["room"]["id"].string!
    _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["approvalRequired": .bool(true)]), owner)
    let rejected = try await fixture.join(rejectedUser)["request"]
    let expired = try await fixture.join(expiredUser)["request"]
    let cursor = try await fixture.store.eventBatch(room: room, context: owner, after: nil).cursor
    let rejectedPath = "rooms/\(room)/join-requests/\(rejected["id"].string!)"
    let expiredPath = "rooms/\(room)/join-requests/\(expired["id"].string!)"
    _ = try await fixture.request("POST", rejectedPath + "/reject", owner)
    _ = try await fixture.request("POST", rejectedPath + "/reject", owner)
    fixture.clock.advance(599)
    try await fixture.store.maintain()
    #expect(await fixture.store.state.rooms[room]?.joinRequests?[expired["id"].string!]?.status == "pending")
    fixture.clock.advance(1)
    // A failed late approval still commits expiration and its event exactly once.
    await expectError("JOIN_REQUEST_STATE") { _ = try await fixture.request("POST", expiredPath + "/approve", owner) }
    try await fixture.store.maintain()
    await expectError("JOIN_REQUEST_STATE") { _ = try await fixture.request("DELETE", expiredPath, expiredUser) }
    await expectError("JOIN_REQUEST_STATE") { _ = try await fixture.request("DELETE", rejectedPath, rejectedUser) }
    let batch = try await fixture.store.eventBatch(room: room, context: owner, after: cursor)
    let changes = batch.events.filter { $0.type == "join-request.updated" }
    #expect(changes.map { $0.data["status"] } == [.string("rejected"), .string("expired")])
    #expect(changes[1].data == (try await fixture.request("GET", expiredPath, expiredUser)).json["data"])
    let pendingUser = try await fixture.user("closing-user")
    let pendingID = try await fixture.request("GET", "session", pendingUser).json["data"]["deviceId"].string!
    _ = try await fixture.join(pendingUser)
    _ = try await fixture.request("DELETE", "rooms/\(room)", owner)
    fixture.clock.advance(601)
    try await fixture.store.maintain()
    let terminal = await fixture.store.state.rooms[room]!
    #expect(terminal.events.last?.type == "room.closed")
    #expect(terminal.members[pendingID] == nil)
}

@Test
func concurrentApprovalDecisionProducesOneUpdatedEvent() async throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    let owner = try await fixture.user("race-event-owner")
    let applicant = try await fixture.user("race-event-applicant")
    let room = try await fixture.room(owner)["room"]["id"].string!
    _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["approvalRequired": .bool(true)]), owner)
    let pending = try await fixture.join(applicant)["request"]
    let path = "rooms/\(room)/join-requests/\(pending["id"].string!)"
    let cursor = try await fixture.store.eventBatch(room: room, context: owner, after: nil).cursor
    let results = await withTaskGroup(of: Int.self, returning: [Int].self) { group in
        for action in ["approve", "reject"] {
            group.addTask {
                do { return try await fixture.request("POST", path + "/" + action, owner).status } catch let error
                    as APIError
                { return error.status } catch {
                    Issue.record("Unexpected \(error)")
                    return 500
                }
            }
        }
        var values: [Int] = []
        for await value in group { values.append(value) }
        return values.sorted()
    }
    #expect(results == [200, 409])
    let changes = try await fixture.store.eventBatch(room: room, context: owner, after: cursor).events.filter {
        $0.type == "join-request.updated"
    }
    #expect(changes.count == 1)
}

@Test
func eventWakeupShutdownAndCancelledWaitersDoNotCloseRooms() async throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    let owner = try await fixture.user("stream-stop-owner")
    let room = try await fixture.room(owner)["room"]["id"].string!
    let cursor = try await fixture.store.eventBatch(room: room, context: owner, after: nil).cursor
    let waiter = Task { await fixture.store.waitForEvent(room: room, after: cursor) }
    for _ in 0..<10000 {
        if await fixture.store.eventWaiters.count == 1 { break }
        await Task.yield()
    }
    #expect(await fixture.store.eventWaiters.count == 1)
    _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["approvalRequired": .bool(true)]), owner)
    await waiter.value
    #expect(await fixture.store.eventWaiters.isEmpty)
    let latest = try await fixture.store.eventBatch(room: room, context: owner, after: nil).cursor
    let cancelled = Task { await fixture.store.waitForEvent(room: room, after: latest) }
    cancelled.cancel()
    await cancelled.value
    #expect(await fixture.store.eventWaiters.isEmpty)
    let stopping = Task { await fixture.store.waitForEvent(room: room, after: latest) }
    await fixture.store.stopStreaming()
    await stopping.value
    #expect(await fixture.store.eventWaiters.isEmpty)
    #expect(await fixture.store.state.rooms[room]?.closed == nil)
    #expect(try await fixture.request("GET", "rooms/\(room)", owner).status == 200)
}
