import Foundation
import Testing

@testable import WebdropAPI

private func configurationDirectory() throws -> URL {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("webdrop-first-run-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
    return path
}

@Test
func firstLaunchCreatesPrivateConfigAndPreservesEdits() throws {
    let directory = try configurationDirectory()
    defer {
        try? FileManager.default.removeItem(at: directory)
    }
    let created = try StartupConfiguration.createEnvironmentIfMissing(in: directory.path)
    #expect(created == directory.appendingPathComponent(".env").path)
    let data = try String(contentsOfFile: created!, encoding: .utf8)
    #expect(data.contains("MAX_ROOMS=500"))
    #expect(data.contains("MEMORY_FILE_BYTES=1048576"))
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent(".data").path))
    let mode = try FileManager.default.attributesOfItem(atPath: created!)[.posixPermissions] as? NSNumber
    #expect(mode?.intValue == 0o600)
    let custom = "# user configuration\nMAX_ROOMS=123\n"
    try Data(custom.utf8).write(to: URL(fileURLWithPath: created!))
    #expect(try StartupConfiguration.createEnvironmentIfMissing(in: directory.path) == nil)
    #expect(try String(contentsOfFile: created!, encoding: .utf8) == custom)
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path) == [".env"])
}

@Test
func simultaneousFirstLaunchesPublishOneCompleteTemplate() async throws {
    let directory = try configurationDirectory()
    defer {
        try? FileManager.default.removeItem(at: directory)
    }
    let results = try await withThrowingTaskGroup(of: String?.self, returning: [String].self) { group in
        for _ in 0..<8 {
            group.addTask { try StartupConfiguration.createEnvironmentIfMissing(in: directory.path) }
        }
        var created: [String] = []
        for try await result in group {
            if let result {
                created.append(result)
            }
        }
        return created
    }
    #expect(results.count == 1)
    let template = try String(contentsOf: directory.appendingPathComponent(".env"), encoding: .utf8)
    #expect(template == StartupConfiguration.template(embeddedWeb: false))
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path) == [".env"])
}

@Test
func firstLaunchRejectsDirectoryAndKeepsHelpSideEffectFree() throws {
    let directory = try configurationDirectory()
    defer {
        try? FileManager.default.removeItem(at: directory)
    }
    try FileManager.default.createDirectory(
        at: directory.appendingPathComponent(".env"),
        withIntermediateDirectories: false
    )
    #expect(throws: (any Error).self) { try StartupConfiguration.createEnvironmentIfMissing(in: directory.path) }
    for arguments in [["--help"], ["serve", "-h"], ["--version"]] {
        #expect(!StartupConfiguration.needsEnvironmentFile(arguments: arguments))
    }
    #expect(StartupConfiguration.needsEnvironmentFile(arguments: []))
    #expect(StartupConfiguration.needsEnvironmentFile(arguments: ["serve", "--port", "8080"]))
}

@Test
func configTemplateCoversDocumentedKeysAndFrontendMode() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 {
        root.deleteLastPathComponent()
    }
    let example = try String(contentsOf: root.appendingPathComponent("apps/api/.env.example"), encoding: .utf8)
    func keys(_ text: String) -> Set<String> {
        Set(
            text.split(separator: "\n").filter { !$0.hasPrefix("#") && $0.contains("=") }.map {
                String($0.split(separator: "=", maxSplits: 1)[0])
            }
        )
    }
    for embedded in [false, true] {
        let template = StartupConfiguration.template(embeddedWeb: embedded)
        #expect(keys(template) == keys(example))
        #expect(!keys(template).contains("PUBLIC_ORIGIN"))
        #expect(!keys(template).contains("WEB_ORIGINS"))
    }
}
