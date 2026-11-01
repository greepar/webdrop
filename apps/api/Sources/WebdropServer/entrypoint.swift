import Vapor
import WebdropAPI

@main
struct WebdropServer {
    static func main() async throws {
        var environment = try Environment.detect()
        try LoggingSystem.bootstrap(from: &environment)
        if let path = try StartupConfiguration.prepareFirstLaunch(arguments: environment.commandInput.arguments) {
            print("已生成配置文件：\(path)")
            print("请先检查并修改 .env 中的监听地址、端口和房间数量，保存后重新执行启动命令。")
            print("本次未启动服务，也未创建数据目录；已有配置不会被覆盖。")
            return
        }
        let application = try await Application.make(environment)
        do {
            try configure(application)
            try await application.execute()
        } catch {
            try await application.asyncShutdown()
            throw error
        }
        try await application.asyncShutdown()
    }
}
