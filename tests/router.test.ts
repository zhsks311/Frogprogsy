import { describe, expect, test } from "bun:test";
import { AUTO_MODE_CLASSIFIER_ALIAS } from "../src/classifier-settings";
import { routeModel } from "../src/router";
import type { FrogConfig } from "../src/types";

function baseConfig(): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "codex",
    providers: {
      codex: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "oauth",
        defaultModel: "gpt-5.5",
        models: ["gpt-5.5"],
      },
    },
  };
}

describe("routeModel", () => {
  test("maps Claude Code default model sentinel to the configured provider default", () => {
    const route = routeModel(baseConfig(), "default");

    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.5");
  });

  test("keeps unknown explicit model ids as requested on the default provider", () => {
    const route = routeModel(baseConfig(), "future-model-id");

    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("future-model-id");
  });
});
describe("explicit auto-mode classifier routing", () => {
  function classifierConfig(): FrogConfig {
    return {
      port: 10100,
      defaultProvider: "codex",
      autoModeClassifierEnabled: true,
      autoModeClassifier: { provider: "codex", model: "gpt-5.4-mini" },
      providers: {
        codex: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "oauth",
          defaultModel: "gpt-5.5",
          models: ["gpt-5.5", "gpt-5.4-mini"],
        },
      },
    };
  }

  test("routes only the exact reserved alias to the explicit target", () => {
    const route = routeModel(classifierConfig(), AUTO_MODE_CLASSIFIER_ALIAS);
    expect(route.providerName).toBe("codex");
    expect(route.modelId).toBe("gpt-5.4-mini");
    expect(route.routeKind).toBe("classifier");
    expect(route.classifierRoute).toBe(true);
  });

  for (const model of ["claude-haiku-4-5", "claude-3-5-haiku-20241022", "claude-sonnet-5", "claude-opus-4-8"]) {
    test(`${model} remains an ordinary client-default request`, () => {
      const route = routeModel(classifierConfig(), model);
      expect(route.providerName).toBe("codex");
      expect(route.modelId).toBe("gpt-5.5");
      expect(route.classifierRoute).toBeFalsy();
    });
  }

  test("fails closed when the reserved alias has no configured target", () => {
    const config = classifierConfig();
    delete config.autoModeClassifier;
    expect(() => routeModel(config, AUTO_MODE_CLASSIFIER_ALIAS)).toThrow(/auto-mode|review|classifier/i);
  });
});
