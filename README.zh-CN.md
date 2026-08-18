<p align="center">
  <img src="assets/banner.png" alt="frogprogsy — 让 Claude Code 接入任意 LLM" width="820">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <b>简体中文</b> · <a href="https://zhsks311.github.io/Frogprogsy/zh-cn/"><b>完整文档</b></a>
</p>

frogprogsy 是运行在 Claude Code 前面的本地 provider 网关。先在仪表盘中连接 provider，然后照常使用 Claude Code。

## 快速开始：在仪表盘连接第一个 provider

### 1. 安装

```bash
bun add -g frogprogsy
frogp --version
```

不带 tag 时会安装稳定版 `latest` 渠道，当前版本是 `0.0.1`。要试用当前预览版 `0.0.2-preview.1`，请明确安装 `preview` 渠道：

```bash
bun add -g frogprogsy@preview
```

`frogp update` 始终把 Bun 管理的安装切换到稳定版 `latest`。要继续使用预览版，请用 Bun 重新安装 `frogprogsy@preview`。

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

默认仪表盘地址是 `http://localhost:3764`（`3764` 在电话键盘上正好拼出 FROG）。如果实际使用了其他端口，下一步的 `frogp gui` 会打开当前仪表盘。

<details>
<summary><b>在 Docker 中运行 proxy？</b></summary>

构建并运行随仓库提供的 Docker Compose 服务：

```bash
docker compose up --build
```

Compose 文件会设置 `FROGP_EXTERNAL_SUPERVISOR=1`，让容器内 proxy 绑定到 `0.0.0.0`，发布 `3764` 端口，并把配置保存在 `frogprogsy-config` volume 中。Crash recovery 由 Docker restart policy 负责，因此 frogprogsy 不会在容器内启动自己的 watchdog。

让 Claude Code 指向宿主机暴露出来的 gateway，例如 `ANTHROPIC_BASE_URL=http://localhost:3764`。

</details>

### 3. 在仪表盘添加 provider

```bash
frogp gui
```

在仪表盘中按下面顺序连接第一个 provider：

1. 打开 **Add Provider**。
2. 选择内置 provider，或输入 OpenAI-compatible endpoint。
3. 保存 API key，或对支持 OAuth 的 provider（Codex/ChatGPT、xAI、Kimi）登录。Anthropic Claude 的订阅认证留在 Claude Code 目录中；添加 Anthropic provider 会创建 forward-auth 模型选择器条目，但 frogprogsy 不存储 Claude token。
4. 选择默认 provider 和 model。
5. 确认模型列表出现在 Claude Code 的模型选择器中。
如果更改 provider 或 model 后 Claude Code 模型选择器看起来还是旧列表，请刷新 Claude Code profile 的模型列表，然后从新的 Claude Code 会话或 resume 后的会话重新打开选择器：

```bash
frogp claude reload-models <profile-id>
```

已经打开的 `/model` 页面不会 hot reload；需要启动新的 `claude` 会话或 resume 一个会话，让 Claude Code 重新获取 `/v1/models`。

FrogProgsy 会在 proxy 启动时检查经过验证的最新模型资料。要启用更新后的列表，请重启 proxy；检查失败时，FrogProgsy 会比较上次验证后保存的副本与当前安装版本自带的模型资料，并使用 catalog revision 较高的一份。API key、已选默认模型和手动添加的模型不会改变。运行 `frogp models` 可以查看每个模型是**已验证**还是**仅发现**，以及当前模型资料的来源。

