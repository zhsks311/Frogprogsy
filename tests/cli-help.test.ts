import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");



describe("CLI subcommand help", () => {
  test("restore --help prints usage without mutating Claude Code config", () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-help-"));
    try {
      const configPath = join(claudeHome, "config.toml");
      const before = [
        'model_provider = "frogprogsy"',
        "",
        "[model_providers.frogprogsy]",
        'base_url = "http://localhost:10100/v1"',
        'wire_api = "messages"',
        "",
      ].join("\n");
      writeFileSync(configPath, before, "utf8");

      const result = spawnSync(process.execPath, [cliPath, "restore", "--help"], {
        cwd: repoRoot,
        env: { ...process.env, CLAUDE_HOME: claudeHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: frogp restore");
      expect(result.stdout).toContain("every enrolled project");
      expect(result.stdout).toContain("retains enrollment intent");
      expect(result.stdout).toContain("next start/refresh reapplies enrolled projects");
      expect(result.stdout).not.toContain("Plain `claude` now runs natively");
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      rmSync(claudeHome, { recursive: true, force: true });
    }
  }, 15000);
  test("stop --help documents enrolled-project routing suspension", () => {
    const result = spawnSync(process.execPath, [cliPath, "stop", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: frogp stop");
    expect(result.stdout).toContain("every enrolled project");
    expect(result.stdout).toContain("retains enrollment intent");
    expect(result.stdout).toContain("next start/refresh reapplies enrolled projects");
  }, 15000);


  test("uninstall --help prints usage without uninstalling", () => {
    const result = spawnSync(process.execPath, [cliPath, "uninstall", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: frogp uninstall");
    expect(result.stdout).toContain("every enrolled project");
    expect(result.stdout).not.toContain("frogprogsy uninstalled");
    expect(result.stderr).not.toContain("Unknown command");
  }, 15000);

  test("frogp --version prints the installed package version", () => {
    const pkgVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version as string;
    const result = spawnSync(process.execPath, [cliPath, "--version"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`frogprogsy v${pkgVersion}`);
  }, 15000);

  test("frogp help <command> prints that command's usage", () => {
    const result = spawnSync(process.execPath, [cliPath, "help", "login"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: frogp login");
  });

  test("frogp help with an unknown topic fails and suggests the closest command", () => {
    const result = spawnSync(process.execPath, [cliPath, "help", "statu"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown help topic: statu");
    expect(result.stderr).toContain("Did you mean: frogp help status?");
  });

  test("unknown command fails and suggests the closest command", () => {
    const result = spawnSync(process.execPath, [cliPath, "refrsh"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: refrsh");
    expect(result.stderr).toContain("Did you mean: frogp refresh?");
  });

  test("help topics cover status --json, models, and login --list", () => {
    const statusHelp = spawnSync(process.execPath, [cliPath, "help", "status"], { cwd: repoRoot, encoding: "utf8" });
    expect(statusHelp.status).toBe(0);
    expect(statusHelp.stdout).toContain("--json");

    const modelsHelp = spawnSync(process.execPath, [cliPath, "help", "models"], { cwd: repoRoot, encoding: "utf8" });
    expect(modelsHelp.status).toBe(0);
    expect(modelsHelp.stdout).toContain("RUNNING proxy");
    expect(modelsHelp.stdout).toContain("--json");
    expect(modelsHelp.stdout).toContain("frogp start");

    const loginHelp = spawnSync(process.execPath, [cliPath, "help", "login"], { cwd: repoRoot, encoding: "utf8" });
    expect(loginHelp.status).toBe(0);
    expect(loginHelp.stdout).toContain("--list");
  }, 15000);

  test("claude help recommends project enrollment without account-selection claims", () => {
    const result = spawnSync(process.execPath, [cliPath, "help", "claude"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("frogp claude project enroll [path]");
    expect(result.stdout).toContain("<project>/.claude/settings.local.json");
    expect(result.stdout).toContain("not chosen by project enrollment");
    expect(result.stdout).not.toContain("selects the Claude account");
  }, 15000);
  test("login anthropic returns pass-through guidance instead of starting OAuth", () => {
    const result = spawnSync(process.execPath, [cliPath, "login", "anthropic"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Claude subscription OAuth login is not supported");
    expect(result.stderr).toContain("frogp claude");
  });

  test("claude run treats --help after -- as Claude payload instead of frogp help", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-claude-payload-help-"));
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-claude-payload-home-"));
    const env = { ...process.env, FROGPROGSY_HOME: frogHome, CLAUDE_HOME: claudeHome, CLAUDE_CONFIG_DIR: claudeHome };
    try {
      const result = spawnSync(process.execPath, [cliPath, "claude", "run", "missing-profile", "--", "--help"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unknown Claude Code home: missing-profile");
      expect(result.stdout).not.toContain("Usage: frogp claude");
    } finally {
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("claude shortcuts setup appends the account shortcut path to zshrc", () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-shortcuts-cli-"));
    const frogHome = join(root, "frog");
    const userHome = join(root, "user");
    const claudeHome = join(userHome, ".claude");
    mkdirSync(join(frogHome, "bin"), { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: userHome,
      SHELL: "/bin/zsh",
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: claudeHome,
      CLAUDE_CONFIG_DIR: claudeHome,
    };
    delete env.ZDOTDIR;
    try {
      const result = spawnSync(process.execPath, [cliPath, "claude", "shortcuts", "setup"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("open a new terminal");
      expect(readFileSync(join(userHome, ".zshrc"), "utf8")).toContain(frogHome.replaceAll("\\", "/"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude shortcuts setup stays manual when SHELL is unset", () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-shortcuts-manual-"));
    const frogHome = join(root, "frog");
    const userHome = join(root, "user");
    const claudeHome = join(userHome, ".claude");
    mkdirSync(claudeHome, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: claudeHome,
      CLAUDE_CONFIG_DIR: claudeHome,
    };
    delete env.SHELL;
    delete env.ZDOTDIR;
    try {
      const result = spawnSync(process.execPath, [cliPath, "claude", "shortcuts", "setup"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("supports zsh on POSIX only");
      expect(result.stdout).toContain(process.platform === "win32" ? "$env:Path +=" : "export PATH=");
      expect(existsSync(join(userHome, ".zshrc"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude add rejects a missing explicit home before saving config", () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-claude-missing-home-"));
    const frogHome = join(root, "frog");
    const defaultClaudeHome = join(root, "default");
    const missingHome = join(root, "missing");
    mkdirSync(defaultClaudeHome);
    try {
      const result = spawnSync(process.execPath, [cliPath, "claude", "add", "work", "--home", missingHome], {
        cwd: repoRoot,
        env: { ...process.env, FROGPROGSY_HOME: frogHome, CLAUDE_HOME: defaultClaudeHome, CLAUDE_CONFIG_DIR: defaultClaudeHome },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--home must point at an existing Claude Code home directory");
      expect(existsSync(join(frogHome, "config.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude add with only a command name creates a 0700 home and account shortcut", () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-claude-name-only-"));
    const frogHome = join(root, "frog");
    const userHome = join(root, "user");
    const defaultClaudeHome = join(userHome, ".claude");
    const realClaude = process.platform === "win32" ? process.execPath : "/usr/bin/true";
    mkdirSync(defaultClaudeHome, { recursive: true });
    const env = {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: defaultClaudeHome,
      CLAUDE_CONFIG_DIR: defaultClaudeHome,
      FROGP_REAL_CLAUDE: realClaude,
    };
    try {
      const result = spawnSync(process.execPath, [cliPath, "claude", "add", "work"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Claude account added: work");
      expect(result.stdout).toContain("next: open a new terminal and run claude-work");
      const workHome = join(userHome, ".claude-work");
      expect(existsSync(workHome)).toBe(true);
      if (process.platform !== "win32") expect(statSync(workHome).mode & 0o777).toBe(0o700);
      expect(existsSync(join(frogHome, "bin", process.platform === "win32" ? "claude-work.cmd" : "claude-work"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude add does not claim plain Claude Code is installed when the original executable is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-claude-missing-executable-"));
    const frogHome = join(root, "frog");
    const userHome = join(root, "user");
    const defaultClaudeHome = join(userHome, ".claude");
    mkdirSync(defaultClaudeHome, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
      PATH: join(root, "empty-bin"),
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: defaultClaudeHome,
      CLAUDE_CONFIG_DIR: defaultClaudeHome,
    };
    delete env.FROGP_REAL_CLAUDE;
    try {
      const result = spawnSync(process.execPath, [cliPath, "claude", "add", "work"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("install Claude Code");
      expect(result.stdout).not.toContain("remains your installed Claude Code");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude home CLI add and rename keep a stable id", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-claude-cli-"));
    const defaultClaudeHome = mkdtempSync(join(tmpdir(), "frogp-claude-default-"));
    const workClaudeHome = mkdtempSync(join(tmpdir(), "frogp-claude-work-"));
    const realClaude = process.platform === "win32" ? process.execPath : "/usr/bin/true";
    const env = { ...process.env, FROGPROGSY_HOME: frogHome, CLAUDE_HOME: defaultClaudeHome, CLAUDE_CONFIG_DIR: defaultClaudeHome, FROGP_REAL_CLAUDE: realClaude };
    try {
      const added = spawnSync(process.execPath, [cliPath, "claude", "add", "컬리 업무용", "--home", workClaudeHome], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(added.status).toBe(0);
      expect(added.stdout).toContain("Claude account added");

      const configPath = join(frogHome, "config.json");
      const afterAdd = JSON.parse(readFileSync(configPath, "utf8"));
      const workProfile = afterAdd.claudeProfiles.profiles.find((profile: any) => profile.name === "컬리 업무용");
      expect(workProfile.id).toMatch(/^cp_[a-z0-9]+$/);
      expect(workProfile.claudeHome).toBe(workClaudeHome);

      const renamed = spawnSync(process.execPath, [cliPath, "claude", "rename", workProfile.id, "개인 Max"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(renamed.status).toBe(0);
      const afterRename = JSON.parse(readFileSync(configPath, "utf8"));
      const renamedProfile = afterRename.claudeProfiles.profiles.find((profile: any) => profile.name === "개인 Max");
      expect(renamedProfile.id).toBe(workProfile.id);
      expect(renamedProfile.claudeHome).toBe(workClaudeHome);
    } finally {
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(defaultClaudeHome, { recursive: true, force: true });
      rmSync(workClaudeHome, { recursive: true, force: true });
    }
  });

  test("claude add exits nonzero after saving an account whose shortcut name conflicts", () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-claude-add-conflict-"));
    const frogHome = join(root, "frog");
    const defaultClaudeHome = join(root, "default");
    const firstHome = join(root, "first");
    const conflictingHome = join(root, "conflicting");
    const realClaude = process.platform === "win32" ? process.execPath : "/usr/bin/true";
    mkdirSync(defaultClaudeHome);
    mkdirSync(firstHome);
    mkdirSync(conflictingHome);
    const env = {
      ...process.env,
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: defaultClaudeHome,
      CLAUDE_CONFIG_DIR: defaultClaudeHome,
      FROGP_REAL_CLAUDE: realClaude,
    };
    try {
      const first = spawnSync(process.execPath, [cliPath, "claude", "add", "Work", "--home", firstHome], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(first.status).toBe(0);

      const conflicting = spawnSync(process.execPath, [cliPath, "claude", "add", "work", "--home", conflictingHome], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      const savedConfig = JSON.parse(readFileSync(join(frogHome, "config.json"), "utf8")) as {
        claudeProfiles: { profiles: Array<{ id: string; name: string; claudeHome: string }> };
      };
      const saved = savedConfig.claudeProfiles.profiles.find(profile => profile.claudeHome === conflictingHome)!;

      expect(conflicting.status).not.toBe(0);
      expect(saved).toMatchObject({ name: "work", claudeHome: conflictingHome });
      expect(conflicting.stderr).toContain(`Account was saved: work (${saved.id})`);
      expect(conflicting.stderr).toContain("shortcut name conflicts");
      expect(conflicting.stderr).toContain("rename");
      expect(conflicting.stdout).not.toContain("Claude account added: work");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude rename rejects a later account collision without saving or replacing the existing shortcut owner", () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-claude-rename-conflict-"));
    const frogHome = join(root, "frog");
    const defaultClaudeHome = join(root, "default");
    const workHome = join(root, "work");
    const personalHome = join(root, "personal");
    const realClaude = process.platform === "win32" ? process.execPath : "/usr/bin/true";
    mkdirSync(defaultClaudeHome);
    mkdirSync(workHome);
    mkdirSync(personalHome);
    const env = {
      ...process.env,
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: defaultClaudeHome,
      CLAUDE_CONFIG_DIR: defaultClaudeHome,
      FROGP_REAL_CLAUDE: realClaude,
    };
    try {
      const work = spawnSync(process.execPath, [cliPath, "claude", "add", "Work", "--home", workHome], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      const personal = spawnSync(process.execPath, [cliPath, "claude", "add", "Personal", "--home", personalHome], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(work.status).toBe(0);
      expect(personal.status).toBe(0);
      const beforeRename = JSON.parse(readFileSync(join(frogHome, "config.json"), "utf8")) as {
        claudeProfiles: { profiles: Array<{ id: string; name: string; claudeHome: string }> };
      };
      const personalId = beforeRename.claudeProfiles.profiles.find(profile => profile.claudeHome === personalHome)!.id;
      const workLauncher = join(frogHome, "bin", process.platform === "win32" ? "claude-work.cmd" : "claude-work");
      const workLauncherBefore = readFileSync(workLauncher);

      const renamed = spawnSync(process.execPath, [cliPath, "claude", "rename", personalId, "work"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      const afterRename = JSON.parse(readFileSync(join(frogHome, "config.json"), "utf8")) as {
        claudeProfiles: { profiles: Array<{ id: string; name: string; claudeHome: string }> };
      };
      const unchanged = afterRename.claudeProfiles.profiles.find(profile => profile.id === personalId)!;

      expect(renamed.status).not.toBe(0);
      expect(unchanged).toMatchObject({ id: personalId, name: "Personal", claudeHome: personalHome });
      expect(readFileSync(workLauncher)).toEqual(workLauncherBefore);
      expect(renamed.stderr).toContain("shortcut name conflicts");
      expect(renamed.stderr).not.toContain("rename was saved");
      expect(renamed.stdout).not.toContain("Claude Code home renamed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude rename rejects an earlier account collision without saving or replacing the existing shortcut owner", () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-claude-rename-reverse-conflict-"));
    const frogHome = join(root, "frog");
    const defaultClaudeHome = join(root, "default");
    const workHome = join(root, "work");
    const personalHome = join(root, "personal");
    const realClaude = process.platform === "win32" ? process.execPath : "/usr/bin/true";
    mkdirSync(defaultClaudeHome);
    mkdirSync(workHome);
    mkdirSync(personalHome);
    const env = {
      ...process.env,
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: defaultClaudeHome,
      CLAUDE_CONFIG_DIR: defaultClaudeHome,
      FROGP_REAL_CLAUDE: realClaude,
    };
    try {
      const work = spawnSync(process.execPath, [cliPath, "claude", "add", "Work", "--home", workHome], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      const personal = spawnSync(process.execPath, [cliPath, "claude", "add", "Personal", "--home", personalHome], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(work.status).toBe(0);
      expect(personal.status).toBe(0);
      const beforeRename = JSON.parse(readFileSync(join(frogHome, "config.json"), "utf8")) as {
        claudeProfiles: { profiles: Array<{ id: string; name: string; claudeHome: string }> };
      };
      const workId = beforeRename.claudeProfiles.profiles.find(profile => profile.claudeHome === workHome)!.id;
      const personalLauncher = join(frogHome, "bin", process.platform === "win32" ? "claude-personal.cmd" : "claude-personal");
      const personalLauncherBefore = readFileSync(personalLauncher);

      const renamed = spawnSync(process.execPath, [cliPath, "claude", "rename", workId, "personal"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      const afterRename = JSON.parse(readFileSync(join(frogHome, "config.json"), "utf8")) as {
        claudeProfiles: { profiles: Array<{ id: string; name: string; claudeHome: string }> };
      };
      const unchanged = afterRename.claudeProfiles.profiles.find(profile => profile.id === workId)!;

      expect(renamed.status).not.toBe(0);
      expect(unchanged).toMatchObject({ id: workId, name: "Work", claudeHome: workHome });
      expect(afterRename.claudeProfiles.profiles.find(profile => profile.claudeHome === personalHome)).toMatchObject({ name: "Personal" });
      expect(readFileSync(personalLauncher)).toEqual(personalLauncherBefore);
      expect(renamed.stderr).toContain("shortcut name conflicts");
      expect(renamed.stderr).not.toContain("rename was saved");
      expect(renamed.stdout).not.toContain("Claude Code home renamed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude rename succeeds for the default profile when native Claude is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-claude-default-rename-no-native-"));
    const frogHome = join(root, "frog");
    const defaultClaudeHome = join(root, "default");
    const emptyPath = join(root, "empty-path");
    mkdirSync(frogHome);
    mkdirSync(defaultClaudeHome);
    mkdirSync(emptyPath);
    writeFileSync(join(frogHome, "config.json"), JSON.stringify({
      port: 10100,
      defaultProvider: "test",
      providers: {
        test: { adapter: "openai-chat", baseUrl: "https://models.test/v1", apiKey: "sk-test", defaultModel: "alpha", models: ["alpha"], liveModels: false },
      },
      claudeProfiles: {
        schemaVersion: 1,
        defaultProfileId: "cp_default",
        profiles: [{ id: "cp_default", name: "Default", claudeHome: defaultClaudeHome, authState: "not_seen" }],
      },
    }, null, 2) + "\n");
    const { FROGP_REAL_CLAUDE: _realClaude, ...baseEnv } = process.env;
    const env = {
      ...baseEnv,
      PATH: emptyPath,
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: defaultClaudeHome,
      CLAUDE_CONFIG_DIR: defaultClaudeHome,
    };

    try {
      const renamed = spawnSync(process.execPath, [cliPath, "claude", "rename", "cp_default", "Primary"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      const saved = JSON.parse(readFileSync(join(frogHome, "config.json"), "utf8")) as {
        claudeProfiles: { profiles: Array<{ id: string; name: string }> };
      };

      expect(renamed.status).toBe(0);
      expect(saved.claudeProfiles.profiles.find(profile => profile.id === "cp_default")?.name).toBe("Primary");
      expect(renamed.stdout).toContain("Claude Code home renamed: Primary (cp_default)");
      expect(renamed.stderr).not.toContain("shortcut name conflicts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  test("claude rename reports missing native Claude instead of a name conflict for a planned nondefault launcher", () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-claude-rename-no-native-"));
    const frogHome = join(root, "frog");
    const defaultClaudeHome = join(root, "default");
    const workHome = join(root, "work");
    const emptyPath = join(root, "empty-path");
    mkdirSync(frogHome);
    mkdirSync(defaultClaudeHome);
    mkdirSync(workHome);
    mkdirSync(emptyPath);
    writeFileSync(join(frogHome, "config.json"), JSON.stringify({
      port: 10100,
      defaultProvider: "test",
      providers: {
        test: { adapter: "openai-chat", baseUrl: "https://models.test/v1", apiKey: "sk-test", defaultModel: "alpha", models: ["alpha"], liveModels: false },
      },
      claudeProfiles: {
        schemaVersion: 1,
        defaultProfileId: "cp_default",
        profiles: [
          { id: "cp_default", name: "Default", claudeHome: defaultClaudeHome, authState: "not_seen" },
          { id: "cp_work", name: "Work", claudeHome: workHome, authState: "not_seen" },
        ],
      },
    }, null, 2) + "\n");
    const { FROGP_REAL_CLAUDE: _realClaude, ...baseEnv } = process.env;
    const env = {
      ...baseEnv,
      PATH: emptyPath,
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: defaultClaudeHome,
      CLAUDE_CONFIG_DIR: defaultClaudeHome,
    };

    try {
      const renamed = spawnSync(process.execPath, [cliPath, "claude", "rename", "cp_work", "Personal"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      const saved = JSON.parse(readFileSync(join(frogHome, "config.json"), "utf8")) as {
        claudeProfiles: { profiles: Array<{ id: string; name: string }> };
      };

      expect(renamed.status).not.toBe(0);
      expect(saved.claudeProfiles.profiles.find(profile => profile.id === "cp_work")?.name).toBe("Personal");
      expect(renamed.stderr).toContain("original Claude Code executable was not found");
      expect(renamed.stderr).toContain("install Claude Code");
      expect(renamed.stderr).toContain("frogp refresh");
      expect(renamed.stderr).not.toContain("shortcut name conflicts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  test("claude rename reports a launcher creation problem when the planned target is unowned", () => {
    const root = mkdtempSync(join(tmpdir(), "frogp-claude-rename-unowned-launcher-"));
    const frogHome = join(root, "frog");
    const defaultClaudeHome = join(root, "default");
    const workHome = join(root, "work");
    mkdirSync(join(frogHome, "bin"), { recursive: true });
    mkdirSync(defaultClaudeHome);
    mkdirSync(workHome);
    writeFileSync(join(frogHome, "bin", process.platform === "win32" ? "claude-personal.cmd" : "claude-personal"), "user-owned launcher\n");
    writeFileSync(join(frogHome, "config.json"), JSON.stringify({
      port: 10100,
      defaultProvider: "test",
      providers: {
        test: { adapter: "openai-chat", baseUrl: "https://models.test/v1", apiKey: "sk-test", defaultModel: "alpha", models: ["alpha"], liveModels: false },
      },
      claudeProfiles: {
        schemaVersion: 1,
        defaultProfileId: "cp_default",
        profiles: [
          { id: "cp_default", name: "Default", claudeHome: defaultClaudeHome, authState: "not_seen" },
          { id: "cp_work", name: "Work", claudeHome: workHome, authState: "not_seen" },
        ],
      },
    }, null, 2) + "\n");
    const realClaude = process.platform === "win32" ? process.execPath : "/usr/bin/true";
    const env = {
      ...process.env,
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: defaultClaudeHome,
      CLAUDE_CONFIG_DIR: defaultClaudeHome,
      FROGP_REAL_CLAUDE: realClaude,
    };

    try {
      const renamed = spawnSync(process.execPath, [cliPath, "claude", "rename", "cp_work", "Personal"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });

      expect(renamed.status).not.toBe(0);
      expect(renamed.stderr).toContain("shortcut could not be created");
      expect(renamed.stderr).toContain("frogp refresh");
      expect(renamed.stderr).not.toContain("shortcut name conflicts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  test("claude remove validates the only home before project cleanup", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-remove-only-"));
    const defaultClaudeHome = mkdtempSync(join(tmpdir(), "frogp-remove-only-claude-"));
    const project = mkdtempSync(join(tmpdir(), "frogp-remove-only-project-"));
    const env = { ...process.env, FROGPROGSY_HOME: frogHome, CLAUDE_HOME: defaultClaudeHome, CLAUDE_CONFIG_DIR: defaultClaudeHome };
    try {
      mkdirSync(join(project, ".claude"), { recursive: true });
      writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({
        env: { ANTHROPIC_CUSTOM_HEADERS: "X-Frogp-Claude-Profile: cp_default" },
      }, null, 2));
      writeFileSync(join(frogHome, "config.json"), JSON.stringify({
        port: 10100,
        defaultProvider: "codex",
        providers: {
          codex: { adapter: "openai-chat", baseUrl: "https://models.test/v1", apiKey: "sk-test", defaultModel: "gpt-5.5", models: ["gpt-5.5"], liveModels: false },
        },
        claudeProfiles: {
          schemaVersion: 1,
          defaultProfileId: "cp_default",
          profiles: [{ id: "cp_default", name: "Default", claudeHome: defaultClaudeHome, authState: "not_seen" }],
        },
        claudeProjects: {
          schemaVersion: 1,
          projects: [{ id: "cpr_default", name: "project", projectPath: project, routingProfileId: "cp_default", enrolled: true }],
        },
      }, null, 2) + "\n");

      const result = spawnSync(process.execPath, [cliPath, "claude", "remove", "cp_default"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Cannot remove the only Claude Code home");
      const configAfter = JSON.parse(readFileSync(join(frogHome, "config.json"), "utf8"));
      expect(configAfter.claudeProjects.projects[0].routingProfileId).toBe("cp_default");
      const settingsAfter = JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf8"));
      expect(settingsAfter.env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Frogp-Claude-Profile: cp_default");
    } finally {
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(defaultClaudeHome, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 15000);
  test("claude reload-models prepares a selected home without starting the proxy", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-reload-cli-"));
    const defaultClaudeHome = mkdtempSync(join(tmpdir(), "frogp-reload-default-"));
    const workClaudeHome = mkdtempSync(join(tmpdir(), "frogp-reload-work-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: defaultClaudeHome,
      CLAUDE_CONFIG_DIR: defaultClaudeHome,
    };
    delete env.FROGPROGSY_NO_CLAUDE_WRITES;

    try {
      writeFileSync(join(frogHome, "config.json"), JSON.stringify({
        port: 9,
        defaultProvider: "codex",
        providers: {
          codex: {
            adapter: "openai-chat",
            baseUrl: "https://models.test/v1",
            apiKey: "sk-test",
            defaultModel: "gpt-5.5",
            models: ["gpt-5.5"],
            liveModels: false,
          },
        },
        claudeProfiles: {
          schemaVersion: 1,
          defaultProfileId: "cp_default",
          profiles: [
            { id: "cp_default", name: "Default", claudeHome: defaultClaudeHome, authState: "not_seen" },
            { id: "cp_work", name: "Work Home", claudeHome: workClaudeHome, authState: "not_seen" },
          ],
        },
      }, null, 2) + "\n");

      const result = spawnSync(process.execPath, [cliPath, "claude", "reload-models", "cp_work"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Model reload prepared for Work Home (cp_work)");
      expect(result.stdout).toContain("Gateway cache: written (1 models)");
      expect(result.stdout).toContain("Catalog cache: not synced");
      expect(result.stdout).toContain("Proxy is not answering on port 9; run frogp refresh");
      expect(result.stdout).toContain("Start a new Claude Code session or resume so it refetches /v1/models");
      expect(result.stdout).toContain("frogp claude project enroll [path]");
      expect(result.stdout).not.toContain("frogp start");

      const namedResult = spawnSync(process.execPath, [cliPath, "claude", "reload-models", "Work Home"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(namedResult.status).toBe(0);
      expect(namedResult.stdout).toContain("Model reload prepared for Work Home (cp_work)");

      const gatewayCache = JSON.parse(readFileSync(join(workClaudeHome, "cache", "gateway-models.json"), "utf8"));
      expect(gatewayCache.models.map((model: any) => model.display_name)).toEqual(["codex/gpt-5.5"]);

      const settings = JSON.parse(readFileSync(join(workClaudeHome, "settings.json"), "utf8"));
      expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://localhost:9");
      expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
      expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toContain("X-Frogp-Claude-Profile: cp_work");

      const globalAuthResult = spawnSync(process.execPath, [cliPath, "claude", "reload-models", "cp_work", "--global-discovery-auth"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(globalAuthResult.status).toBe(0);
      expect(globalAuthResult.stdout).toContain("Local gateway auth token injected into settings");
      const globalAuthSettings = JSON.parse(readFileSync(join(workClaudeHome, "settings.json"), "utf8"));
      expect(globalAuthSettings.env.ANTHROPIC_AUTH_TOKEN).toBe("local-frogprogsy");
    } finally {
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(defaultClaudeHome, { recursive: true, force: true });
      rmSync(workClaudeHome, { recursive: true, force: true });
    }
  });
  test("claude reload-models sends the local Origin required by a non-loopback management guard", async () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-running-reload-cli-"));
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-running-reload-claude-"));
    const refreshRequests: Array<{ path: string; origin: string | null; body: unknown }> = [];
    let writesBlocked = false;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/healthz") return Response.json({ status: "ok" });
        if (url.pathname === "/api/claude-profiles/cp_work/refresh" && request.method === "POST") {
          refreshRequests.push({
            path: url.pathname,
            origin: request.headers.get("origin"),
            body: await request.json(),
          });
          if (request.headers.get("origin") !== `http://127.0.0.1:${server.port}`) {
            return Response.json({ error: "cross-origin request blocked" }, { status: 403 });
          }
          if (writesBlocked) {
            return Response.json({
              success: true,
              message: "Claude Code environment writes disabled; home refresh skipped.",
              modelReload: {
                attempted: false,
                writeBlocked: true,
                status: "skipped",
                catalog: { exists: null, cacheSynced: false },
                gatewayCache: { status: "skipped" },
                warnings: ["Claude Code environment writes disabled; model reload skipped."],
              },
            });
          }
          return Response.json({
            success: true,
            message: "server snapshot refreshed",
            profile: { id: "cp_work", name: "Work Home", claudeHome },
            modelReload: {
              attempted: true,
              writeBlocked: false,
              status: "synced",
              catalog: { path: "/server/models.json", added: 2, exists: true, cacheSynced: true },
              gatewayCache: { status: "written", modelCount: 2 },
              warnings: [],
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: claudeHome,
      CLAUDE_CONFIG_DIR: claudeHome,
    };
    delete env.FROGPROGSY_NO_CLAUDE_WRITES;

    try {
      writeFileSync(join(frogHome, "config.json"), JSON.stringify({
        port: server.port,
        defaultProvider: "codex",
        modelCatalogConfigVersion: 1,
        providers: {
          codex: {
            adapter: "openai-chat",
            baseUrl: "https://models.test/v1",
            catalogProviderId: "codex",
            apiKey: "sk-test",
            models: ["local-stale-model"],
            liveModels: false,
          },
        },
        claudeProfiles: {
          schemaVersion: 1,
          defaultProfileId: "cp_work",
          profiles: [
            { id: "cp_work", name: "Work Home", claudeHome, authState: "not_seen" },
          ],
        },
      }, null, 2) + "\n");

      const child = Bun.spawn(
        [process.execPath, cliPath, "claude", "reload-models", "cp_work", "--global-discovery-auth"],
        { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(refreshRequests).toEqual([{
        path: "/api/claude-profiles/cp_work/refresh",
        origin: `http://127.0.0.1:${server.port}`,
        body: { globalDiscoveryAuth: true },
      }]);
      expect(stdout).toContain("server snapshot refreshed");
      expect(stdout).toContain("Gateway cache: written (2 models)");
      expect(stdout).toContain("Catalog cache: synced");
      expect(existsSync(join(claudeHome, "cache", "gateway-models.json"))).toBe(false);

      const topLevelChild = Bun.spawn(
        [process.execPath, cliPath, "refresh"],
        { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
      );
      const [topLevelStdout, topLevelStderr, topLevelExitCode] = await Promise.all([
        new Response(topLevelChild.stdout).text(),
        new Response(topLevelChild.stderr).text(),
        topLevelChild.exited,
      ]);

      expect(topLevelExitCode).toBe(0);
      expect(topLevelStderr).toBe("");
      expect(topLevelStdout).toContain("server snapshot refreshed");
      expect(refreshRequests).toEqual([
        {
          path: "/api/claude-profiles/cp_work/refresh",
          origin: `http://127.0.0.1:${server.port}`,
          body: { globalDiscoveryAuth: true },
        },
        {
          path: "/api/claude-profiles/cp_work/refresh",
          origin: `http://127.0.0.1:${server.port}`,
          body: {},
        },
      ]);
      expect(existsSync(join(claudeHome, "cache", "gateway-models.json"))).toBe(false);

      writesBlocked = true;
      const blockedChild = Bun.spawn(
        [process.execPath, cliPath, "claude", "reload-models", "cp_work"],
        { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
      );
      const [blockedStdout, blockedStderr, blockedExitCode] = await Promise.all([
        new Response(blockedChild.stdout).text(),
        new Response(blockedChild.stderr).text(),
        blockedChild.exited,
      ]);

      expect(blockedExitCode).toBe(0);
      expect(blockedStderr).toBe("");
      expect(blockedStdout).toContain("Model reload skipped for Work Home (cp_work).");
      expect(blockedStdout).not.toContain("Model reload prepared");
    } finally {
      server.stop(true);
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(claudeHome, { recursive: true, force: true });
    }
  }, 15000);
  test("claude reload-models includes bundled models for a catalog-managed provider", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-managed-reload-cli-"));
    const claudeHome = mkdtempSync(join(tmpdir(), "frogp-managed-reload-claude-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FROGPROGSY_HOME: frogHome,
      CLAUDE_HOME: claudeHome,
      CLAUDE_CONFIG_DIR: claudeHome,
    };
    delete env.FROGPROGSY_NO_CLAUDE_WRITES;

    try {
      writeFileSync(join(frogHome, "config.json"), JSON.stringify({
        port: 9,
        defaultProvider: "codex",
        modelCatalogConfigVersion: 1,
        providers: {
          codex: {
            adapter: "openai-chat",
            baseUrl: "https://models.test/v1",
            catalogProviderId: "codex",
            apiKey: "sk-test",
            liveModels: true,
          },
        },
        claudeProfiles: {
          schemaVersion: 1,
          defaultProfileId: "cp_default",
          profiles: [
            { id: "cp_default", name: "Default", claudeHome, authState: "not_seen" },
          ],
        },
      }, null, 2) + "\n");

      const result = spawnSync(process.execPath, [cliPath, "claude", "reload-models", "cp_default"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      const gatewayCache = JSON.parse(
        readFileSync(join(claudeHome, "cache", "gateway-models.json"), "utf8"),
      ) as { models: Array<{ display_name: string }> };
      expect(gatewayCache.models.map(model => model.display_name)).toContain("codex/gpt-5.5");
      expect(gatewayCache.models.length).toBeGreaterThan(1);
    } finally {
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(claudeHome, { recursive: true, force: true });
    }
  }, 15000);


  test("claude project CLI enrolls local settings and reports account/home boundary", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-project-cli-home-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "frogp-project-cli-"));
    const env = { ...process.env, FROGPROGSY_HOME: frogHome };
    try {
      writeFileSync(join(frogHome, "config.json"), JSON.stringify({
        port: 10100,
        defaultProvider: "test",
        providers: {
          test: { adapter: "openai-chat", baseUrl: "https://models.test/v1", apiKey: "sk-test", defaultModel: "alpha", models: ["alpha"], liveModels: false },
        },
        claudeProfiles: {
          schemaVersion: 1,
          defaultProfileId: "cp_default",
          profiles: [{ id: "cp_default", name: "Default", claudeHome: join(frogHome, ".claude"), authState: "not_seen" }],
        },
      }, null, 2) + "\n");

      const enrolled = spawnSync(process.execPath, [cliPath, "claude", "project", "enroll", projectRoot], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(enrolled.status).toBe(0);
      expect(enrolled.stdout).toContain("Claude project enrolled");
      expect(enrolled.stdout).toContain("project local settings");
      expect(enrolled.stdout).toContain("Claude account/home selection remains Claude Code controlled");

      const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf8"));
      expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://localhost:10100");
      expect(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
      expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

      const status = spawnSync(process.execPath, [cliPath, "claude", "project", "status", projectRoot], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(status.status).toBe(0);
      expect(status.stdout).toContain("carrier: token-free");
      expect(status.stdout).toContain("token scope: not set");
      expect(status.stdout).toContain("does not choose the Claude account or Claude Code home");
    } finally {
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 15000);


  test("top-level help advertises current Claude Code and login surfaces", () => {
    const result = spawnSync(process.execPath, [cliPath, "help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("frogprogsy (frogp)");
    expect(result.stdout).toContain("frogp login [--list|<provider>]");
    expect(result.stdout).toContain("codex, openai, xai, kimi");
    expect(result.stdout).toContain("frogp login codex");
    expect(result.stdout).not.toContain("frogp service <sub>");
    expect(result.stdout).not.toContain("frogp claude-shim <sub>");
    expect(result.stdout).toContain("frogp gui");
    expect(result.stdout).toContain("Start on default port (3764)");
    expect(result.stdout).toContain("frogp uninstall");
    expect(result.stdout).not.toContain("OAuth login (xai) —");
    // refresh present; removed commands absent
    expect(result.stdout).toContain("frogp refresh");
    expect(result.stdout).toContain("frogp claude reload-models");
    expect(result.stdout).not.toContain("frogp ensure");
    expect(result.stdout).not.toContain("frogp sync-cache");
    expect(result.stdout).not.toContain("frogp recover-history");
    expect(result.stdout).toContain("--no-restart");
    // round-2 surfaces present
    expect(result.stdout).toContain("frogp status [--json]");
    expect(result.stdout).toContain("frogp models [--json]");
    expect(result.stdout).toContain("frogp claude project enroll");
    // Branch-B isolated Claude subscription grant surfaces
    expect(result.stdout).toContain("frogp providers set <name> --auth claude-grant --grant <id>");
    expect(result.stdout).toContain("frogp claude grants add");
  });

  test("claude help documents grants lifecycle, probe-b consent, and real-executable requirement", () => {
    const result = spawnSync(process.execPath, [cliPath, "help", "claude"], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("frogp claude grants add <label>");
    expect(result.stdout).toContain("frogp claude grants remove <id> [--force]");
    expect(result.stdout).toContain("frogp claude auth probe-b --grant <id> [--live --yes] [--json]");
    expect(result.stdout).toContain("real claude executable");
    expect(result.stdout).toContain("never touch your native ~/.claude home or the global Keychain");
  });

  test("providers help topic documents the claude-grant binding and OAuth safety", () => {
    const result = spawnSync(process.execPath, [cliPath, "help", "providers"], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: frogp providers set <name> --auth claude-grant --grant <id>");
    expect(result.stdout).toContain("Unknown provider or grant is a hard error");
    expect(result.stdout).toContain("never touches OAuth or API-key logins");
  });

  for (const { name, args } of [
    { name: "rejects an unknown local-key add option", args: ["work", "--limti", "60/60"] },
    { name: "rejects duplicate local-key add limits", args: ["work", "--limit", "60/60", "--limit", "30/30"] },
    { name: "rejects a missing local-key add limit value", args: ["work", "--limit"] },
    { name: "rejects positional local-key add arguments after the limit", args: ["work", "--limit", "60/60", "extra"] },
    { name: "rejects a zero local-key add request count", args: ["work", "--limit", "0/60"] },
    { name: "rejects a zero local-key add window", args: ["work", "--limit", "60/0"] },
    { name: "rejects an unsafe local-key add request count", args: ["work", "--limit", "9007199254740992/60"] },
    { name: "rejects an unsafe local-key add window", args: ["work", "--limit", "60/9007199254740992"] },
  ]) {
    test(name, () => {
      const frogHome = mkdtempSync(join(tmpdir(), "frogp-local-key-invalid-"));
      const configPath = join(frogHome, "config.json");
      const before = JSON.stringify({
        localAccess: {
          enabled: true,
          keys: [{
            id: "lk_existing",
            label: "existing",
            secretHash: `sha256:${"a".repeat(64)}`,
          }],
        },
      }, null, 2) + "\n";
      writeFileSync(configPath, before, "utf8");

      try {
        const result = spawnSync(process.execPath, [cliPath, "local-key", "add", ...args], {
          cwd: repoRoot,
          env: { ...process.env, FROGPROGSY_HOME: frogHome, NODE_ENV: "test" },
          encoding: "utf8",
        });

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).not.toMatch(/frogp_[A-Za-z0-9_-]{43}/);
        expect(readFileSync(configPath, "utf8")).toBe(before);
      } finally {
        rmSync(frogHome, { recursive: true, force: true });
      }
    }, 15000);
  }

  test("local-key add accepts a multi-word label with one positive safe-integer limit", () => {
    const frogHome = mkdtempSync(join(tmpdir(), "frogp-local-key-valid-"));
    try {
      const result = spawnSync(
        process.execPath,
        [cliPath, "local-key", "add", "work", "laptop", "--limit", "60/120"],
        {
          cwd: repoRoot,
          env: { ...process.env, FROGPROGSY_HOME: frogHome, NODE_ENV: "test" },
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/frogp_[A-Za-z0-9_-]{43}/);
      const config = JSON.parse(readFileSync(join(frogHome, "config.json"), "utf8"));
      expect(config.localAccess.enabled).toBe(true);
      expect(config.localAccess.keys).toHaveLength(1);
      expect(config.localAccess.keys[0]).toMatchObject({
        label: "work laptop",
        requestLimit: { maxRequests: 60, windowSec: 120 },
      });
      expect(config.localAccess.keys[0].secretHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    } finally {
      rmSync(frogHome, { recursive: true, force: true });
    }
  }, 15000);
});
