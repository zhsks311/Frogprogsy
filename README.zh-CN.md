<p align="center">
  <img src="assets/banner.png" alt="frogprogsy — 让 Claude Code 接入任意 LLM" width="820">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <b>简体中文</b> · <a href="https://zhsks311.github.io/Frogprogsy/zh-cn/"><b>完整文档</b></a>
</p>

frogprogsy 是支持 Claude Code CLI、TUI、App 和 SDK 的本地 provider 网关。frogprogsy package 支持 macOS、Linux 和 Windows。它使用 Claude Code 的 gateway 设置，不会 patch Claude Code。先在仪表盘中连接 provider，然后照常使用 Claude Code。

## 快速开始：在仪表盘连接第一个 provider

### 1. 安装

```bash
bun add -g frogprogsy
frogp --version
```

不带 tag 时会安装稳定版 `latest` 渠道。要使用预览版，请明确安装 `preview` 渠道：

```bash
bun add -g frogprogsy@preview
```

`frogp update` 始终把 Bun 管理的安装切换到稳定版 `latest`。要继续使用预览版，请用 Bun 重新安装 `frogprogsy@preview`。

对于普通的 Bun 全局稳定版安装，proxy 启动后会在后台检查 npm 稳定版发布信息，并在
dashboard 和 `frogp status` 中显示可用版本。它不会自动安装或重启。可以在
**详细设置**中关闭自动检查；显式的 `frogp status --refresh-update` 与 `frogp update`
仍由你主动执行。