已配置的模型停止提供或暂时失败时，可以在 dashboard **Models** 页面或 `frogp models continuity` 中查看受影响的设置和精确修复操作。自动替代在你显式启用前保持关闭，也不会自动改写已选择的模型。完整说明见 [frogp 命令](https://zhsks311.github.io/Frogprogsy/zh-cn/reference/cli/#models)、[配置参考](https://zhsks311.github.io/Frogprogsy/zh-cn/reference/configuration/#模型连续性)与[仪表盘流程](https://zhsks311.github.io/Frogprogsy/zh-cn/guides/web-dashboard/#替换已停止提供的模型)。

`frogp start`/`frogp refresh` 会在 `~/.frogprogsy/bin` 为每个附加 Claude 账户生成一个快捷命令，例如 `claude-work` 或 `claude-personal`。默认账户使用普通的 `claude` 命令，该名称始终保留给用户安装的 Claude Code。请将快捷命令目录追加到 `PATH` 末尾。Proxy 停止时，账户快捷命令会按所选目录直通原生 Claude Code。

### 4. 发送第一条 Claude Code 请求

```bash
claude "解释这个项目的入口点"
```

要路由到其他 model，或使用 `provider/model` alias，请继续阅读[模型路由](https://zhsks311.github.io/Frogprogsy/zh-cn/guides/model-routing/)。

## 指定 auto-mode 审查模型（预览版）

把主模型设为 GPT，并不会自动把 Claude Code 内部的两次 auto-mode 审查调用也设为 GPT；它们是独立请求。在 `0.0.2-preview.1` 中，先在仪表盘选择一组明确的审查 provider/model，再为需要使用该功能的每个 Claude Code 目录启用 **Route auto-mode reviews**。只有保留的审查路由会使用这个目标；普通 provider fallback 和 Model Mixing 都不会替换它。

此行为已在 Claude Code 2.1.220 上验证。更改目录设置后，请重启或 resume Claude Code 会话。启用该路由时，切换主模型要选择 FrogProgsy gateway catalog 中的精确条目，不要使用 Claude Code 内置的 `sonnet` 快捷名。详见[Dashboard 与 Activity](https://zhsks311.github.io/Frogprogsy/zh-cn/guides/web-dashboard/#自动模式审查路由)和[配置参考](https://zhsks311.github.io/Frogprogsy/zh-cn/reference/configuration/#自动模式审查路由)。

## 可选：连接 Claude 订阅（dual-auth grant）

<details>
<summary><b>isolated Claude 订阅 grant（Branch B）</b></summary>

上面的 forward-auth 是默认行为，也是零托管：frogprogsy 不保存 Claude token，你的 native `~/.claude` homes 和多账户保持不变。如果需要在无人值守或脚本 caller 中使用 Claude 订阅，可以另外发放一个仅供 frogprogsy 使用、与 native home 及全局 Keychain 登录完全隔离的订阅凭据。

```bash
frogp claude grants add "工作订阅"
frogp providers set anthropic --auth claude-grant --grant <grant-id>
frogp claude grants status
```

`grants add` 不会自动登录：它只创建 grant 记录和隔离目录，并用已验证的真实 Claude 可执行文件和一个隔离的 `CLAUDE_CONFIG_DIR` 打印一条手动登录命令。add 本身不验证凭据；你亲自完成 Claude 登录后，再由 `grants status`（或仪表盘）核对隔离 scoped 凭据是否就绪。`grants status` 只报告 `ok`/`reauth_required`/`dangling` 这类就绪状态，不显示任何 secret。绑定后的 grant 可以和 Codex/ChatGPT 等 OAuth 登录在同一 session 及 model mixing 中并存，Codex OAuth 保持独立。

Grant 是 opt-in 的托管选择：携带订阅认证的网络请求可能触及 Anthropic 服务条款，并带来 account/quota 层面的后果。显式同意用于选择启用 grant，以及 `frogp claude auth probe-b --live --yes` 这类实时订阅诊断，而不是每个正常 provider 请求都弹确认。不想托管订阅、或需要纯 headless/API 认证时，Anthropic API-key provider 仍是随时可用的替代方案。frogprogsy 不复制 token，也不接管全局登录。详见[Claude Code 接入指南](https://zhsks311.github.io/Frogprogsy/zh-cn/guides/claude-integration/)。

</details>

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
