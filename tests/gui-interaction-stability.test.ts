import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pageToHash, parsePageHash, shouldPushPageHash } from "../gui/src/hash-routing";
import * as ClaudeProfiles from "../gui/src/pages/ClaudeProfiles";
import * as Models from "../gui/src/pages/Models";
import { en } from "../gui/src/i18n/en";
import { ko } from "../gui/src/i18n/ko";
import { zh } from "../gui/src/i18n/zh";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const {
  claudeProfileAddNotice,
  claudeProfileCanRemove,
  claudeProfileShortcutView,
  fetchProfileModels,
  sonnetModelCandidates,
  sonnetModelCommand,
} = ClaudeProfiles;

const {
  confirmModelContinuityReplacement,
  loadModelContinuityReport,
  postModelContinuityAction,
  saveModelContinuityPolicy,
  updateModelContinuityFallback,
} = Models;

type SavedErrorHelper = (body: unknown) => {
  profileId: string;
  message: string;
  success: false;
} | undefined;

type PatchNoticeHelper = (body: unknown, savedMessage: string) => {
  message: string;
  success: boolean;
};
describe("GUI interaction stability", () => {
  test("hash routing helpers cover the page union and safe fallbacks", () => {
    expect(pageToHash("home")).toBe("#/home");
    expect(pageToHash("accounts")).toBe("#/accounts");
    expect(pageToHash("models")).toBe("#/models");
    expect(pageToHash("modelMixing")).toBe("#/model-mixing");
    expect(pageToHash("activity")).toBe("#/activity");
    expect(pageToHash("developerDetails")).toBe("#/developer-details");

    expect(parsePageHash("")).toBe("home");
    expect(parsePageHash("#/model-mixing")).toBe("modelMixing");
    expect(parsePageHash("#/developer-details")).toBe("developerDetails");
    expect(parsePageHash("#/unknown")).toBe("home");
    expect(parsePageHash("#/models?ignored=true")).toBe("models");

    expect(shouldPushPageHash("#/models", "models")).toBe(false);
    expect(shouldPushPageHash("#/home", "models")).toBe(true);
  });

  test("App wires hash initial load, navigation push, hashchange, and duplicate-history guard", () => {
    const app = read("gui/src/App.tsx");

    expect(app).toContain("useState<Page>(() => parsePageHash(currentHash()))");
    expect(app).toContain('window.addEventListener("hashchange", onHashChange)');
    expect(app).toContain("setPage(parsePageHash(window.location.hash))");
    expect(app).toContain("const nextHash = pageToHash(nextPage)");
    expect(app).toContain("shouldPushPageHash(window.location.hash, nextPage)");
    expect(app).toContain('window.history.pushState(null, "", nextHash)');
  });

  test("Model Mixing numeric fields commit only on blur or Enter", () => {
    const mixing = read("gui/src/pages/ModelMixing.tsx");
    const numberInputs = mixing.match(/<CommitNumberInput/g) ?? [];

    expect(numberInputs).toHaveLength(7);
    expect(mixing).toContain("onBlur={commit}");
    expect(mixing).toContain('e.key === "Enter"');
    expect(mixing).toContain("e.currentTarget.blur()");
    expect(mixing).not.toContain("onChange={e => void saveFusionPatch({ panelWebSearch");
    expect(mixing).not.toContain("onChange={e => void savePatch({ stageTimeoutMs");
  });

  test("provider modal guards dirty close and traps focus", () => {
    const modal = read("gui/src/components/AddProviderModal.tsx");
    const en = read("gui/src/i18n/en.ts");
    const ko = read("gui/src/i18n/ko.ts");
    const zh = read("gui/src/i18n/zh.ts");

    expect(modal).toContain("modal.discardConfirm");
    expect(modal).toContain("const isDirty = form !== null");
    expect(modal).toContain("querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)");
    expect(modal).toContain('e.key !== "Tab"');
    expect(modal).toContain("document.activeElement === first");
    expect(modal).toContain("!cardRef.current.contains(document.activeElement)");
    expect(en).toContain("modal.discardConfirm");
    expect(ko).toContain("modal.discardConfirm");
    expect(zh).toContain("modal.discardConfirm");
  });

  test("Models clarifies save semantics and reduces repeated n/5 counters", () => {
    const models = read("gui/src/pages/Models.tsx");
    const en = read("gui/src/i18n/en.ts");
    const ko = read("gui/src/i18n/ko.ts");
    const zh = read("gui/src/i18n/zh.ts");

    expect(models).toContain("models.visibilityAutoSave");
    expect(models).toContain("models.priorityManualSave");
    expect(models).toContain("models.priorityNoChanges");
    expect(models).toContain("disabled={featuredSaving || !featuredDirty}");
    expect(models).toContain("featuredAfterVisibilityChange");
    expect(models).toContain("apply(next, featuredAfterVisibilityChange(next))");
    expect(models).not.toContain("{featuredChosen.length}/5</div>");
    expect(models).not.toContain("selected-order-count");
    for (const source of [en, ko, zh]) {
      expect(source).toContain("models.visibilityAutoSave");
      expect(source).toContain("models.priorityManualSave");
      expect(source).toContain("models.priorityNoChanges");
    }
  });

  test("Models continuity fallback selectors preserve exact order", () => {
    let fallbacks: string[] = [];
    fallbacks = updateModelContinuityFallback(fallbacks, 0, "work/first");
    fallbacks = updateModelContinuityFallback(fallbacks, 1, "codex/second");
    fallbacks = updateModelContinuityFallback(fallbacks, 2, "work/third");

    expect(fallbacks).toEqual(["work/first", "codex/second", "work/third"]);
    expect(updateModelContinuityFallback(fallbacks, 1, "work/replacement")).toEqual([
      "work/first",
      "work/replacement",
      "work/third",
    ]);
    expect(updateModelContinuityFallback(fallbacks, 3, "work/fourth")).toEqual(fallbacks);
  });

  test("Models continuity failed save sends one set action and restores the saved policy", async () => {
    const reference = Models.parseModelContinuityReport({
      policies: {},
      references: [{
        id: "provider-default:work",
        kind: "provider-default",
        primary: "work/old",
        status: "retired",
        automaticEligible: true,
        policy: { fallbacks: ["work/saved"], automatic: "off" },
        supportStatus: "validated",
        label: "Provider default",
      }],
      circuits: [],
    }).references[0];
    const actions: Models.ModelContinuitySetAction[] = [];
    const view = await saveModelContinuityPolicy(
      reference,
      { fallbacks: ["work/new", "codex/backup"], automatic: "all" },
      async action => {
        actions.push(action);
        return "failed";
      },
    );

    expect(actions).toEqual([{
      action: "set",
      primary: "work/old",
      referenceId: "provider-default:work",
      fallbacks: ["work/new", "codex/backup"],
      automatic: "all",
    }]);
    expect(view).toEqual({ fallbacks: ["work/saved"], automatic: "off" });
  });
  test("Models superseded save leaves the local draft untouched", async () => {
    const reference = Models.parseModelContinuityReport({
      policies: {},
      references: [{
        id: "provider-default:work",
        kind: "provider-default",
        primary: "work/old",
        status: "retired",
        automaticEligible: true,
        policy: { fallbacks: ["work/saved"], automatic: "off" },
        supportStatus: "validated",
      }],
      circuits: [],
    }).references[0];

    expect(await saveModelContinuityPolicy(
      reference,
      { fallbacks: ["work/draft"], automatic: "all" },
      async () => "superseded",
    )).toBeNull();
  });


  test("Models permanent replacement requires confirmation and sends expectedPrimary", async () => {
    const reference = Models.parseModelContinuityReport({
      policies: {},
      references: [{
        id: "classifier",
        kind: "classifier",
        primary: "work/old",
        status: "ready",
        automaticEligible: false,
        policy: { fallbacks: [], automatic: "off" },
        supportStatus: "validated",
        label: "Auto-mode classifier",
      }],
      circuits: [],
    }).references[0];
    const actions: Models.ModelContinuityReplaceAction[] = [];

    expect(await confirmModelContinuityReplacement(
      reference,
      "work/new",
      () => false,
      async action => {
        actions.push(action);
        return "applied";
      },
    )).toBe("failed");
    expect(actions).toHaveLength(0);

    expect(await confirmModelContinuityReplacement(
      reference,
      "work/new",
      () => true,
      async action => {
        actions.push(action);
        return "applied";
      },
    )).toBe("applied");
    expect(actions).toEqual([{
      action: "replace",
      referenceId: "classifier",
      expectedPrimary: "work/old",
      replacement: "work/new",
    }]);
  });

  test("Models stale continuity action reloads the report and keeps an actionable error", async () => {
    let reloads = 0;
    const result = await postModelContinuityAction(
      async () => Response.json({
        error: "model reference changed; reload and retry",
        code: "stale_reference",
      }, { status: 409 }),
      "/frogp",
      {
        action: "replace",
        referenceId: "provider-default:work",
        expectedPrimary: "work/old",
        replacement: "work/new",
      },
      async () => { reloads += 1; return "applied"; },
    );

    expect(reloads).toBe(1);
    expect(result).toEqual({
      ok: false,
      stale: true,
      reloadFailed: false,
      superseded: false,
      message: "model reference changed; reload and retry",
    });
  });
  test("Models stale continuity action does not claim a reload when refresh fails", async () => {
    const result = await postModelContinuityAction(
      async () => Response.json({
        error: "model reference changed; reload and retry",
        code: "stale_reference",
      }, { status: 409 }),
      "/frogp",
      {
        action: "replace",
        referenceId: "provider-default:work",
        expectedPrimary: "work/old",
        replacement: "work/new",
      },
      async () => "failed",
    );

    expect(result).toEqual({
      ok: false,
      stale: false,
      reloadFailed: true,
      superseded: false,
      message: "model reference changed; reload and retry",
    });
  });

  test("Models continuity latest request wins when deferred responses complete out of order", async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const firstResponse = new Promise<Response>(resolve => { resolveFirst = resolve; });
    const secondResponse = new Promise<Response>(resolve => { resolveSecond = resolve; });
    let latestRequest = 0;
    let shownPrimary = "";
    let failures = 0;
    let settled = 0;
    const start = (response: Promise<Response>) => {
      const requestId = ++latestRequest;
      return loadModelContinuityReport(
        async () => response,
        "/frogp",
        () => requestId === latestRequest,
        {
          success: report => { shownPrimary = report.references[0]?.primary ?? ""; },
          failure: () => { failures += 1; },
          settled: () => { settled += 1; },
        },
      );
    };
    const first = start(firstResponse);
    const second = start(secondResponse);
    const reportFor = (primary: string) => ({
      policies: {},
      references: [{
        id: "provider-default:work",
        kind: "provider-default",
        primary,
        status: "ready",
        automaticEligible: true,
        policy: { fallbacks: [], automatic: "off" },
        supportStatus: "validated",
      }],
      circuits: [],
    });

    resolveSecond(Response.json(reportFor("work/newest")));
    expect(await second).toBe("applied");
    resolveFirst(Response.json(reportFor("work/stale")));
    expect(await first).toBe("superseded");

    expect(shownPrimary).toBe("work/newest");
    expect(failures).toBe(0);
    expect(settled).toBe(1);
  });

  test("Models superseded stale recovery preserves the newer explicit refresh report and status", async () => {
    let resolveRecovery!: (response: Response) => void;
    let markRecoveryStarted!: () => void;
    const recoveryStarted = new Promise<void>(resolve => { markRecoveryStarted = resolve; });
    const recoveryResponse = new Promise<Response>(resolve => { resolveRecovery = resolve; });
    let latestRequest = 0;
    let shownPrimary = "";
    let visibleStatus = "initial";
    const reportFor = (primary: string) => ({
      policies: {},
      references: [{
        id: "provider-default:work",
        kind: "provider-default",
        primary,
        status: "ready",
        automaticEligible: true,
        policy: { fallbacks: [], automatic: "off" },
        supportStatus: "validated",
      }],
      circuits: [],
    });
    const load = (response: Promise<Response>) => {
      const requestId = ++latestRequest;
      return loadModelContinuityReport(
        async () => response,
        "/frogp",
        () => requestId === latestRequest,
        {
          success: report => {
            shownPrimary = report.references[0]?.primary ?? "";
            visibleStatus = "";
          },
          failure: () => { visibleStatus = "load failed"; },
          settled: () => {},
        },
      );
    };
    const staleAction = postModelContinuityAction(
      async () => Response.json({ error: "stale reference" }, { status: 409 }),
      "/frogp",
      {
        action: "replace",
        referenceId: "provider-default:work",
        expectedPrimary: "work/old",
        replacement: "work/new",
      },
      () => {
        markRecoveryStarted();
        return load(recoveryResponse);
      },
    );
    await recoveryStarted;
    const explicitRefresh = load(Promise.resolve(Response.json(reportFor("work/newest"))));
    expect(await explicitRefresh).toBe("applied");
    visibleStatus = "newest report shown";
    resolveRecovery(Response.json(reportFor("work/stale")));
    const actionResult = await staleAction;

    expect(actionResult).toEqual({
      ok: false,
      stale: false,
      reloadFailed: false,
      superseded: true,
      message: "stale reference",
    });
    expect(shownPrimary).toBe("work/newest");
    expect(visibleStatus).toBe("newest report shown");
  });

  test("Models model polling excludes continuity and model loading does not await it", () => {
    const models = read("gui/src/pages/Models.tsx");
    const modelLoadStart = models.indexOf("const loadModels = async");
    const refreshStart = models.indexOf("const refreshAll", modelLoadStart);
    const effectStart = models.indexOf("useEffect(() =>", refreshStart);
    const timerStart = models.indexOf("const timer = setInterval", effectStart);
    const modelLoad = models.slice(modelLoadStart, refreshStart);
    const refresh = models.slice(refreshStart, effectStart);
    const polling = models.slice(timerStart, models.indexOf("return () => clearInterval(timer)", timerStart));

    expect(modelLoad).not.toContain("loadContinuity");
    expect(modelLoad).toContain("setLoading(false)");
    expect(refresh).toContain("loadContinuity()");
    expect(polling).toContain("loadModels()");
    expect(polling).not.toContain("loadContinuity");
    expect(models).toContain("const continuityLoadSeqRef = useRef(0)");
  });

  test("Models continuity normal rows stay collapsed and localized copy avoids internal terms", () => {
    const models = read("gui/src/pages/Models.tsx");
    expect(models).toContain('<details className="continuity-normal-list">');
    expect(models).not.toContain('<details className="continuity-normal-list" open');

    for (const dict of [en, ko, zh]) {
      const copy = Object.entries(dict)
        .filter(([key]) => key.startsWith("models.continuity."))
        .map(([, value]) => value)
        .join(" ")
        .toLowerCase();
      expect(copy).not.toContain("circuit");
      expect(copy).not.toContain("tombstone");
      expect(copy).not.toContain("adapter");
      expect(copy).not.toContain("reference id");
    }
  });

  test("Claude profile removal protects the default and sole account", () => {
    expect(claudeProfileCanRemove({ isDefault: true }, 2)).toBe(false);
    expect(claudeProfileCanRemove({ isDefault: false }, 1)).toBe(false);
    expect(claudeProfileCanRemove({ isDefault: false }, 2)).toBe(true);
  });

  test("Claude profile Sonnet candidates stay explicit, usable, and namespaced", () => {
    const models = [
      { provider: "zeta", id: "Claude-SONNET-4", namespaced: "zeta/Claude-SONNET-4" },
      { provider: "alpha", id: "sonnet-latest", namespaced: "alpha/sonnet-latest", authReady: true },
      { provider: "alpha", id: "sonnet-disabled", namespaced: "alpha/sonnet-disabled", disabled: true },
      { provider: "alpha", id: "sonnet-login-required", namespaced: "alpha/sonnet-login-required", authReady: false },
      { provider: "alpha", id: "opus", namespaced: "alpha/opus" },
      { provider: "alpha", id: "sonnet-empty", namespaced: "   " },
    ];

    const candidates = sonnetModelCandidates(models);

    expect(candidates.map(model => model.namespaced)).toEqual([
      "alpha/sonnet-latest",
      "zeta/Claude-SONNET-4",
    ]);
    expect(sonnetModelCommand(candidates[1]!.namespaced)).toBe("/model zeta/Claude-SONNET-4");
  });

  test("Claude profile model loading rejects request failures instead of reporting an empty result", async () => {
    expect(await fetchProfileModels(async () => Response.json([]))).toEqual([]);

    for (const request of [
      async () => new Response("upstream failed", { status: 503 }),
      async () => new Response("not json", { headers: { "Content-Type": "application/json" } }),
      async () => Response.json({ models: [] }),
      async () => { throw new Error("network failed"); },
    ]) {
      expect(fetchProfileModels(request)).rejects.toThrow();
    }
  });

  test("Claude profile add warnings are not reported as successful setup", () => {
    expect(claudeProfileAddNotice({ warning: "Shortcut setup failed" }, "Account added")).toEqual({
      message: "Shortcut setup failed",
      success: false,
    });
    expect(claudeProfileAddNotice({}, "Account added")).toEqual({
      message: "Account added",
      success: true,
    });
  });

  test("Claude profile saved POST conflicts reload and select the saved account while reporting failure", () => {
    const savedError = (
      ClaudeProfiles as typeof ClaudeProfiles & { claudeProfileSavedError?: SavedErrorHelper }
    ).claudeProfileSavedError;
    expect(typeof savedError).toBe("function");
    if (!savedError) return;

    expect(savedError({
      code: "shortcut_conflict",
      error: "Account saved, but shortcut conflicts",
      profile: { id: "cp_saved", name: "work", claudeHome: "/redacted" },
    })).toEqual({
      profileId: "cp_saved",
      message: "Account saved, but shortcut conflicts",
      success: false,
    });
    expect(savedError({
      code: "shortcut_conflict",
      error: "Rename was rejected",
    })).toBeUndefined();

    const source = read("gui/src/pages/ClaudeProfiles.tsx");
    const addFlow = source.slice(source.indexOf("const addProfile"), source.indexOf("const setupShortcuts"));
    expect(addFlow).toContain("claudeProfileSavedError(body)");
    expect(addFlow).toContain("if (!res.ok && !savedError)");
    expect(addFlow.indexOf('setNewName(""); setNewHome("");')).toBeLessThan(addFlow.indexOf("await loadProfiles()"));
    expect(addFlow.indexOf("await loadProfiles()")).toBeLessThan(addFlow.indexOf("setSelectedId(savedError?.profileId"));
  });

  test("Claude profile PATCH warnings keep the saved profile reload but replace the success notice", () => {
    const patchNotice = (
      ClaudeProfiles as typeof ClaudeProfiles & { claudeProfilePatchNotice?: PatchNoticeHelper }
    ).claudeProfilePatchNotice;
    expect(typeof patchNotice).toBe("function");
    if (!patchNotice) return;

    expect(patchNotice({ warning: "Rename saved, but shortcut setup failed" }, "Account renamed")).toEqual({
      message: "Rename saved, but shortcut setup failed",
      success: false,
    });
    expect(patchNotice({}, "Account renamed")).toEqual({
      message: "Account renamed",
      success: true,
    });

    const source = read("gui/src/pages/ClaudeProfiles.tsx");
    const patchFlow = source.slice(source.indexOf("const patchSelected"), source.indexOf("const copyReloadCommand"));
    expect(patchFlow).toContain("warning?: string");
    expect(patchFlow.indexOf("await loadProfiles()")).toBeLessThan(patchFlow.indexOf("claudeProfilePatchNotice(result, successMessage)"));
    expect(patchFlow).toContain("notify(notice.message, notice.success)");
    expect(patchFlow).not.toContain("claudeProfileSavedError");
  });

  test("Claude profile DELETE warnings keep the reloaded state but replace the success notice", () => {
    const removeNotice = (
      ClaudeProfiles as typeof ClaudeProfiles & { claudeProfileRemoveNotice?: PatchNoticeHelper }
    ).claudeProfileRemoveNotice;
    expect(typeof removeNotice).toBe("function");
    if (!removeNotice) return;

    expect(removeNotice({ warning: "Account removed, but launcher cleanup was deferred" }, "Account removed")).toEqual({
      message: "Account removed, but launcher cleanup was deferred",
      success: false,
    });
    expect(removeNotice({}, "Account removed")).toEqual({
      message: "Account removed",
      success: true,
    });

    const source = read("gui/src/pages/ClaudeProfiles.tsx");
    const removeFlow = source.slice(source.indexOf("const removeSelected"), source.indexOf("const setupGrant"));
    expect(removeFlow).toContain("warning?: string");
    expect(removeFlow.indexOf("await loadProfiles()")).toBeLessThan(removeFlow.indexOf("claudeProfileRemoveNotice(body"));
    expect(removeFlow).toContain("notify(notice.message, notice.success)");
  });

  test("Claude profile shortcut conflicts require rename and never suggest shell setup", () => {
    expect(claudeProfileShortcutView({
      id: "cp_conflict",
      name: "work",
      claudeHome: "/redacted",
      shortcutIssue: "name_conflict",
    })).toEqual({
      command: "—",
      state: "name_conflict",
      showRenameAction: true,
      showSetupAction: false,
    });
    expect(claudeProfileShortcutView({
      id: "cp_missing",
      name: "team",
      claudeHome: "/redacted",
    })).toMatchObject({
      command: "—",
      state: "needs_setup",
      showRenameAction: false,
      showSetupAction: true,
    });

    for (const messages of [en, ko, zh]) {
      expect(messages["claudeProfiles.shortcutNameConflict"].trim()).not.toBe("");
      expect(messages["claudeProfiles.shortcutRenameHint"].trim()).not.toBe("");
    }
  });
  test("auto-mode review is a global checkbox and only reveals model controls when checked", () => {
    const developer = read("gui/src/pages/DeveloperDetails.tsx");
    const profiles = read("gui/src/pages/ClaudeProfiles.tsx");

    expect(developer).toContain("classifierEnabledDraft");
    expect(developer).toContain("autoModeClassifierEnabled: enabled");
    expect(developer).toContain("{classifierEnabledDraft && (");
    expect(developer).toContain("!classifierEnabledDraft && classifier?.autoModeClassifier.provider");
    expect(developer).toContain("saveClassifier(false, null)");
    expect(profiles).not.toContain("routeAutoModeClassifier");
    expect(profiles).toContain("autoModeClassifierEnabled");
  });


  test("Claude profile Sonnet command UI follows the global route and stays local and clipboard-safe", () => {
    const profiles = read("gui/src/pages/ClaudeProfiles.tsx");
    const copyStart = profiles.indexOf("const copySonnetCommand");
    const copyEnd = profiles.indexOf("\n  };", copyStart);
    const copyHandler = profiles.slice(copyStart, copyEnd);
    const sonnetUiStart = profiles.indexOf("{autoModeClassifierEnabled && (");
    const sonnetUiEnd = profiles.indexOf("\n          )}", sonnetUiStart);
    const sonnetUi = profiles.slice(sonnetUiStart, sonnetUiEnd);
    // Region-scoped (not exact-format) so reformatting the effect cannot fail a test that guards
    // behavior: switching Claude homes must drop the previous home's models and Sonnet selection.
    const switchEffectEnd = profiles.indexOf("[selected?.id]);");
    const switchEffectStart = profiles.lastIndexOf("useEffect(", switchEffectEnd);
    const switchEffect = profiles.slice(switchEffectStart, switchEffectEnd);

    expect(profiles).toContain("authReady?: boolean");
    expect(profiles).toContain('const [selectedSonnet, setSelectedSonnet] = useState("")');
    expect(switchEffectStart).toBeGreaterThan(-1);
    expect(switchEffectEnd).toBeGreaterThan(switchEffectStart);
    expect(switchEffect).toContain("setModels([])");
    expect(switchEffect).toContain('setSelectedSonnet("")');
    expect(switchEffect).toContain('setSonnetCopyState("idle")');
    expect(switchEffect).toContain("loadProfileDetails(selected)");
    expect(profiles).toContain("const requestId = ++modelRequestId.current");
    expect(profiles).toContain("if (requestId !== modelRequestId.current) return");
    expect(profiles).not.toContain("setSelectedSonnet(sonnetCandidates[0]");

    expect(sonnetUiStart).toBeGreaterThan(-1);
    expect(sonnetUiEnd).toBeGreaterThan(sonnetUiStart);
    // Upper bound: a reformat that breaks the region markers must fail here, not silently widen the
    // slice until the negative assertions below stop meaning anything. Sized to catch a runaway
    // file-scale slice (~49k chars), NOT to cap ordinary growth of this block (~3k).
    expect(sonnetUi.length).toBeLessThan(12000);
    // Loading and empty are distinct states: the "no Sonnet model" guidance must not claim a home has
    // no usable model while its models are still loading.
    expect(sonnetUi).toContain("modelsLoading ? (");
    expect(sonnetUi.indexOf("modelsLoading ? (")).toBeLessThan(sonnetUi.indexOf("claudeProfiles.noSonnetModels"));
    expect(sonnetUi).toContain('disabled={!sonnetCommand}');
    expect(sonnetUi).toContain("{model.provider}/{model.id}");
    expect(sonnetUi).toContain('<code className="text-anywhere">{sonnetCommand}</code>');
    expect(sonnetUi).toContain('navigate("models", "model-visibility-row")');
    expect(sonnetUi).not.toContain("fetch(");
    expect(sonnetUi).not.toContain("patchSelected(");

    expect(copyStart).toBeGreaterThan(-1);
    expect(copyEnd).toBeGreaterThan(copyStart);
    expect(copyHandler.length).toBeLessThan(600);
    expect(copyHandler).toContain("if (!navigator.clipboard)");
    expect(copyHandler).toContain("await navigator.clipboard.writeText(sonnetCommand)");
    expect(copyHandler).toContain('setSonnetCopyState("copied")');
    expect(copyHandler).toContain('setSonnetCopyState("failed")');
    expect(copyHandler).not.toContain("fetch(");
    expect(copyHandler).not.toContain("patchSelected(");

    const keys = [
      "claudeProfiles.sonnetPickerLabel",
      "claudeProfiles.sonnetPickerPlaceholder",
      "claudeProfiles.sonnetSessionHint",
      "claudeProfiles.sonnetCommand",
      "claudeProfiles.copySonnetCommand",
      "claudeProfiles.sonnetCommandCopied",
      "claudeProfiles.sonnetCommandCopyFailed",
      "claudeProfiles.noSonnetModels",
      "claudeProfiles.noSonnetModelsHint",
    ];
    for (const source of [
      read("gui/src/i18n/en.ts"),
      read("gui/src/i18n/ko.ts"),
      read("gui/src/i18n/zh.ts"),
    ]) {
      for (const key of keys) expect(source).toContain(`"${key}"`);
    }
  });
});
