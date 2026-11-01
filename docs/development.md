# 开发约定

前端React/TypeScript/Vite，后端Swift6.4/Vapor。运行和打包入口见根README；当前业务行为以packages/contracts中的正式OpenAPI与协议为准。

## 协作与代码边界

- 前端依赖方向为app/pages/layouts → features → shared；页面不散落fetch，API响应作为unknown在边界验证。
- 前后端分别维护apps/web/GOAL.md和apps/api/GOAL.md的有效要求及验收记录；跨端行为变更先明确契约并同步两端，mock不能成为另一套标准。
- 后端共享状态由actor/事务保护；请求授权、状态变更、人数/配额检查和幂等必须原子执行。只向客户端返回契约允许的数据。
- 错误统一为error.code/message/requestId；Range416、HEAD、SSE已开始后的撤权按协议处理。
- 角色来自服务端会话；房间号、密码、浏览器缓存和旧成功响应不能代替当前权限。导航不自动离房/关房，不自动转让owner。

## 工具链与构建

- 提交package-lock.json和apps/api/Package.resolved；构建使用锁定版本。
- 不提交node_modules、.build、dist、运行.data、.env或自动生成的嵌入资源Swift文件。
- 发布使用pwsh scripts/build-api.ps1，默认构建并嵌入前端；纯API构建用-ApiOnly。生成资源只在WEBDROP_EMBED_WEB编译条件下启用。
- 浏览器可见VITE_*变量不存放秘密；前后端按同源部署，生产配置确切HTTPS origin。
- Linux发布默认使用ICU语言子集；`-FullICU`保留完整SDK数据。保留语言、已知回退及工具依赖见后端说明，升级SDK时重新验证子集。macOS继续使用系统库。

## Swift代码风格

手写Swift统一4空格缩进、120列目标宽度；每行一条语句/一个属性，方法和类型之间留空行，import排序。局部变量和工具函数使用有含义的lowerCamelCase名称；边界输入用guard/可选绑定，长路由按职责拆分。Codable属性名属于持久化格式，整理代码时不得随意改名。

不为标准库调用、枚举构造或单纯类型转换增加转发函数；共享协议编码、输入校验和实际计算逻辑按职责封装。

根目录`.swift-format`定义格式规则。安装官方`swift-format`604.x（与Swift6.4匹配；Homebrew可用`brew install swift-format`），执行：

```powershell
npm run format:swift
npm run check:swift
```

两条命令均调用`pwsh scripts/format-swift.ps1`；不依赖Node时可直接执行，检查加`-Check`。范围包括后端、测试、Package.swift和ICU探针；排除依赖、构建缓存及自动生成的前端资源。`npm test`包含Swift严格格式检查；更新formatter版本时统一更新脚本版本约束及配置。

## 前端交互

统一语义主题变量和动效参数，支持亮暗主题及prefers-reduced-motion。数字房间号按字符串处理，保留前导零；PoW在Worker执行并支持取消、超时和旧请求失效。输入区保留换行与输入法组合输入；新消息只在接近底部时自动跟随。剪贴板、媒体与下载按浏览器权限和能力处理。

手机实机验收覆盖软键盘、安全区、滚动恢复、后台恢复和媒体播放；无头Chrome通过不能代替Safari/iOS验收。

## 验证

运行适用的类型检查、lint、前端构建和后端测试。权限/生命周期边界使用可控时钟；并发、重放、重复请求及撤权补充有意义的测试。真实HTTP与浏览器测试使用独立DATA_DIR及测试服务，不消耗人工预览会话额度。未验证的平台、负载和故障注入需如实记录。
