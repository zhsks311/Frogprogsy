---
title: 대시보드와 사용 기록
description: "AI 서비스 연결, 모델 표시, 자동 모드 확인, 요청 기록, 사용량, 종료를 한곳에서 다루는 FrogProgsy 관리 화면."
---

FrogProgsy의 전체 운영 문서는 docs-site의 `/ko/` 경로가 기준입니다. 대시보드는 실행 중인
FrogProgsy가 제공하는 로컬 관리 화면입니다. AI 서비스 추가, 기본 모델 선택, 모델 표시, 자동 모드 확인,
웹 검색/이미지 대신 처리, 요청 기록, 사용량, 종료를 한 화면에서 다룹니다.

## 열기

```bash
frogp gui
```

`http://localhost:<port>`를 열고, 필요하면 FrogProgsy를 먼저 시작합니다. 개발 중에는 서버와 GUI를 따로 실행할 수 있습니다.

```bash
frogp start
cd gui && bun dev
```

## 먼저 볼 화면

| 화면 | 용도 |
| --- | --- |
| **Dashboard** | 실행 상태, 설치/안정판 업데이트 상태, 버전, 연결한 서비스 수, 웹 검색/이미지 대신 처리 설정, 자동 모드 확인 모델 |
| **Providers** | OAuth 로그인, API 키 서비스, Anthropic Claude Code 홈 행, 직접 입력한 주소, 명시적으로 누르는 연결 테스트, 기본 서비스 변경, 삭제 |
| **Models** | 대시보드/API 모델 목록 새로고침: Claude Code에 노출되는 모델, 숨긴 모델, discovery 상태를 확인합니다. 대시보드와 `/v1/models`가 내보내는 목록을 다시 읽는 기능이며 Claude Code 선택기 복구 명령은 아닙니다. |
| **Claude Code 홈** | Claude 모델 선택이 아닌 이름이 있는 Claude Code 설정 디렉터리, pass-through 인증 상태, 주입/복원/새로고침, 홈별 모델 오버레이. 새로고침은 Claude Code 선택기 복구를 준비하고 해당 홈의 안정적인 `frogp claude reload-models <profile-id>` 명령을 보여줍니다. |
| **Activity** | 안전한 요청 단계 기록, 최근 로그, 날짜/모델/서비스별 로컬 사용량 |
| **Stop Proxy** | 안전하게 종료하고 Claude Code 설정을 원래대로 복원 |

새 안정판이 있으면 Home은 설치 버전 → 최신 버전, 정확한 `frogp update` 명령, 명시적
새로고침, 해당 버전 알림 닫기를 보여줍니다. 더 새 버전은 다시 나타납니다. **자세한 설정**은
자동 확인 토글과 npm 메타데이터만 확인한다는 개인정보 경계를 담당합니다. 대시보드는 버전을
직접 비교하거나 npm에 연결하지 않고 프록시의 공용 snapshot만 표시합니다.

## 모델 목록 새로고침과 Claude Code 선택기 복구

대시보드/API 모델 목록을 다시 읽어야 할 때는 **Models**를 사용하세요. 이 새로고침은 FrogProgsy가 제공하는 모델 표시, 숨긴 모델, `/v1/models` 응답에 적용됩니다. proxy가 내려가 있으면 먼저 `frogp refresh`로 proxy를 복구한 뒤 목록을 다시 새로고침하세요.

Claude Code의 `/model` 선택기가 오래된 목록을 보여줄 때는 **Claude Code 홈**을 사용하세요. 대상 홈을 새로고침한 뒤 표시되는 `frogp claude reload-models <profile-id>` 명령을 그 profile에 실행합니다. 이미 열려 있는 `/model` 화면은 hot reload되지 않으므로, Claude Code 세션을 새로 시작하거나 해당 profile로 resume해서 Claude Code가 `/v1/models`를 다시 가져오게 해야 합니다.

## 종료된 모델 교체하기

Models 화면은 페이지 요약 바로 아래, 모델 표시와 우선순위 조정 영역 위에서 교체 상태를 확인합니다. 종료됐거나 로그인이 필요하거나 대체 설정에 문제가 있는 항목은 처음부터 열립니다. 정상 항목은 하나의 접힌 영역에 모여 있어 먼저 할 일을 바로 볼 수 있습니다.

일반 모델 요청에는 정확한 대체 모델을 최대 3개까지 순서대로 저장할 수 있습니다. 자동 대응은 끄거나, 모델이 종료됐을 때만, 일시적인 실패가 생겼을 때만, 또는 두 경우 모두에 적용할 수 있습니다. 이 동작은 요청을 처리할 때만 잠시 다른 모델을 시도하며, 저장된 기본 모델 자체는 바꾸지 않습니다.

