# Task 6 보고서

## 상태

완료. 실행 중인 proxy의 모델 연속성 보고서 조회, 정책 설정, reference 영구 교체를 CLI에 추가했습니다.

## 변경

- `frogp models continuity [--json]`이 실행 중인 proxy의 `GET /api/model-continuity` 보고서를 읽습니다.
  - 사람용 출력은 API가 정렬한 reference 순서를 유지하며 문제, 영향, 실행 가능한 다음 명령을 먼저 보여줍니다.
  - reference id는 `replace` 명령을 실행하는 데 필요할 때만 표시합니다.
  - 열린 circuit의 원인과 자동 재시도 시각을 표시합니다.
  - `--json`은 API 문서를 단일 JSON으로 그대로 출력하고 ANSI와 진단 메시지를 stdout에 섞지 않습니다.
- `frogp models continuity set <provider/model> --fallback <provider/model>... --auto off|retired|transient|all`을 추가했습니다.
  - 반복한 `--fallback` 순서를 보존하고 `--auto`를 정확히 한 번 요구합니다.
  - 누락된 값, 알 수 없는 옵션, 추가 positional argument를 proxy 연결 전에 거부합니다.
- `frogp models continuity replace <reference-id> <provider/model>`을 추가했습니다.
  - 현재 보고서에서 `expectedPrimary`를 구해 stale guard를 포함한 정확한 POST action을 전송합니다.
- 기존 `frogp models`와 `frogp models --json` 경로는 continuity dispatch와 분리했습니다.
- 영어, 한국어, 중국어 CLI reference에 정확한 세 명령, 기본 `off`, 자동 모드, 일반 모델 요청 전용 경계, classifier 수동 교체 전용 규칙을 추가했습니다.

## 실행 명령과 실제 결과

1. Stub과 CLI 테스트를 먼저 추가한 뒤 RED를 실행했습니다.
   - 최초 `bun test --isolate ./tests/cli-models.test.ts`는 cold CLI child startup이 기존 5초 제한을 넘겨 120초 상위 제한에서 중단됐습니다.
   - Dispatch가 없는 상태를 다시 확인한 `bun test --isolate --timeout 30000 ./tests/cli-models.test.ts -t "models continuity prints problem"`은 종료 코드 1, 0 pass / 1 fail이었고 `Expected: 0, Received: 1`로 continuity subcommand 부재를 재현했습니다.
2. Parser와 새 CLI 동작을 부하 상황에서 나눠 확인했습니다.
   - `bun test --isolate --timeout 30000 ./tests/cli-models.test.ts -t "before contacting the proxy"`: 7 pass / 0 fail / 28 expect.
   - `bun test --isolate --timeout 30000 ./tests/cli-models.test.ts -t "continuity|set preserves|replace resolves|API safe"`: 6 pass / 0 fail / 27 expect.
3. `bun test --isolate ./tests/model-continuity-api.test.ts`
   - 결과: 13 pass / 0 fail / 133 expect.
4. 최종 focused gate: `bun test --isolate ./tests/cli-models.test.ts ./tests/model-continuity-api.test.ts`
   - 결과: 종료 코드 0, 35 pass / 0 fail / 244 expect, 2개 파일.
5. 자체 검토에서 plain models 분리, 옵션 개수와 누락값, 반복 fallback 순서, stopped proxy, safe API 오류, guarded replace body, JSON stdout, report 순서, reference id 노출, circuit 출력을 구현과 테스트에서 대조했습니다.

## 커밋

`feat: add model continuity CLI controls`

## 우려

전체 suite, formatter, linter, 전체 typecheck, GUI build는 요청에 따라 실행하지 않았습니다. 이 워크트리에서는 Bun CLI child의 cold startup이 간헐적으로 기존 5초·15초·30초 제한을 넘어 중간 focused 실행이 실패했지만 timeout을 변경하지 않았습니다. Transpiler cache가 준비된 뒤 요청된 최종 focused 명령은 원래 제한 그대로 통과했습니다.

## 검토 수정 round 1

### 상태

완료. Fallback이 없는 retired reference에도 바로 실행할 수 있는 다음 행동을 추가했습니다.

### 변경

- Retired reference의 fallback이 비어 있으면 placeholder가 든 가짜 교체 명령 대신 `Next: frogp models`를 출력합니다.
- 실제 CLI child와 stub proxy를 쓰는 회귀 테스트가 빈 fallback, 기본 `automatic: off`, reference id 비노출, 실행 가능한 다음 명령을 검증합니다.

### 실행 명령과 실제 결과

1. RED: `bun test --isolate ./tests/cli-models.test.ts -t "retired reference without a fallback"`
   - 결과: 종료 코드 1, 0 pass / 1 fail. 영향 설명 뒤에 실행 가능한 다음 행동이 없음을 재현했습니다.
2. GREEN: 같은 단일 테스트 명령
   - 결과: 종료 코드 0, 1 pass / 0 fail / 7 expect.
3. 기존 사람용/JSON 출력 회귀:
   `bun test --isolate ./tests/cli-models.test.ts -t "models continuity prints problem|models continuity --json|retired reference without a fallback"`
   - 결과: 종료 코드 0, 3 pass / 0 fail / 22 expect.
4. 최종 focused gate:
   `bun test --isolate ./tests/cli-models.test.ts ./tests/model-continuity-api.test.ts`
   - 결과: 종료 코드 0, 36 pass / 0 fail / 251 expect, 2개 파일.

### 커밋

`fix: keep retired continuity reports actionable`

### 우려

전체 suite, formatter, linter, 전체 typecheck, GUI build는 요청에 따라 실행하지 않았습니다. Timeout 값은 변경하지 않았습니다.
