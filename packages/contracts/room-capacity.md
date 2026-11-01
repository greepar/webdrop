# 房间数量配置与空位查询（OpenAPI 0.6.0）

## 配置

| 环境变量 | 默认值 | 范围与含义 |
| --- | --- | --- |
| MAX_ROOMS | 500 | 1–1,000,000，全服务活跃房间总上限 |
| MAX_OWNED_ROOMS | min(5, MAX_ROOMS) | 1–MAX_ROOMS，每有效会话同时拥有的活跃房间上限 |
| ROOM_CODE_LENGTH | 4 | 4–8，当前创建/更换房间号使用的数字位数，保留前导零 |

修改后重启生效；非法值启动失败，INVALID_CONFIG不属于正常API响应。降低上限不会强制关闭已有房间：activeRooms可大于maxRooms，此时availableRooms为0，等待房间关闭或到期。更改位数也不会更换已有房间号。

## 公共查询

`GET /api/v1/room-capacity` 无需Cookie或CSRF，返回聚合数据，不列出房间号或成员信息；Cache-Control: no-store。查询执行既有到期清理，但不刷新任何房间的在线租约。

```json
{"data":{"maxRooms":500,"activeRooms":12,"availableRooms":488,"maxOwnedRooms":5,"roomCodeLength":4,"codeCapacity":10000,"occupiedCodes":12,"availableCodes":9988}}
```

- maxRooms：配置的活跃房间上限。
- activeRooms：全服务未关闭且未到期的房间数，锁定和待审批房间也计入；离线但未到期的房间仍占位。
- availableRooms：`min(max(0, maxRooms - activeRooms), availableCodes)`，全服务层面的剩余创建空间。
- maxOwnedRooms：每会话创建上限，不是当前访客自己的剩余名额。
- roomCodeLength：当前配置位数。
- codeCapacity：`10 ** roomCodeLength`，四位时包含0000，共10,000种。
- occupiedCodes：活跃房间中，占用当前位数合法数字号码的不同号码数。旧位数房间仍计入activeRooms，但不占用当前号码空间。
- availableCodes：codeCapacity减occupiedCodes；关房/到期后的号码重新可用。

`GET /api/v1/capabilities` 同时增加 maxRooms、maxOwnedRooms，原有roomCodeLength继续提供当前位数。静态限制取capabilities；实时余量取room-capacity。前端若需估算当前会话的剩余拥有名额，可用GET session有效memberships中owner的数量与maxOwnedRooms比较；结果仍不是名额预留。

## 并发与失败

查询只是瞬时快照，不预留名额。即使availableRooms大于0，当前会话可能已达到maxOwnedRooms，也可能受来源限流、号码冲突或随机号码分配重试次数限制。创建仍在服务端同一事务中原子校验；并发创建不能突破上限。

创建达到全局或会话限制沿用429 ROOM_CAPACITY + Retry-After；指定号码已占用沿用409 CODE_TAKEN；随机号码分配失败沿用503 CODE_CAPACITY。不能用查询结果绕过PoW、幂等、会话或其它权限检查。

公共查询沿用来源600次/分钟、全局3000次/分钟限流，超限429 RATE_LIMITED。前端按需刷新，不高频轮询；出现429遵循Retry-After。

## 兼容性

0.6.0增加一个公共GET端点及capabilities的两个字段，未修改既有字段/写请求及错误码。未配置时默认仍为全局500、每会话5。采用禁止未知字段的旧客户端需更新capabilities schema；本仓库前端解析器按已知字段读取，可继续使用。历史房间、密码、审批及生命周期规则保持适用。
