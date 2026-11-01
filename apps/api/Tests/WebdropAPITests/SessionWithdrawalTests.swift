import Foundation
import Testing

@testable import WebdropAPI

@Test
func withdrawIsApplicantOnlyAndEmitsOneTerminalUpdate() async throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    let owner = try await fixture.user("withdraw-owner")
    let applicant = try await fixture.user("withdraw-applicant")
    let stranger = try await fixture.user("withdraw-stranger")
    let room = try await fixture.room(owner)["room"]["id"].string!
    _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["approvalRequired": .bool(true)]), owner)
    let pending = try await fixture.join(applicant)["request"]
    let path = "rooms/\(room)/join-requests/\(pending["id"].string!)"
    let cursor = try await fixture.store.eventBatch(room: room, context: owner, after: nil).cursor
    await expectError("FORBIDDEN") { _ = try await fixture.request("DELETE", path, owner) }
    await expectError("NOT_FOUND") { _ = try await fixture.request("DELETE", path, stranger) }
    var invalid = applicant
    invalid.csrf = nil
    await expectError("CSRF_INVALID") { _ = try await fixture.request("DELETE", path, invalid) }
    #expect(try await fixture.request("DELETE", path, applicant).status == 204)
    await expectError("JOIN_REQUEST_STATE") { _ = try await fixture.request("DELETE", path, applicant) }
    await expectError("JOIN_REQUEST_STATE") { _ = try await fixture.request("POST", path + "/approve", owner) }
    let terminal = try await fixture.request("GET", path, applicant).json["data"]
    #expect(terminal["status"] == .string("withdrawn"))
    let changes = try await fixture.store.eventBatch(room: room, context: owner, after: cursor).events.filter {
        $0.type == "join-request.updated"
    }
    #expect(changes.map(\.data) == [terminal])
    #expect(try await fixture.request("GET", "rooms/\(room)/join-requests", owner).json["data"] == .array([]))
    await expectError("NOT_FOUND") { _ = try await fixture.request("GET", "rooms/\(room)", applicant) }
    let renewed = try await fixture.join(applicant)["request"]
    #expect(renewed["id"] != pending["id"])
    let renewedPath = "rooms/\(room)/join-requests/\(renewed["id"].string!)"
    let statuses = await withTaskGroup(of: Int.self, returning: [Int].self) { group in
        group.addTask {
            do { return try await fixture.request("DELETE", renewedPath, applicant).status } catch let error as APIError
            { return error.status } catch { return 500 }
        }
        group.addTask {
            do { return try await fixture.request("POST", renewedPath + "/approve", owner).status } catch let error
                as APIError
            { return error.status } catch { return 500 }
        }
        var values: [Int] = []
        for await value in group { values.append(value) }
        return values.sorted()
    }
    #expect(statuses == [204, 409] || statuses == [200, 409])
}

extension Store {
    func seedWithdrawnRequests(room: String, device: String) {
        state.rooms[room]?.joinRequests = Dictionary(
            uniqueKeysWithValues: (0..<100).map { _ in
                let id = UUID().uuidString.lowercased()
                return (
                    id,
                    JoinRequest(
                        id: id,
                        device: device,
                        name: "withdrawn",
                        created: now,
                        expires: now + 600,
                        status: "withdrawn"
                    )
                )
            }
        )
    }
}

@Test
func withdrawnRequestsDoNotConsumeCapacity() async throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    let owner = try await fixture.user("quota-owner")
    let applicant = try await fixture.user("quota-applicant")
    let room = try await fixture.room(owner)["room"]["id"].string!
    _ = try await fixture.request("PATCH", "rooms/\(room)", .object(["approvalRequired": .bool(true)]), owner)
    let device = try await fixture.request("GET", "session", applicant).json["data"]["deviceId"].string!
    await fixture.store.seedWithdrawnRequests(room: room, device: device)
    #expect(try await fixture.join(applicant)["request"]["status"] == .string("pending"))
}

@Test
func sessionRenameValidatesBytesAndPreservesExistingMemberSnapshots() async throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    let owner = try await fixture.user("original")
    let room = try await fixture.room(owner)["room"]["id"].string!
    let before = try await fixture.request("GET", "session", owner).json["data"]
    let name = String(repeating: "界", count: 26) + "ab"
    let renamed = try await fixture.request("PATCH", "session", .object(["displayName": .string(name)]), owner)
    #expect(renamed.status == 200)
    #expect(renamed.json["data"]["displayName"] == .string(name))
    #expect(renamed.json["data"]["deviceId"] == before["deviceId"])
    #expect(renamed.json["data"]["csrfToken"] == before["csrfToken"])
    #expect(renamed.json["data"]["memberships"] == before["memberships"])
    #expect(await fixture.store.state.rooms[room]?.members.values.first?.name == "original")
    for body: JSON in [
        .object([:]), .object(["displayName": .null]), .object(["displayName": .string("")]),
        .object(["displayName": .string(String(repeating: "界", count: 27))]),
        .object(["displayName": .string("valid"), "unknown": .bool(true)]),
    ] {
        await expectError("INVALID_INPUT") { _ = try await fixture.request("PATCH", "session", body, owner) }
    }
    var invalid = owner
    invalid.csrf = "wrong"
    await expectError("CSRF_INVALID") {
        _ = try await fixture.request("PATCH", "session", .object(["displayName": .string("bad")]), invalid)
    }
    #expect(try await fixture.request("GET", "session", owner).json["data"]["displayName"] == .string(name))
    let second = try await fixture.room(owner, code: "0043")
    #expect(second["membership"]["displayName"] == .string(name))
    let saved = try JSONDecoder().decode(
        State.self,
        from: Data(contentsOf: URL(fileURLWithPath: fixture.settings.directory + "/state.json"))
    )
    #expect(saved.sessions[owner.sessionHash!]?.name == name)
}
