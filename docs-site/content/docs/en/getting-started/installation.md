---
title: Install frogp
description: "Install the FrogProgsy local relay command and check what you need before the first successful route."
---

`frogp` is the FrogProgsy command. It starts a local HTTP relay in front of Claude Code and routes traffic only to providers you configure. This page stops at installation. Add the first provider and choose the default model from the dashboard in the next step.

## What you need

| Requirement | Notes |
| --- | --- |
| Bun 1.1+ | Runtime for the `frogp` binary. Bun must be on `PATH` even when you install from a source checkout. |
| Claude Code | CLI, App, or SDK. FrogProgsy uses gateway settings and does not patch binaries. |
| Provider lane | API key, OAuth account, forward provider, local server, or custom OpenAI-compatible endpoint. |

## Install

The normal install follows the stable `latest` registry channel, currently `0.0.1`:

```bash
bun add -g frogprogsy
frogp --version
```

To test the current prerelease, `0.0.2-preview.1`, select the `preview` channel explicitly:

```bash
bun add -g frogprogsy@preview
```

`frogp update` always updates a Bun-managed install to stable `latest`. To remain on the prerelease channel, reinstall `frogprogsy@preview` with Bun.

For a source checkout instead of the registry package:

```bash
git clone https://github.com/zhsks311/Frogprogsy.git
cd Frogprogsy
bun add -g .
frogp --version
```

After installation, start the relay directly:

```bash
frogp start
```

`frogp start` opens the local gateway and synchronizes the FrogProgsy-owned Claude Code settings and model catalog. Provider setup, default provider/model selection, and the first `claude` request continue in [First Relay Run](/frog-progsy/getting-started/quickstart/).

## Docker Compose

The repository includes a tested `Dockerfile` and `docker-compose.yml` for running the relay as a containerized service:

```bash
docker compose up --build
```

The container writes FrogProgsy state under `/config`, exposed as the `frogprogsy-config` volume. Its entrypoint seeds `config.json` with `hostname: "0.0.0.0"` so Docker port publishing can reach the relay, and the Compose file sets `FROGP_EXTERNAL_SUPERVISOR=1` so Docker owns crash recovery instead of the in-process watchdog.

By default the host receives `http://localhost:3764`. To use a different host port without changing the container port:

```bash
FROGP_HOST_PORT=3765 docker compose up --build
```

Point Claude Code at the host-exposed gateway, for example `ANTHROPIC_BASE_URL=http://localhost:3764`.

## Advanced installation notes

- `frogp init` is the alternate setup path when you need a CLI wizard. The first-success path is dashboard-first with `frogp gui`.
- Recovery commands such as `frogp restore` and `frogp uninstall` are covered in the [CLI reference](/frog-progsy/reference/cli/).
- Operators who must edit JSON directly should use the [Configuration reference](/frog-progsy/reference/configuration/).
- Source checkouts and the dashboard development server are contributor/development workflows, not the normal install path.

Next: [First Relay Run](/frog-progsy/getting-started/quickstart/).
