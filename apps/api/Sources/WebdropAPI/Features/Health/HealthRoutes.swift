import Vapor

struct HealthResponse: Content {
    let status: String
    let service: String
    let apiVersion: String

    init() {
        status = "ok"
        service = "webdrop-api"
        apiVersion = "v1"
    }
}

struct HealthRoutes: RouteCollection {
    func boot(routes: any RoutesBuilder) throws {
        routes.get("health") { _ in HealthResponse() }
    }
}
