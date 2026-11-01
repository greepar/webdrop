# 浏览器真实接口检查

要求 Node 24、本机 Chrome 和独立测试 API（不要使用生产服务）。不下载浏览器，不使用 mock。

1. 按 API README 用独立 DATA_DIR 启动服务，设置 PUBLIC_ORIGIN、WEB_ORIGINS 为测试前端地址。
2. 设置 VITE_API_MODE=live、API_PROXY_TARGET 启动前端。
3. 执行：

```sh
WEBDROP_TEST_URL=http://127.0.0.1:5188 node apps/web/tests/live-smoke.mjs
WEBDROP_TEST_URL=http://127.0.0.1:5188 node apps/web/tests/upload-fault.mjs
```

可用 CHROME_PATH 指定 Chrome 可执行文件。每个浏览器使用临时独立配置目录，并在检查结束后清理。脚本会创建测试房间和上传文件；仅针对可丢弃的测试数据运行。连续运行可能触发真实服务限流，错误输出保留页面反馈，不能将限流误判为业务功能失败。

live-smoke 检查独立会话加入、SSE 文字/文件、下载字节、暗色手机布局、分享撤销及踢人。upload-fault 在 Chrome 网络层丢弃完成响应、暂停 PUT，验证重试和取消后重传。它们不代替 iOS 实机、全视觉矩阵与性能录制。

历史分页检查：`WEBDROP_TEST_URL=http://127.0.0.1:5188 node apps/web/tests/history-smoke.mjs`。它会写入 40 条真实消息，检查 30→40 条分页后同一消息位置偏差小于 3px，且不出现虚假的新消息计数。

短暂离线重连：`WEBDROP_TEST_URL=http://127.0.0.1:5188 node apps/web/tests/reconnect-smoke.mjs`。两个独立浏览器会话加入后，接收端离线、发送端发送消息，再恢复接收端网络，检查漏收消息恢复且不重复。不覆盖游标过期的全量同步。

减少动态效果：`WEBDROP_TEST_URL=http://127.0.0.1:5188 node apps/web/tests/reduced-motion.mjs`，模拟 reduce 并检查实际计算样式。会话故障恢复：同样方式执行 `session-recovery.mjs`；该检查要求测试环境仍允许建立新会话，遇到 429 会按实际状态失败并输出 HTTP 诊断。

客户端事件边界：`WEBDROP_TEST_URL=http://127.0.0.1:5188 node apps/web/tests/event-validation.mjs`。要求 Vite 开发服务器（动态导入源模块）；使用明确的 EventSource 替身检查重复与非法事件，属于客户端检查，不是真实 SSE 联调。

完整顺序运行：`WEBDROP_TEST_URL=http://127.0.0.1:5190 node apps/web/tests/run-live.mjs`。建议专用前端 5190 代理专用 API 18190，后端使用独立临时 DATA_DIR，PUBLIC_ORIGIN 与 WEB_ORIGINS 对应 5190。不要反复使用人工预览服务运行整套测试；真实限流依然有效，完整套件不保证可立即重复。

媒体检查：`WEBDROP_TEST_URL=http://127.0.0.1:5190 node apps/web/tests/media-smoke.mjs`，上传生成 PNG 与仓库自制 MP4，验证实际图片尺寸、视频尺寸与播放时间推进；随后通过 CDP 注入资源 410，验证错误提示及下载入口。Chrome 播放通过不代表 iOS Safari 通过。

性能录制：`WEBDROP_TEST_URL=http://127.0.0.1:5190 node apps/web/tests/motion-profile.mjs`。输出 CDP trace 与摘要到 /tmp（可用 WEBDROP_TRACE_PATH 指定）。使用 4 倍 CPU 降速，覆盖 PoW、弹窗连续开关与发消息；不设虚假通用性能通过阈值，结果需按场景分析。审查结果见 MOTION-REVIEW.md。

弹窗键盘检查：`node apps/web/tests/dialog-keyboard.mjs`（默认 5190，可覆盖 WEBDROP_TEST_URL）。通过开发模块挂载真实 Dialog 的双层测试组合，不创建后端数据；使用 CDP 键盘事件验证 Escape 顶层关闭、焦点返回和多层滚动锁计数。

文字响应丢失：`WEBDROP_TEST_URL=http://127.0.0.1:5191 node apps/web/tests/text-fault.mjs`，在真实 POST 响应阶段断开，重试后同时检查服务端列表与 UI 只有一条。PoW 官方向量：`node apps/web/tests/pow-vectors.mjs`（Node 24，直接加载可擦除类型的协议模块），不依赖浏览器或服务。

