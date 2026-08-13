# 최종 Important 5건 수정 보고서

## 결과

Important 5건을 모두 회귀 테스트로 재현한 뒤 원인을 수정했다. 생성 artifact의 `catalogRevision`은 모델 자료 변경 규칙에 따라 1에서 2로 올렸다.

## Finding별 RED/GREEN

### 1. v1 문서 최소 reader 버전

- RED: generator가 `package.json`의 `0.0.2-preview.2`를 매번 문서 최소 버전으로 복사해 다음 package version에서 기존 v1 reader를 차단할 수 있었다.
- GREEN: 문서 최소 버전을 v1 reader 최초 지원 버전 `0.0.2-preview.2`로 고정했다. 새 runtime이 필요한 provider/model만 registry record의 `minFrogprogsyVersion`을 직렬화할 수 있다. `0.0.2` reader가 다음 release 문서를 수용하는 테스트를 추가했다.
- 변경 파일: `src/model-catalog-generator.ts`, `src/providers/registry.ts`, `tests/model-catalog-generator.test.ts`

### 2. retired model 원천과 default 경계

- RED: registry에 명시적 retirement 원천이 없어 generator artifact에서 삭제 의도를 잃었고, persisted default가 retired model이면 effective config가 이를 계속 선택했다.
- GREEN: `umans`, `neuralwatt`, `deepseek` retirement를 registry에 두고 artifact에 정렬해 기록한다. effective merge는 retired managed model을 baseline/userModels에서 제외하고 retired default만 catalog default로 교체한다. custom provider와 retired가 아닌 사용자 default는 그대로 둔다.
- 변경 파일: `src/providers/registry.ts`, `src/model-catalog-generator.ts`, `src/model-catalog-config.ts`, `tests/model-catalog-generator.test.ts`, `tests/model-catalog-config.test.ts`

### 3. 논리 model ID와 upstream wire model ID

- RED: catalog의 `wireModelId`가 effective provider에 전달되지 않아 `claude-opus-4-6[1m]`이 그대로 Anthropic upstream body에 실렸다.
- GREEN: 지원 adapter인 `anthropic`에만 managed `modelWireIds`를 보존한다. Anthropic adapter는 capability와 선택 로직을 논리 ID로 처리한 뒤 outgoing `body.model`만 base slug로 바꾼다. 다른 adapter는 mapping을 적용하지 않는다.
- 변경 파일: `src/types.ts`, `src/adapters/base.ts`, `src/adapters/anthropic.ts`, `src/model-catalog-config.ts`, `tests/model-catalog-config.test.ts`, `tests/anthropic-adapter.test.ts`

### 4. migration save 실패의 원본 semantics

- RED: backup 성공 뒤 save가 실패해도 메모리의 `persisted`가 변환본으로 먼저 바뀌어 디스크와 실행 상태가 달라졌다.
- GREEN: 변환본 save가 성공한 뒤에만 `persisted`를 교체한다. save 실패 시 메모리와 디스크 모두 원본 semantics를 유지한다.
- 변경 파일: `src/runtime-config-state.ts`, `tests/model-catalog-config.test.ts`

### 5. startup 후 Claude catalog/cache 동기화

- RED: server는 effective config로 실행하지만 CLI는 startup 뒤 `loadConfig()`로 persisted config를 다시 읽어 on-disk Claude catalog와 gateway cache에서 remote-only model을 누락했다.
- GREEN: `startServer`가 startup snapshot의 effective config를 복제해 안전하게 전달한다. CLI의 Claude catalog/cache refresh는 이 snapshot을 쓰고, profile 주입 상태 저장은 계속 persisted config만 쓴다. remote-only model이 `/api/models`, `/v1/models`, Claude catalog, `models_cache.json`, gateway cache에 모두 나타나는 통합 테스트를 추가했다.
- 변경 파일: `src/server.ts`, `src/cli.ts`, `tests/server-startup.test.ts`, `tests/model-catalog-e2e.test.ts`

## 생성 artifact

- 파일: `src/generated/model-catalog-v1.json`
- `catalogRevision`: 2
- `catalogDigest`: `f256684912b14fa7748d3a7b9379450ea885246932b7d0e3d8cfced8020066d2`
- 생성 source: `68fe2b7e2b75fbc30c9970736e4462142b4eefa6`, `2026-08-13T12:27:54+09:00`
- deterministic `--check`: 통과

## 테스트 근거

- RED: 관련 5개 파일 실행 결과 52 pass, 9 fail. 5개 finding의 기대 실패를 모두 확인했다.
- GREEN: 같은 5개 파일 재실행 결과 61 pass, 0 fail, 298 assertions.
- 관련 범위: generator/runtime/config/adapter/startup/CLI 8개 파일 결과 121 pass, 0 fail, 520 assertions.
- publication/release 범위 3개 파일 결과 28 pass, 0 fail, 254 assertions.
- `bun run typecheck`: 통과.

## Self-review

- 사용자 credentials와 persisted provider 설정은 catalog artifact나 managed mapping에 복사하지 않는다.
- UI/API/route/log에 쓰는 model ID는 논리 ID로 유지하고 Anthropic outgoing JSON만 wire ID로 바꾼다.
- custom provider, fixed allowlist, 사용자 추가 model/default 경계를 유지한다.
- migration 실패 경로는 backup 성공 여부와 무관하게 save 성공 전 원본 상태를 유지한다.
- startup config 전달은 `structuredClone` snapshot을 사용해 server runtime state를 CLI가 바꾸지 못하게 한다.
- 모델 자료가 바뀌었으므로 revision을 2로 올렸고 artifact를 generator로만 갱신했다.

## Fix round 2

- 추가 Important: catalog가 retire한 ID라도 사용자가 `persisted.userModels`에 명시적으로 추가했다면 사용자가 제거할 때까지 `effective.models`와 `effective.userModels`에 남아야 한다.
- RED: retired ID를 `userModels`에 넣은 회귀 테스트가 effective model 목록 누락으로 실패했다.
- GREEN: retirement는 managed baseline 제거와 retired managed default 교체에만 적용한다. 명시적 `userModels`는 retirement와 관계없이 보존한다.
- 검증 공백 보완: generator에 synthetic registry 입력 seam을 추가하고 provider/model record별 `minFrogprogsyVersion` 직렬화를 직접 검증했다. CLI startup effective handoff는 기존 `server-startup` 및 on-disk catalog/cache E2E가 직접 검증한다.
- 변경 파일: `src/model-catalog-config.ts`, `src/model-catalog-generator.ts`, `tests/model-catalog-config.test.ts`, `tests/model-catalog-generator.test.ts`
- RED: 36 pass, 1 expected failure.
- GREEN: config/generator/e2e 39 pass, 0 fail, 234 assertions. `bun run typecheck` 및 deterministic generator `--check` 통과.
- 별도 fix commit SHA는 완료 채팅에 기록한다.

## Commit

초기 fix commit: `81bbb17`. Fix round 2의 별도 commit SHA는 완료 채팅에 기록한다.
