# Task 5 보고서

## 상태

완료. GUI와 CLI가 함께 쓰는 모델 연속성 조회·변경 API를 추가했습니다.

## 변경

- `GET /api/model-continuity`가 정규화한 `policies`, 문제 우선 정렬의 공개 `references`, 만료되지 않은 `circuits`를 한 번에 반환합니다.
- 회로 상태는 `primary`, 구조화된 `reason`, epoch milliseconds인 `retryAt`만 공개하며 `primary` 오름차순으로 정렬합니다.
- 보고서에는 prompt, 요청·upstream body, credential, provider URL, 로컬 경로가 들어가지 않습니다.
- `POST /api/model-continuity`는 `set`과 `replace`의 정확한 필드·타입만 허용하고, 오류를 안전한 `{error,code}`로 반환합니다.
- `set`은 기존 정책 검증을 재사용하고 `{fallbacks:[],automatic:"off"}`를 map entry 삭제로 저장합니다. owner reference가 자동 연속성 비대상이라면 자동 설정을 거부하지만, 같은 target의 ordinary route 정책은 `referenceId` 없이 허용합니다.
- `replace`는 기존 owner 교체와 stale guard를 재사용합니다. 성공한 변경만 한 번 저장하며, 교체 성공 뒤에만 기존 Claude catalog best-effort refresh 경로를 호출합니다.
- 기존 local-origin mutation guard를 그대로 사용합니다.
- `structure/05_gui-and-management-api.md`에 공개 응답, POST action, 저장·refresh 경계와 ordinary-route-only 규칙을 기록했습니다.

## 실행 명령과 실제 결과

1. RED: `bun test --isolate ./tests/model-continuity-api.test.ts`
   - 결과: 종료 코드 1, 1 pass / 7 fail.
   - GET/POST route가 아직 없어 응답이 `undefined`인 예상 실패를 확인했습니다. local-origin guard 회귀 검증 1건만 통과했습니다.
2. 구현 후 단일 API 테스트: `bun test --isolate ./tests/model-continuity-api.test.ts`
   - 결과: 종료 코드 0, 8 pass / 0 fail / 71 expect.
3. 최종 focused 관리 API 테스트: `bun test --isolate ./tests/model-continuity-api.test.ts ./tests/provider-rest-api.test.ts ./tests/claude-profile-dashboard-api.test.ts`
   - 결과: 종료 코드 0, 60 pass / 0 fail / 295 expect, 3개 파일.
   - 테스트 환경의 `FROGPROGSY_NO_CLAUDE_WRITES=1`에 따른 기존 catalog/home write 차단 로그만 출력됐습니다.
4. 자체 검토: 공개 필드 allowlist, enum, 문제 우선 정렬, 만료 회로 제외, strict action parsing, stale 409, disabled/retired fallback, classifier owner 경계, local origin, save/refresh 횟수를 구현과 테스트에서 대조했습니다.
5. `git diff --check`
   - 결과: 종료 코드 0, 출력 없음.

## 커밋

`feat: expose model continuity management`

## 우려

전체 suite, formatter, linter, 전체 typecheck, GUI build는 요청에 따라 실행하지 않았습니다. 검증 범위는 지정된 focused Bun 테스트 3개 파일입니다.
