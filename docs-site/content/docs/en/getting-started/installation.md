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

`frogp start` opens the local gateway and synchronizes the FrogProgsy-owned Claude Code settings and model catalog. Provider setup, default provider/model selection, and the first `claude` request continue in [First Relay Run](/getting-started/quickstart/).

## Docker Compose

The repository includes a tested `Dockerfile` and `docker-compose.yml` for running the relay as a containerized service:

Before the first start, export a strong relay key as `FROGP_LOCAL_ACCESS_KEY` and retain it in your password manager or container secret store. Compose passes it to the entrypoint, which stores only its hash and never writes the plaintext to container logs. Once the volume contains an enabled key, later restarts do not require the environment value.

```bash
docker compose up --build
```

The container writes FrogProgsy state under `/config`, exposed as the `frogprogsy-config` volume. Its entrypoint seeds `config.json` with `hostname: "0.0.0.0"` so Docker port publishing can reach the relay, and the Compose file sets `FROGP_EXTERNAL_SUPERVISOR=1` so Docker owns crash recovery instead of the in-process watchdog.

By default Compose publishes `http://localhost:3764` on the host's `127.0.0.1` interface only. The container still listens on `0.0.0.0` internally, but the relay is not exposed directly to the LAN. To use a different host port without changing the container port:

```bash
FROGP_HOST_PORT=3765 docker compose up --build
```

Point Claude Code at the host-exposed gateway, for example `ANTHROPIC_BASE_URL=http://localhost:3764`.

Local access keys are bearer secrets, and plain HTTP does not protect them from observers on the network path. For remote access, keep this loopback-only port mapping and put a TLS-terminating reverse proxy on the host in front of it. Do not publish the relay port directly on a non-loopback interface over HTTP.

Clients should send this relay key in `x-frogp-local-key`. If a `forward` provider uses `Authorization` or `x-api-key` for its real upstream credential, keep that credential in place; do not reuse either header for the relay key.

## Advanced installation notes

- `frogp init` is the alternate setup path when you need a CLI wizard. The first-success path is dashboard-first with `frogp gui`.
- Recovery commands such as `frogp restore` and `frogp uninstall` are covered in the [CLI reference](/reference/cli/).
- Operators who must edit JSON directly should use the [Configuration reference](/reference/configuration/).
- Source checkouts and the dashboard development server are contributor/development workflows, not the normal install path.

Next: [First Relay Run](/getting-started/quickstart/).
