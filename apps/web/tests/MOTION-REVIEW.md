# 动效审查

## 清单（当前实现）

| 元素 | 驱动 | 属性 | 时长/曲线 |
| --- | --- | --- | --- |
| 首页品牌区、表单 | CSS `wd-enter` | `translateY` + `opacity` | 260ms，`--ease-out` |
| 弹层遮罩 | CSS `wd-fade` | `opacity` | 180ms 入 / 100ms 出 |
| 弹层面板 | CSS `wd-pop` + WAAPI 退场 | `translateY` + `scale` + `opacity` | 220ms 入 / 100ms 出，与入场对称 |
| 新消息（仅末尾到达） | CSS `wd-fade` | `opacity` | 120ms |
| 历史消息、快照 | 无动画 | — | — |
| “有新内容”提示 | CSS `wd-pop` | `translateY` + `scale` + `opacity` | 220ms |
| 状态文字 | CSS `wd-fade` | `opacity` | 180ms |
| 按钮/图标按钮 | CSS transition | `background-color`、`border-color`、`color`、`opacity`、`transform` | 150ms |
| 输入框 | CSS transition | `border-color`、`box-shadow` | 150ms |
| 上传进度 | CSS transform | `scaleX` | 200ms |
| 消息滚动跟随 | `scrollTo` | 滚动位置 | 减少动态效果时改为 `auto` |
| 加载标记 | CSS `wd-spin` | `rotate` | 900ms 循环；减少动态效果时停止 |

## 本轮修正（按 `animate` 硬规则）

| Before | After | 原因 |
| --- | --- | --- |
| `--ease-out: cubic-bezier(0.2, 0.8, 0.2, 1)` | `cubic-bezier(0.23, 1, 0.32, 1)` | 使用规定的强 ease-out，入场更快到达静止 |
| `--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1)` | `cubic-bezier(0.77, 0, 0.175, 1)` | 同上，用于屏内位移 |
| 弹层退场只有遮罩淡出，面板瞬移消失 | 遮罩淡出 + 面板 `translateY(8px) scale(0.985)`，100ms | 退场与入场对称，避免面板突然消失 |
| 锁定 body 滚动可能因滚动条消失横向跳动 | `html { scrollbar-gutter: stable }` | 桌面弹层打开时页面宽度不变 |
| 输入光标沿用浏览器默认 | `caret-color: var(--c-accent)` | 浏览器原生表面也使用主题色 |

## 实际录制（本轮）

`apps/web/tests/motion-record.mjs`，隔离真实 API + live 前端，Chrome headless，390×844 手机视口（D 项为 1440×900），逐帧记录 rAF 间隔并用 `PerformanceObserver('longtask')` 观测长任务：

| 场景 | 帧数 | >25ms | >50ms | 最大间隔 | Long Task | 弹层位移 | 背景滚动 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A 弹层开/关 | 47 | 0 | 0 | 16.7ms | 无 | 10px（入场/退场位移本身） | 0 |
| B 2 MB 上传 + 8 条消息 + 弹层开/关 | 152 | 0 | 0 | 16.8ms | 无 | 10px | 0 |
| C PoW 求解 + 进入房间 | 25 | 0 | 0 | 16.8ms | 无 | — | — |
| D 桌面弹层锁滚动 | — | — | — | — | — | — | 页面宽度稳定 1440，`scrollX=0` |

检查断言：无 >50ms 帧、>25ms 帧不超过 1、无 Long Task、弹层位移不超过 12px（即只包含 8px 入场/退场位移）、弹层打开期间背景不滚动、桌面锁滚动时页面宽度不变。全部通过。

## 边界

- 录制在无头 Chrome、本机、默认 60Hz 下完成，未覆盖 120Hz、移动 GPU、Safari。
- `longtask` 阈值为浏览器默认 50ms；25ms 帧间隔只说明未明显掉帧，不等于全程 60fps。
- B 项上传为本地 2 MB，未覆盖弱网与 100 MB 上限。
- 视觉观感（曲线是否“好”）仍需人眼在设备上看；本轮只证明没有跳变、掉帧与长任务。

结论：此前的 Block 原因（未录制、弹层跳变未验证）已用实际帧数据补上；目标设备性能与 iOS 仍属未验证范围。
