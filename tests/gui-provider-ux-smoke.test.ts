import { describe, expect, test } from "bun:test";
import React from "../gui/node_modules/react/index.js";
import { renderToStaticMarkup } from "../gui/node_modules/react-dom/server.bun.js";
import { parseExtraApiKeys, sanitizeVisibleText } from "../gui/src/components/AddProviderModal";
import { parseConfig, ProviderMetadataList, AnthropicAuthEditor } from "../gui/src/pages/Providers";
import {
  ModelCatalogStatusSummary,
  ModelContinuityPanel,
  ModelSupportStatusBadge,
  parseCatalogStatus,
  parseModelContinuityReport,
} from "../gui/src/pages/Models";
import {
  ClaudeGrantsCard,
  parseGrants,
  grantStateChip,
  grantUsable,
  grantReauthCommand,
  isVerifiedRealClaudePath,
  realClaudeReady,
  grantErrorText,
  type ClaudeGrantSummary,
} from "../gui/src/pages/ClaudeProfiles";
import { en } from "../gui/src/i18n/en";
import { ko } from "../gui/src/i18n/ko";

function t(key: keyof typeof en, vars?: Record<string, string | number>): string {
  let value = en[key];
  for (const [name, replacement] of Object.entries(vars ?? {})) value = value.split(`{${name}}`).join(String(replacement));
  return value;
}

function tKo(key: keyof typeof ko, vars?: Record<string, string | number>): string {
  let value = ko[key];
  for (const [name, replacement] of Object.entries(vars ?? {})) value = value.split(`{${name}}`).join(String(replacement));
  return value;
}

const STUB_CONTINUITY_REPORT = {
  policies: {
    "work/old": { fallbacks: ["work/new", "codex/gpt-5.5"], automatic: "off" },
  },
  references: [
    {
      id: "provider-default:work",
      kind: "provider-default",
      primary: "work/old",
      status: "retired",
      automaticEligible: true,
      policy: { fallbacks: ["work/new", "codex/gpt-5.5"], automatic: "off" },
      supportStatus: "validated",
      label: "Provider default",
    },
    {
      id: "classifier",
      kind: "classifier",
      primary: "work/classifier",
      status: "ready",
      automaticEligible: false,
      policy: { fallbacks: [], automatic: "off" },
      supportStatus: "validated",
      label: "Auto-mode classifier",
    },
    {
      id: "mix-agent:0",
      kind: "mix-agent",
      primary: "work/mixer",
      status: "ready",
      automaticEligible: false,
      policy: { fallbacks: [], automatic: "off" },
      supportStatus: "discovered",
      label: "Mixing agent",
    },
  ],
  circuits: [
    { primary: "work/old", reason: "http_5xx", retryAt: 1_786_707_630_000 },
  ],
};

describe("G004 GUI provider UX smoke", () => {
  test("mock rendered provider status shows normalized metadata without raw secrets", () => {
    const rawSecrets = ["sk-live-secret-1111", "sk-second-secret-2222"];
    const parsed = parseConfig({
      port: 19999,
      defaultProvider: "primary",
      providers: {
        primary: {
          adapter: "openai-chat",
          baseUrl: "https://primary.example/v1",
          defaultModel: "primary-model",
          authMode: "key",
          hasApiKey: true,
          apiKeyCount: 2,
          balanceSupported: false,
          apiKey: rawSecrets[0],
          apiKeys: [rawSecrets[1]],
        },
      },
    });
    const provider = parsed.providers.primary!;
    const safeMessage = sanitizeVisibleText(
      `Connected via ${rawSecrets[0]} and ${rawSecrets[1]}`,
      rawSecrets,
      "Connected",
    );

    const markup = renderToStaticMarkup(
      React.createElement("section", { "data-testid": "provider-card" },
        React.createElement("h2", null, "primary"),
        React.createElement(ProviderMetadataList, {
          provider,
          testResult: { status: "ok", message: safeMessage, modelCount: 3 },
          t,
        }),
      ),
    );

    expect(parseExtraApiKeys(`${rawSecrets[1]}\n sk-third-secret-3333,sk-fourth-secret-4444`)).toEqual([
      rawSecrets[1],
      "sk-third-secret-3333",
      "sk-fourth-secret-4444",
    ]);
    expect(sanitizeVisibleText("overlap sk-secret-long sk-secret", ["sk-secret", "sk-secret-long"], "fallback")).toBe("overlap [redacted] [redacted]");
    expect(markup).toContain("primary");
    expect(markup).toContain("API keys");
    expect(markup).toContain(">2<");
    expect(markup).toContain("Balance support");
    expect(markup).toContain("not supported");
    expect(markup).toContain("Connected via [redacted] and [redacted] · 3 models");
    for (const secret of rawSecrets) expect(markup).not.toContain(secret);
  });
});

