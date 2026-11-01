import Foundation
import Testing
import VaporTesting

@testable import WebdropAPI

@Suite("API foundation")
struct HealthTests {
    @Test("Versioned health endpoint matches the frontend contract")
    func versionedHealth() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("health-" + UUID().uuidString)
            .path
        defer {
            try? FileManager.default.removeItem(atPath: directory)
        }
        let settings = Settings(
            directory: directory,

            secureCookies: false
        )
        try await withApp(configure: { try configure($0, settings: settings) }) { application in
            try await application.testing().test(.GET, "/api/v1/health") { response async throws in
                #expect(response.status == .ok)
                let health = try response.content.decode(HealthResponse.self)
                #expect(health.status == "ok")
                #expect(health.service == "webdrop-api")
                #expect(health.apiVersion == "v1")
            }
        }
    }

    @Test("Deployment probe is available without an API version")
    func healthProbe() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("health-" + UUID().uuidString)
            .path
        defer {
            try? FileManager.default.removeItem(atPath: directory)
        }
        let settings = Settings(
            directory: directory,

            secureCookies: false
        )
        try await withApp(configure: { try configure($0, settings: settings) }) { application in
            try await application.testing().test(.GET, "/health") { response async in
                #expect(response.status == .ok)
            }
        }
    }

    @Test("Unknown routes return a structured 404")
    func unknownRoute() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("health-" + UUID().uuidString)
            .path
        defer {
            try? FileManager.default.removeItem(atPath: directory)
        }
        let settings = Settings(
            directory: directory,

            secureCookies: false
        )
        try await withApp(configure: { try configure($0, settings: settings) }) { application in
            try await application.testing().test(.GET, "/api/v1/transfers") { response async in
                #expect(response.status == .notFound)
            }
        }
    }
}
