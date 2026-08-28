<p align="center">
  <img src="assets/banner.png" alt="frogprogsy — 어떤 LLM이든 Claude Code에서 사용" width="820">
</p>

<p align="center">
  <a href="README.md">English</a> · <b>한국어</b> · <a href="README.zh-CN.md">简体中文</a> · <a href="https://zhsks311.github.io/Frogprogsy/ko/"><b>전체 문서</b></a>
</p>

frogprogsy는 Claude Code CLI, TUI, App, SDK 앞에 두고 쓰는 로컬 provider gateway입니다. frogprogsy package는 macOS, Linux, Windows를 지원합니다. Claude Code를 patch하지 않고 기존 gateway 설정을 사용합니다. 먼저 대시보드에서 AI 서비스를 연결하고, Claude Code는 평소처럼 실행하세요.

## 빠른 시작: 대시보드에서 첫 AI 서비스 연결하기

### 1. 설치

```bash
bun add -g frogprogsy
frogp --version
```

태그를 붙이지 않으면 안정판 `latest` 채널을 설치합니다. 시험판을 사용하려면 `preview` 채널을 명시하세요.

```bash
bun add -g frogprogsy@preview
```

`frogp update`는 Bun으로 설치한 패키지를 항상 안정판 `latest`로 옮깁니다. 시험판을 계속 쓰려면 Bun으로 `frogprogsy@preview`를 다시 설치하세요.

일반 Bun 전역 안정판 설치에서는 프록시 시작 뒤 npm 안정판 릴리스 정보를 백그라운드에서 확인하고
대시보드와 `frogp status`에 사용 가능한 버전을 표시합니다. 자동 설치나 재시작은 하지 않습니다.
**자세한 설정**에서 자동 확인을 끌 수 있으며, 명시적인 `frogp status --refresh-update`와
`frogp update`는 계속 사용자가 직접 실행합니다.