预览版是公开且不可变的候选版本，稳定性可能不如正式版。`preview` tag 会指向更新的候选版本；
如需固定某个候选版本，请安装其确切版本号。维护者请遵循
[基于标签的发布流程](structure/06_docs-and-release.md#release-strategy)。

frogprogsy 需要 [Bun](https://bun.sh) 1.1 或更新版本。如果找不到 `frogp` 命令，请确认 Bun 已加入 `PATH`。

<details>
<summary><b>还没有 Bun，或需要从源码安装？</b></summary>

需要时先安装 Bun：

```bash
# macOS / Linux / WSL
curl -fsSL https://bun.sh/install | bash

# Windows PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
```

也可以不用 registry package，改为从源码仓库安装：

```bash
git clone https://github.com/zhsks311/Frogprogsy.git
cd Frogprogsy
bun add -g .
frogp --version
```

安装 Bun 或全局 package 后，请重新打开终端。

</details>

### 2. 启动本地 relay

```bash
frogp start
```

默认仪表盘地址是 `http://localhost:3764`（`3764` 在电话键盘上正好拼出 FROG）。如果实际使用了其他端口，下一步的 `frogp gui` 会打开当前仪表盘。`frogp start` 会为所有已配置的 Claude Code 目录同步 FrogProgsy 拥有的 gateway 设置和 model catalog 条目。

`frogp stop` 会停止 relay，并在所有已配置目录中恢复 FrogProgsy 添加的 Claude Code 设置和 catalog 条目。`frogp restore` 执行相同的原生状态清理，但不会停止 relay。`frogp uninstall` 还会删除 FrogProgsy 配置和托管的账户快捷命令；如果是 Bun 管理的安装，也会删除全局 package。三个命令都会保留原生 `~/.claude*` 目录、全局 Claude credential 和无关的 Claude 设置。

<details>
<summary><b>在 Docker 中运行 proxy？</b></summary>

首次启动前，请在 container 环境中为 `FROGP_LOCAL_ACCESS_KEY` 设置一个高强度 secret；entrypoint 只存储其 hash。在一个 terminal 中构建并运行随仓库提供的 Docker Compose 服务：

```bash
export FROGP_LOCAL_ACCESS_KEY='<strong-secret>'
docker compose up --build
```

```powershell
$env:FROGP_LOCAL_ACCESS_KEY='<strong-secret>'
docker compose up --build
```

Compose 运行期间请保持该 terminal 打开，或者添加 `-d` 让它在 detached mode 中运行。Compose 文件会设置 `FROGP_EXTERNAL_SUPERVISOR=1`，让 container 内 proxy 绑定到 `0.0.0.0`，在 host loopback 上发布 `3764` 端口，并把配置保存在 `frogprogsy-config` volume 中。Crash recovery 由 Docker restart policy 负责，因此 frogprogsy 不会在 container 内启动自己的 watchdog。

在另一个 client terminal 中，让 Claude Code 指向 host 暴露的 gateway，并通过专用 relay header 发送同一个 secret：

```bash
export ANTHROPIC_BASE_URL='http://localhost:3764'
export ANTHROPIC_CUSTOM_HEADERS='x-frogp-local-key: <strong-secret>'
claude
```

```powershell
$env:ANTHROPIC_BASE_URL='http://localhost:3764'
$env:ANTHROPIC_CUSTOM_HEADERS='x-frogp-local-key: <strong-secret>'
claude
```

所有 upstream `Authorization` 或 `x-api-key` credential 都应保留在原来的 header 中；`ANTHROPIC_CUSTOM_HEADERS` 会添加 relay key，而不会替换其中任何一个。

</details>

### 3. 在仪表盘添加 provider

```bash
frogp gui
```

在仪表盘中按下面顺序连接第一个 provider：

1. 打开 **Add Provider**。
2. 选择内置 provider，或输入 OpenAI-compatible endpoint。
3. 保存 API key，对支持 OAuth 的 provider（Codex/ChatGPT、xAI、Kimi）登录，或通过官方 `kiro-cli` 与 `frogp login kiro` 导入 Kiro。Anthropic Claude 的订阅认证留在 Claude Code 目录中；添加 Anthropic provider 会创建 forward-auth 模型选择器条目，但 frogprogsy 不存储 Claude token。
4. 选择默认 provider 和 model。
5. 确认模型列表出现在 Claude Code 的模型选择器中。
如果更改 provider 或 model 后 Claude Code 模型选择器看起来还是旧列表，请刷新 Claude Code profile 的模型列表，然后从新的 Claude Code 会话或 resume 后的会话重新打开选择器：

```bash
frogp claude reload-models <profile-id>
```

已经打开的 `/model` 页面不会 hot reload；需要启动新的 `claude` 会话或 resume 一个会话，让 Claude Code 重新获取 `/v1/models`。

FrogProgsy 会在 proxy 启动时检查经过验证的最新模型资料。安装版本自带的 catalog 只记录各 provider 路径已验证的当前 model ID、context limit 和 Claude Code 输入能力；即使名称相同，也不会套用其他登录方式或 gateway 的值。要启用更新后的列表，请重启 proxy；检查失败时，FrogProgsy 会比较上次验证后保存的副本与当前安装版本自带的模型资料，并使用 catalog revision 较高的一份。API key、已选默认模型和手动添加的模型不会改变。运行 `frogp models` 可以查看每个模型是**已验证**还是**仅发现**，以及当前模型资料的来源。

已配置的模型停止提供或暂时失败时，可以在 dashboard **Models** 页面或 `frogp models continuity` 中查看受影响的设置和精确修复操作。自动替代在你显式启用前保持关闭，也不会自动改写已选择的模型。完整说明见 [frogp 命令](https://zhsks311.github.io/Frogprogsy/zh-cn/reference/cli/#models)、[配置参考](https://zhsks311.github.io/Frogprogsy/zh-cn/reference/configuration/#模型连续性)与[仪表盘流程](https://zhsks311.github.io/Frogprogsy/zh-cn/guides/web-dashboard/#替换已停止提供的模型)。

`frogp start`/`frogp refresh` 会在 `~/.frogprogsy/bin` 为每个附加 Claude 账户生成一个快捷命令，例如 `claude-work` 或 `claude-personal`。默认账户使用普通的 `claude` 命令，该名称始终保留给用户安装的 Claude Code。请将快捷命令目录追加到 `PATH` 末尾。Proxy 停止时，账户快捷命令会按所选目录直通原生 Claude Code。

### 4. 发送第一条 Claude Code 请求

```bash
claude "解释这个项目的入口点"
```

要路由到其他 model，或使用 `provider/model` alias，请继续阅读[模型路由](https://zhsks311.github.io/Frogprogsy/zh-cn/guides/model-routing/)。

## 指定 auto-mode 审查模型（预览版）

把主模型设为 GPT，并不会自动把 Claude Code 内部的两次 auto-mode 审查调用也设为 GPT；它们是独立请求。要配置这项预览功能，请先在仪表盘选择一组明确的审查 provider/model，再为需要使用该功能的每个 Claude Code 目录启用 **Route auto-mode reviews**。只有保留的审查路由会使用这个目标；普通 provider fallback 和 Model Mixing 都不会替换它。

此行为已在 Claude Code 2.1.220 上验证。更改目录设置后，请重启或 resume Claude Code 会话。启用该路由时，切换主模型要选择 FrogProgsy gateway catalog 中的精确条目，不要使用 Claude Code 内置的 `sonnet` 快捷名。详见[Dashboard 与 Activity](https://zhsks311.github.io/Frogprogsy/zh-cn/guides/web-dashboard/#自动模式审查路由)和[配置参考](https://zhsks311.github.io/Frogprogsy/zh-cn/reference/configuration/#自动模式审查路由)。

## 可选：连接 Claude 订阅（dual-auth grant）

默认情况下，Anthropic provider 使用 **forward** mode：frogprogsy 不存储 Claude token，而是在请求时复用当前 Claude Code 目录的订阅认证。不需要额外设置；原生 `~/.claude*` 目录和多个 Claude 账户保持不变。

如果希望 Claude 订阅在同一 session 或 `frogp/mix` roster 中与 Codex 一起响应，又不想让每次调用都依赖已登录的 Claude Code 目录，可以添加一个可选、隔离的 **Claude grant**：

```bash
frogp claude grants add "Work Claude"     # prints a login command; frogprogsy never runs it
frogp claude grants status                # ok / expiring / none / unreadable / reauth_required / dangling — no secrets
frogp providers set anthropic --auth claude-grant --grant <cg_id>
```

- Grant 是一次独立的 Claude 登录，由你使用真实的 `claude` executable 登录到 frogprogsy 拥有的 `CLAUDE_CONFIG_DIR`。`frogp claude grants add` 创建 grant record 和 scoped directory，并打印 `CLAUDE_CONFIG_DIR=<grant-dir> claude auth login --claudeai` 命令；它不会自动登录、打开 browser、复制 token，也不会接管原生 `~/.claude*` 目录或全局 Keychain login。登录后，使用 `frogp claude grants status` 或 dashboard 确认 scoped credential 已出现。
- Grant custody 相互隔离并且 fail-closed：grant token 只服务于已绑定的 Anthropic provider；Codex OAuth 始终是独立 credential。如果 refresh 失败，provider 会返回 typed re-auth error，而不是 fallback 到其他 credential。
- 设置 grant 时需要同意；任何使用订阅认证的 live 诊断还需要显式 `--yes` 或 dashboard 确认，普通 routed request 不会每次要求确认。这种 custody 会把订阅 token 交给 frogprogsy，因此订阅认证调用会带来任何保护措施都无法消除的 Anthropic ToS、account 和 quota risk。如果不接受，请使用同样支持 headless/API caller 的 Anthropic API-key provider。

Grant readiness 状态、re-auth 和 `frogp doctor claude` 详见[Claude Code 接入指南](https://zhsks311.github.io/Frogprogsy/zh-cn/guides/claude-integration/)。

## model-mixing 配置

现在可以在仪表盘的 **Model Mixing** 标签页中，无需编辑 JSON，直接应用 Low、Balanced 或 Research 预设并启用 `frogp/mix`。面向用户的仪表盘流程和 caveats 见[模型混合指南](https://zhsks311.github.io/Frogprogsy/zh-cn/guides/model-mixing/)。

Model mixing 是 opt-in 功能，启用前不会改变行为。仪表盘预设包括 Low（4 次答案调用，0 次搜索）、Balanced（5 次答案调用，0 次搜索）和 Research（11 次答案调用，最多 3 次搜索）。应用预设不会自动启用；Enable 开关需要单独确认。启用后，Claude Code 模型列表会出现 `frogp/mix`。

Research/F3 在冻结的 60 题 `local-suite-v1` 上，相对最强单模型基线（`gpt-5.5`）通过评估：delta `+0.1333`，95% CI `[+0.0583, +0.2000]`。Caveats：hard reasoning 没有改善，收益集中在分析/编码；评分使用单一 judge；响应延迟约 p50 `29s` / p95 `3.7 分钟`；该声明仅限 suite-v1。

| 预设 | 用途 | 每次请求答案调用 | 搜索调用 |
| --- | --- | ---: | ---: |
| Low | 不搜索的小型专家组 | `4` | `0` |
| Balanced | 质量比速度更重要时做更多比较 | `5` | `0` |
| Research | 能等待，且分析/编码质量更重要时 | `11` | 最多 `3` |

## 接下来阅读

README 只覆盖第一次成功使用的路径。官方完整文档位于 docs-site。

| 要做什么 | 文档 |
| --- | --- |
| 查看安装行为和首次运行生成的文件 | [安装 frogp](https://zhsks311.github.io/Frogprogsy/zh-cn/getting-started/installation/) |
| 详细走一遍首次 relay 启动 | [启动并验证](https://zhsks311.github.io/Frogprogsy/zh-cn/getting-started/quickstart/) |
| 配置 provider、OAuth、API key、本地 endpoint | [provider 设置](https://zhsks311.github.io/Frogprogsy/zh-cn/guides/providers/) |
| 查看 dashboard activity 与 usage | [Dashboard 与 Activity](https://zhsks311.github.io/Frogprogsy/zh-cn/guides/web-dashboard/) |
| 阅读 CLI、config JSON、adapter 参考 | [CLI 参考](https://zhsks311.github.io/Frogprogsy/zh-cn/reference/cli/) · [配置参考](https://zhsks311.github.io/Frogprogsy/zh-cn/reference/configuration/) · [adapter 参考](https://zhsks311.github.io/Frogprogsy/zh-cn/reference/adapters/) |

`frogp init`、config JSON、provider 矩阵、capability fallback 等高级主题不放在 README 主路径中，而是在上面的文档中维护。

许可证：MIT
