# fish-heart · DSH 情绪状态记录插件

给 DeepSeek Harness（DSH）加一层「硬状态情绪记录」：七维情绪 + 六档状态 + 念头（惦记）+ 作息。**只记录、不注入**——心境由模型自己从人格卡 + 对话临场判断，插件不替它定。

> 名字致敬 AstrBot 插件 `astrbot_plugin_fish_heart`（大肥鱼的心），但这是独立的 DSH 插件实现，不依赖 AstrBot、不绑定任何具体角色或桥接。

## 特性

- **七维情绪状态机**：5 维事件驱动（依恋/反刍/亲密/压力/喜悦）+ 2 维脚本驱动（疲惫按钟点、好奇按发问），各 0–100，随时间半衰期回落。
- **六档状态**：由「责怪压力」映射（日常/委屈/**闷**/生气/害怕/回避）。45–65 这一段按亲密分叉——责怪高但关系还近算「闷」（憋着），亲密掉了才是真「生气」。
- **念头（惦记）**：想被夸 / 想被抱 / 想听你说今天怎么样，满足后冷却 6 小时再冒出来。
- **作息**：入睡/起床可配，每天概率性熬夜。
- **只记录不注入**：不往 systemPrompt 塞任何东西，与任何已有的心境/人格注入都不冲突。
- **双通道感知**：默认直接监听 DSH 的 `user/message`（只吃带 `[QQ线` / `[QQ会话` 标记的消息，不重复读网页对话）；也可关掉，改由宿主桥接通过 HTTP 转发。
- **落盘节流**：tick 累积的漂移最多每 10 分钟落一次盘，事件（被夸/被骂/被哄/被抱）仍然即时落盘。

## 安装

```bash
dsh plugin --profile <profile> add ./fish-heart
```

要求 DSH `>= 0.2.2-rc.1`。装完重启 DSH（或插件管理页重载）。

## 配置（settings 命名空间 `fish-heart`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关掉不感知，数据保留 |
| `perceiveFromDsh` | `true` | 是否直接监听 DSH 的 `user/message`；默认开，只吃带 `[QQ线` / `[QQ会话` 标记的消息。关掉则由桥接转发 |
| `bedtime` / `wakeAt` | `23:30` / `07:30` | 作息 |

## HTTP API（供桥接调用）

插件在 DSH host 上暴露 `/api/fish-heart/*`：

| 端点 | 说明 |
|---|---|
| `POST /api/fish-heart/state` | 查状态（公开视图） |
| `POST /api/fish-heart/command` `{action:"status"}` | 同 `state` |
| `POST /api/fish-heart/command` `{action:"perceive", text:"…"}` | 喂一条用户消息做情绪感知 |
| `POST /api/fish-heart/command` `{action:"event", kind:"…"}` | 直接注入事件（`praise`/`blame`/`comfort`/`hug`/`ignore`/`dismiss`/`curious`/`wish-fulfilled`） |
| `POST /api/fish-heart/command` `{action:"calm"\|"reset"\|"tick"}` | 清责怪 / 重置 / 手动心跳 |

> ⚠️ 这些端点依赖 DSH host 的访问控制，**不要把 DSH web 端口暴露公网**；身份校验应由调用方（桥接）完成。

## 与 SnowLuma / OneBot 等桥接集成

本插件**不负责消息收发**，只暴露上面的 HTTP API。集成方式（以 SnowLuma OneBot 桥接为例）：

1. 桥接收到消息时，把文本转发给 `POST /api/fish-heart/command`（`action:"perceive"`）。
2. 桥接周期性（如每 60 秒）调 `action:"status"`，把返回的七维/档位/念头/作息拼进自己的提示词。
3. 桥接拦截一条命令（如 `/心`），调 `action:"status"` 回显状态。

这样插件就是「纯情绪状态源」，与桥接、人格卡、记忆各司其职——不抢通道、不重复造桥。

## 情绪模型

- **七维**（0–100）：
  - 事件驱动：依恋 `attachment` / 反刍 `rumination` / 亲密 `intimacy` / 压力 `pressure` / 喜悦 `joy`
  - 脚本驱动：疲惫 `fatigue`（按钟点）/ 好奇 `curiosity`（按发问）
- **两条快变量**：期待 `expectation`（主动后没回就涨）、责怪压力 `blamePressure`（被责怪/敷衍才涨，决定档位）。
- **六档**（由 `blamePressure` 映射）：

  | 档位 | 责怪区间 | 附加条件 |
  |---|---|---|
  | `daily` 日常 | `[0, 20)` | |
  | `wronged` 委屈 | `[20, 45)` | |
  | `sullen` 闷 | `[45, 65)` | **亲密 ≥ 60** |
  | `angry` 生气 | `[45, 65)` | 亲密 < 60 |
  | `afraid` 害怕 | `[65, 80)` | |
  | `avoidant` 回避 | `[80, +∞)` | |

  「闷」和「生气」是同一段责怪压力下的两种状态：**关系还近 = 闷（憋着，给个台阶就下来）**，关系疏了 = 生气。上层提示词据此区分，才不会把“还在乎你”写成“你不道歉我就不理你”。

