import Foundation

struct Session: Codable, Sendable { var id: String; var csrf: String; var name: String; var expires: Double }
struct Member: Codable, Sendable {
    var id: String; var device: String; var name: String; var role: String; var joined: Double; var seen: Double
    func json(now: Double, lease: Double) -> JSON { .object(["id": str(id), "deviceId": str(device), "displayName": str(name), "role": str(role), "joinedAt": iso(joined), "presence": str(now - seen < lease ? "online" : "offline")]) }
}
struct Event: Codable, Sendable {
    var id: Int; var type: String; var room: String; var time: Double; var data: JSON
    var json: JSON { .object(["eventId": str(String(id)), "type": str(type), "roomId": str(room), "occurredAt": iso(time), "data": data]) }
}
struct Room: Codable, Sendable {
    var id: String; var code: String; var owner: String; var created: Double; var locked = false
    var closed: Double?; var members: [String: Member]; var banned: Set<String> = []
    var passwordHash: String? = nil
    var approvalRequired: Bool? = nil
    var joinRequests: [String: JoinRequest]? = nil
    var idleSince: Double?; var sequence = 0; var events: [Event] = []
    func json(idle: Double) -> JSON { .object(["id": str(id), "code": str(code), "ownerMemberId": str(owner), "createdAt": iso(created), "joinPolicy": str(locked ? "locked" : "open"), "hasPassword": .bool(passwordHash != nil), "approvalRequired": .bool(approvalRequired ?? false), "expiresAt": idleSince.map { iso($0 + idle) } ?? .null]) }
}
struct Item: Codable, Sendable {
    var id: String; var room: String; var sender: String; var created: Double; var sequence: Int
    var text: String?; var asset: String?
}
struct Upload: Codable, Sendable {
    var id: String; var room: String; var device: String; var member: String; var filename: String
    var size: Int; var declaredType: String; var type = "application/octet-stream"; var created: Double; var expires: Double
    var storage: String? // nil in legacy snapshots means disk.
    var status = "pending"; var attempt: String?; var sha256: String?; var item: String?
    var json: JSON { .object(["id": str(id), "filename": str(filename), "sizeBytes": num(size), "contentType": str(type), "sha256": sha256.map(str) ?? .null, "status": str(status), "createdAt": iso(created)]) }
}
struct ShareLink: Codable, Sendable {
    var id: String; var asset: String; var room: String; var creator: String; var slug: String; var expires: Double; var revoked: Double?
    func json(origin: String) -> JSON { .object(["id": str(id), "assetId": str(asset), "slug": str(slug), "expiresAt": iso(expires), "revokedAt": revoked.map(iso) ?? .null, "shareUrl": str(origin + "/s/" + slug), "contentUrl": str(origin + "/d/" + slug)]) }
}
struct Challenge: Codable, Sendable {
    var id: String; var device: String; var source: String; var action: String; var code: String?
    var key: String; var bits: Int; var input: String; var expires: Double
}
struct Idempotent: Codable, Sendable { var fingerprint: String; var response: WireResponse; var expires: Double; var room: String?; var passwordHash: String? = nil }
struct Bucket: Codable, Sendable { var start: Double; var count: Int }
struct State: Codable, Sendable {
    var schema = 1
    var sessions: [String: Session] = [:]
    var rooms: [String: Room] = [:]
    var items: [String: Item] = [:]
    var uploads: [String: Upload] = [:]
    var links: [String: ShareLink] = [:]
    var challenges: [String: Challenge] = [:]
    var idem: [String: Idempotent] = [:]
    var buckets: [String: Bucket] = [:]
}
struct Context: Sendable {
    var sessionHash: String?; var source: String; var csrf: String?; var key: String?
}

struct JoinRequest: Codable, Sendable {
    var id: String; var device: String; var name: String; var created: Double; var expires: Double; var status: String
    var json: JSON { .object(["id": str(id), "displayName": str(name), "createdAt": iso(created), "expiresAt": iso(expires), "status": str(status)]) }
}
