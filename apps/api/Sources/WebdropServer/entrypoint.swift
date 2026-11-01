import Vapor
import WebdropAPI

@main
struct WebdropServer {
    static func main() async throws {
        var environment = try Environment.detect()
        try LoggingSystem.bootstrap(from: &environment)
        let app = try await Application.make(environment)
        do {
            try configure(app)
            try await app.execute()
        } catch {
            try await app.asyncShutdown()
            throw error
        }
        try await app.asyncShutdown()
    }
}
