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
