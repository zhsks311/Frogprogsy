import { existsSync, readFileSync } from "node:fs";
import { getConfigPath, loadConfig, saveConfig } from "./config";
import {
  buildEffectiveConfig,
  migratePersistedCatalogConfig,
  writeCatalogConfigBackupOnce,
} from "./model-catalog-config";
import { refreshModelCatalog, type SelectedModelCatalog } from "./model-catalog-runtime";
import type { ModelCatalogDocumentV1 } from "./model-catalog-schema";
import type { FrogConfig } from "./types";

export interface RuntimeConfigState {
  persisted: FrogConfig;
  effective: FrogConfig;
  readonly catalog: SelectedModelCatalog;
  rebuild(): void;
  persist(): void;
}

export interface RuntimeConfigStateDeps {
  loadConfig?: () => FrogConfig;
  saveConfig?: (config: FrogConfig) => void;
  refreshCatalog?: () => Promise<SelectedModelCatalog>;
  getConfigPath?: () => string;
  configExists?: (path: string) => boolean;
  readConfig?: (path: string) => string;
  bundledCatalog?: ModelCatalogDocumentV1;
  writeBackup?: (configPath: string, originalBytes: string) => void;
  warn?: (message: string) => void;
}

class DefaultRuntimeConfigState implements RuntimeConfigState {
  effective: FrogConfig;

  constructor(
    public persisted: FrogConfig,
    public readonly catalog: SelectedModelCatalog,
    private readonly save: (config: FrogConfig) => void,
  ) {
    this.effective = buildEffectiveConfig(persisted, catalog);
  }

  rebuild(): void {
    this.effective = buildEffectiveConfig(this.persisted, this.catalog);
  }

  persist(): void {
    this.save(this.persisted);
    this.rebuild();
  }
}

function readBundledCatalog(): ModelCatalogDocumentV1 {
  return JSON.parse(readFileSync(
    new URL("./generated/model-catalog-v1.json", import.meta.url),
    "utf8",
  )) as ModelCatalogDocumentV1;
}

export async function createRuntimeConfigState(
  deps: RuntimeConfigStateDeps = {},
): Promise<RuntimeConfigState> {
  const loadPersisted = deps.loadConfig ?? loadConfig;
  const savePersisted = deps.saveConfig ?? saveConfig;
  const configExists = deps.configExists ?? existsSync;
  const readConfig = deps.readConfig ?? ((path: string) => readFileSync(path, "utf8"));
  const warn = deps.warn ?? console.warn;

  let persisted = loadPersisted();
  const configPath = (deps.getConfigPath ?? getConfigPath)();
  if (!configExists(configPath)) {
    persisted.modelCatalogConfigVersion = 1;
  } else if (persisted.modelCatalogConfigVersion !== 1) {
    try {
      const originalBytes = readConfig(configPath);
      JSON.parse(originalBytes);
      const bundled = deps.bundledCatalog ?? readBundledCatalog();
      const migration = migratePersistedCatalogConfig(persisted, bundled, {
        writeBackup: () => (deps.writeBackup ?? writeCatalogConfigBackupOnce)(configPath, originalBytes),
      });
      for (const warning of migration.warnings) warn(`[frogp] ${warning}`);
      if (migration.changed) {
        savePersisted(migration.config);
        persisted = migration.config;
      }
    } catch (error) {
      warn(`[frogp] model catalog config migration was skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const catalog = await (deps.refreshCatalog ?? refreshModelCatalog)();
  return new DefaultRuntimeConfigState(persisted, catalog, savePersisted);
}