房间响应式矩阵：`node apps/web/tests/layout-matrix.mjs` 默认使用 5173 开发 mock（明确标识），同页检查 320/390/844/768/1440 五种视口及亮暗主题，长文件名、页面/内容滚动宽度和关键顶栏控件可见范围。截图默认 /tmp/webdrop-layout，可用 WEBDROP_SCREENSHOTS 修改；这不是真实 API 功能验收。

输入行为：`node apps/web/tests/composer-input.mjs`（默认开发前端 5191），挂载真实 Composer 并控制发送 Promise；检查缩进/换行不变、合成输入和 Shift+Enter 不触发发送、同步重复提交被拦截、发送中新增草稿及发送失败草稿保留。属于客户端交互检查，不替代真实 iOS 中文键盘。

PoW 生命周期：`node apps/web/tests/pow-lifecycle.mjs`，挂载真实 usePow，明确替换挑战响应与 Worker，验证取消兑现 Promise、终止 Worker，以及跳过冷却截止时间后 focus 恢复为 idle。此项不验证真实后端冷却策略或 Worker 算力。

房间管理：`node apps/web/tests/management-smoke.mjs`，真实双会话检查锁定/开放、号码同步、关闭后失去访问。分享分页：`node apps/web/tests/link-pagination.mjs`，真实创建 31 条链接，确认两种分页游标均读取且面板显示 31 条。两者默认独立测试服务 5191，支持 WEBDROP_TEST_URL。

可视区域响应：`node apps/web/tests/viewport-frame.mjs`，为真实 hook 注入可控 VisualViewport，检查高度缩小、顶部偏移、缩放退出自动贴合与卸载清理。不模拟真实软键盘，也不证明 iOS 安全区正确。

旧游标全量恢复：`WEBDROP_TEST_URL=http://127.0.0.1:5193 node apps/web/tests/resync-smoke.mjs`，两会话中接收端离线，发送端写入 270 条真实消息超过服务端事件保留窗口，再恢复网络，确认重新获取房间快照、最新 30 条中最后一条只出现一次。会产生较多测试数据和请求，仅针对隔离 API 运行。

全量同步阅读位置：`WEBDROP_TEST_URL=http://127.0.0.1:5194 node apps/web/tests/resync-history.mjs`。创建 40 条真实消息并停留历史位置；明确关闭测试 EventSource，另写 40 条，再注入 resync.required。检查真实快照分页恢复 80 条、同一可见消息位置偏差小于 3px。控制事件是客户端注入，不声称验证物理断网或服务端主动发出重同步事件。

失效分页游标：`node apps/web/tests/cursor-invalid.mjs`，真实写入 40 条，读取服务端 nextCursor 后删除对应消息，确认分页 400 触发重新快照、继续加载到 39 条存活消息，无重复或已删除内容；同时检查实时与分页后的原始消息顺序。

迟到历史删除竞态：`node apps/web/tests/history-delete-race.mjs`，真实写入 40 条，CDP 暂停旧页响应，删除其中尚未展示的一条并等待 SSE，再放行历史页；确认 39 条有序唯一消息且不带回删除项。

上传超时恢复：`node apps/web/tests/upload-timeout.mjs`。使用真实 XHR 和 API，暂停 PUT，将原生 timeout setter 的计时在测试中加速为 400ms；断言产品配置的仍是 120000ms，随后恢复 setter、重试、校验下载字节。验证原生 timeout 失败/恢复路径，不声称实际等待完整 120 秒。

全页面矩阵：`node apps/web/tests/page-matrix.mjs`（建议经 `isolated.py` 运行）。首页、分享页、404 与房间页 × 五种视口 × 亮暗，检查无横向溢出、首页品牌与输入尺寸、分享下载入口、404 标题，并断言房间未误报断线；截图默认 /tmp/webdrop-pages。分享页需要真实 API 数据。

新消息入场：`WEBDROP_TEST_URL=... node apps/web/tests/message-motion.mjs`。真实 SSE 下确认快照与历史消息无动画、仅新到达的末尾消息为 120ms opacity 淡入。

字节格式：`node apps/web/tests/format-bytes.mjs`，校验十进制单位与 100,000,000 字节显示为 100 MB。

