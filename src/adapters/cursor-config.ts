import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { prepareNativeConfig } from "./native-config.js";

function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Cursor configuration");
  return value as Record<string, unknown>;
}

function strings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("Invalid Cursor permissions");
  }
  return value as string[];
}

export function prepareCursorConfig(stateDir: string, cwd: string, env: NodeJS.ProcessEnv) {
  return prepareNativeConfig(stateDir, "cursor", async (directory) => {
    const sourceDirectory = env.CURSOR_CONFIG_DIR?.trim()
      || (env.XDG_CONFIG_HOME?.trim() ? join(env.XDG_CONFIG_HOME, "cursor") : join(homedir(), ".cursor"));
    let source: Record<string, unknown> = {};
    try {
      source = object(JSON.parse(await readFile(join(resolve(cwd, sourceDirectory), "cli-config.json"), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const permissions = object(source.permissions);
    const sandbox = object(source.sandbox);
    const snapshot = {
      ...source,
      version: source.version ?? 1,
      editor: { vimMode: false, ...object(source.editor) },
      approvalMode: "allowlist",
      permissions: {
        ...permissions,
        allow: strings(permissions.allow),
        deny: [...new Set([...strings(permissions.deny), "WebFetch(*)"])],
      },
      sandbox: { ...sandbox, mode: "enabled", networkAccess: "user_config_only" },
    };
    await writeFile(join(directory, "cli-config.json"), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    return { env: { ...env, CURSOR_CONFIG_DIR: directory } };
  });
}