const SAMPLE_GRANTS: ClaudeGrantSummary[] = [
  { id: "cg_ready01", label: "work-subscription", state: "ok", boundProviders: ["anthropic"], realClaudeReady: true, reauthCommand: `CLAUDE_CONFIG_DIR="$HOME/.frogprogsy/claude-grants/cg_ready01" "$HOME/.local/bin/claude" auth login --claudeai` },
  { id: "cg_reauth9", label: "personal", state: "reauth_required", boundProviders: [], realClaudeReady: true, reauthCommand: `CLAUDE_CONFIG_DIR="$HOME/.frogprogsy/claude-grants/cg_reauth9" "$HOME/.local/bin/claude" auth login --claudeai` },
  { id: "cg_new0000", label: "spare", state: "none", boundProviders: [], realClaudeReady: true, statusError: "status_unavailable", reauthCommand: `CLAUDE_CONFIG_DIR="$HOME/.frogprogsy/claude-grants/cg_new0000" "$HOME/.local/bin/claude" auth login --claudeai` },
];

describe("Branch B Claude grant pure helpers", () => {
  test("parseGrants keeps the contract shape and fails closed on bad state", () => {
    const parsed = parseGrants({
      grants: [
        { id: "cg_a", label: "A", state: "ok", boundProviders: ["anthropic"], realClaudeReady: true, expiresAt: "2026-08-01T00:00:00Z" },
        { id: "cg_c", label: "C", state: "expiring", boundProviders: [], realClaudeReady: true, expiresAt: 1800000000 },
        { id: "cg_b", label: "B", state: "totally-bogus", boundProviders: "nope", realClaudeReady: "yes" },
        { id: 5, label: "no id" },
        "junk",
      ],
      realClaude: { ready: true, name: "claude" },
    });
    expect(parsed.grants).toHaveLength(3);
    expect(parsed.grants[0]).toMatchObject({ id: "cg_a", state: "ok", boundProviders: ["anthropic"], realClaudeReady: true, expiresAt: "2026-08-01T00:00:00Z" });
    // numeric epoch (seconds) expiry is normalized to a safe ISO display string
    expect(parsed.grants[1]).toMatchObject({ id: "cg_c", state: "expiring", expiresAt: new Date(1800000000 * 1000).toISOString() });
    // unknown state fails closed to "unreadable"; non-array boundProviders → []; non-true readiness → false
    expect(parsed.grants[2]).toMatchObject({ id: "cg_b", state: "unreadable", boundProviders: [], realClaudeReady: false });
    // a bare basename "claude" is not a verified path, so it is dropped and treated as not-ready
    expect(parsed.realClaude).toEqual({ ready: true });
  });

  test("state chips and usability follow readiness", () => {
    expect(grantStateChip("ok").label).toBe("Ready");
    expect(grantStateChip("expiring").label).toBe("Expiring soon");
    expect(grantStateChip("reauth_required").label).toBe("Re-auth required");
    expect(grantStateChip("none").cls).toBe("badge-muted");
    expect(grantUsable({ id: "x", label: "x", state: "ok", boundProviders: [], realClaudeReady: true })).toBe(true);
    expect(grantUsable({ id: "x", label: "x", state: "ok", boundProviders: [], realClaudeReady: false })).toBe(false);
    expect(grantUsable({ id: "x", label: "x", state: "reauth_required", boundProviders: [], realClaudeReady: true })).toBe(false);
  });

  test("re-auth command is consumed verbatim from the server and never rebuilt client-side", () => {
    // The server owns the $HOME-tokenized command (built by grantSetup); parseGrants surfaces it
    // as-is — even a NON-default FROGPROGSY_HOME path the old client fabrication ($HOME/.frogprogsy)
    // could never have produced.
    const serverCmd = `CLAUDE_CONFIG_DIR="$HOME/.frogprogsy-custom/claude-grants/cg_ready01" "$HOME/.local/bin/claude" auth login --claudeai`;
    const parsed = parseGrants({
      grants: [{ id: "cg_ready01", label: "work", state: "reauth_required", boundProviders: [], realClaudeReady: true, reauthCommand: serverCmd }],
      realClaude: { ready: true, name: "$HOME/.local/bin/claude" },
    });
    // The GUI keeps the exact server string; it never reconstructs the default-home path.
    expect(parsed.grants[0].reauthCommand).toBe(serverCmd);
    expect(grantReauthCommand(parsed.grants[0])).toBe(serverCmd);
    expect(grantReauthCommand(parsed.grants[0])).not.toContain(".frogprogsy/claude-grants");
    expect(grantReauthCommand(parsed.grants[0])).not.toContain("/Users/");
    // No server command → the GUI offers nothing (it cannot invent a scoped config path).
    expect(grantReauthCommand({ id: "cg_x", label: "x", state: "ok", boundProviders: [], realClaudeReady: true })).toBe("");
    // A non-string server value is rejected (fail-closed), never coerced into a fabricated path.
    expect(parseGrants({ grants: [{ id: "cg_y", label: "y", state: "ok", boundProviders: [], realClaudeReady: true, reauthCommand: 42 }] }).grants[0].reauthCommand).toBeUndefined();

    // The card renders the re-auth affordance only when the server supplied the command.
    const cardProps = { t, realClaude: parsed.realClaude, loadFailed: false, busy: false, onSetup: async () => null, onRemove: () => undefined };
    const withCmd = renderToStaticMarkup(React.createElement(ClaudeGrantsCard, { ...cardProps, grants: parsed.grants }));
    expect(withCmd).toContain("Re-auth guide");
    const withoutCmd = renderToStaticMarkup(React.createElement(ClaudeGrantsCard, { ...cardProps, grants: parsed.grants.map(g => ({ ...g, reauthCommand: undefined })) }));
    expect(withoutCmd).not.toContain("Re-auth guide");
  });

  test("verified-path / readiness / error helpers fail closed", () => {
    expect(isVerifiedRealClaudePath("$HOME/.local/bin/claude")).toBe(true);
    expect(isVerifiedRealClaudePath("/usr/local/bin/claude")).toBe(true);
    expect(isVerifiedRealClaudePath("claude")).toBe(false);
    expect(isVerifiedRealClaudePath(undefined)).toBe(false);
    expect(realClaudeReady({ ready: true, name: "$HOME/.local/bin/claude" })).toBe(true);
    expect(realClaudeReady({ ready: true, name: "claude" })).toBe(false);
    expect(realClaudeReady({ ready: false, name: "$HOME/.local/bin/claude" })).toBe(false);
    // object errors render message + code safely; strings pass through; unknown shapes fall back
    expect(grantErrorText({ code: "grant_bound", message: "grant is bound" }, "fallback")).toBe("grant is bound (grant_bound)");
    expect(grantErrorText("plain error", "fallback")).toBe("plain error");
    expect(grantErrorText({ nope: 1 }, "fallback")).toBe("fallback");
  });
});

