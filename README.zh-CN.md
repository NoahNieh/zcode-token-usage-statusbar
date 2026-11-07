# ZCode Token 用量状态栏（个人 Fork）

> Fork 自 [ByteRax/zcode-token-usage-statusbar](https://github.com/ByteRax/zcode-token-usage-statusbar)（其上游为 [xhwxt/zcode-token-usage-statusbar](https://github.com/xhwxt/zcode-token-usage-statusbar)），感谢原作者的工作。
> 本 fork 供自用维护，README 已按实际行为修订：如实标注联网行为与风险，删去了宣传性内容。功能问题请优先到上游反馈。

给 [ZCode](https://zcode.z.ai) 桌面客户端的对话窗口底部加一条状态栏：生成速度、token 消耗、上下文占用、工具调用、子智能体，一眼看到。附赠 CLI（`zusage.py`）、`/usage` 命令和 MCP 工具（`token_usage`）用于查询历史用量。

简体中文 · [English](README.en.md)

Windows / macOS（macOS 未经充分测试）· Python 3.8+（零第三方依赖）· [MIT](LICENSE)

---

## 它是怎么工作的（装之前先读）

这不是官方插件，而是一个**注入式外挂**：

- 安装时会**修改 ZCode 的 `app.asar` 程序文件**（在入口末尾追加一行加载器，完整重打包）；
- 注入的代码运行在 **Electron 主进程**，拥有与本机普通程序相同的权限；
- 用量数据来自本地 `~/.zcode/cli/db/db.sqlite`（只读），ZCode 升级会覆盖 `app.asar`，状态栏随之失效（插件方式可自动修复，手动方式需重跑安装）。

理解并接受以上事实再安装。企业受管环境、对客户端完整性有要求的场景，不建议使用。

## 状态栏长什么样

```text
⚡ 86 t/s │ 6.25万 90% 7次 Σ18.4s ⏱1.4s │ 144.85万 86% 23轮 187次 │ 142 🔴2 │ 342.18万 │ 23.64万 🟢 │ ⚙
  生成速度       本轮（这次提问）            会话累计（这次对话）       工具调用    今日合计    子智能体   设置
```

- **生成速度**：t/s；生成中为字符增量估算，请求完成后切换为统计值
- **本轮**：本次提问的 token、缓存命中、请求数、累计耗时、首字延迟；悬停看输入/输出/缓存/思考明细与预估费用
- **会话累计 / 今日合计**：本次对话 / 今天所有会话的合计（悬停有明细）
- **工具调用**：次数，出错亮红点，悬停看每个工具的耗时与错误
- **子智能体**：模型派发的子任务消耗（含动态工作流派发的子代理，明细带「工作流」标识、汇总有分项小计），🟢 表示有子任务在跑，点击看各子任务明细
- **⚙**：显示项开关、语言、上下文窗口覆盖、更新检查等

上下文占用不在状态条上：看输入框工具栏的**上下文按钮**（环形图标+百分比），快满变色，超限会弹建议气泡，内含一键压缩。

## 安装

需要：ZCode 桌面客户端、Python 3.8+（标准库 `sqlite3`）。不需要 Node.js。

**方式一：一键安装（最直接）**

```bash
git clone https://github.com/NoahNieh/zcode-token-usage-statusbar.git
cd zcode-token-usage-statusbar
python install.py          # Windows；macOS 用 python3，--lang en 切英文
```

ZCode 升级覆盖 `app.asar` 后状态栏失效，重跑 `python install.py` 即可（注入行未变时秒级完成）。

**方式二：本地目录插件（免终端，会话启动时自动同步运行时并自动修复注入）**

ZCode → **设置 → 插件 → 添加插件市场 → 选择目录**，指向本仓库根目录，安装并启用 **ZCode Token Usage Statusbar**。

> 远程市场 URL（`https://github.com/…#plugin-releases`）依赖 `plugin-releases` 分支与 Releases，本 fork 未推送，勿直接使用原仓库地址安装到本 fork 的开发版本。

**装完之后：** 确认安装成功 → **完全退出 ZCode 再重开**（关窗口不算）→ 检查状态栏出现。只想用 `/usage`/MCP 查询、不想注入客户端的话，装插件后运行 `/uninstall-overlay` 写入豁免标记。

## 联网行为（如实说明）

**不联网的部分**：用量统计、状态栏、CLI、MCP、Git chip——只读本地 SQLite 与本地 git，无任何上传。

**默认会联网的部分**（均可关闭）：

| 功能 | 默认 | 访问什么 | 怎么关 |
|---|---|---|---|
| 套餐额度/重置卡查询 | 开 | 解密宿主凭据，请求发往**对应厂商官方域**（BigModel/Z.ai、Anthropic、DeepSeek、Kimi、OpenRouter 等） | ⚙ 关闭额度，或 `quota_enabled: false` |
| 预估费用价表与汇率 | 开 | 每 12 小时拉取 models.dev 价表 + 汇率 API（只下载） | `pricing.fetch: false` |
| 插件自动更新 | 开 | 从 Release 渠道下载代码（主进程可执行） | ⚙ 关闭，或 `plugin_auto_update: false` |
| 远程会话（SSH/WSL/Docker） | 按需 | 经你配置的通道在远端执行查询脚本 | 不配置即无 |

要彻底离线，在 `~/.zcode/zcode-token-usage-statusbar/config.json` 里：

```json
{ "quota_enabled": false, "pricing": { "fetch": false }, "plugin_auto_update": false }
```

> ⚠️ 自动更新是一条远程代码通道：更新内容会直接进入主进程执行。使用本 fork 请意识到你在信任的是这个 fork 的发布链。

## 凭据边界

- ZCode 存储的 SSH 密码、私钥口令**不会被解密使用**；远程查询只用你显式配置的通道。
- 额度查询的凭据仅在内存中使用，不写日志；⚙ 面板手动保存的凭据写入运行目录 `quota-secrets.json`（0600）。
- Anthropic 数据源需显式启用，启用后可能读取 `~/.claude/.credentials.json`。

## 数据口径（速览）

- 一行 `model_usage` = 一次模型请求；`input` 已含 cache-read，`output` 已含 reasoning，合计 = input + output。
- token 用量 ≠ 账单；「预估费用」是按公开价表的估算值，匹配不到价格的模型按默认均价，可能偏差很大。
- 每个窗口只显示自己焦点会话的数据；子智能体经 `parent_id` 归并，不与会话合计重复计数；工作流派发的子代理（`query_source='workflow_child'`）与 Task 子代理一并计入子智能体维度。
- 详细算法与坑见 [docs/design-notes.md](docs/design-notes.md)、[docs/user-guide.md](docs/user-guide.md)。

## 风险须知

1. **非官方注入**：修改客户端程序文件，可能违反 ZCode 使用条款；杀软/EDR 可能对 asar 改写行为告警。
2. **主进程权限 + 自动更新**：注入代码拥有完整本机权限，默认每小时检查更新并自动安装——这是供应链信任链，介意请关闭。
3. **升级脆弱性**：客户端升级会覆盖注入；注入/补丁对客户端版本有白名单依赖，新版本客户端可能暂不被支持（引擎补丁 fail-closed 拒绝而非写坏）。
4. **macOS**：修改 app.asar 会使代码签名失效，可能触发 Gatekeeper 拒启；上游亦未在 macOS 实测。

## 卸载

- **一键安装的**：仓库目录跑 `python install.py --remove`，然后完全退出重开 ZCode。卸载只移除本工具自己的注入行，不影响客户端其他内容。
- **插件装的**：⚙ 关自动更新 → `/uninstall-overlay` → 设置 → 插件 → 卸载 → 完全退出重开。别只删插件留下注入。

## 更多文档

- [安装、配置与排查](docs/user-guide.md) · [功能截图](docs/features.md) · [额度支持矩阵](docs/quota-support-audit.md)
- [实现原理与数据口径](docs/design-notes.md) · [Web 版（自托管）](web/README.zh-CN.md) · [开发与发布](docs/maintaining.md) · [测试说明](tests/README.md)

[MIT License](LICENSE)
