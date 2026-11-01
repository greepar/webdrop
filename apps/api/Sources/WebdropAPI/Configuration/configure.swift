import Vapor

/// Configures the HTTP server, persistent store, middleware, and maintenance task.
public func configure(_ application: Application) throws {
    try configure(application, settings: Settings.environment(application))
}

func configure(_ application: Application, settings: Settings) throws {
    let host = Environment.get("API_HOST") ?? "127.0.0.1"
    let rawPort = Environment.get("API_PORT") ?? "8080"
    guard let port = Int(rawPort), (1...65535).contains(port) else {
        throw Abort(.internalServerError, reason: "API_PORT must be between 1 and 65535")
    }
    application.http.server.configuration.hostname = host
    application.http.server.configuration.port = port
    application.http.server.configuration.idleTimeout = .seconds(60)
    // File routes stream bodies and enforce their own declared byte limits.
    application.routes.defaultMaxBodySize = "64kb"
    application.middleware = .init()
    application.middleware.use(APIErrorMiddleware(corsOrigins: settings.corsOrigins))
    application.middleware.use(EmbeddedWebMiddleware())
    try routes(application)
    let store = try Store(settings: settings)
    try application.register(collection: BusinessRoutes(store: store, settings: settings))
    application.lifecycle.use(Maintenance(store: store))
}
