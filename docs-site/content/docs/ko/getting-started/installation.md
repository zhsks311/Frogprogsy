---
title: frogp 설치
description: "FrogProgsy 명령을 설치하고, 첫 실행 전 필요한 준비물을 확인합니다."
---

`frogp`는 FrogProgsy를 실행하는 명령입니다. Claude Code 앞에서 로컬 연결을 열고, 요청을 사용자가 고른 AI 서비스로 보냅니다. 이 페이지는 설치까지만 다룹니다. 첫 AI 서비스와 기본 모델은 다음 단계에서 대시보드로 설정합니다.

## 필요 항목

| 필요 항목 | 설명 |
| --- | --- |
| Bun 1.1+ | `frogp` 실행에 필요합니다. 소스 checkout에서 설치하더라도 Bun이 `PATH`에 있어야 합니다. |
| Claude Code | CLI, App, SDK 모두 지원합니다. FrogProgsy는 Claude Code 실행 파일을 고치지 않습니다. |
| 연결할 AI 서비스 | API 키, OAuth 계정, 기존 로그인 전달, 로컬 서버, OpenAI 호환 서버 중 하나 |

## 설치

기본 설치는 레지스트리의 안정판 `latest` 채널을 사용하며, 현재 버전은 `0.0.1`입니다.

```bash
bun add -g frogprogsy
frogp --version
```

현재 시험판 `0.0.2-preview.1`을 사용하려면 `preview` 채널을 명시하세요.

```bash
bun add -g frogprogsy@preview
```

`frogp update`는 Bun으로 설치한 패키지를 항상 안정판 `latest`로 업데이트합니다. 시험판을 계속 쓰려면 Bun으로 `frogprogsy@preview`를 다시 설치하세요.

레지스트리 패키지 대신 소스 저장소에서 설치하려면 다음 명령을 사용합니다.

```bash
git clone https://github.com/zhsks311/Frogprogsy.git
cd Frogprogsy
bun add -g .
frogp --version
```

설치가 끝났으면 로컬 연결을 바로 시작합니다.

```bash
frogp start
```

`frogp start`는 로컬 연결을 열고 Claude Code가 볼 모델 목록을 맞춥니다.
AI 서비스 추가, 기본 AI 서비스/모델 선택, 첫 `claude` 요청은 [처음 실행하기](/frog-progsy/ko/getting-started/quickstart/)에서 이어집니다.

## Docker Compose

저장소에는 컨테이너 서비스로 실행하기 위한 검증된 `Dockerfile`과 `docker-compose.yml`이 포함되어 있습니다.

처음 시작하기 전에 충분히 긴 relay key를 `FROGP_LOCAL_ACCESS_KEY`로 내보내고 password manager나 container secret store에 보관하세요. Compose가 이 값을 entrypoint에 전달하면 hash만 저장하고 평문은 container log에 남기지 않습니다. Volume에 enabled key가 저장된 뒤에는 환경 변수 없이 다시 시작할 수 있습니다.

```bash
docker compose up --build
```

컨테이너는 FrogProgsy 상태를 `/config`에 쓰고, 이 경로는 `frogprogsy-config` 볼륨으로 보존됩니다. Entrypoint는 Docker 포트 공개가 프록시에 닿도록 `config.json`의 `hostname`을 `"0.0.0.0"`으로 준비하고, Compose 파일은 `FROGP_EXTERNAL_SUPERVISOR=1`을 설정해 crash 복구를 프로세스 내부 watchdog이 아니라 Docker가 맡게 합니다.

기본 설정에서는 host의 `127.0.0.1`에만 `http://localhost:3764`를 공개합니다. 컨테이너 내부에서는 계속 `0.0.0.0`으로 수신하지만 LAN에서는 relay 포트에 직접 접근할 수 없습니다. 컨테이너 포트는 그대로 두고 host 포트만 바꾸려면 다음처럼 실행하세요.

```bash
FROGP_HOST_PORT=3765 docker compose up --build
```

Claude Code는 호스트에 열린 gateway를 보게 설정하세요. 예: `ANTHROPIC_BASE_URL=http://localhost:3764`.

Local access key는 한 번 노출되면 다시 사용할 수 있는 bearer secret이므로 평문 HTTP로 원격 전송하면 안 됩니다. 다른 머신에서 접속해야 한다면 loopback 전용 port mapping을 유지하고 host의 TLS reverse proxy를 앞에 두세요. Relay 포트를 loopback이 아닌 interface에 HTTP로 직접 공개하지 마세요.

Client는 relay key를 `x-frogp-local-key`로 보내는 방식을 기본으로 사용하세요. `forward` provider가 실제 upstream credential을 `Authorization`이나 `x-api-key`로 보낸다면 해당 값을 그대로 유지하고, 그 header를 relay key 용도로 겸용하지 마세요.

## 처음 설치할 때는 넘겨도 되는 것

- `frogp init`은 터미널에서 하나씩 설정하고 싶을 때 쓰는 다른 방법입니다. 처음에는 `frogp gui` 대시보드로 시작하는 흐름을 권장합니다.
- `frogp restore`와 `frogp uninstall`은 문제가 생겼을 때 되돌리는 명령이며, 자세한 내용은 [frogp 명령](/frog-progsy/ko/reference/cli/)에 있습니다.
- `config.json`을 직접 고쳐야 하는 경우는 [설정 파일 항목](/frog-progsy/ko/reference/configuration/)에서 다룹니다.
- 소스 checkout과 대시보드 개발 서버 실행은 기여자/개발 작업에만 필요합니다.

다음: [처음 실행하기](/frog-progsy/ko/getting-started/quickstart/).
