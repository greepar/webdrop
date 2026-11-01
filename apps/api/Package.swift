// swift-tools-version: 6.4
import PackageDescription

let package = Package(
    name: "webdrop-api",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "webdrop", targets: ["WebdropServer"]),
        .library(name: "WebdropAPI", targets: ["WebdropAPI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/vapor/vapor.git", from: "4.122.3"),
        .package(url: "https://github.com/apple/swift-crypto.git", from: "5.0.3"),
    ],
    targets: [
        .executableTarget(name: "WebdropServer", dependencies: ["WebdropAPI"]),
        .target(
            name: "WebdropAPI",
            dependencies: [
                .product(name: "Vapor", package: "vapor"), .product(name: "Crypto", package: "swift-crypto"),
            ]
        ),
        .testTarget(
            name: "WebdropAPITests",
            dependencies: [
                "WebdropAPI",
                .product(name: "VaporTesting", package: "vapor"),
            ]
        ),
    ]
)
