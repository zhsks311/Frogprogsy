import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureZshAccountShortcuts, removeZshAccountShortcuts, zshAccountShortcutsSupported, zshManualPathLine } from "../src/shell-shortcuts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "frog-shell-shortcuts-"));
  const rcPath = join(root, ".zshrc");
  const binDir = join(root, "frog", "bin");
  mkdirSync(binDir, { recursive: true });
  return { root, rcPath, binDir };
}

describe("zsh account-shortcut setup", () => {
  test("supports only an explicit zsh on POSIX", () => {
    expect(zshAccountShortcutsSupported({ SHELL: "/bin/bash" })).toBe(false);
    expect(zshAccountShortcutsSupported({})).toBe(false);
    expect(zshAccountShortcutsSupported({ SHELL: "/bin/zsh" })).toBe(process.platform !== "win32");
  });

  test.skipIf(process.platform === "win32")("appends one owned block, preserves mode and line endings, and is idempotent", () => {
    const { root, rcPath, binDir } = fixture();
    try {
      writeFileSync(rcPath, "# user config\r\nexport EDITOR=vim\r\n", { encoding: "utf8", mode: 0o640 });
      chmodSync(rcPath, 0o640);

      const first = configureZshAccountShortcuts({ rcPath, binDir });
      expect(first.state).toBe("configured");
      const content = readFileSync(rcPath, "utf8");
      expect(content.match(/frogprogsy account shortcuts/g)).toHaveLength(2);
      expect(content).toContain(zshManualPathLine({ binDir }));
      expect(content.replaceAll("\r\n", "")).not.toContain("\n");
      expect(lstatSync(rcPath).mode & 0o777).toBe(0o640);

      const second = configureZshAccountShortcuts({ rcPath, binDir });
      expect(second.state).toBe("already_configured");
      expect(readFileSync(rcPath, "utf8")).toBe(content);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not add a block when the shortcut path already exists", () => {
    const { root, rcPath, binDir } = fixture();
    try {
      writeFileSync(rcPath, `${zshManualPathLine({ binDir })}\n`, "utf8");
      const result = configureZshAccountShortcuts({ rcPath, binDir });
      expect(result.state).toBe("already_configured");
      expect(readFileSync(rcPath, "utf8")).toBe(`${zshManualPathLine({ binDir })}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("adds an active block when the shortcut path appears only in a comment", () => {
    const { root, rcPath, binDir } = fixture();
    try {
      writeFileSync(rcPath, `#${zshManualPathLine({ binDir })}\n`, "utf8");
      const result = configureZshAccountShortcuts({ rcPath, binDir });
      const content = readFileSync(rcPath, "utf8");

      expect(result.state).toBe("configured");
      expect(content).toContain(`#${zshManualPathLine({ binDir })}`);
      expect(content).toContain(`\n${zshManualPathLine({ binDir })}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!existsSync("/bin/zsh"))("quotes an override bin path so zsh sources it as one PATH entry", () => {
    const { root, rcPath } = fixture();
    const binDir = join(root, "frog's account shortcuts", "bin");
    mkdirSync(binDir, { recursive: true });
    try {
      expect(configureZshAccountShortcuts({ rcPath, binDir }).state).toBe("configured");
      const result = spawnSync("/bin/zsh", ["-fc", `. ${JSON.stringify(rcPath)}; print -r -- \"$PATH\"`], {
        env: { PATH: "/usr/bin:/bin" },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split(":")).toContain(binDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("removes only the adjacent separator and preserves unrelated blank lines", () => {
    const { root, rcPath, binDir } = fixture();
    const original = "# first\n\n\n\n# second\n";
    try {
      writeFileSync(rcPath, original, "utf8");
      expect(configureZshAccountShortcuts({ rcPath, binDir }).state).toBe("configured");
      expect(removeZshAccountShortcuts({ rcPath, binDir }).state).toBe("configured");
      expect(readFileSync(rcPath, "utf8")).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses symlink rc files and edited marker blocks", () => {
    const { root, rcPath, binDir } = fixture();
    try {
      const target = join(root, "real-zshrc");
      writeFileSync(target, "# user\n", "utf8");
      symlinkSync(target, rcPath);
      expect(configureZshAccountShortcuts({ rcPath, binDir })).toMatchObject({ state: "refused" });
      expect(readFileSync(target, "utf8")).toBe("# user\n");

      rmSync(rcPath);
      writeFileSync(rcPath, "# >>> frogprogsy account shortcuts >>>\n# user edited\n", "utf8");
      expect(configureZshAccountShortcuts({ rcPath, binDir })).toMatchObject({ state: "refused" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("stops on a concurrent edit and preserves the newer user content", () => {
    const { root, rcPath, binDir } = fixture();
    try {
      writeFileSync(rcPath, "# original\n", "utf8");
      const result = configureZshAccountShortcuts({
        rcPath,
        binDir,
        beforePublish: () => writeFileSync(rcPath, "# concurrent user edit\n", "utf8"),
      });
      expect(result.state).toBe("refused");
      expect(readFileSync(rcPath, "utf8")).toBe("# concurrent user edit\n");
      expect(existsSync(`${rcPath}.frogp.${process.pid}.tmp`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("removes only an exact owned block and refuses an edited one", () => {
    const { root, rcPath, binDir } = fixture();
    try {
      writeFileSync(rcPath, "# user config\n", "utf8");
      expect(configureZshAccountShortcuts({ rcPath, binDir }).state).toBe("configured");
      expect(removeZshAccountShortcuts({ rcPath, binDir }).state).toBe("configured");
      expect(readFileSync(rcPath, "utf8")).toContain("# user config");
      expect(readFileSync(rcPath, "utf8")).not.toContain("frogprogsy account shortcuts");

      writeFileSync(rcPath, "# >>> frogprogsy account shortcuts >>>\n# edited\n# <<< frogprogsy account shortcuts <<<\n", "utf8");
      expect(removeZshAccountShortcuts({ rcPath })).toMatchObject({ state: "refused" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses while a marked plain claude launcher still exists", () => {
    const { root, rcPath, binDir } = fixture();
    try {
      writeFileSync(join(binDir, process.platform === "win32" ? "claude.cmd" : "claude"), "# Generated by frogprogsy\n", "utf8");
      expect(() => configureZshAccountShortcuts({ rcPath, binDir })).toThrow(/plain claude launcher still exists/);
      expect(existsSync(rcPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
