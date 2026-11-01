// swift-tools-version: 6.4
import PackageDescription

let package = Package(
    name: "ICUProbe",
    products: [.executable(name: "icu-probe", targets: ["ICUProbe"])],
    targets: [.executableTarget(name: "ICUProbe")]
)
