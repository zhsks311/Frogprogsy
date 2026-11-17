import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogDataDigest,
  generateModelCatalog,
} from "../src/model-catalog-generator";
import { modelCatalogDocumentV1Schema } from "../src/model-catalog-schema";
import { validateCatalogCandidate } from "../src/model-catalog-runtime";

const input = {
  sourceCommit: "a".repeat(40),
  generatedAt: "2026-08-12T00:00:00.000Z",
  catalogRevision: 1,
};

const validDocument = {
  schemaVersion: 1 as const,
  catalogRevision: 1,
  catalogDigest: "b".repeat(64),
  sourceCommit: "a".repeat(40),
  generatedAt: "2026-08-12T00:00:00.000Z",
  minFrogprogsyVersion: "0.0.1",
  providers: [
    {
      id: "provider-a",
      defaultModel: "model-a",
      models: [
        {
          id: "model-a",
          contextWindow: 128_000,
          inputModalities: ["text" as const],
          reasoningEfforts: ["low" as const, "high" as const],
        },
      ],
    },
  ],
};

describe("model catalog generator", () => {
  test("같은 입력은 byte-identical JSON을 만든다", () => {
    expect(JSON.stringify(generateModelCatalog(input)))
      .toBe(JSON.stringify(generateModelCatalog(input)));
  });

  test("transport와 인증 필드를 산출하지 않는다", () => {
    const text = JSON.stringify(generateModelCatalog(input));
    for (const forbidden of ["baseUrl", "adapter", "authMode", "headers", "apiKey", "oauth"]) {
      expect(text).not.toContain(`\"${forbidden}\"`);
    }
  });

  test("OpenRouter의 공급자 소유 snapshot 전체를 고정해 재현한다", () => {
    const openrouter = generateModelCatalog(input).providers.find(provider => provider.id === "openrouter");
    const digest = createHash("sha256").update(JSON.stringify(openrouter)).digest("hex");

    expect(openrouter?.models).toHaveLength(470);
    expect(digest).toBe("ef0897905b52dbad289e9007043ea8398fb1729fb361a742e12a56d309a193ef");
  });

  test("명시한 current model만 관리하고 Jawcode·metadata 키는 멤버십을 만들지 않는다", () => {
    const catalog = generateModelCatalog(input, [{
      id: "verified-google",
      label: "Verified Google",
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      authKind: "key",
      models: ["gemini-2.5-flash", "gemini-3.5-flash"],
      modelContextWindows: { "metadata-only": 123_000 },
      jawcodeBundle: "google",
      officialModelSources: ["https://ai.google.dev/gemini-api/docs/models"],
      verifiedJawcodeModels: ["gemini-2.5-flash"],
    }]);

    expect(catalog.providers[0]?.models.map(model => model.id)).toEqual([
      "gemini-2.5-flash",
      "gemini-3.5-flash",
    ]);
    expect(catalog.providers[0]?.models.find(model => model.id === "gemini-3.5-flash"))
      .toEqual({ id: "gemini-3.5-flash" });
  });

  test("공식 검증 목록이 없는 non-OpenRouter Jawcode bundle은 model을 관리하지 않는다", () => {
    const catalog = generateModelCatalog(input, [{
      id: "unverified-google",
      label: "Unverified Google",
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      authKind: "key",
      jawcodeBundle: "google",
    }]);

    expect(catalog.providers[0]?.models).toEqual([]);
  });

  test("OpenRouter만 명시적 모델 목록 없이 전체 snapshot을 관리한다", () => {
    const catalog = generateModelCatalog(input, [{
      id: "openrouter",
      label: "OpenRouter",
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      authKind: "key",
      jawcodeBundle: "openrouter",
    }]);

    expect(catalog.providers[0]?.models).toHaveLength(470);
    expect(catalog.providers[0]?.models.some(model => model.id === "openai/gpt-6.1-sol")).toBeTrue();
  });

  test("provider와 model을 ID 순서로 정렬한다", () => {
    const catalog = generateModelCatalog(input);
    const providerIds = catalog.providers.map(provider => provider.id);
    expect(providerIds).toEqual(providerIds.toSorted());

    for (const provider of catalog.providers) {
      const modelIds = provider.models.map(model => model.id);
      expect(modelIds).toEqual(modelIds.toSorted());
    }
  });

  test("생성한 문서는 엄격한 v1 스키마를 통과한다", () => {
    expect(modelCatalogDocumentV1Schema.parse(generateModelCatalog(input)))
      .toEqual(generateModelCatalog(input));
  });

  test("v1 문서 최소 reader 버전을 최초 지원 버전으로 유지한다", () => {
    const current = generateModelCatalog(input);
    const nextRelease = generateModelCatalog({
      ...input,
      sourceCommit: "c".repeat(40),
      generatedAt: "2026-08-13T00:00:00.000Z",
    });

    expect(nextRelease.minFrogprogsyVersion).toBe("0.0.2-preview.2");
    expect(validateCatalogCandidate(
      nextRelease,
      current,
      "0.0.2",
      new Date("2026-08-13T00:00:01.000Z"),
    ).ok).toBeTrue();
  });

  test("registry의 retired·unmanaged model을 provider artifact에 직렬화한다", () => {
    const providers = new Map(generateModelCatalog(input).providers.map(provider => [provider.id, provider]));

    expect(providers.get("umans")?.retiredModels).toContain("umans-kimi-k3");
    expect(providers.get("umans")?.unmanagedModels).toEqual(["umans-glm-5.1", "umans-kimi-k2.6"]);
    expect(providers.get("neuralwatt")?.unmanagedModels).toContain("kimi-k2.5-fast");
    expect(providers.get("deepseek")?.retiredModels).toEqual(["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);
  });

  test("record별 최소 runtime 버전을 provider와 model에 직렬화한다", () => {
    const catalog = generateModelCatalog(input, [{
      id: "future",
      label: "Future",
      adapter: "anthropic",
      baseUrl: "https://future.invalid",
      authKind: "key",
      minFrogprogsyVersion: "0.0.3",
      models: ["future-model"],
      modelMinFrogprogsyVersions: { "future-model": "0.0.4" },
    }]);

    expect(catalog.providers[0]?.minFrogprogsyVersion).toBe("0.0.3");
    expect(catalog.providers[0]?.models[0]?.minFrogprogsyVersion).toBe("0.0.4");
  });

  test("중복 provider ID를 거부한다", () => {
    const duplicate = {
      ...validDocument,
      providers: [validDocument.providers[0], validDocument.providers[0]],
    };
    expect(modelCatalogDocumentV1Schema.safeParse(duplicate).success).toBeFalse();
  });

  test("중복 model ID를 거부한다", () => {
    const duplicate = {
      ...validDocument,
      providers: [{
        ...validDocument.providers[0],
        models: [validDocument.providers[0].models[0], validDocument.providers[0].models[0]],
      }],
    };
    expect(modelCatalogDocumentV1Schema.safeParse(duplicate).success).toBeFalse();
  });

  test("존재하지 않는 default model 참조를 거부한다", () => {
    const invalid = {
      ...validDocument,
      providers: [{ ...validDocument.providers[0], defaultModel: "missing" }],
    };
    expect(modelCatalogDocumentV1Schema.safeParse(invalid).success).toBeFalse();
  });

  test("활성 model을 retired model로 동시에 참조하면 거부한다", () => {
    const invalid = {
      ...validDocument,
      providers: [{ ...validDocument.providers[0], retiredModels: ["model-a"] }],
    };
    expect(modelCatalogDocumentV1Schema.safeParse(invalid).success).toBeFalse();
  });

  test("unmanaged model은 활성·retired model과 겹치면 거부한다", () => {
    for (const invalidProvider of [
      { ...validDocument.providers[0], unmanagedModels: ["model-a"] },
      { ...validDocument.providers[0], retiredModels: ["retired-a"], unmanagedModels: ["retired-a"] },
    ]) {
      expect(modelCatalogDocumentV1Schema.safeParse({
        ...validDocument,
        providers: [invalidProvider],
      }).success).toBeFalse();
    }
  });

  test("알 수 없는 object 필드를 거부한다", () => {
    const invalid = { ...validDocument, unexpected: true };
    expect(modelCatalogDocumentV1Schema.safeParse(invalid).success).toBeFalse();
  });

  test("context window는 양의 정수만 허용한다", () => {
    for (const contextWindow of [0, -1, 1.5]) {
      const invalid = {
        ...validDocument,
        providers: [{
          ...validDocument.providers[0],
          models: [{ ...validDocument.providers[0].models[0], contextWindow }],
        }],
      };
      expect(modelCatalogDocumentV1Schema.safeParse(invalid).success).toBeFalse();
    }
  });


  test("지원하지 않는 reasoning effort를 거부한다", () => {
    const invalid = {
      ...validDocument,
      providers: [{
        ...validDocument.providers[0],
        models: [{ ...validDocument.providers[0].models[0], reasoningEfforts: ["max"] }],
      }],
    };
    expect(modelCatalogDocumentV1Schema.safeParse(invalid).success).toBeFalse();
  });

  test("reasoning이 없는 model의 reasoning effort map을 거부한다", () => {
    const invalid = {
      ...validDocument,
      providers: [{
        ...validDocument.providers[0],
        models: [{
          ...validDocument.providers[0].models[0],
          reasoningEfforts: [],
          reasoningEffortMap: { low: "high" },
          noReasoning: true,
        }],
      }],
    };
    expect(modelCatalogDocumentV1Schema.safeParse(invalid).success).toBeFalse();
  });

  test("source commit과 catalog revision 경계를 검증한다", () => {
    expect(modelCatalogDocumentV1Schema.safeParse({
      ...validDocument,
      sourceCommit: "A".repeat(40),
    }).success).toBeFalse();
    expect(modelCatalogDocumentV1Schema.safeParse({
      ...validDocument,
      catalogRevision: 0,
    }).success).toBeFalse();
  });

  test("timestamp만 바뀌면 digest는 유지된다", () => {
    const first = generateModelCatalog(input);
    const second = generateModelCatalog({
      ...input,
      generatedAt: "2026-08-13T00:00:00.000Z",
    });
    expect(second.catalogDigest).toBe(first.catalogDigest);
  });

  test("source SHA와 revision은 digest에 포함하지 않는다", () => {
    const first = generateModelCatalog(input);
    const second = generateModelCatalog({
      ...input,
      sourceCommit: "c".repeat(40),
      catalogRevision: 2,
    });
    expect(second.catalogDigest).toBe(first.catalogDigest);
  });

  test("model data가 바뀌면 digest가 바뀐다", () => {
    const first = catalogDataDigest({ providers: validDocument.providers });
    const changedProviders = [{
      ...validDocument.providers[0],
      models: [{ ...validDocument.providers[0].models[0], contextWindow: 256_000 }],
    }];
    expect(catalogDataDigest({ providers: changedProviders })).not.toBe(first);
  });
});

describe("model catalog generator CLI", () => {
  test("명시적 source SHA와 생성 시간으로 newline이 있는 파일을 쓰고 검사한다", async () => {
    const directory = mkdtempSync(join(tmpdir(), "frogprogsy-model-catalog-"));
    const outputPath = join(directory, "model-catalog.json");
    const command = [
      "bun",
      "scripts/generate-model-catalog.ts",
      "--source-commit",
      input.sourceCommit,
      "--generated-at",
      input.generatedAt,
      "--out",
      outputPath,
    ];

    try {
      const writeProcess = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
      expect(await writeProcess.exited).toBe(0);
      const generatedBytes = await Bun.file(outputPath).text();
      expect(generatedBytes.endsWith("\n")).toBeTrue();
      expect(JSON.parse(generatedBytes)).toEqual(generateModelCatalog({
        sourceCommit: input.sourceCommit,
        generatedAt: input.generatedAt,
      }));

      const checkProcess = Bun.spawn([...command, "--check"], { stdout: "pipe", stderr: "pipe" });
      expect(await checkProcess.exited).toBe(0);

      writeFileSync(outputPath, "{}\n");
      const staleCheckProcess = Bun.spawn([...command, "--check"], { stdout: "pipe", stderr: "pipe" });
      expect(await staleCheckProcess.exited).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("source SHA나 생성 시간을 생략하면 실패한다", async () => {
    const missingSource = Bun.spawn([
      "bun",
      "scripts/generate-model-catalog.ts",
      "--generated-at",
      input.generatedAt,
      "--out",
      join(tmpdir(), "unused-model-catalog.json"),
    ], { stdout: "pipe", stderr: "pipe" });
    expect(await missingSource.exited).not.toBe(0);

    const missingTime = Bun.spawn([
      "bun",
      "scripts/generate-model-catalog.ts",
      "--source-commit",
      input.sourceCommit,
      "--out",
      join(tmpdir(), "unused-model-catalog.json"),
    ], { stdout: "pipe", stderr: "pipe" });
    expect(await missingTime.exited).not.toBe(0);
  });
});

test("provider-owned OpenRouter input refreshes full passthrough without borrowing route metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "frogprogsy-provider-metadata-"));
  const jawcodePath = join(directory, "jawcode.json");
  const openrouterPath = join(directory, "openrouter.json");
  const outputPath = join(directory, "src", "generated", "jawcode-model-metadata.ts");
  writeFileSync(jawcodePath, JSON.stringify({
    openrouter: { stale: { contextWindow: 1 } },
    google: { unverified: { contextWindow: 999999 } },
  }));
  writeFileSync(openrouterPath, JSON.stringify({ data: [
    { id: "current", context_length: 123456, architecture: { input_modalities: ["text", "image", "audio"] },
      top_provider: { max_completion_tokens: 8192 }, supported_parameters: ["reasoning", "tools"] },
    { id: "unknown" },
  ] }));
  const command = ["bun", join(import.meta.dir, "..", "scripts", "generate-jawcode-metadata.ts")];
  const env = { ...process.env, JAWCODE_MODELS_JSON: jawcodePath, OPENROUTER_MODELS_JSON: openrouterPath };
  try {
    const generated = Bun.spawnSync(command, { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
    expect(generated.exitCode).toBe(0);
    const source = readFileSync(outputPath, "utf8");
    expect(source).toContain('["current",123456,8192,"text,image",1]');
    expect(source).toContain('["unknown"]');
    expect(source).not.toContain('"stale"');
    expect(source).not.toContain('"unverified"');
    expect(source).not.toContain("reasoningEfforts");
    writeFileSync(openrouterPath, JSON.stringify({ data: [{ id: "duplicate" }, { id: "duplicate" }] }));
    const duplicate = Bun.spawnSync(command, { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.stderr.toString()).toContain("duplicate OpenRouter model ID");
    expect(readFileSync(outputPath, "utf8")).toBe(source);
    writeFileSync(openrouterPath, JSON.stringify({ data: [{ id: "broken", context_length: -1 }] }));
    const malformed = Bun.spawnSync(command, { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
    expect(malformed.exitCode).not.toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe(source);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


describe("official OpenRouter metadata input", () => {
  test("unknown limits stay unknown through nullable tuple holes and duplicates fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frog-openrouter-input-"));
    const script = new URL("../scripts/generate-jawcode-metadata.ts", import.meta.url).pathname;
    try {
      writeFileSync(join(dir, "jawcode.json"), "{}");
      const snapshot = { data: [
        { id: "fixture/unknown", supported_parameters: ["reasoning"] },
        { id: "fixture/vision", context_length: 123456, architecture: { input_modalities: ["text", "image", "audio"] } },
      ] };
      writeFileSync(join(dir, "openrouter.json"), JSON.stringify(snapshot));
      const run = () => Bun.spawnSync([process.execPath, script], {
        cwd: dir, env: { ...process.env, JAWCODE_MODELS_JSON: join(dir, "jawcode.json"), OPENROUTER_MODELS_JSON: join(dir, "openrouter.json") },
        stdout: "pipe", stderr: "pipe",
      });
      expect(run().exitCode).toBe(0);
      const module = await import(join(dir, "src/generated/jawcode-model-metadata.ts"));
      expect(module.getJawcodeModelMetadata("openrouter", "fixture/unknown")).toEqual({ provider: "openrouter", id: "fixture/unknown", reasoning: true });
      expect(module.getJawcodeModelMetadata("openrouter", "fixture/vision").input).toEqual(["text", "image"]);
      snapshot.data.push(snapshot.data[0]);
      writeFileSync(join(dir, "openrouter.json"), JSON.stringify(snapshot));
      expect(run().exitCode).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
