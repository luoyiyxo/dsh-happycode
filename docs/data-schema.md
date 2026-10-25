# DSH 会话数据勘察（Step 0-1）

> 结论文档：`dsh-happycode` 的数据源、物理格式、事件 schema 与计数映射。
> 勘察环境：DSH Desktop `0.2.1-rc.2`（Electron 内置 Node `v24.21.0` / zlib 含 zstd），
> Windows 11，本地时区 `Asia/Shanghai`（UTC+8）。
> 勘察样本：`~/.dsh/sessions/` 下 **16 个会话**、4 个工作区 slug，共 1296 条事件，全部解码成功。

---

## 1. 磁盘布局

```
<DSH_HOME>/                                   # 默认 %USERPROFILE%\.dsh，可用 DSH_HOME 覆盖
├── sessions/
│   └── --<规范化 cwd>--/                     # 工作区 slug，把路径分隔符转成 '-'
│       └── session-<uuid>/
│           └── session.v4.jsonl.zstd        # 当前格式（格式版本 = 文件名版本）
└── storages/
    └── session_projcache/
        └── sessions/
            └── session-<uuid>.json          # 会话元数据（投影缓存）
```

实测 16 个会话目录与 16 个 projcache 文件 **一一对应**，文件名即会话 id。

- 工作区 slug 形如 `--D-program_software-deepseek_harness_workplace-default--`，即 `D:\program_software\...\default`
  把 `:`、`\` 换成分隔符后的形式（首尾各补 `-`）。
- 会话目录名就是 `record.identity.id` 的值（本机实测 `session-<uuid>` 与文件名前缀一致）。
- 会话目录下**只有** `session.v4.jsonl.zstd` 一个文件（本机 16/16）。历史世代（`session.v3.jsonl.zstd` 等）
  在将来升级后可能共存，读取时应**取版本号最大的**那个，见 §2.1。

---

## 2. 物理格式：拼接的 Zstandard 帧

`session.v4.jsonl.zstd` **不是**单个 zstd 流，而是**若干独立、各自带校验和的 zstd 帧首尾拼接**：

- 第 1 帧 = 会话头（一行 JSON，`type: "session"`）；
- 之后每个持久化批次一帧（一批可含多行 JSON）；
- 每帧独立可解（RFC 8878 frame，`ZSTD_c_checksumFlag=1`）。

实测：最大的 511 460 字节文件里有 **126 个帧**；`zstdDecompressSync(whole file)` 只解出第一帧 237 字节，
`createZstdDecompress()` 流式读也只解出第一帧 —— **必须自己扫帧、逐帧解压**。

### 2.1 帧扫描算法（照 RFC 8878 帧头 + 块头解析，不依赖解压）

```
offset = 0
while offset < len:
    start = offset
    magic u32le == 0xFD2FB528 ? 否则:该文件损坏
    offset += 4
    descriptor = u8[offset++]
      若 (descriptor & 0x18) != 0 → 保留位被置位，损坏
      fcs_flag = descriptor >>> 6
      single_segment = descriptor & 0x20
      checksum = descriptor & 0x04
      dict_flag = descriptor & 0x03
      dict_bytes = dict_flag == 3 ? 4 : dict_flag
      fcs_bytes = fcs_flag == 0 ? (single_segment ? 1 : 0) : (1 << fcs_flag)
      offset += (single_segment ? 0 : 1) + dict_bytes + fcs_bytes
    loop:                                   # 块
        block_header = u24le[offset]; offset += 3
        last = header & 1; type = (header >>> 1) & 3; size = header >>> 3
        type == 3 → 损坏；payload = (type == 1 ? 1 : size)   # RLE 块只占 1 字节
        offset += payload
        if last: break
    if checksum: offset += 4
    frames.push({ start, end: offset })
```

读到文件尾但帧未闭合 → 视为「未写完的尾帧」，只解压已完整的帧（崩溃恢复语义，与宿主一致），
**不要**把尾帧当损坏。

解码：`zlib.zstdDecompressSync(buf.subarray(start, end))`，把各帧明文按顺序拼接后按 `\n` 切行，逐行 `JSON.parse`。
坏帧 / 坏行**只跳过该帧或该行并记日志**，不抛到上层（红线 4）。

> 兼容性：宿主 Node 24 自带 `zstdDecompressSync`；若运行环境的 Node < 22.15（无 zstd），
> 插件应**跳过压缩会话并记一条日志**，不崩溃、不联网。若将来需要纯 JS 兜底，可加 `fzstd` 依赖
> （本机不需要，故不引入，保持零依赖）。

---

## 3. 事件信封

除首行会话头外，每个事件都是：

```jsonc
{ "type": "<事件类型>", "seq": 0,          // 会话内单调递增序号
  "time": 1792909503454,                    // epoch 毫秒（UTC），归日就靠它
  "data": { ... },                          // 类型专属负载
  "sourceEventSeqs": [..],                  // 可选：派生行对源 seq 的反向引用
  "surfaceOp": { ... } }                    // 可选：界面投影操作
