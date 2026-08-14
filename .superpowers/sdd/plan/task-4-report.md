# Task 4 보고서

## 상태

완료. 일반 `POST /v1/messages` 요청에만 exact provider/model 연속성 후보와 30초 메모리 회로 차단을 적용했습니다.

## 변경

- 기존 `AttemptContext` 반복문에 exact 연속성 후보를 추가하고 일반 `fallbackProviders` 동작과 분리했습니다.
- 404, 410, 429, 5xx, 연결 실패, 헤더 시간 초과만 연속성 전환 대상으로 삼았습니다.
- 구조화된 `type`/`code`가 정확히 context-limit 오류인 경우 재시도하지 않으며, 자유 형식 메시지의 문자열은 판정에 사용하지 않습니다.
- retired 대상과 열린 회로는 primary 호출 없이 건너뛰며, primary 성공 시 회로를 지웁니다.
- 후보별 인증을 다시 확인해 사용할 수 없는 OAuth, Claude grant, key, forwarded-auth 후보를 건너뜁니다.
- 후보마다 원본 파싱 요청을 복제하고 adapter, capability, wire model, 인증을 다시 계산합니다.
- 요청 로그와 관리용 로그에 `continuityReason`을 기록합니다.
- HTTP 200 이후의 SSE/adapter 오류와 응답 변환 오류는 다른 대상을 호출하지 않습니다.

## 실행 명령과 실제 결과

`bun test --isolate ./tests/model-continuity-runtime.test.ts ./tests/provider-fallback-chain.test.ts ./tests/provider-key-failover.test.ts ./tests/fallback-attempt-context.test.ts ./tests/fallback-abort.test.ts`

- 결과: 종료 코드 0
- 통과: 74
- 실패: 0
- 검증식: 208
- 실행 파일: 5개

`git diff --check`

- 결과: 종료 코드 0, 출력 없음

## 커밋

`feat: fail over exact model routes before output`

## 우려

요청 제한에 따라 전체 테스트, 포맷터, 린터, 전체 typecheck, GUI build는 실행하지 않았습니다. 지정된 데이터 경로와 관련 회귀 테스트만 검증했습니다.

## 검토 수정 round 1

### 상태

완료. 후보 단위 실패 격리, 구조화 오류 보존, 후보가 없어도 열리는 회로, 인증 후보가 모두 건너뛰어진 경우의 원래 upstream 오류 보존, 동시 요청 완료 순서를 추가로 검증했습니다.

### 변경

- stale exact 후보의 route 해석 실패를 해당 후보만 건너뛰도록 제한했습니다.
- message가 없는 구조화 upstream 오류도 exact `type`/`code`와 안전한 fallback message를 보존합니다.
- eligible primary 실패가 key 진행을 마치면 다음 후보 유무와 관계없이 회로를 열되, 현재 요청에서 인증 가능한 후보가 없으면 열린 회로가 primary를 건너뛰지 않게 했습니다.
- 모든 exact 후보가 인증 단계에서 건너뛰어지면 마지막 실제 upstream의 status/type/message를 반환합니다.
- failure와 success가 겹친 요청은 마지막 완료가 회로 상태를 결정하는지 제어된 비동기 테스트로 고정했습니다.

### 실행 명령과 실제 결과

`bun test --isolate ./tests/model-continuity-runtime.test.ts ./tests/provider-fallback-chain.test.ts ./tests/provider-key-failover.test.ts ./tests/fallback-attempt-context.test.ts ./tests/fallback-abort.test.ts ./tests/error-fidelity.test.ts`

- 결과: 종료 코드 0
- 통과: 92
- 실패: 0
- 검증식: 262
- 실행 파일: 6개

### 우려

요청 제한에 따라 전체 테스트, 포맷터, 린터, 전체 typecheck, GUI build는 실행하지 않았습니다.

## 최종 검토 수정 round 2

### 상태

완료. primary 연결 대기 중 client abort가 연속성 실패로 오인되지 않도록 분리했습니다.

### 변경

- parent/client abort 신호가 실제로 취소된 fetch rejection은 header timeout이나 연결 실패보다 먼저 `client_cancel`로 처리합니다.
- client cancel은 fallback 진행과 30초 회로 변경을 하지 않습니다.
- 로그에는 고정된 `client_cancel` 코드와 499 상태만 남기며 원본 abort reason은 저장하거나 응답하지 않습니다.
- 취소 직후 독립 요청이 같은 primary를 다시 호출해 성공하는 회귀 테스트를 추가했습니다.

### 실행 명령과 실제 결과

`bun test --isolate ./tests/model-continuity-runtime.test.ts ./tests/provider-fallback-chain.test.ts ./tests/request-log-lifecycle.test.ts`

- 결과: 종료 코드 0
- 통과: 69
- 실패: 0
- 검증식: 234
- 실행 파일: 3개
- 관찰: 취소 요청은 499/`client_cancel`, fallback 호출 0회, 회로 snapshot 빈 배열이었고 다음 독립 요청은 primary 1회 호출로 200을 반환했습니다.

### 우려

요청 제한에 따라 전체 테스트, 포맷터, 린터, 전체 typecheck, GUI build는 실행하지 않았습니다.
