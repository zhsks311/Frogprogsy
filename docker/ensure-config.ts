import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { generateLocalAccessSecret, hashLocalAccessSecret } from "../src/local-access";

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

// A published container port is reachable from outside the container, so the relay refuses to bind a
// non-loopback hostname without request authentication. Mint one key on first run and print the
// plaintext once: it exists nowhere else, and callers send it as ANTHROPIC_AUTH_TOKEN / x-api-key.
// FROGP_LOCAL_ACCESS_KEY pins a caller-chosen key instead (compose secret, redeploy with a known key).
const existingLocalAccess = config.localAccess as { enabled?: boolean; keys?: unknown[] } | undefined;
const hasKey = Array.isArray(existingLocalAccess?.keys) && existingLocalAccess.keys.length > 0;
const pinnedKey = process.env.FROGP_LOCAL_ACCESS_KEY?.trim();
if (bindHostname !== "127.0.0.1" && bindHostname !== "localhost" && bindHostname !== "::1" && (!hasKey || pinnedKey)) {
  const secret = pinnedKey || generateLocalAccessSecret();
  config.localAccess = {
    enabled: true,
    keys: [{ id: `lk_${randomBytes(4).toString("hex")}`, label: "docker", secretHash: hashLocalAccessSecret(secret) }],
  };
  if (!pinnedKey) {
    console.log("frogprogsy: created a relay access key for this container (shown once):");
    console.log(`frogprogsy:   ${secret}`);
    console.log("frogprogsy: send it as ANTHROPIC_AUTH_TOKEN, x-api-key, or x-frogp-local-key. Set FROGP_LOCAL_ACCESS_KEY to pin your own.");
  }
}

atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