```

会话头：

```jsonc
{ "type":"session", "version":4, "id":"session-<uuid>", "createdAt":1792909503448,
  "cwd":"D:\\program_software\\...", "isSeeded":false, "delegationDepth":0, "agentPreset":"standard" }
```

`time` 一律是 **epoch 毫秒**；`createdAt` 同。归日规则见 §5。

---

## 4. 事件类型表（本机实测 1296 条）

| type | 次数 | 语义 | 是否计入贡献 |
|---|---:|---|---|
| `session` | 16（每文件 1） | 会话头 | 否 |
| `turn/start` / `turn/end` | 8 / 8 | 一个对话轮次的开合（`data.turn`） | 否（轮次以用户消息计） |
| `step/start` / `step/end` | 31 / 31 | 一轮内的一个模型步 | 否 |
| `user/message` | 16 | 投影到对话历史的一条 user 行 | **是，仅 `data.source.kind === "user"`** |
| `agent/inbox/spliced` | 16 | 往 inbox 里塞/撤消息 | 否（与 `user/message` 重复计会翻倍） |
| `assistant/message` | 31 | 模型输出（含 `usage`、`stream`） | 否 |
| `tool/call` | 51 | **一次工具调用**（`data.name` = 工具名，`data.arguments` = JSON 字符串） | **是** |
| `tool/result` | 51 | 工具结果（`data.message.role="tool"`，`isError`） | 否 |
| `workspace/changes` | 5 | 工作区变更摘要（仅 `turn`） | 否 |
| `system/message` | 1 | 系统提示注入 | 否 |
| `session/title`, `session/title-llm-request` | 2, 1 | 标题生成 | 否 |
| `permission/preset`, `sandbox/mode`, `approval/policy` | 1,1,1 | 权限相关状态 | 否 |
| `request/header`, `request/context` | 1,1 | 请求头/上下文快照 | 否 |
| `approval/asked`, `approval/decided` | 1,1 | 审批 | 否 |
| `job/registered`, `job/settled` | 1,1 | 后台作业 | 否 |
| `deliverables/presented` | 2 | 交付物 | 否 |

### 4.1 `user/message` 的 `source.kind` 分布（本机全量）

| kind | 次数 | 说明 | 计为消息轮次 |
|---|---:|---|---|
| `user` | 38 | 真人输入 | ✅ |
| `time-context` | 21 | 注入的当前时间上下文 | ❌ |
| `runtime-context` | 8 | 运行时上下文快照（工作区/沙箱等） | ❌ |
| `skill-catalog` | 6 | 技能目录注入 | ❌ |
| `user-approval` | 2 | 审批答复（不是对话消息） | ❌ |
| `model-selection` | 1 | 模型选择事件 | ❌ |

**结论**：消息轮次必须以 `type === 'user/message' && data.source.kind === 'user'` 判据，
不能简单数 `user/message`（本机会虚高 16 → 38 的 2.2 倍）。

> 旁证：`agent/inbox/spliced` 的 `data.inserted[].source.kind === 'user'` 出现 8 次，
> 与其中一个会话的 8 条真人消息一一对应，但这是**投递**动作、不是稳定的消息记录
> （同一批消息可能被 `removedCount` 撤回过），且并非所有 `user/message` 都伴随 splice，
> 因此**只认 `user/message`**，避免重复计数。

### 4.2 工具名分布（本机全量，用于校准「文件编辑」名单）

| 工具 | 次数 | 类别 |
|---|---:|---|
| `pwsh` | 56 | 命令执行 |
| `edit` | 23 | **文件编辑** |
| `read` | 22 | 读取 |
| `web_fetch` | 17 | 网络（宿主工具，不是插件发的请求） |
| `write` | 9 | **文件编辑** |
| `grep` / `glob` | 6 / 6 | 搜索 |
| `ask_user_question` | 5 | 交互 |
| `skill` | 3 | 技能加载 |
| `web_search` | 2 | 网络 |
| `present` | 2 | 交付 |
| `load_workspace_dependencies`, `todo_write` | 1, 1 | 其他 |

宿主自带工具清单（`@deepseek-ai/dsh-tool-*`）里与「写文件」相关的有：`write`、`edit`（`tool-fs`）、
`str_replace_editor`（`tool-str-replace-editor`，可选安装）。`apply_patch` / `patch` / `multi_edit`
在当前发行版中不存在，但为未来兼容一并纳入。

---

## 5. 计数映射（校准后的 §7.2 规则）

```
每个事件（有 time 的）→ 按本地时区归入 YYYY-MM-DD
  m（消息轮次）+1   ⟺ type === 'user/message' && data.source.kind === 'user'
  t（工具调用）+1   ⟺ type === 'tool/call'
  f（文件编辑）+1   ⟺ type === 'tool/call' && EDIT_TOOLS.has(data.name)

EDIT_TOOLS = { write, edit, str_replace_editor, apply_patch, multi_edit, patch }
             （默认集合；写进 settings.json 后可由用户覆盖，见 §7）

