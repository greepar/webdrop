import Crypto
import Foundation
import Vapor

// JSON values at the transport boundary; persistence models remain typed.
indirect enum JSON: Codable, Sendable, Equatable {
    case object([String: JSON])
    case array([JSON])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode([JSON].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSON].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }

    subscript(_ key: String) -> JSON {
        if case .object(let object) = self {
            return object[key] ?? .null
        }
        return .null
    }

    var string: String? {
        if case .string(let string) = self {
            return string
        }
        return nil
    }

    var integer: Int? {
        if case .number(let number) = self, number.isFinite, number >= 0, number < Double(Int.max),
            number.rounded() == number
        {
            return Int(number)
        }
        return nil
    }

    var object: [String: JSON]? {
        if case .object(let value) = self {
            return value
        }
        return nil
    }

    func requiredString(_ key: String, maxBytes: Int = 256) throws -> String {
        guard let string = self[key].string, !string.isEmpty, string.utf8.count <= maxBytes else {
            throw APIError(400, "INVALID_INPUT", "Invalid \(key)")
        }
        return string
    }

    func validateFields(_ fields: Set<String>) throws {
        guard let object = object, Set(object.keys).isSubset(of: fields) else {
            throw APIError(400, "INVALID_INPUT", "Unknown fields or invalid object")
        }
    }

    func resolvingLinkURLs(against origin: String) -> JSON {
        switch self {
        case .object(let fields):
            var resolved: [String: JSON] = [:]
            for (key, value) in fields {
                if ["shareUrl", "contentUrl"].contains(key), let text = value.string,
                    let path = URLComponents(string: text)?.percentEncodedPath,
                    path.hasPrefix("/s/") || path.hasPrefix("/d/")
                {
                    resolved[key] = .string(origin + path)
                } else {
                    resolved[key] = value.resolvingLinkURLs(against: origin)
                }
            }
            return .object(resolved)
        case .array(let values):
            return .array(values.map { $0.resolvingLinkURLs(against: origin) })
        default:
            return self
        }
    }

    func encodedData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

func jsonTimestamp(_ time: Double) -> JSON {
    .string(ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: time)))
}

