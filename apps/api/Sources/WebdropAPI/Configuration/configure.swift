import Vapor

public func configure(_ app: Application) throws {
    try configure(app, settings: Settings.environment(app))
}

func configure(_ app: Application, settings: Settings) throws {
    let host = Environment.get("API_HOST") ?? "127.0.0.1"
    let rawPort = Environment.get("API_PORT") ?? "8080"
    guard let port = Int(rawPort), (1...65535).contains(port) else {
        throw Abort(.internalServerError, reason: "API_PORT must be between 1 and 65535")
    }
    app.http.server.configuration.hostname = host
    app.http.server.configuration.port = port
    app.http.server.configuration.idleTimeout = .seconds(60)
    // File routes stream bodies and enforce their own declared byte limits.
    app.routes.defaultMaxBodySize = "64kb"
    app.middleware = .init()
    app.middleware.use(APIErrorMiddleware())
    try routes(app)
    let store = try Store(settings: settings)
    try app.register(collection: BusinessRoutes(store: store, settings: settings))
    app.lifecycle.use(Maintenance(store: store))
}
