import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pageToHash, parsePageHash, shouldPushPageHash } from "../gui/src/hash-routing";
import { sonnetModelCandidates, sonnetModelCommand } from "../gui/src/pages/ClaudeProfiles";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

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
