import Foundation
import Vapor
import Crypto

// JSON values at the transport boundary; persistence models remain typed.
indirect enum JSON: Codable, Sendable, Equatable {
    case object([String: JSON]), array([JSON]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([JSON].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    subscript(_ key: String) -> JSON { if case .object(let o) = self { return o[key] ?? .null }; return .null }
    var string: String? { if case .string(let s) = self { return s }; return nil }
    var integer: Int? {
        if case .number(let n) = self, n.isFinite, n >= 0, n < Double(Int.max), n.rounded() == n { return Int(n) }
        return nil
    }
    var object: [String: JSON]? { if case .object(let v) = self { return v }; return nil }
    func required(_ key: String, max: Int = 256) throws -> String {
        guard let s = self[key].string, !s.isEmpty, s.utf8.count <= max else { throw APIError(400, "INVALID_INPUT", "Invalid \(key)") }
        return s
    }
    func only(_ fields: Set<String>) throws {
        guard let o = object, Set(o.keys).isSubset(of: fields) else { throw APIError(400, "INVALID_INPUT", "Unknown fields or invalid object") }
    }
    func bytes() throws -> Data { let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]; return try encoder.encode(self) }
}
func str(_ s: String) -> JSON { .string(s) }
func num(_ n: Int) -> JSON { .number(Double(n)) }
func iso(_ time: Double) -> JSON { .string(ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: time))) }
func timestamp(_ s: String) -> Double? { ISO8601DateFormatter().date(from: s)?.timeIntervalSince1970 }
func uid() -> String { UUID().uuidString.lowercased() }
func randomToken() -> String { (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined() }
func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func hash(_ string: String) -> String { digest(Data(string.utf8)) }
func validProof(input: String, nonce: String, bits: Int) -> Bool {
    guard (1...64).contains(nonce.count), nonce.utf8.allSatisfy({ (48...57).contains($0) }), nonce == "0" || !nonce.hasPrefix("0") else { return false }
    let bytes = Array(SHA256.hash(data: Data((input + nonce).utf8)))
    for bit in 0..<bits where (bytes[bit / 8] & (1 << (7 - bit % 8))) != 0 { return false }
    return true
}
struct APIError: Error, Sendable {
    let status: Int; let code: String; let message: String; var retryAfter: Int? = nil
    init(_ status: Int, _ code: String, _ message: String, retryAfter: Int? = nil) {
        self.status = status; self.code = code; self.message = message; self.retryAfter = retryAfter
    }
}
struct WireResponse: Codable, Sendable {
    var status: Int = 200
    var json: JSON = .null
    func response() throws -> Response {
        let response = Response(status: .init(statusCode: status), body: status == 204 ? .empty : .init(data: try json.bytes()))
        response.headers.contentType = .json
        response.headers.replaceOrAdd(name: .cacheControl, value: "no-store")
        response.headers.replaceOrAdd(name: "X-Content-Type-Options", value: "nosniff")
        return response
    }
}
func dataResponse(_ value: JSON, status: Int = 200) -> WireResponse { .init(status: status, json: .object(["data": value])) }
struct APIErrorMiddleware: AsyncMiddleware {
    func respond(to request: Request, chainingTo next: any AsyncResponder) async throws -> Response {
        let requestID = uid()
        do {
            let response = try await next.respond(to: request)
            response.headers.replaceOrAdd(name: "X-Request-ID", value: requestID)
            return response
        } catch {
            let failure: APIError
            if let e = error as? APIError { failure = e }
            else if let e = error as? AbortError {
                failure = APIError(Int(e.status.code), "HTTP_\(e.status.code)", e.status.code >= 500 ? "Service unavailable" : e.status.reasonPhrase)
            } else { request.logger.error("Request failed [\(requestID)]: \(error)"); failure = APIError(500, "INTERNAL_ERROR", "Service unavailable") }
            let response = try WireResponse(status: failure.status, json: .object(["error": .object([
                "code": str(failure.code), "message": str(failure.message), "requestId": str(requestID)
            ])])).response()
            if let seconds = failure.retryAfter { response.headers.replaceOrAdd(name: .retryAfter, value: String(seconds)) }
            response.headers.replaceOrAdd(name: "X-Request-ID", value: requestID)
            return response
        }
    }
}

// Passwords are exact UTF-8 bytes; reject NUL and bcrypt's truncation boundary.
func roomPassword(_ body: JSON) throws -> String? {
    if body["password"] == .null { return nil }
    let value = try body.required("password", max: 72)
    guard !value.utf8.contains(0) else { throw APIError(400, "INVALID_INPUT", "Password must not contain NUL") }
    return value
}
func passwordMatches(_ value: String?, _ hash: String?) throws -> Bool {
    switch (value, hash) {
    case (nil, nil): return true
    case (.some(let value), .some(let hash)): return try Bcrypt.verify(value, created: hash)
    default: return false
    }
}