- **责怪压力怎么变**：被责怪 `+15` / 被哄（道歉、说清楚）`−30` / 被抱 `−10` / 每 6 小时向基线回落一半。
- **心情标签**（由事件驱动五维推导，先命中先返回）：黏人 / 想亲近 / 紧绷 / 开心 / 走神 / 平常。注意 `attachment ≥ 66` 优先级最高，长期高频互动时会一直显示「黏人」。
- **念头**：想被夸 / 想被抱 / 想听你说今天怎么样。
- **作息**：入睡/起床可配，每天 20% 概率熬夜。

### 关键词（默认中文，改 `lib/index.js` 顶部正则即可定制）

| 事件 | 关键词 |
|---|---|
| 被夸 `praise` | 真棒 / 厉害 / 好看 / 可爱 / 喜欢你 / 爱你 / 不错 / 绝了 … |
| 被骂 `blame` | 你他妈 / 废物 / 傻逼 / 滚蛋 / 恶心 / 闭嘴 / 智障 … |
| 被哄 `comfort` | 对不起 / 我错了 / 别生气 / 乖 / 没事 / 不哭 … |
| 被抱 `hug` | 抱抱 / 摸摸 / 贴贴 |
| 被敷衍 `dismiss` | 哦 / 嗯 / 随便 / 不知道（整句） |
| 想听今天 `today` | 我今天 / 今天有点 / 好 / 去 / 吃 / 上班 … |
| 好奇 `curious` | 你知道吗 / 什么是 / 为什么 / 怎么做 / 教我 / 科普 |

判定顺序 `blame → hug → comfort → praise → today → curious → dismiss`，一句话只算一个事件。唯一例外：一句里既抱又道歉（「对不起，抱抱」）按 `comfort` 算，因为和解比撒娇重。

> 词表是 `lib/index.js` 顶部的正则，改完直接 `node test/smoke.mjs` 跑一遍。

## 数据与隐私

全部状态在一个文件 `$DSH_HOME/fish-heart/state.json`。只存数值、念头、最近 5 条责怪原句；**不存聊天全文、不存图片、不建数据库**。

## 目录

```
fish-heart/
├── package.json          # 插件 manifest
├── cordis.patch.yml      # entry（id == 命名空间 fish-heart）
├── LICENSE               # MIT
├── lib/
│   ├── heart.js          # 状态机核心（纯逻辑，可单测）
│   └── index.js          # DSH 接线层（HTTP 路由 + 事件感知）
└── test/
    └── smoke.mjs         # 逻辑自测（node test/smoke.mjs）
```

## 自测

```bash
node test/smoke.mjs   # 纯逻辑，无需装 DSH
```

## 已知限制

- 事件感知是**关键词级 best-effort**，不是语义理解；精确语义可自行加 LLM 兜底。
- **档位有滞后**：`state.tier` 由 tick（默认 5 分钟）重算，责怪压力刚衰减到跨档时，显示可能最多晚 5 分钟。要即时，读状态时现算 `deriveTier(state)` 即可（纯函数，不落盘）。
- **轻度责怪无通道**：`BLAME_RE` 只收重度词（你他妈 / 废物 / 傻逼 …），「别生气 / 生气」不触发。轻度不满目前读不出来，需要自己扩词表或接 LLM。
- **心情标签是单标签**：`attachment ≥ 66` 就返回「黏人」，会盖住「开心 / 紧绷 / 走神」。想要组合标签得改成加权排序。
- 主动说话（proactive）不在本版；状态与接口已就绪，可在此基础上扩展。

## 变更记录

### v0.2.0

- **新增第六档「闷」**：责怪压力 45–65 且亲密 ≥ 60 判「闷」，不再一律判「生气」。原来的阈值表没动，只在上层加了一层亲和力分叉。
- **`hug` 事件会降责怪压力（−10）**：之前「抱抱/摸摸」排在「哄」前面命中，却完全不碰 `blamePressure`，导致越软的示好越降不下来，只剩正式道歉一条路。
- **感知词表去重**：`抱抱/摸摸` 从 `COMFORT_RE` 移除，交给 `HUG_RE` 独占；同句既抱又道歉时改按 `comfort` 算。
- 落盘节流（10 分钟）与 `perceiveFromDsh` 默认开（只吃 QQ 线消息）。
- 自测 15 → 18 项，覆盖分叉边界（亲密 59/60）与两种和解方式的强弱关系。

## 许可

MIT
