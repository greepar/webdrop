import Foundation
import Vapor

struct WebAsset: Sendable {
    let bytes: Data
    let contentType: String
    let immutable: Bool
}

#if !WEBDROP_EMBED_WEB
enum EmbeddedWebBundle {
    static let files: [String: WebAsset] = [:]
}
#endif

/// Serves only compiled-in public assets. API/download/probe paths always reach
/// their original handlers, including structured errors instead of SPA HTML.
struct EmbeddedWebMiddleware: AsyncMiddleware {
    let files: [String: WebAsset]

    init(files: [String: WebAsset] = EmbeddedWebBundle.files) {
        self.files = files
    }

    func respond(to request: Request, chainingTo next: any AsyncResponder) async throws -> Response {
        guard request.method == .GET || request.method == .HEAD,
            let index = files["/index.html"]
        else {
            return try await next.respond(to: request)
        }
        guard let path = request.url.path.removingPercentEncoding,
            !path.split(separator: "/").contains("..")
        else {
            return try await next.respond(to: request)
        }
        for prefix in ["/api", "/d", "/health"] where path == prefix || path.hasPrefix(prefix + "/") {
            return try await next.respond(to: request)
        }
        let asset: WebAsset
        if let exact = files[path] {
            asset = exact
        } else if path == "/" || (path as NSString).pathExtension.isEmpty {
            asset = index
        } else {
            return try await next.respond(to: request)
        }
        let response = Response(status: .ok)
        response.headers.replaceOrAdd(name: .contentType, value: asset.contentType)
        response.headers.replaceOrAdd(name: .contentLength, value: String(asset.bytes.count))
        response.headers.replaceOrAdd(
            name: .cacheControl,
            value: asset.immutable ? "public, max-age=31536000, immutable" : "no-cache"
        )
        response.headers.replaceOrAdd(name: "X-Content-Type-Options", value: "nosniff")
        if request.method != .HEAD {
            response.body = .init(data: asset.bytes)
        }
        return response
    }
}