describe("Claude Grants card (readiness-first, no secrets)", () => {
  const render = (props: Partial<Parameters<typeof ClaudeGrantsCard>[0]> = {}) =>
    renderToStaticMarkup(
      React.createElement(ClaudeGrantsCard, {
        t,
        grants: SAMPLE_GRANTS,
        realClaude: { ready: true, name: "$HOME/.local/bin/claude" },
        loadFailed: false,
        busy: false,
        onSetup: async () => null,
        onRemove: () => undefined,
        ...props,
      }),
    );

  test("leads with bindings/usability and hides diagnostics behind a disclosure", () => {
    const markup = render();
    expect(markup).toContain("Claude Grants");
    // readiness-first: bound providers and usability lead the default view
    expect(markup).toContain("Bound providers");
    expect(markup).toContain("work-subscription");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Usable now");
    expect(markup).toContain("anthropic");
    // verified real Claude → ready badge and a guided re-auth affordance
    expect(markup).toContain("Real Claude ready");
    expect(markup).toContain("Re-auth guide");
    // state chips for every state present in the sample
    expect(markup).toContain("Re-auth required");
    expect(markup).toContain("Not set up");
    // Set up (create) affordance with a plain label field (not a secret)
    expect(markup).toContain("Set up grant");
    expect(markup).toContain("New grant label");
    // ToS / account risk and the API-key alternative are stated
    expect(markup).toContain("Terms-of-Service");
    expect(markup).toContain("API-key");
    // Advanced diagnostics disclosure carries redacted metadata + doctor pointer
    expect(markup).toContain("<details");
    expect(markup).toContain("Advanced diagnostics");
    expect(markup).toContain("frogp doctor claude");
    // absolutely no secret input fields and no leaked absolute home paths
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain("/Users/");
    expect(markup).not.toContain("credentials.json");
  });

  test("real-Claude-not-ready and load-failure states are fail-closed", () => {
    const notReady = render({ realClaude: { ready: false, name: "$HOME/.local/bin/claude" } });
    expect(notReady).toContain("Real Claude not verified");
    expect(notReady).toContain("needs a verified real Claude executable");
    // a bare basename is not a verified path → not ready and no re-auth command is offered
    const bareReady = render({ realClaude: { ready: true, name: "claude" } });
    expect(bareReady).toContain("Real Claude not verified");
    expect(bareReady).not.toContain("Re-auth guide");

    const failed = render({ loadFailed: true, grants: [], realClaude: undefined });
    expect(failed).toContain("Claude grants are unavailable");
    // fail-closed: no grant rows or diagnostics rendered when the API failed
    expect(failed).not.toContain("Advanced diagnostics");
  });
});

