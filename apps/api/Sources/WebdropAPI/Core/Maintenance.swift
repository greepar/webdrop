import Vapor

// Vapor owns the task handle through its ordered boot/shutdown lifecycle callbacks.
final class Maintenance: LifecycleHandler, @unchecked Sendable {
    let store: Store
    private var task: Task<Void, Never>?

    init(store: Store) {
        self.store = store
    }

    func didBoot(_ application: Application) throws {
        let store = store
        let logger = application.logger
        task = Task {
            while !Task.isCancelled {
                do {
                    try await store.maintain()
                } catch {
                    logger.error("Storage maintenance failed: \(error)")
                }
                do {
                    try await Task.sleep(for: .seconds(15))
                } catch {
                    break
                }
            }
        }
    }

    func shutdown(_ application: Application) {
        task?.cancel()
        Task { await store.stopStreaming() }
    }

    func shutdownAsync(_ application: Application) async {
        await store.stopStreaming()
        task?.cancel()
        await task?.value
    }
}
