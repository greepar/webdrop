# 房主审批入房（0.6.1补充，已实现）

创建房间 POST /api/v1/rooms 可传 `approvalRequired: true`；省略为 false。房主通过 PATCH /api/v1/rooms/{roomId} 修改该布尔值，可与 password、joinPolicy 一起原子修改。Room/RoomSnapshot 与 room.updated 均返回 approvalRequired。旧房间默认 false。

访客仍使用原来的 POST /api/v1/rooms/join，携带 Cookie、Origin、CSRF、Idempotency-Key、code、proof，以及可选 password。顺序为 PoW、锁定/封禁检查、密码校验、提交申请。已有成员直接返回200，无需审批。普通入房仍返回201和成员关系；需要审批时返回202：

```json
{"data":{"roomId":"uuid","request":{"id":"uuid","displayName":"手机","createdAt":"UTC ISO8601","expiresAt":"UTC ISO8601","status":"pending"}}}
```

202不是入房成功：申请者此时不能读取房间快照、成员、内容、文件或SSE。前端保留 roomId 和 request.id，进入等待界面。

| 操作 | 接口 | 权限与结果 |
| --- | --- | --- |
| 查看待审批列表 | GET /api/v1/rooms/{roomId}/join-requests | 仅房主；data 为未过期 pending 申请数组，按创建时间升序，最多100条 |
| 查看申请状态 | GET /api/v1/rooms/{roomId}/join-requests/{requestId} | 申请者本人或房主；data 为 JoinRequest |
| 同意 | POST /api/v1/rooms/{roomId}/join-requests/{requestId}/approve | 仅房主；空对象请求，返回200 JoinRequest |
| 拒绝 | POST /api/v1/rooms/{roomId}/join-requests/{requestId}/reject | 仅房主；空对象请求，返回200 JoinRequest |

写操作要求 Origin、CSRF；审批不要求额外PoW或幂等键。同一决定重复提交返回200，尝试反转终态返回409 JOIN_REQUEST_STATE。只有一个并发决定能成功。批准时原子校验房间未关闭、未锁定、未封禁、申请会话有效及人数上限；满员返回409 ROOM_FULL，申请保持pending。批准直接建立成员关系并向已有成员发送 member.joined。

房间成员通过join-request.created / join-request.updated SSE获知新申请及同意/拒绝/撤回/到期变化，data为与GET申请相同的完整JoinRequest。仅真实状态转换发事件，重复请求不重复发送。owner收到事件后立即重读申请列表，30秒轮询作为兜底，打开面板时可轮询；申请者尚非成员，不能接收SSE，继续按约3秒轮询本人状态，页面隐藏时暂停；429遵循Retry-After。申请者收到 approved 后读取房间快照并建立SSE；拒绝显示 rejected，过期显示 expired；其它标签页撤回显示 withdrawn（申请已取消）。最终访问权限仍以房间API鉴权为准，历史 approved 不代表后来被踢后仍有权限。

申请有效期10分钟；每会话每房只保留一个有效pending申请，重新提交仍需新PoW，但返回原pending请求。每房最多100条未过期且非withdrawn的申请记录（含已同意/拒绝记录），满额返回429 JOIN_REQUEST_LIMIT，等待或刷新。过期记录可以被后续申请清理，查询随后可能404。房间关闭或申请不存在返回404；不能通过他人的requestId读取申请。拒绝后可重新申请，但仍受PoW与来源限流约束，拒绝不等于永久封禁。

改变审批设置、房间号或密码不自动决定已有申请；申请密码在提交时验证，后续改密不撤销该申请。关闭审批后新访客直接加入，旧pending申请仍由房主决定或到期。已有成员不受设置变化影响。密码与审批可同时启用；锁定阻止新申请及批准。

加入成功缓存遵循原幂等语义；202重试返回原申请快照，最新状态必须通过状态接口获取。改变code/password等业务参数使用新幂等键并重新申请PoW。申请记录随房间元数据持久化，重启保留剩余有效期。

生命周期补充：owner或已有成员查询单个申请状态刷新房间租约；待审批访客查询不刷新，不因owner离线而自动批准。房间关闭后的申请查询与决定返回404，旧approved状态不能代替当前成员鉴权。详见room-lifecycle.md。

| 操作 | 接口 | 结果 |
| --- | --- | --- |
| 撤回 | DELETE /api/v1/rooms/{roomId}/join-requests/{requestId} | 仅申请人本人；pending有效时204，否则409 JOIN_REQUEST_STATE；已消失404；owner不能代撤（403 FORBIDDEN） |

withdrawn为终态：申请人主动取消，不占100条申请额度，不出现在owner pending列表；仍可查询本人终态至到期清理。重复撤回409，撤回与审批并发只允许一个成功；状态改变发送一次join-request.updated。重新申请须新PoW/幂等键。