贡献值 = w_m·m + w_t·t + w_f·f     默认 1 / 1 / 3
```

补充判据（实现时使用）：

- **跳过 `delegationDepth > 0` 的会话**：子智能体会话（`subagent`）是与父会话同一批活动的分身，
  计入会重复统计。本机 16 个会话 `delegationDepth` 全为 0。
  该字段在会话头里；缺失或非数字时按 0 处理。
- 会话头本身没有 `time`，只有 `createdAt`；**不**用 `createdAt` 计贡献（否则每个空会话都会污染日期）。
  但 `createdAt` 会被记录为该用户「开始使用 DSH 的时间」（`firstSessionAt`，出现在
  `/api/status` 与图谱响应的 `meta` 里）。
- 年份选择器的列表（v3 R5）= **当前年份 ∪ 有活动数据的年份**，降序取前 3：
  新年当天即使还没有任何活动，当前年份仍在列（显示空图），2029 年时则为 `[2029, 2028, 2027]`。
  D14 的「从开始使用起算」体现为「不会把开始使用之前的年份算进来」，而不是凭空列出空年份。
- `tool/result` 不计数；`tool/call` 与其结果一一对应（本机 51/51），不会重复。

---

## 6. 归日 / 归年与时区

- 归日：`new Date(time)` 后用**系统本地时区**取 `getFullYear/getMonth/getDate`。
- 归年：同一套本地时区，年边界 = 本地 1 月 1 日 00:00。
- 缓存里存 `YYYY-MM-DD` 本地日键 —— 契约要求「时区变更全量重算」，因此缓存同时记录
  构建时使用的时区偏移（`Intl.DateTimeFormat().resolvedOptions().timeZone` + 当年的 `getTimezoneOffset()`），
  不一致即作废重建。

本机抽查（本地时区 UTC+8，勘察时刻）：

| 本地日 | m | t | f | 贡献值 |
|---|---:|---:|---:|---:|
| 2026-10-23 | 0 | 0 | 0 | 0 |
| 2026-10-24 | 8 | 11 | 0 | 19 |
| 2026-10-25 | 30 | 151 | 33 | 280 |

2026-10-06 / 10-15 / 10-22 / 10-23 只有空会话（4–8 条系统事件、0 条用户消息），
是验证「全空格子 / 无贡献 tooltip / 空年份」的现成样本。

> 注意：本机数据目前只覆盖 2026 年，所以「最近 3 个有数据年份」实测只能列出 1 个（2026）。
> 代码需在只有 1 个年份时正常工作（不是退化情形，是常态起点）。

---

## 7. `session_projcache` 元数据（可选加速，非必需）

`storages/session_projcache/sessions/session-<uuid>.json`：

```jsonc
{ "version": 7,
  "record": {
    "identity": { "formatVersion":4, "createdAt":1792848323357, "cwd":"...", "isSeeded":false, "inheritedEventCount":0 },
    "rows": {
      "sessionStats":       { "ver":1, "seq":178, "val":{ "turns":6, "steps":25, "llmMs":..., "toolMs":48848, ... } },
      "sessionListMetadata":{ "ver":1, "seq":178, "val":{ "blank":false, "lastPromptAt":1792916485535 } },
      "title":              { ... },
      "turnOutline":        { ... },
      ...
    } } }
```

用途（**只读**）：

1. `record.rows.sessionListMetadata.val.blank === true` → **廉价跳过**，不解压文件；
   实测本机 10 个 `blank` 会话全部 0 贡献。缺失该字段时保守处理：照常解压。
2. `record.identity.createdAt` → D14 的「最早使用时间」（年份选择器下限）；解压后的会话头
   `createdAt` 同样可用，projcache 只是省一次解压。
3. `record.rows.sessionStats.val`（`turns/steps/toolMs`）**不用于计数**：它是宿主自己的口径，
   与「消息轮次 / 工具调用 / 文件编辑」不同维，只可作为「该会话非空」的旁证。

projcache 与 sessions 并非强一致（写盘时机不同）；**projcache 只作加速，真相始终以会话文件为准**。

---

## 8. 增量与缓存键

- 增量单位 = 会话文件。缓存 `sessions.json` 记每个会话：`id`、文件路径、`size`、`mtimeMs`、
  以及该会话解出的 `{ perDay: {"YYYY-MM-DD": {m,t,f}}, createdAt }`。
- 重新解析条件：文件 `size` 或 `mtimeMs` 变化、缓存 `schemaVersion` 不符、时区变化。
- 会话被删除时，把它在 `daily.json` 里的贡献按会话级日计数**扣掉**（因此必须存会话级 perDay，
  不能只存全局 daily）。
- `daily.json` 是 `sessions.json` 的物化汇总（便于 `GET graph` 直接切片），两者同一次写入落盘。

---

## 9. 对实现的硬约束

1. 只读 `~/.dsh/sessions/**` 与 `~/.dsh/storages/session_projcache/**`；写只落
   `<profile>/.dsh-happycode/`。
2. 不上传任何内容；日志里**不出现**会话文本（只记路径、计数、错误码）。
3. 单文件解析失败 → 跳过 + 记一条 warning，继续下一个文件。
4. 解压/扫描用零依赖 Node 内置（`node:zlib` + `node:fs`）；不引入原生模块。
