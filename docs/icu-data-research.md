# ICU 数据裁剪研究（2026-11-01）

本轮先将打包入口迁移到PowerShell，再对Swift 6.4.2 Static Linux SDK中的ICU 76数据进行独立实验。实验期间未修改已安装SDK或后端业务代码。后续按部署要求将此语言子集接入Linux默认打包；`-FullICU`恢复完整数据，macOS使用系统库。原实验结果如下。

## 实测结果

| 项目 | 完整数据 | 10语言实验子集 |
| --- | ---: | ---: |
| ICU数据 | 33,976,096字节 / 32.4021 MiB | 18,460,768字节 / 17.6056 MiB |
| strip后Linux x86-64后端 | 76,622,712字节 / 73.0731 MiB | 61,107,064字节 / 58.2762 MiB |
| 部署性质 | 完全静态 | 仍为完全静态，但locale行为改变 |

数据减少15,515,328字节，后端减少15,515,648字节，约20.25%。这是历史API-only、-Osize对照；当前默认产物使用-O且嵌入前端及语言子集，实际字节数见产物清单。早期实验候选保存在`dist/api/icu-research/candidate/`。

数据包共4,855项。实测按内容分类的主要原始条目字节为：

| 类别 | 字节 |
| --- | ---: |
| 编码转换表 | 5,668,800 |
| 排序coll | 4,276,704 |
| 主locale资源 | 4,068,352 |
| 分词规则/词典brkitr | 3,843,008 |
| 本地化时区zone | 3,293,376 |
| 单位unit | 2,958,176 |
| 货币curr | 2,933,136 |
| 语言名称lang | 2,914,464 |
| 地区名称region | 1,228,304 |
| 转写translit | 1,111,904 |
| 核心Unicode/共享数据 | 895,184 |
| 规则数字格式rbnf | 634,160 |

这是本包的逐条文件长度统计，不含包索引/对齐开销。单个最大条目为CJK分词词典（2,007,344字节），其次为中文排序数据（1,518,800字节）。

## 实验裁剪方式

保留root及en、zh、es、de、fr、ru、ja、pt、it、ko所有已有变体资源，删除其它语言的locale `.res`；保留全部Unicode算法数据、转换表、分词词典、转写、共享时区和pool/res_index资源。由icupkg执行依赖检查，自动补回rbnf/yue.res，最终移除3,134项。不使用`--ignore-deps`强行跳过校验。

从SDK的`lib_FoundationICU.a`提取专门的`icu_packaged_data.cpp.o`，导出.rodata获得完整.dat。生成独立GNU汇编对象，使用链接器`--wrap=icudt76_dat`将数据引用重定向到裁剪包。库代码、Foundation与ICU数据版本不变。替换对象文件名包含数据SHA-256片段，改变过滤配置后会触发重新链接。

仅用额外`-L`目录放置覆盖archive的初始尝试没有选中覆盖库，链接map仍指向SDK原archive，因此没有把那个产物算作裁剪成功。SDK原库始终未被覆盖。原实验在Linux x86-64的LLD下运行验证；默认打包现也完成Linux ARM64的交叉构建/静态ELF校验，尚未在ARM机器运行。该替换不应用于Mach-O或Windows原生产物。

## 已发现并修复的陷阱

`icupkg`默认按输出文件名生成内部ToC前缀。将输出命名为`icudt76l-slim.dat`时，内部路径变为`icudt76l-slim/...`，与Foundation期望的`icudt76l/...`不符。首个候选因此在ISO8601DateFormatter内部崩溃，HTTP PoW挑战阶段断开；GDB定位到CFDateFormatterCreateISO8601Formatter。这不是可忽略的功能退化。

脚本现显式设置`--toc_prefix icudt76l`（版本号从源符号读取）。修正后的探针和HTTP重新通过；不发布早期失败候选。这个实验也说明，单看体积与ELF静态检查不足以判断数据裁剪是否正确。

## 行为验证与差异

`ICUProbe`分别链接完整/裁剪数据，输出排序JSON作对照。覆盖：ISO日期/闰年/2038边界/带时差输入/无效输入；多语言日期和数字格式；UTC、上海、纽约、柏林时区；中文、组合音标、泰文、日文、阿拉伯文、emoji族群的字符和UTF-8计数、大小写；Unicode单词边界正则；Shift-JIS编码；中文IDN URL。

实际差异为4项：ar_EG日期与数字格式、hi_IN日期、th_TH日期。被移除语言的部分显示回退英文；泰文日期的佛历年份仍为2569，显示名称却回退，不能将结果简单视为“切换为英文locale”。其余本轮探针输出一致，包括保留的中英等语言和Unicode/编码/IDN/时区测试。

