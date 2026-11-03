import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareCursorConfig } from "../src/adapters/cursor-config.js";
import { tempDir, useRunnerCleanup } from "./helpers.js";

const dirs: string[] = [];
useRunnerCleanup(dirs);

describe("native Cursor configuration", () => {
  it.each(["cursor", "xdg"])("resolves %s source configuration and preserves credential/data discovery", async (location) => {
    const cwd = await tempDir(dirs);
    const state = await tempDir(dirs);
    const sourceRoot = join(cwd, "source with spaces");
    const source = location === "cursor" ? sourceRoot : join(sourceRoot, "cursor");
    await mkdir(source, { recursive: true });
    const original = JSON.stringify({
      version: 1, permissions: { deny: ["Write(**/.env)"] }, sandbox: { readBoundary: "workspace" },
    });
    await writeFile(join(source, "cli-config.json"), original);
    const env = {
      ...(location === "cursor" ? { CURSOR_CONFIG_DIR: "source with spaces", XDG_CONFIG_HOME: "unused" }
        : { CURSOR_CONFIG_DIR: " ", XDG_CONFIG_HOME: "source with spaces" }),
      CURSOR_API_KEY: "fixture-auth",
      CURSOR_DATA_DIR: join(cwd, "original data"),
    };
    const prepared = await prepareCursorConfig(state, cwd, env);
    try {
      expect(prepared.env.CURSOR_API_KEY).toBe(env.CURSOR_API_KEY);
      expect(prepared.env.CURSOR_DATA_DIR).toBe(env.CURSOR_DATA_DIR);
      expect(prepared.env.XDG_CONFIG_HOME).toBe(env.XDG_CONFIG_HOME);
      const path = join(prepared.env.CURSOR_CONFIG_DIR!, "cli-config.json");
      const snapshot = JSON.parse(await readFile(path, "utf8"));
      expect(snapshot.permissions.deny).toEqual(["Write(**/.env)", "WebFetch(*)"]);
      expect(snapshot.sandbox).toEqual({ readBoundary: "workspace", mode: "enabled", networkAccess: "user_config_only" });
      if (process.platform !== "win32") {
        expect((await stat(prepared.env.CURSOR_CONFIG_DIR!)).mode & 0o777).toBe(0o700);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
      expect(await readFile(join(source, "cli-config.json"), "utf8")).toBe(original);
    } finally {
      await prepared.dispose();
    }
    await expect(stat(prepared.env.CURSOR_CONFIG_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