auto mode, Model Mixing, 웹 검색·이미지 처리, 하위 작업 모델은 맡은 역할이 정해져 있어 성격이 다른 모델로 조용히 바뀌면 안 됩니다. 그래서 자동 대응 대신 **영구 교체**만 제공합니다. 영구 교체는 확인을 받은 뒤 이후 요청이 사용할 저장 모델을 바꾸며, 일시적으로 대체 모델을 시도하는 자동 대응과 다릅니다.

## Model Mixing 페이지

**Model Mixing**은 Claude Code에 `frogp/mix` 모델 하나를 보여주고, 그 뒤에서 여러 모델이 함께 답하게 만들 때 쓰는 화면입니다. JSON을 직접 고치지 않아도 됩니다. 프리셋을 고르고, 경고를 확인한 뒤 켜고, Claude Code에서 `frogp/mix`를 선택하면 됩니다.

이 화면에서 볼 수 있는 것:

- **Low**, **Balanced**, **Research** 프리셋 카드와 서버가 계산한 답변 호출/검색 호출 예상치
- Research 증거 배너: F3가 frozen `local-suite-v1` 주장을 통과했다는 내용과 함께 hard reasoning 개선 없음, 단일 judge 채점, p50 `29s` / p95 약 `3.7분` 지연, suite-v1 한정이라는 캐비앗
- 실제로 답할 패널 모델 명단, 심판 모델, 합성자 모델
- 사용자 요청 1번이 내부 호출 여러 번이 된다는 점을 켜기 전에 보여주는 비용 미리보기

조용히 설정이 바뀌지 않도록 안전장치가 두 개 있습니다. 프리셋이 기존 커스텀 설정을 덮어쓰는 경우 먼저 확인창이 뜨고, 취소하면 아무것도 저장하지 않습니다. Enable 토글도 현재 호출 수와 지연 경고를 보여준 뒤 저장합니다. 취소하면 저장하지 않고, 저장에 실패하면 토글은 원래 상태로 돌아갑니다.

이 화면은 자동 모드 확인 모델 카드와 별개입니다. Model Mixing은 일반 요청에서 `frogp/mix`가 답을 만드는 방식을 바꾸는 기능이지, Claude Code auto-mode 안전 확인을 라우팅하거나 대체하지 않습니다.

## 안전한 기록으로 실패 위치 좁히기

요청 기록은 비밀 저장소가 되지 않도록 좁게 설계되었습니다. 시간, 모델, AI 서비스, 상태, 주소,
단계 목록, 안전한 오류 코드와 함께 상태/서비스/오류 필터 및 행별 상세 진단을 보여주지만 API 키, OAuth 토큰, 요청 본문, 프롬프트, 이메일, 계정 정보는
저장하지 않습니다.

단계 목록으로 실패 위치를 좁힐 수 있습니다.

- `parse` — Claude Code 요청 읽기
- `route` — 모델과 AI 서비스 선택
- `oauth` 또는 `auth` — 인증 정보 확인
- `adapter_build` — 외부 서비스 요청 만들기
- `upstream_connect` — 외부 서비스 연결
- `stream_bridge` — Claude Code로 돌려주는 변환
- `finalize` — 기록 저장과 정리

## auto mode 경로

대시보드에서 심사 프로바이더/모델 한 쌍을 지정한 뒤, 사용할 Claude Code 홈마다 이 기능을 켭니다.
Claude Code 2.1.220은 해당 홈의 두 심사 단계를 예약 alias로 보내며, FrogProgsy는 Sonnet/Haiku
모델명으로 심사 요청을 추측하지 않습니다. 홈 설정을 바꾼 뒤에는 기존 세션을 재시작하거나
resume해야 합니다.

기능을 켠 동안 메인 모델은 Claude Code의 내장 `sonnet` 단축명이 아니라 정확한 게이트웨이 모델
항목으로 선택하세요. 심사 대상의 404/429는 Claude Code가 현재 메인 모델로 fallback하게 할 수 있습니다.


## 로컬 사용량 확인

Activity의 사용량 영역은 외부 서비스의 청구서가 아니라 로컬 집계입니다. FrogProgsy는 완료 처리된 모든
`/v1/messages` 요청을 `~/.frogprogsy/usage.jsonl`에 기록하며, 외부 서비스가 제공한 사용량과 성공하지
못한 요청의 실패 상태도 보존합니다. 사용량을 주지 않은 요청은 token 0으로 표시하지 않고 `unreported`로 집계합니다.
프롬프트 캐시 효과는 wire 의미와 입력 분모가 확인된 요청만 계산합니다. Anthropic은
`cache_read_input_tokens / (cache_read_input_tokens + cache_creation_input_tokens + input_tokens)`를
사용합니다. 네이티브 OpenAI Chat Completions는
`prompt_tokens_details.cached_tokens / prompt_tokens`, 네이티브 OpenAI Responses는
`input_tokens_details.cached_tokens / input_tokens`를 사용합니다. OpenAI 입력 합계에는 캐시 토큰이
이미 포함되므로 다시 더하지 않습니다. 여러 provider가 섞이면 각 요청의 올바른 입력 기준을 합쳐
계산하며, 캐시 생성은 Anthropic 값으로만 표시합니다. 일반 OpenAI 호환 provider와 Google의 캐시
수치는 provenance와 분모가 입증되기 전까지 제외하고, 내역 누락과 외부 서비스 요청 실패는 별도로
셉니다. 보고된 실제 0은 `0%`로 표시하며 데이터 없음, 미지원, 내역 누락, 요청 실패 상태도 서로 구분합니다.

