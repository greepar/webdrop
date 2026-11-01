# 后端 ELF 体积实测（2026-11-01）

Swift 6.4.2，x86-64 Linux。完全静态构建使用匹配版本的官方musl Static Linux SDK。安装并使用Bloaty 1.1，同时用GNU size/nm、readelf、LLD链接map交叉核对。以下均为实际文件长度，以MiB（1,048,576字节）表示；strip统一使用`--strip-unneeded`。

## 对照结果

| 构建 | strip后字节数 | MiB | 运行时性质 |
| --- | ---: | ---: | --- |
| 完全静态基线，release默认-O | 78,953,336 | 75.2958 | musl，无共享库 |
| 完全静态，-Osize | 76,622,712 | 73.0731 | musl，无共享库 |
| 完全静态，-Osize + function-sections + gc-sections | 76,622,712 | 73.0731 | 与上一行strip后SHA-256完全相同 |
| 动态Swift运行库，release -Osize | 22,510,296 | 21.4675 | 依赖Swift/Foundation等共享库，不是独立单文件 |

-Osize节省2,330,624字节（2.2227 MiB，2.9519%）。这组历史对照采用-Osize；当前按部署偏好恢复release默认优化（-O），脚本不额外传-Osize，正式输出仍为`dist/api/webdrop-linux-x86_64`。不采用无额外收益的显式function-sections/gc-sections参数，不裁剪反射元数据，不把动态版本替换为默认部署产物。

原有glibc + static-swift-stdlib文件另存为`stdlib-static-baseline.unstripped`和`.stripped`。检查发现收到的这份原文件本就已经stripped，两份均86,715,944字节，再strip没有收益。该历史产物并非本轮完全静态基线，不能将其与新-Osize构建的差值全部归因于strip。

动态对照构建实际重建了原生`.build/release/webdrop`；该路径为临时构建输出，不再代表旧的static-swift-stdlib版本。历史文件和所有对照均已保留在独立分析目录。部署完全静态版本应使用`dist/api/webdrop-linux-x86_64`。

## .rodata来自哪里

基线.rodata共38,260,600字节（36.4882 MiB）。Bloaty和nm均定位到单个`icudt76_dat`符号，大小33,976,096字节（32.4021 MiB），占.rodata的88.8018%，占整个strip后文件约43%。链接map确认它来自SDK的`lib_FoundationICU.a`，不是WebDrop消息或业务常量。

ICU数据作为一个整体输入段保留；当运行库仍引用它时，函数级GC不能将该符号内的locale/Unicode数据逐条删除。项目的-Osize也不会重新编译SDK预构建的Swift/Foundation/ICU库。若继续显著缩小这部分，需要另行研究裁剪ICU数据或定制SDK，以及国际化、日期格式和Unicode行为的兼容测试，本轮没有删除或外置这些数据。

本轮函数分节构建的map显示，.rodata按库归属的前几项为：

| 输入库 | .rodata字节数 |
| --- | ---: |
| lib_FoundationICU.a | 34,386,123 |
| libswiftCore.a | 839,344 |
| libCoreFoundation.a | 775,254 |
| libFoundationEssentials.a | 527,662 |
| CCryptoBoringSSL | 273,589 |

另有链接器合并字符串等内部输入，不能全部归到某个源码模块。完整map和聚合JSON保留在分析目录，不将原始nm符号大小简单相加，以免重复计算别名。

## .text与元数据

基线.text为29,491,330字节，-Osize为27,201,922字节，减少2,289,408字节（7.76%）；总文件收益主要来自这里。.rodata仅减少6,400字节。

本轮LLD输入的.text主要来自libswiftCore.a（3,612,730字节）、libFoundationEssentials.a（2,546,805）、lib_FoundationICU.a（2,461,041）、libFoundation.a（1,562,105）、CNIOBoringSSL（1,358,501）、Vapor（1,158,638）等。业务只是总.text的一部分，修改项目编译参数不会重新优化SDK所有预编译库。

基线swift5_fieldmd、swift5_typeref、swift5_reflstr、swift5_capture合计840,707字节（0.8018 MiB），远小于ICU数据。保留反射和必要类型元数据，未启用disable-reflection-metadata或disable-reflection-names。没有尝试删除异常展开信息，避免影响运行时、堆栈与错误处理。

检查SwiftPM的release.yaml发现，链接本来就带`--gc-sections`。本轮显式加入`-function-sections`和`--gc-sections`没有产生链接错误，但最终strip文件与仅-Osize版本逐字节一致（SHA-256同为`d195d4be38e23a88be0579414d2d6a5a78c313e0d578124fcabfc9c333d968db`）。这个结论限于当前工具链、SDK、锁定依赖与项目，不能推及所有Swift版本。

## Bloaty、DWARF与复现

本机apt源没有提供bloaty，实际通过Homebrew瓶装包安装。section/symbol维度成功：

```bash
bloaty dist/api/size-analysis/baseline.stripped \
  --debug-file=dist/api/size-analysis/baseline.unstripped \
  -d sections,symbols -n 20
```

compileunits维度失败：`Data is in new DWARF format we don't understand`。llvm-dwarfdump确认文件混合了项目的DWARF4与SDK预编译对象的DWARF5 skeleton/split-DWARF。原始未strip产物已经有.debug_info等调试信息；仅给项目再加-g不能补全或转换SDK的预编译DWARF。没有把失败的compileunits结果当作成功分析，改用链接map确认库/对象归属。

函数分节诊断构建的额外参数如下（在静态SDK基础命令上追加）：

```bash
-Xswiftc -Osize -Xswiftc -Xfrontend -Xswiftc -function-sections \
-Xlinker --gc-sections -Xlinker -Map -Xlinker /绝对路径/webdrop.map
```

动态对照命令（会改变原生release临时产物）：

```bash
swift build --package-path apps/api -c release --product webdrop -j 4 -Xswiftc -Osize
```

可重复的正式完全静态构建：

```bash
pwsh -NoProfile -File scripts/build-api.ps1 -Target linux-x86_64 -ApiOnly
```

所有基线/候选的strip与未strip文件、Bloaty文本输出、`metrics.json`、`dynamic-osize.ldd.txt`、`osize-function-sections.map`及`link-map-attribution.json`均保留在`dist/api/size-analysis/`（构建产物目录，不提交源码库）。基线.unstripped未被后续构建覆盖。

## 验证与边界

最小的纯静态候选在干净环境变量及独立工作目录下，分别通过200 KB内存和2 MB磁盘的完整HTTP契约smoke，包含会话、PoW、房间密码、审批、内容、SHA256、Range/HEAD、分享、SSE和关闭撤权。ELF继续无INTERP、无NEEDED共享库。

动态版本仅做体积和依赖对照，没有把21.47 MiB解释为完整部署总占用。未验证它在无Swift运行库机器上的运行，也未做吞吐/延迟基准；-Osize可能影响性能，体积收益不代表性能收益。其它发行版、内核及架构仍需部署环境验收。

后续已将构建入口迁移为PowerShell，并完成独立ICU子集实验；详见 [ICU数据裁剪研究](icu-data-research.md)。后续已按部署要求将Linux默认发布改为该ICU语言子集，`-FullICU`恢复完整SDK数据；下表历史实验与当前含前端产物应分开比较。

本次原始对照为API-only文件；默认发布后来增加前端嵌入，复现以上字节对照用-ApiOnly，当前默认产物体积另含前端资源。