完整与裁剪后端均在独立工作目录、干净环境变量下通过200 KB内存和2 MB磁盘的完整HTTP schema smoke，覆盖会话、PoW、房间密码、审批、消息、SHA256、Range、分享、SSE及关闭撤权。裁剪版本仍无动态依赖。

局限：pool/res_index未重建，locale枚举可能仍列出已移除项；没有运行Foundation全量测试、所有locale/编码/日历组合或生产负载，不能把HTTP通过视为Foundation语义完全等价。当前Linux打包默认使用此子集；上述功能差异和限制仍然适用。

## PowerShell复现

需要PowerShell7.2+、匹配版本的Swift/Static Linux SDK，以及llvm-ar、llvm-objcopy、llvm-nm、clang、icupkg。`icupkg`实测使用本机ICU79工具读取ICU76包，原包与库均保留SDK76数据格式；工具不替换SDK数据版本。生产流水线若采用此方案，应固定工具版本并校验源archive SHA-256。

先构建完整ICU基线（传-FullICU绕过默认裁剪）：

```powershell
pwsh ./scripts/build-api.ps1 -Target linux-x86_64 -ApiOnly -FullICU -KeepSymbols
```

在pwsh中定位**x86-64 SDK**的archive，并运行实验脚本（也可显式传入归档绝对路径）：

```powershell
$sdk = Get-ChildItem "$HOME/.swiftpm/swift-sdks" -Filter lib_FoundationICU.a -Recurse |
    Where-Object { $_.FullName -match '/x86_64/' } | Select-Object -First 1
./scripts/prepare-icu.ps1 -IcuArchive $sdk.FullName -OutputDirectory dist/api/icu-research/repro
$profile = Get-Content dist/api/icu-research/repro/profile.json | ConvertFrom-Json
./scripts/build-api.ps1 -Target linux-x86_64 -ApiOnly -FullICU `
    -OutputDirectory dist/api/icu-research/candidate `
    -ExtraLinkerArguments $profile.linkerArguments -KeepSymbols
```

研究脚本输出语言清单、源库SHA-256、完整/子集长度、删除清单、补回依赖、替换对象与profile.json；可用`-Languages`修改子集。该逻辑现由build-api.ps1默认调用；standalone调用可用-Target选择linux-x86_64/linux-arm64，目标与archive架构不符会拒绝。

探针源码在`scripts/probes/ICUProbe/`，命令如下。在两次执行之间保存输出，比较JSON；第二次链接需要在pwsh会话中已有上述profile：

```powershell
swift build --package-path scripts/probes/ICUProbe --build-system native `
    -c release --swift-sdk x86_64-swift-linux-musl -Xswiftc -Osize
& scripts/probes/ICUProbe/.build/x86_64-swift-linux-musl/release/icu-probe
$argsForProbe = @('build', '--package-path', 'scripts/probes/ICUProbe', `
    '--build-system', 'native', '-c', 'release', '--swift-sdk', `
    'x86_64-swift-linux-musl', '-Xswiftc', '-Osize')
foreach ($arg in $profile.linkerArguments) { $argsForProbe += @('-Xlinker', $arg) }
& swift @argsForProbe
& scripts/probes/ICUProbe/.build/x86_64-swift-linux-musl/release/icu-probe
```

原始统计、包列表、探针full/slim/diff JSON及候选都保留在`dist/api/icu-research/`，作为构建产物不提交。

## 后续方向

默认采用子集后，仍需继续修正索引枚举，并扩大locale/编码/日历回归与SDK升级校验。更保守的方案只去除确认未使用的功能数据，但应依据当前Foundation实现逐项追踪，不能笼统删除分词、单位或IDNA数据。可重建匹配版本的ICU数据，使用官方Data Build Tool的locale/feature filter生成一致索引，避免长期维护后处理补丁。

官方工具支持从源数据按locale/feature过滤，且提醒预打包.dat存在时会绕过源过滤：[ICU Data Build Tool](https://unicode-org.github.io/icu/userguide/icu_data/buildtool.html)。Foundation自己的国际化数据依赖仍在演进，不能假设升级Swift后过滤结果自动兼容：[Swift Foundation](https://github.com/swiftlang/swift-foundation)。

PowerShell打包另已完成Linux ARM64交叉构建与ELF静态/架构检查；本研究的裁剪配置、探针和HTTP验证仍仅针对Linux x86-64，不能据此视为ARM裁剪已验收。

本报告的字节数针对API-only产物；当前默认PowerShell打包会嵌入前端，复现实验请显式使用-ApiOnly，以免将前端体积混入ICU差值。
