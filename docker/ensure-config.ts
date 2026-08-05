import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashLocalAccessSecret } from "../src/local-access";

const home = process.env.FROGPROGSY_HOME || "/config";
const configPath = join(home, "config.json");
const bindHostname = process.env.FROGP_DOCKER_BIND_HOSTNAME || "0.0.0.0";
const port = Number(process.env.FROGP_DOCKER_PORT || "3764");

function defaultConfig() {
  return {
    port: Number.isFinite(port) && port > 0 ? port : 3764,
    hostname: bindHostname,
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "forward",
        defaultModel: "claude-sonnet-4-6",
      },
    },
    defaultProvider: "anthropic",
    websockets: false,
  };
}

function atomicWrite(path: string, content: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

function hasKeyId(key: unknown, id: string): boolean {
  return key !== null && typeof key === "object" && !Array.isArray(key) && "id" in key && key.id === id;
}

mkdirSync(home, { recursive: true, mode: 0o700 });

let config: Record<string, unknown> = defaultConfig();
if (existsSync(configPath)) {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = { ...defaultConfig(), ...parsed };
    }
  } catch {
    config = defaultConfig();
  }
}

// Docker port publishing needs the proxy to bind beyond container loopback.
// Make the bind host explicit and overridable via FROGP_DOCKER_BIND_HOSTNAME.
config.hostname = bindHostname;
if (typeof config.port !== "number" || !Number.isFinite(config.port)) {
  config.port = 3764;
}

// A published container port is reachable from outside the container, so a first non-loopback start
// requires a caller-supplied key. Generating it here would put the plaintext in container stdout,
// where Docker or a central log collector can retain it. An existing enabled key remains usable on
// later starts without repeating the plaintext environment value.
const existingLocalAccess = config.localAccess as { enabled?: boolean; keys?: unknown[] } | undefined;
const hasKey = existingLocalAccess?.enabled === true
  && Array.isArray(existingLocalAccess.keys)
  && existingLocalAccess.keys.length > 0;
const pinnedKey = process.env.FROGP_LOCAL_ACCESS_KEY?.trim();
const nonLoopbackBind = bindHostname !== "127.0.0.1" && bindHostname !== "localhost" && bindHostname !== "::1";
if (nonLoopbackBind && !hasKey && !pinnedKey) {
  throw new Error(
    "FROGP_LOCAL_ACCESS_KEY is required for the first non-loopback Docker start; " +
    "provide it through your container secret/environment configuration",
  );
}
if (nonLoopbackBind && pinnedKey) {
  const existingKeys = Array.isArray(existingLocalAccess?.keys) ? existingLocalAccess.keys : [];
  const keys = existingKeys.filter(key => !hasKeyId(key, "lk_docker"));
  keys.push({ id: "lk_docker", label: "docker", secretHash: hashLocalAccessSecret(pinnedKey) });
  config.localAccess = { enabled: true, keys };
}

atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