describe("Anthropic auth selector (Forward / API key / Claude grant)", () => {
  const render = (provider: { authMode?: string; claudeGrantId?: string }, extra: { grants?: ClaudeGrantSummary[]; grantsFailed?: boolean } = {}) =>
    renderToStaticMarkup(
      React.createElement(AnthropicAuthEditor, {
        t,
        name: "anthropic",
        provider,
        grants: extra.grants ?? SAMPLE_GRANTS,
        grantsFailed: extra.grantsFailed ?? false,
        busy: false,
        onSave: () => undefined,
      }),
    );

  test("offers all three modes and never renders a secret field", () => {
    const markup = render({ authMode: "forward" });
    expect(markup).toContain("Forward (default)");
    expect(markup).toContain("API key");
    expect(markup).toContain("Claude grant");
    // forward copy preserves the zero-custody meaning
    expect(markup).toContain("stores no Claude token");
    expect(markup).not.toContain('type="password"');
  });

  test("claude-grant mode shows the grant picker, binding and unready warning", () => {
    const markup = render({ authMode: "claude-grant", claudeGrantId: "cg_reauth9" });
    // grant picker lists selectable grants
    expect(markup).toContain("Select a grant");
    expect(markup).toContain("work-subscription");
    // bound-grant readiness surfaced and unready grant warned before save
    expect(markup).toContain("Bound grant");
    expect(markup).toContain("is not ready");
    // grant auth routes through Anthropic's official endpoint
    expect(markup).toContain("api.anthropic.com");
    expect(markup).not.toContain('type="password"');
  });

  test("grant auth surfaces the official Anthropic endpoint and server status errors", () => {
    const markup = render({ authMode: "claude-grant", claudeGrantId: "cg_new0000" });
    // grant auth routes through Anthropic's official endpoint (no third-party endpoint)
    expect(markup).toContain("api.anthropic.com");
    // server-reported status error for the bound/selected grant is shown, redacted-safe
    expect(markup).toContain("Anthropic reported a problem verifying this grant");
    expect(markup).toContain("status_unavailable");
    expect(markup).not.toContain('type="password"');
  });

  test("dangling binding to an unknown grant is warned", () => {
    const markup = render({ authMode: "claude-grant", claudeGrantId: "cg_missing" });
    expect(markup).toContain("dangling");
  });

  test("grant API failure disables verification without breaking the row", () => {
    const markup = render({ authMode: "claude-grant", claudeGrantId: "cg_ready01" }, { grants: [], grantsFailed: true });
    expect(markup).toContain("Claude grants are unavailable");
  });
});

