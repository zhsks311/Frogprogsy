---
title: 安装 frogp
description: "安装 FrogProgsy local relay command，并检查进入首次成功路径前的准备项。"
---

`frogp` 是 FrogProgsy command。它在 Claude Code 前启动 local HTTP relay，traffic 只会 route 到你配置的 provider。
本页只覆盖安装。第一个 provider 与默认模型会在下一步通过 dashboard 设置。

## 需求

| 需求 | 说明 |
| --- | --- |
| Bun 1.1+ | `frogp` binary runtime。即使从 source checkout 安装，Bun 也必须在 `PATH` 中。 |
| Claude Code | CLI、App、SDK。FrogProgsy 使用 gateway settings，不 patch binary。 |
| Provider lane | API key、OAuth account、forward provider、local server 或 custom OpenAI-compatible endpoint 之一 |

## 安装

默认安装使用 registry 的稳定版 `latest` 渠道，当前版本是 `0.0.1`：

```bash
bun add -g frogprogsy
frogp --version
```

要测试当前预览版 `0.0.2-preview.1`，请明确选择 `preview` 渠道：

```bash
bun add -g frogprogsy@preview
```

`frogp update` 始终把 Bun 管理的安装更新到稳定版 `latest`。要继续使用预览版，请用 Bun 重新安装 `frogprogsy@preview`。

如果要从源码仓库安装，而不是使用 registry package：

```bash
git clone https://github.com/zhsks311/Frogprogsy.git
cd Frogprogsy
bun add -g .
frogp --version
```

安装完成后直接启动 relay。

```bash
frogp start
```

`frogp start` 会打开本地 gateway，并同步 Claude Code 使用的 FrogProgsy-owned settings 与 model catalog。
Provider 添加、默认 provider/model 选择、第一条 `claude` 请求在 [首次 Relay 运行](/frog-progsy/zh-cn/getting-started/quickstart/) 中继续。

## Docker Compose

仓库包含经过验证的 `Dockerfile` 和 `docker-compose.yml`，可以把 relay 作为容器服务运行：

首次启动前，请把足够强的 relay key 导出为 `FROGP_LOCAL_ACCESS_KEY`，并保存在 password manager 或 container secret store 中。Compose 会把它传给 entrypoint；entrypoint 只保存 hash，绝不把明文写入 container log。Volume 中已有 enabled key 后，之后重启无需再次提供该环境变量。

```bash
docker compose up --build
```

容器会把 FrogProgsy 状态写到 `/config`，该路径由 `frogprogsy-config` volume 持久化。Entrypoint 会把 `config.json` 的 `hostname` 设置为 `"0.0.0.0"`，让 Docker 端口发布能访问 relay；Compose 文件设置 `FROGP_EXTERNAL_SUPERVISOR=1`，因此 crash recovery 由 Docker 负责，而不是由进程内 watchdog 负责。

默认情况下，Compose 只在 host 的 `127.0.0.1` interface 上发布 `http://localhost:3764`。容器内部仍监听 `0.0.0.0`，但 LAN 无法直接访问 relay port。如果只想改变 host port、不改变容器 port：

```bash
FROGP_HOST_PORT=3765 docker compose up --build
```

让 Claude Code 指向宿主机暴露出来的 gateway，例如 `ANTHROPIC_BASE_URL=http://localhost:3764`.

Local access key 是可重复使用的 bearer secret，明文 HTTP 无法防止 network path 上的观察者获取它。需要远程访问时，请保留仅 loopback 的 port mapping，并在 host 上使用终止 TLS 的 reverse proxy。不要通过 HTTP 把 relay port 直接发布到非 loopback interface。

Client 默认应通过 `x-frogp-local-key` 发送 relay key。如果 `forward` provider 使用 `Authorization` 或 `x-api-key` 传递真实的 upstream credential，请保留该 credential，不要复用这两个 header 来发送 relay key。

## 高级安装备注

- `frogp init` 是需要 CLI wizard 时使用的替代配置路径。首次成功路径以 `frogp gui` dashboard 为准。
- `frogp restore` 与 `frogp uninstall` 等恢复命令见 [CLI reference](/frog-progsy/zh-cn/reference/cli/)。
- 必须直接编辑 JSON 的 operator 可使用 [Configuration reference](/frog-progsy/zh-cn/reference/configuration/)。
- Source checkout 与 dashboard development server 只在 contributor/development workflow 中需要。

下一步：[首次 Relay 运行](/frog-progsy/zh-cn/getting-started/quickstart/)。
