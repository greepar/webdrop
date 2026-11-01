import Testing

@testable import WebdropAPI

@Test
func roomCapacityCountsExpiryAndConfig() async throws {
    let fixture = try Fixture(maxRooms: 2, maxOwnedRooms: 1)
    defer {
        fixture.clean()
    }
    let anonymous = Context(sessionHash: nil, source: "public", csrf: nil, key: nil)
    func capacity() async throws -> JSON {
        try await fixture.request("GET", "room-capacity", anonymous).json["data"]
    }
    let initial = try await capacity()
    #expect(initial["availableRooms"] == .number(2))
    #expect(initial["codeCapacity"] == .number(10000))
    let firstUser = try await fixture.user("capacity-a")
    let secondUser = try await fixture.user("capacity-b")
    let room = try await fixture.room(firstUser)["room"]["id"].string!
    #expect(try await capacity()["occupiedCodes"] == .number(1))
    let (body, key) = try await fixture.proved(firstUser, code: "0043")
    await expectError("ROOM_CAPACITY") { _ = try await fixture.request("POST", "rooms", body, firstUser, key: key) }
    _ = try await fixture.room(secondUser, code: "0043")
    #expect(try await capacity()["availableRooms"] == .number(0))
    _ = try await fixture.request("DELETE", "rooms/\(room)", firstUser)
    #expect(try await capacity()["availableRooms"] == .number(1))
    fixture.clock.advance(1890)
    #expect(try await capacity()["activeRooms"] == .number(0))
    #expect(try await capacity()["availableCodes"] == .number(10000))
    var config = fixture.settings
    try config.configureRoomCapacity(maxRooms: "3", maxOwnedRooms: nil)
    #expect(config.maxRooms == 3)
    for pair in [("0", "1"), ("abc", "1"), ("2", "3"), ("1000001", "1"), ("2", "0")] {
        #expect(throws: APIError.self) { try config.configureRoomCapacity(maxRooms: pair.0, maxOwnedRooms: pair.1) }
    }
}

@Test
func concurrentRoomCreationCannotOversubscribeCapacity() async throws {
    let fixture = try Fixture(maxRooms: 1)
    defer {
        fixture.clean()
    }
    let firstUser = try await fixture.user("slot-a")
    let secondUser = try await fixture.user("slot-b")
    let firstProof = try await fixture.proved(firstUser, code: "0042")
    let secondProof = try await fixture.proved(secondUser, code: "0043")
    let values = await withTaskGroup(of: Int.self, returning: [Int].self) { group in
        for (context, pair) in [(firstUser, firstProof), (secondUser, secondProof)] {
            group.addTask {
                do {
                    return try await fixture.request("POST", "rooms", pair.0, context, key: pair.1).status
                } catch let error as APIError {
                    return error.status
                } catch {
                    Issue.record("Unexpected \(error)")
                    return 500
                }
            }
        }
        var result: [Int] = []
        for await value in group {
            result.append(value)
        }
        return result.sorted()
    }
    #expect(values == [201, 429])
    #expect(
        try await fixture.request("GET", "room-capacity", firstUser).json["data"]["availableRooms"] == .number(0)
    )
}