describe("model catalog status UX", () => {
  test("shows freshness, next action, and model support badges without raw internal details", () => {
    const rawPath = "/Users/private/.frogprogsy/cache/model-catalog-v1.json";
    const rawUrl = "https://private.invalid/catalog?token=secret";
    const status = parseCatalogStatus({
      source: "remote",
      catalogRevision: 42,
      sourceCommit: "1234567890abcdef1234567890abcdef12345678",
      refreshedAt: "2026-08-12T10:30:00.000Z",
      skippedRecords: 0,
      warnings: { count: 0, causes: [] },
      cachePath: rawPath,
      remoteUrl: rawUrl,
    });
    const markup = renderToStaticMarkup(
      React.createElement("div", null,
        React.createElement(ModelCatalogStatusSummary, { status, t: tKo, onRefresh: () => undefined }),
        React.createElement(ModelSupportStatusBadge, { status: "validated", t: tKo }),
        React.createElement(ModelSupportStatusBadge, { status: "discovered", t: tKo }),
        React.createElement(ModelSupportStatusBadge, { status: "unknown", t: tKo }),
      ),
    );

    expect(markup).toContain("모델 자료가 최신입니다");
    expect(markup).toContain("Frogprogsy를 다시 시작할 때");
    expect(markup).toContain("검증됨");
    expect(markup).toContain("발견됨");
    expect(markup).toContain("확인 필요");
    expect(markup).not.toContain(rawPath);
    expect(markup).not.toContain(rawUrl);
    expect(markup).not.toContain("token=secret");
  });

  test("an identical remotely refreshed cached catalog is shown as current", () => {
    const status = parseCatalogStatus({
      source: "cached",
      catalogRevision: 42,
      sourceCommit: "1234567890abcdef1234567890abcdef12345678",
      refreshedAt: "2026-08-12T10:30:00.000Z",
      skippedRecords: 0,
      warnings: { count: 0, causes: [] },
    });
    const markup = renderToStaticMarkup(
      React.createElement(ModelCatalogStatusSummary, { status, t: tKo, onRefresh: () => undefined }),
    );

    expect(markup).toContain("모델 자료가 최신입니다");
    expect(markup).not.toContain("models-status-card warn");
  });

  test("uses skippedRecords for excluded-item attention even when there are no warnings", () => {
    const status = parseCatalogStatus({
      source: "remote",
      catalogRevision: 43,
      sourceCommit: "1234567890abcdef1234567890abcdef12345678",
      refreshedAt: "2026-08-12T11:30:00.000Z",
      skippedRecords: 5,
      warnings: { count: 0, causes: [] },
    });
    const markup = renderToStaticMarkup(
      React.createElement(ModelCatalogStatusSummary, { status, t: tKo, onRefresh: () => undefined }),
    );

    expect(status.skippedRecords).toBe(5);
    expect(status.warningCount).toBe(0);
    expect(markup).toContain("모델 자료 일부를 확인해야 합니다");
    expect(markup).toContain("호환되지 않는 5개 항목을 제외");
    expect(markup).not.toContain("5건의 문제");
  });

  test("keeps warning-only attention separate from excluded-item counts", () => {
    const status = parseCatalogStatus({
      source: "remote",
      catalogRevision: 44,
      sourceCommit: "1234567890abcdef1234567890abcdef12345678",
      refreshedAt: "2026-08-12T12:30:00.000Z",
      skippedRecords: 0,
      warnings: { count: 1, causes: ["refresh_failed"] },
    });
    const markup = renderToStaticMarkup(
      React.createElement(ModelCatalogStatusSummary, { status, t: tKo, onRefresh: () => undefined }),
    );

    expect(status.skippedRecords).toBe(0);
    expect(status.warningCount).toBe(1);
    expect(markup).toContain("모델 자료 일부를 확인해야 합니다");
    expect(markup).toContain("1건의 문제가 발생");
    expect(markup).not.toContain("1개 항목을 제외");
  });

  test.each([
    null,
    { count: -1 },
    { count: 1.5 },
    { count: "1" },
  ])("rejects malformed warning summaries: %p", warnings => {
    expect(() => parseCatalogStatus({
      source: "remote",
      catalogRevision: 45,
      sourceCommit: "1234567890abcdef1234567890abcdef12345678",
      skippedRecords: 0,
      warnings,
    })).toThrow("invalid catalog warnings");
  });
});