func randomToken() -> String {
    (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
}

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func isValidProof(input: String, nonce: String, bits: Int) -> Bool {
    guard (1...64).contains(nonce.count), nonce.utf8.allSatisfy({ (48...57).contains($0) }),
        nonce == "0" || !nonce.hasPrefix("0")
    else {
        return false
    }
    let bytes = Array(SHA256.hash(data: Data((input + nonce).utf8)))
    for bit in 0..<bits where (bytes[bit / 8] & (1 << (7 - bit % 8))) != 0 {
        return false
    }
    return true
}

struct APIError: Error, Sendable {
    let status: Int
    let code: String
    let message: String
    var retryAfter: Int? = nil

    init(_ status: Int, _ code: String, _ message: String, retryAfter: Int? = nil) {
        self.status = status
        self.code = code
        self.message = message
        self.retryAfter = retryAfter
    }
}

struct WireResponse: Codable, Sendable {
    var status: Int = 200
    var json: JSON = .null

    func response(origin: String? = nil) throws -> Response {
        let response = Response(
            status: .init(statusCode: status),
            body: status == 204
                ? .empty : .init(data: try (origin.map { json.resolvingLinkURLs(against: $0) } ?? json).encodedData())
        )
        response.headers.contentType = .json
        response.headers.replaceOrAdd(name: .cacheControl, value: "no-store")
        response.headers.replaceOrAdd(name: "X-Content-Type-Options", value: "nosniff")
        return response
    }
}

func dataResponse(_ value: JSON, status: Int = 200) -> WireResponse {
    .init(status: status, json: .object(["data": value]))
}

struct APIErrorMiddleware: AsyncMiddleware {
    var corsOrigins: Set<String> = []
    private let corsMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]
    private let corsHeaders = [
        "accept", "content-type", "origin", "x-csrf-token", "idempotency-key", "last-event-id", "range",
    ]

    private func addCORSHeaders(to response: Response, request: Request) {
        guard !corsOrigins.isEmpty else { return }
        response.headers.add(name: .vary, value: "Origin")
        guard request.headers[.origin].count == 1,
            let raw = request.headers.first(name: .origin),
            let origin = Settings.canonicalOrigin(raw), corsOrigins.contains(origin)
        else { return }
        response.headers.replaceOrAdd(name: .accessControlAllowOrigin, value: raw)
        response.headers.replaceOrAdd(name: .accessControlAllowCredentials, value: "true")
        response.headers.replaceOrAdd(
            name: .accessControlExpose,
            value: "X-Request-ID, Retry-After, Content-Range, Content-Disposition, Accept-Ranges"
        )
        if request.method == .OPTIONS {
            response.headers.replaceOrAdd(name: .accessControlAllowMethods, value: corsMethods.joined(separator: ", "))
            response.headers.replaceOrAdd(name: .accessControlAllowHeaders, value: corsHeaders.joined(separator: ", "))
            response.headers.replaceOrAdd(name: .accessControlMaxAge, value: "600")
            response.headers.replaceOrAdd(name: .cacheControl, value: "no-store")
        }
    }

    func respond(to request: Request, chainingTo next: any AsyncResponder) async throws -> Response {
        let requestID = UUID().uuidString.lowercased()
        do {
            let response: Response
            if request.method == .OPTIONS, let method = request.headers.first(name: .accessControlRequestMethod) {
                let requestedHeaders =
                    request.headers.first(name: .accessControlRequestHeaders)?.split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? []
                guard request.headers[.origin].count == 1,
                    let origin = request.headers.first(name: .origin).flatMap(Settings.canonicalOrigin),
                    corsOrigins.contains(origin), corsMethods.contains(method),
                    Set(requestedHeaders).isSubset(of: Set(corsHeaders))
                else { throw APIError(403, "ORIGIN_FORBIDDEN", "CORS preflight is not allowed") }
                response = Response(status: .noContent)
            } else {
                response = try await next.respond(to: request)
            }
            addCORSHeaders(to: response, request: request)
            response.headers.replaceOrAdd(name: "X-Request-ID", value: requestID)
            return response
        } catch {
            let failure: APIError
            if let caughtError = error as? APIError {
                failure = caughtError
            } else if let caughtError = error as? AbortError {
                failure = APIError(
                    Int(caughtError.status.code),
                    "HTTP_\(caughtError.status.code)",
                    caughtError.status.code >= 500 ? "Service unavailable" : caughtError.status.reasonPhrase
                )
            } else {
                request.logger.error("Request failed [\(requestID)]: \(error)")
                failure = APIError(500, "INTERNAL_ERROR", "Service unavailable")
            }
            let response = try WireResponse(
                status: failure.status,
                json: .object([
                    "error": .object([
                        "code": .string(failure.code),
                        "message": .string(failure.message),
                        "requestId": .string(requestID),
                    ])
                ])
            ).response()
            addCORSHeaders(to: response, request: request)
            if let seconds = failure.retryAfter {
                response.headers.replaceOrAdd(name: .retryAfter, value: String(seconds))
            }
            response.headers.replaceOrAdd(name: "X-Request-ID", value: requestID)
            return response
        }
    }
}

// Passwords are exact UTF-8 bytes; reject NUL and bcrypt's truncation boundary.
func roomPassword(_ body: JSON) throws -> String? {
    if body["password"] == .null {
        return nil
    }
    let value = try body.requiredString("password", maxBytes: 72)
    guard !value.utf8.contains(0) else {
        throw APIError(400, "INVALID_INPUT", "Password must not contain NUL")
    }
    return value
}

func passwordMatches(_ value: String?, _ storedHash: String?) throws -> Bool {
    switch (value, storedHash) {
    case (nil, nil):
        return true
    case (.some(let value), .some(let storedHash)):
        return try Bcrypt.verify(value, created: storedHash)
    default:
        return false
    }
}