시험판은 공개된 변경 불가 후보이므로 안정판보다 불안정할 수 있습니다. `preview` 태그는 새 후보로
이동하므로 특정 후보를 유지하려면 버전을 정확히 지정해 설치하세요. 유지관리자는
[라벨 기반 릴리스 절차](structure/06_docs-and-release.md#release-strategy)를 따르세요.

frogprogsy는 [Bun](https://bun.sh) 1.1 이상에서 실행됩니다. `frogp` 명령을 찾지 못하면 Bun이 `PATH`에 있는지 확인하세요.

<details>
<summary><b>Bun이 없거나 소스에서 설치하나요?</b></summary>

필요하면 먼저 Bun을 설치하세요.

```bash
# macOS / Linux / WSL
curl -fsSL https://bun.sh/install | bash

# Windows PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
```

레지스트리 패키지 대신 소스 저장소에서 설치할 수도 있습니다.

```bash
git clone https://github.com/zhsks311/Frogprogsy.git
cd Frogprogsy
bun add -g .
frogp --version
```

Bun이나 전역 패키지를 설치한 뒤에는 터미널을 새로 여세요.

</details>

### 2. 로컬 연결 시작

```bash
frogp start
```

기본 대시보드 주소는 `http://localhost:3764`입니다. `3764`는 전화 키패드에서 FROG를 나타냅니다. 다른 포트를 사용하게 되더라도 다음 단계의 `frogp gui`가 현재 대시보드를 엽니다. `frogp start`는 설정된 모든 Claude Code 홈에 FrogProgsy 소유 gateway 설정과 model catalog 항목을 동기화합니다.

`frogp stop`은 relay를 멈추고 설정된 모든 홈에서 FrogProgsy가 추가한 Claude Code 설정과 catalog 항목을 복원합니다. `frogp restore`는 relay를 멈추지 않고 같은 native 상태 정리를 수행합니다. `frogp uninstall`은 FrogProgsy 설정과 관리 계정 바로가기를 제거하고, Bun 관리 설치라면 전역 package도 제거합니다. 세 명령 모두 native `~/.claude*` 홈, 전역 Claude credential, 관련 없는 Claude 설정은 보존합니다.

<details>
<summary><b>Docker에서 프록시를 실행하나요?</b></summary>

처음 시작하기 전에 container 환경의 `FROGP_LOCAL_ACCESS_KEY`에 강한 비밀값을 설정하세요. Entrypoint는 hash만 저장합니다. 포함된 Docker Compose 서비스를 빌드하고 실행합니다.

```bash
# macOS / Linux / WSL
export FROGP_LOCAL_ACCESS_KEY='<strong-secret>'
docker compose up --build

# Windows PowerShell
$env:FROGP_LOCAL_ACCESS_KEY='<strong-secret>'
docker compose up --build
```

Compose 파일은 `FROGP_EXTERNAL_SUPERVISOR=1`을 설정하고, container 안의 proxy를 `0.0.0.0`에 bind하며, host loopback에 `3764` port를 공개하고, 설정을 `frogprogsy-config` volume에 보존합니다. Crash 복구는 Docker restart policy가 맡으므로 container 안에서는 frogprogsy 자체 watchdog을 띄우지 않습니다.

Claude Code는 host에 열린 gateway를 보게 설정하세요. 예: `ANTHROPIC_BASE_URL=http://localhost:3764`. 같은 relay 비밀값을 `x-frogp-local-key` header로 보내고, upstream `Authorization`이나 `x-api-key` credential은 원래 header에 그대로 두세요.

</details>

### 3. 대시보드에서 AI 서비스 추가

```bash
frogp gui
```

대시보드에서 다음 순서로 첫 AI 서비스를 연결하세요.

1. **Add Provider**를 엽니다.
2. 내장 항목을 선택하거나 OpenAI 호환 서버 주소를 입력합니다.
3. API 키를 저장하거나, OAuth를 지원하는 서비스(Codex/ChatGPT, xAI, Kimi)는 로그인합니다. Anthropic Claude는 구독 인증을 Claude Code 홈에 남기고, Anthropic provider를 추가하면 frogprogsy가 Claude 토큰을 저장하지 않는 forward-auth 모델 선택 항목이 생깁니다.
4. 기본으로 사용할 AI 서비스와 모델을 선택합니다.
5. 모델 목록이 Claude Code 모델 선택기에 반영되는지 확인합니다.
Provider나 모델을 바꾼 뒤 Claude Code 모델 선택기가 예전 목록처럼 보이면, Claude Code profile의 모델 목록을 새로고침한 다음 새 Claude Code 세션을 시작하거나 기존 세션을 resume해서 선택기를 다시 여세요.

```bash
frogp claude reload-models <profile-id>
```

이미 열려 있는 `/model` 화면은 hot reload되지 않습니다. 새 `claude` 세션을 시작하거나 resume해야 Claude Code가 `/v1/models`를 다시 가져옵니다.

FrogProgsy는 proxy를 시작할 때 검증된 최신 모델 자료를 확인합니다. 설치 버전의 기본 카탈로그에는 제공 경로별로 확인된 현재 모델 ID, 컨텍스트 크기, Claude Code 입력 형식만 들어가며, 이름이 같아도 다른 로그인 방식이나 gateway의 값을 대신 적용하지 않습니다. 새 목록을 적용하려면 proxy를 다시 시작하세요. 확인에 실패하면 마지막으로 검증해 저장한 사본과 설치 버전의 기본 자료를 비교해 catalog revision이 더 높은 쪽을 사용합니다. API 키, 사용자가 고른 기본 모델, 직접 추가한 모델은 바뀌지 않습니다. `frogp models`를 실행하면 각 모델이 **검증됨**인지 **발견됨**인지, 현재 어떤 모델 자료를 쓰는지 확인할 수 있습니다.

설정한 모델의 제공이 끝났거나 일시적으로 응답하지 않으면 대시보드 **Models** 화면과 `frogp models continuity`에서 영향을 받은 설정과 정확한 복구 방법을 확인할 수 있습니다. 자동 대체는 사용자가 켜기 전까지 꺼져 있고, 선택해 둔 모델을 자동으로 바꾸지 않습니다. 자세한 내용은 [frogp 명령](https://zhsks311.github.io/Frogprogsy/ko/reference/cli/#models), [설정 파일 항목](https://zhsks311.github.io/Frogprogsy/ko/reference/configuration/#모델-연속성), [대시보드 흐름](https://zhsks311.github.io/Frogprogsy/ko/guides/web-dashboard/#종료된-모델-교체하기)에서 확인하세요.

`frogp start`/`frogp refresh`는 `~/.frogprogsy/bin`에 추가 Claude 계정별 바로가기를 하나씩 만듭니다. 예: `claude-work`, `claude-personal`. 기본 계정은 평범한 `claude` 명령을 쓰며, 그 이름은 항상 사용자가 설치한 Claude Code로 남습니다. 바로가기 디렉터리는 `PATH` 뒤에 추가합니다. Proxy가 꺼져 있으면 계정별 바로가기는 선택한 홈의 원래 Claude Code로 그대로 통과합니다.

### 4. 첫 Claude Code 요청 보내기

```bash
claude "이 프로젝트의 진입점을 설명해 줘"
```

다른 모델로 보내거나 `provider/model` 값을 직접 쓰는 방법은 [모델 선택 규칙](https://zhsks311.github.io/Frogprogsy/ko/guides/model-routing/)에서 이어서 확인하세요.

## auto mode 모델 지정하기 (시험판)

메인 모델을 GPT로 골랐다고 해서 Claude Code가 내부적으로 두 번 호출하는 auto mode 모델까지 GPT가 되는 것은 아닙니다. 두 호출은 서로 별개입니다. 이 시험 기능을 사용하려면 대시보드에서 심사에 사용할 AI 서비스와 모델 한 쌍을 정한 뒤, 필요한 Claude Code 홈마다 **Route auto-mode reviews**를 켜세요. 지정된 심사 요청만 선택한 모델로 보내며, 일반 요청의 대체 경로나 Model Mixing이 심사 모델을 바꾸지 않습니다.

이 동작은 Claude Code 2.1.220에서 검증했습니다. 홈 설정을 바꾼 뒤에는 Claude Code 세션을 다시 시작하거나 resume하세요. 기능을 켠 동안 메인 모델을 바꿀 때는 Claude Code 내장 `sonnet` 단축명 대신 FrogProgsy 모델 목록의 정확한 항목을 선택해야 합니다. 자세한 사용법은 [대시보드와 사용 기록](https://zhsks311.github.io/Frogprogsy/ko/guides/web-dashboard/#auto-mode-경로)과 [설정 파일 항목](https://zhsks311.github.io/Frogprogsy/ko/reference/configuration/#auto-mode-라우팅)을 참고하세요.

## 선택: Claude 구독 연결(dual-auth grant)

기본적으로 Anthropic provider는 **forward** mode로 동작합니다. frogprogsy는 Claude token을 저장하지 않고 요청 시 활성 Claude Code 홈의 구독 인증을 다시 사용합니다. 추가 설정이 필요 없으며, native `~/.claude*` 홈과 여러 Claude 계정은 그대로 보존됩니다.

로그인된 Claude Code 홈에 매번 의존하지 않고 Claude 구독이 같은 session이나 `frogp/mix` roster에서 Codex와 함께 응답하게 하려면, 선택 사항인 격리 **Claude grant**를 추가하세요.

```bash
frogp claude grants add "Work Claude"     # prints a login command; frogprogsy never runs it
frogp claude grants status                # ok / reauth required / unreadable / none — no secrets
frogp providers set anthropic --auth claude-grant --grant <cg_id>
```

- Grant는 사용자가 실제 `claude` executable을 사용해 frogprogsy 소유 `CLAUDE_CONFIG_DIR`에 직접 로그인하는 별도 Claude login입니다. `frogp claude grants add`는 grant record와 scoped directory를 만들고 `CLAUDE_CONFIG_DIR=<grant-dir> claude auth login --claudeai` 명령을 출력합니다. 로그인을 자동화하거나 browser를 열거나 token을 복사하거나 native `~/.claude*` 홈 또는 전역 Keychain login을 인수하지 않습니다. 로그인 후 `frogp claude grants status` 또는 dashboard에서 scoped credential이 생겼는지 확인합니다.
- Grant custody는 격리되고 fail-closed입니다. Grant token은 연결된 Anthropic provider에만 쓰이고, Codex OAuth는 별도 credential로 유지됩니다. Refresh에 실패하면 다른 credential로 fallback하지 않고 typed re-auth error를 반환합니다.
- Grant 설정 시, 그리고 live 구독 인증 진단을 실행할 때 명시적 `--yes` 또는 dashboard 확인으로 동의합니다. 정상 routed request마다 동의하지는 않습니다. 이 custody는 frogprogsy에 구독 token을 맡기므로 구독 인증 요청에는 어떤 보호 장치로도 없앨 수 없는 Anthropic ToS, account, quota risk가 있습니다. 이를 원하지 않으면 headless/API caller도 지원하는 Anthropic API-key provider를 사용하세요.

Grant readiness 상태, re-auth, `frogp doctor claude`는 [Claude Code 연결 가이드](https://zhsks311.github.io/Frogprogsy/ko/guides/claude-integration/)에서 확인하세요.

## model-mixing 프로필

이제 대시보드의 **Model Mixing** 탭에서 JSON을 직접 고치지 않고 Low, Balanced, Research 프리셋을 적용하고 `frogp/mix`를 켤 수 있습니다. 대시보드 중심 사용법과 캐비앗은 [모델 섞어 쓰기 가이드](https://zhsks311.github.io/Frogprogsy/ko/guides/model-mixing/)에서 확인하세요.

Model mixing은 켜기 전까지 아무것도 바꾸지 않는 opt-in 기능입니다. 대시보드 프리셋은 Low(답변 호출 4번, 검색 0번), Balanced(답변 호출 5번, 검색 0번), Research(답변 호출 11번, 검색 최대 3번)입니다. 프리셋을 적용해도 자동으로 켜지지 않고, Enable 토글을 별도로 확인해야 합니다. 켜면 Claude Code 모델 목록에 `frogp/mix`가 나타납니다.

Research/F3는 frozen 60문항 `local-suite-v1` 평가에서 최강 단일 모델 기준선(`gpt-5.5`) 대비 delta `+0.1333`, 95% CI `[+0.0583, +0.2000]`로 통과했습니다. 캐비앗: hard reasoning은 개선되지 않았고 이득은 분석·코딩에 집중됐습니다. 단일 judge 채점이며, 응답 지연은 대략 p50 `29s` / p95 `3.7분`이고, 주장은 suite-v1에만 한정됩니다.

| 프로필 | 용도 | 요청당 답변 호출 | 검색 호출 |
| --- | --- | ---: | ---: |
| Low | 검색 없이 작은 전문가 패널 사용 | `4` | `0` |
| Balanced | 속도보다 품질이 중요할 때 더 많이 비교 | `5` | `0` |
| Research | 기다릴 수 있고 분석·코딩 품질이 중요할 때 | `11` | 최대 `3` |

## 다음에 볼 문서

README는 첫 성공 경로만 다룹니다. 공식 전체 문서는 docs-site입니다.

| 할 일 | 문서 |
| --- | --- |
| 설치와 첫 실행 파일 확인 | [frogp 설치](https://zhsks311.github.io/Frogprogsy/ko/getting-started/installation/) |
| 처음 실행 절차 자세히 보기 | [처음 실행하기](https://zhsks311.github.io/Frogprogsy/ko/getting-started/quickstart/) |
| AI 서비스, OAuth, API 키, 로컬 서버 설정 | [AI 서비스 연결](https://zhsks311.github.io/Frogprogsy/ko/guides/providers/) |
| 대시보드, 요청 기록, 사용량 확인 | [대시보드와 사용 기록](https://zhsks311.github.io/Frogprogsy/ko/guides/web-dashboard/) |
| frogp 명령, 설정 파일, 연결 방식 세부 | [frogp 명령](https://zhsks311.github.io/Frogprogsy/ko/reference/cli/) · [설정 파일 항목](https://zhsks311.github.io/Frogprogsy/ko/reference/configuration/) · [연결 방식 세부](https://zhsks311.github.io/Frogprogsy/ko/reference/adapters/) |

`frogp init`, config JSON, 서비스 목록, 부족한 기능 대신 처리 같은 고급 주제는 README의 기본 경로가 아니라 위 문서에서 관리합니다.

라이선스: MIT
