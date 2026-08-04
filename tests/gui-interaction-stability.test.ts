import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pageToHash, parsePageHash, shouldPushPageHash } from "../gui/src/hash-routing";
import * as ClaudeProfiles from "../gui/src/pages/ClaudeProfiles";
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

  test("Claude profile Sonnet command UI is opt-in, local-only, and clipboard-safe", () => {
    const profiles = read("gui/src/pages/ClaudeProfiles.tsx");
    const copyStart = profiles.indexOf("const copySonnetCommand");
    const copyEnd = profiles.indexOf("\n  };", copyStart);
    const copyHandler = profiles.slice(copyStart, copyEnd);
    const sonnetUiStart = profiles.indexOf("{selected.routeAutoModeClassifier === true && (");
    const sonnetUiEnd = profiles.indexOf("\n            )}", sonnetUiStart);
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
    // Turning routing off and on again must not resurrect the previous command's copy result.
    const toggleEnd = profiles.indexOf("routeAutoModeClassifier: !selected.routeAutoModeClassifier");
    const toggleStart = profiles.lastIndexOf("onClick={() => {", toggleEnd);
    const toggleHandler = profiles.slice(toggleStart, toggleEnd);
    expect(toggleStart).toBeGreaterThan(-1);
    expect(toggleHandler).toContain('setSelectedSonnet("")');
    expect(toggleHandler).toContain('setSonnetCopyState("idle")');
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
