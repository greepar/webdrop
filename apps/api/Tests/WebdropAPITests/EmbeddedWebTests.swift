import Foundation
import Testing
import VaporTesting

@testable import WebdropAPI

@Test
func embeddedWebServesSpaWithoutMaskingAPIErrors() async throws {
    let html = Data("<!doctype html><title>WebDrop test</title>".utf8)
    let javascript = Data("console.log('embedded')".utf8)
    let assets: [String: WebAsset] = [
        "/index.html": .init(bytes: html, contentType: "text/html; charset=utf-8", immutable: false),
        "/assets/app-12345678.js": .init(
            bytes: javascript,
            contentType: "text/javascript; charset=utf-8",
            immutable: true
        ),
        "/api/leak": .init(bytes: html, contentType: "text/html", immutable: false),
    ]
    try await withApp(configure: { application in
        application.middleware = .init()
        application.middleware.use(APIErrorMiddleware())
        application.middleware.use(EmbeddedWebMiddleware(files: assets))
        try routes(application)
    }) { application in
        for path in ["/", "/rooms/room-id", "/s/share-slug"] {
            try await application.testing().test(.GET, path) { response async in
                #expect(response.status == .ok)
                #expect(Data(response.body.readableBytesView) == html)
                #expect(response.headers.first(name: .cacheControl) == "no-cache")
            }
        }
        try await application.testing().test(.GET, "/assets/app-12345678.js") { response async in
            #expect(Data(response.body.readableBytesView) == javascript)
            #expect(response.headers.first(name: .contentType) == "text/javascript; charset=utf-8")
            #expect(response.headers.first(name: .cacheControl)?.contains("immutable") == true)
        }
        try await application.testing().test(.HEAD, "/rooms/room-id") { response async in
            #expect(response.status == .ok)
            #expect(response.body.readableBytes == 0)
            #expect(response.headers.first(name: .contentLength) == String(html.count))
        }
        for path in ["/api/leak", "/api/v1/missing", "/d/missing", "/assets/missing.js", "/assets/%2e%2e/index.html"] {
            try await application.testing().test(.GET, path) { response async in
                #expect(response.status == .notFound)
                #expect(response.headers.first(name: .contentType)?.contains("application/json") == true)
            }
        }
        try await application.testing().test(.GET, "/health") { response async in
            #expect(response.status == .ok)
            #expect(response.headers.first(name: .contentType)?.contains("application/json") == true)
        }
        try await application.testing().test(.POST, "/rooms/test") { response async in
            #expect(response.status != .ok)
        }
    }
}
