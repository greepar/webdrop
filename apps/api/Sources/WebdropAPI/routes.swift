import Vapor

func routes(_ application: Application) throws {
    application.get { _ in
        [
            "service": "webdrop-api",
            "health": "/health",
            "api": "/api/v1",
        ]
    }
    // Keep an unversioned probe for deployment health checks.
    application.get("health") { _ in HealthResponse() }
    let v1 = application.grouped("api", "v1")
    try v1.register(collection: HealthRoutes())
    // BusinessRoutes is registered by configure with its isolated persistent store.
}