删除阅读锚点：`node apps/web/tests/deleted-reading-anchor.mjs`，挂载真实 MessageList 的 40 条消息组合，滚动到历史中删除第一条可见锚点，确认下一条存活消息位置偏差小于 3px。属于列表布局检查，不冒充真实服务删除测试。

## 自动隔离运行（推荐）

```sh
python3 apps/web/tests/isolated.py upload-fault.mjs upload-timeout.mjs session-recovery.mjs
```

先确保现有 API 二进制已构建。运行器为每个脚本选择随机端口、临时 DATA_DIR，启动真实 API 和 live Vite，检查退出或超时后清理进程组与临时数据。可用 WEBDROP_API_BINARY 指定已构建 API。不会更改后端限流策略，也不会重启人工预览服务；每个脚本仍需要遵守独立服务的限额。失败会输出对应临时服务日志尾部。

跨快照分页竞态：`python3 apps/web/tests/isolated.py history-generation-race.mjs`。暂停历史响应，注入 resync.required 并等待新快照后放行旧响应，确认仍保留新快照 30 条及其 nextCursor；再次加载获得 40 条有序唯一消息。控制事件注入和真实 API 数据分别明确，不冒充物理断网。

真实剪贴板：`python3 apps/web/tests/isolated.py clipboard-live.mjs`，CDP 对独立 Chrome 会话授予剪贴板权限，原生写入→点击粘贴→真实发送→点击复制→原生读回，精确比较缩进和换行。另明确注入双重复制失败，验证返回 false、隐藏节点清理、焦点/选区恢复。不覆盖真实权限提示或 iOS。

入口冲突：`python3 apps/web/tests/isolated.py entry-conflict.mjs`，真实输入 0042、指定创建、第二会话冲突拒绝无成员关系、独立加入后获得普通成员权限。management-smoke 现包含第三会话锁定拒绝、开放加入、成员主动离开与跨端人数更新。

普通成员分享：`python3 apps/web/tests/isolated.py member-share.mjs`，普通成员上传自己的文件、创建链接、真实剪贴板复制分享页与直链、撤销；第三个独立浏览器确认没有 Cookie 仍可读公开字节，撤销后显示失效。live-smoke 的公开访问现也使用第三个独立浏览器并检查 Cookie 为空。

分享生命周期：`python3 apps/web/tests/isolated.py share-lifecycle.mjs`。普通成员创建两个文件分享，匿名页面对注入的 503 点击重试后读取真实元数据；删除原文件、关闭房间分别使对应分享页失效，原始链接返回真实 410。

自然到期：`python3 apps/web/tests/isolated.py share-expiry.mjs`。真实创建约 62 秒有效期（UTC ISO 秒精度），不修改浏览器或服务端时钟；等待到期后检查已打开匿名分享页自动复核为失效、移除下载按钮，直链返回 410。整个检查通常需要约 70 秒。

文件入口：`python3 apps/web/tests/isolated.py file-entry-paths.mjs`。通过合成 DragEvent/ClipboardEvent 驱动真实 UI 处理器，实际上传拖入与粘贴文件并检查服务端消息；检查空文件、合成超限 size 元数据在入口被过滤；暂停 PUT 后取消并移除队列。OS 拖放/系统剪贴板对话框及真实超大字节流不在此检查范围。

触控尺寸：`python3 apps/web/tests/isolated.py touch-targets.mjs`，启用真实 Chrome touch emulation，断言 coarse pointer 下首页/320px 房间控件 ≥44px 且未被裁切。文字主题对比：同方式执行 theme-contrast.mjs，检查两主题主要语义文字/底色 token 的 4.5:1 下限；不代替全部组件、状态、图片与透明叠层的对比审查。

主题状态：`python3 apps/web/tests/isolated.py theme-state.mjs`。模拟系统深浅色，验证手动覆盖、刷新持久化、同源标签页 storage 同步、后台返回后系统偏好更新、错误/分享路由主题及禁用 localStorage 时 DOMContentLoaded 的暗色属性。不以 DOM 属性检查代替首帧闪烁录像。

PoW 服务端拒绝：`python3 apps/web/tests/isolated.py pow-rejection.mjs`，真实 Worker 求解后在请求层修改 nonce，验证真实服务器拒绝、不产生成员关系，新挑战重试才进入。pow-lifecycle 同时覆盖明确替身条件下的过期挑战和卸载清理，不等于真实 120 秒挑战到期验收。