이 화면은 “FrogProgsy를 통해 어떤 서비스/모델이 토큰을 썼는가?”를 확인하는 용도입니다. 계정 청구서,
구독 한도, 조직 비용은 각 AI 서비스의 사용량 화면에서 확인해야 합니다. 서비스마다 방식이 달라서 FrogProgsy가 하나로 합치지 않습니다.

Claude Code가 서비스별 사용량 주소를 호출할 수도 있으므로, FrogProgsy는 로컬 요약을
`GET /api/usage`, `GET /api/oauth/usage`, `GET /usage`에서 JSON으로 제공합니다. 등록되지 않은 `/api/*`
요청은 대시보드 HTML로 돌려보내지 않습니다.


## 자동화가 필요할 때 쓰는 API

대부분의 운영은 화면에서 끝내고, 아래 주소는 자동화나 간단 점검이 필요할 때만 직접 호출하세요.

| 주소 | 용도 |
| --- | --- |
| `GET /api/provider-state` | 비밀값 없는 서비스/실행 상태 요약 |
| `GET /api/claude-status` | Claude Code 주입/Base URL, 런타임/watchdog/외부 supervisor, 마지막 `/v1/messages` 상태를 민감정보 없이 요약 |
| `GET /api/update-status` | 디스크/메모리 snapshot만 읽으며 registry 작업을 시작하지 않음 |
| `POST /api/update-status/refresh` | 명시적인 제한 시간 안정판 새로고침. 일반 로컬 변경 guard가 필요 |
| `PUT /api/update-settings` | 자동 확인의 정확한 `{enabled:boolean}`만 저장. 꺼진 상태에서도 명시적 새로고침은 가능 |
| `GET /api/providers` | 설정된 AI 서비스 요약 |
| `POST /api/providers` | 목록 또는 직접 입력값으로 AI 서비스 추가/갱신 |
| `POST /api/providers/test` | 사용자가 누를 때만 한 번 수행하는 최소 토큰 provider 연결 테스트와 enum 오류 결과 |
| `PUT /api/default-provider` | 기본 AI 서비스 변경 |
| `DELETE /api/providers?name=…` | 기본값이 아닌 AI 서비스 제거 |
| `GET /api/key-providers` | API 키로 연결 가능한 서비스 목록 |
| `GET /api/oauth/providers` | OAuth 로그인을 지원하는 서비스 |
| `POST /api/oauth/login` / `GET /api/oauth/status` | OAuth 로그인 시작/상태 확인 |
| `GET/POST/PATCH/DELETE /api/claude-profiles` | Claude Code 홈과 홈별 모델 오버레이 관리. `PATCH`를 포함한 변경 메서드는 local origin만 허용 |
| `POST /api/claude-profiles/:id/inject|refresh|restore` | Claude Code 홈 하나만 주입, 새로고침, 복원. `refresh`는 Claude Code 선택기 복구를 위한 additive `modelReload` metadata를 반환하며, 가능하면 안정적인 `frogp claude reload-models <profile-id>` 명령을 포함합니다 |
| `GET /api/subagent-models` / `PUT /api/subagent-models` | 하위 작업에 먼저 보여줄 모델 읽기/설정 |
| `GET /api/fallback-settings` / `PUT /api/fallback-settings` | 웹 검색/이미지 대신 처리 모델 읽기/설정 |
| `GET /api/classifier-settings` / `PUT /api/classifier-settings` | 자동 모드 확인 모델 읽기/설정 |
| `PUT /api/disabled-models` | Claude Code 모델 목록에서 모델 숨김/표시 |
| `GET /api/usage?range=30d` / `GET /api/oauth/usage` / `GET /usage` | `~/.frogprogsy/usage.jsonl` 기반 로컬 사용량 요약. `range`는 `7d`, `30d`, `all` 지원 |
| `POST /api/stop` | FrogProgsy 종료, 서비스 중지, Claude Code 설정 복원 |

> **서비스 목록 항목**
>
> Ollama Cloud 같은 목록 기반 서비스를 추가하면 text-only 모델 힌트가 설정 파일로 복사되어
> 이미지 대신 처리 여부를 판단하는 데 쓰입니다.