describe("model continuity UX", () => {
  test("continuity parser rejects malformed enums and preserves server order", () => {
    const malformedStatus = structuredClone(STUB_CONTINUITY_REPORT);
    malformedStatus.references[0].status = "maybe";
    expect(() => parseModelContinuityReport(malformedStatus)).toThrow();

    const malformedAutomatic = structuredClone(STUB_CONTINUITY_REPORT);
    malformedAutomatic.references[0].policy.automatic = "later";
    expect(() => parseModelContinuityReport(malformedAutomatic)).toThrow();

    const malformedReason = structuredClone(STUB_CONTINUITY_REPORT);
    malformedReason.circuits[0].reason = "unknown_failure";
    expect(() => parseModelContinuityReport(malformedReason)).toThrow();

    expect(parseModelContinuityReport(STUB_CONTINUITY_REPORT).references.map(row => row.id)).toEqual([
      "provider-default:work",
      "classifier",
      "mix-agent:0",
    ]);
  });

  test("problem card leads with impact and action, not internal reference id", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ModelContinuityPanel, {
        report: parseModelContinuityReport(STUB_CONTINUITY_REPORT),
        selectableModels: ["work/new", "codex/gpt-5.5", "work/backup"],
        t: tKo,
        onSet: async () => "applied",
        onReplace: async () => "applied",
      }),
    );

    expect(markup).toContain("기본 모델이 종료됐습니다");
    expect(markup).toContain("이 모델을 사용하는 새 요청은 시작할 수 없습니다");
    expect(markup).toContain("영구 교체");
    expect(markup).not.toContain("provider-default:work");
  });
  test("retired actions precede active fallback status and collapsed normal rows", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ModelContinuityPanel, {
        report: parseModelContinuityReport(STUB_CONTINUITY_REPORT),
        selectableModels: ["work/new", "codex/gpt-5.5", "work/backup"],
        t: tKo,
        onSet: async () => "applied",
        onReplace: async () => "applied",
      }),
    );
    const attention = markup.indexOf("기본 모델이 종료됐습니다");
    const active = markup.indexOf("저장한 대체 모델을 사용 중입니다");
    const normal = markup.indexOf('<details class="continuity-normal-list">');

    expect(attention).toBeGreaterThan(-1);
    expect(active).toBeGreaterThan(attention);
    expect(normal).toBeGreaterThan(active);
  });


  test("classifier row has no automatic selector and normal rows start collapsed", () => {
    const report = parseModelContinuityReport({
      policies: {},
      references: [STUB_CONTINUITY_REPORT.references[1]],
      circuits: [],
    });
    const markup = renderToStaticMarkup(
      React.createElement(ModelContinuityPanel, {
        report,
        selectableModels: ["work/classifier", "work/new"],
        t: tKo,
        onSet: async () => "applied",
        onReplace: async () => "applied",
      }),
    );

    expect(markup).toContain("자동 모드 심사");
    expect(markup).toContain("영구 교체만 사용할 수 있습니다");
    expect(markup).not.toContain("자동 대응 범위");
    expect(markup).toContain('<details class="continuity-normal-list">');
    expect(markup).not.toContain('<details class="continuity-normal-list" open');
  });

  test("automatic controls expose labels in keyboard reading order", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ModelContinuityPanel, {
        report: parseModelContinuityReport(STUB_CONTINUITY_REPORT),
        selectableModels: ["work/new", "codex/gpt-5.5", "work/backup"],
        t: tKo,
        onSet: async () => "applied",
        onReplace: async () => "applied",
      }),
    );
    const labels = [
      'aria-label="자동 대응 범위"',
      'aria-label="첫 번째 대체 모델"',
      'aria-label="두 번째 대체 모델"',
      'aria-label="세 번째 대체 모델"',
      'aria-label="자동 대응 저장"',
      'aria-label="영구 교체 모델"',
      'aria-label="영구 교체"',
    ];

    let previous = -1;
    for (const label of labels) {
      const index = markup.indexOf(label);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
  });
});
