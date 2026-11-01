import Foundation
import Testing
import VaporTesting

@testable import WebdropAPI

@Test
func sameOriginUsesRequestHostPortAndRejectsCrossSite() async throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    try await withApp(configure: { _ in }) { application in
        let routes = BusinessRoutes(store: fixture.store, settings: fixture.settings)
        for (host, origin) in [
            ("drop.example.com:3666", "http://drop.example.com:3666"),
            ("LOCALHOST:80", "http://localhost"),
            ("[::1]:3666", "http://[::1]:3666"),
        ] {
            let request = Request(
                application: application,
                headers: ["Host": host, "Origin": origin],
                on: application.eventLoopGroup.next()
            )
            try routes.validateOrigin(request)
            #expect(try routes.requestOrigin(request) == origin)
        }
        for origin in ["http://evil.example", "http://localhost:8080", "null", "http://localhost:3666/path"] {
            let request = Request(
                application: application,
                headers: ["Host": "localhost:3666", "Origin": origin],
                on: application.eventLoopGroup.next()
            )
            await expectError("ORIGIN_FORBIDDEN") { try routes.validateOrigin(request) }
        }
        let crossSite = Request(
            application: application,
            headers: ["Host": "localhost:3666", "Origin": "http://localhost:3666", "Sec-Fetch-Site": "cross-site"],
            on: application.eventLoopGroup.next()
        )
        await expectError("ORIGIN_FORBIDDEN") { try routes.validateOrigin(crossSite) }
    }
}

@Test
func proxyHTTPSUsesPreservedHostAndIgnoresForwardedHost() async throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    try await withApp(configure: { _ in }) { application in
        let routes = BusinessRoutes(store: fixture.store, settings: fixture.settings)
        let request = Request(
            application: application,
            headers: [
                "Host": "drop.qwq.lu", "Origin": "https://drop.qwq.lu", "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "evil.example", "X-Forwarded-For": "192.0.2.2",
            ],
            remoteAddress: try .init(ipAddress: "172.17.0.2", port: 10000),
            on: application.eventLoopGroup.next()
        )
        try routes.validateOrigin(request)
        #expect(try routes.requestOrigin(request) == "https://drop.qwq.lu")
        for host in ["drop.qwq.lu/path", "evil@example.com", "localhost:99999", "localhost,evil.example"] {
            let invalid = Request(
                application: application,
                headers: ["Host": host],
                on: application.eventLoopGroup.next()
            )
            await expectError("INVALID_INPUT") { _ = try routes.requestOrigin(invalid) }
        }
    }
}

@Test
func cachedShareURLsUseCurrentRequestOrigin() throws {
    let cached = WireResponse(
        json: .object([
            "data": .array([
                .object([
                    "shareUrl": .string("https://old.example/s/mint-lake-234567"),
                    "contentUrl": .string("/d/mint-lake-234567"), "text": .string("https://old.example/s/keep-text"),
                ])
            ])
        ])
    )
    for origin in ["http://localhost:3666", "https://drop.qwq.lu"] {
        let response = try cached.response(origin: origin)
        let json = try JSONDecoder().decode(JSON.self, from: Data(response.body.buffer!.readableBytesView))
        guard case .array(let items) = json["data"] else {
            Issue.record("Missing list")
            return
        }
        #expect(items[0]["shareUrl"] == .string(origin + "/s/mint-lake-234567"))
        #expect(items[0]["contentUrl"] == .string(origin + "/d/mint-lake-234567"))
        #expect(items[0]["text"] == .string("https://old.example/s/keep-text"))
    }
}

@Test
func configuredCORSPreflightCredentialsAndErrorHeaders() async throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    var settings = fixture.settings
    settings.directory += "-cors"
    defer { try? FileManager.default.removeItem(atPath: settings.directory) }
    settings.secureCookies = true
    try settings.configureCORS("https://web.example")
    for raw in ["*", "https://web.example/path", "null"] {
        #expect(throws: APIError.self) { try settings.configureCORS(raw) }
    }
    try await withApp(configure: { try configure($0, settings: settings) }) { application in
        try await application.testing().test(
            .OPTIONS,
            "/api/v1/rooms",
            beforeRequest: { request in
                request.headers = [
                    "Host": "api.example", "Origin": "https://web.example", "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "Content-Type, X-CSRF-Token, Idempotency-Key",
                ]
            }
        ) { response async in
            #expect(response.status == .noContent)
            #expect(response.headers.first(name: .accessControlAllowOrigin) == "https://web.example")
            #expect(response.headers.first(name: .accessControlAllowCredentials) == "true")
            #expect(response.headers.first(name: .vary)?.contains("Origin") == true)
        }
        try await application.testing().test(
            .POST,
            "/api/v1/sessions",
            beforeRequest: { request in
                request.headers = [
                    "Host": "api.example", "Origin": "https://web.example", "Sec-Fetch-Site": "cross-site",
                    "Content-Type": "application/json",
                ]
                request.body = ByteBuffer(string: "{}")
            }
        ) { response async in
            #expect(response.status == .created)
            #expect(response.headers.first(name: .accessControlAllowOrigin) == "https://web.example")
            let cookie = response.headers.first(name: .setCookie) ?? ""
            #expect(cookie.contains("SameSite=None"))
            #expect(cookie.contains("Secure"))
        }
        try await application.testing().test(
            .POST,
            "/api/v1/rooms",
            beforeRequest: { request in
                request.headers = [
                    "Host": "api.example", "Origin": "https://web.example", "Content-Type": "application/json",
                ]
                request.body = ByteBuffer(string: "{}")
            }
        ) { response async in
            #expect(response.status == .unauthorized)
            #expect(response.headers.first(name: .accessControlAllowOrigin) == "https://web.example")
        }
        try await application.testing().test(
            .OPTIONS,
            "/api/v1/rooms",
            beforeRequest: { request in
                request.headers = [
                    "Host": "api.example", "Origin": "https://evil.example", "Access-Control-Request-Method": "POST",
                ]
            }
        ) { response async in
            #expect(response.status == .forbidden)
            #expect(response.headers.first(name: .accessControlAllowOrigin) == nil)
        }
    }
}
