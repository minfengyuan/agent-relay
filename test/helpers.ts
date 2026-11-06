import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, vi } from "vitest";
import type { RelayConfig } from "../src/config.js";
import { cleanupAllChildren } from "../src/runner.js";
import type { SessionStore } from "../src/store.js";
import { RelayFailure, type DelegateInput, type GrokRelayResult } from "../src/types.js";
import { AcpRunner } from "../src/runner/acp-runner.js";
import { authMethodIds, cancelledPermission } from "../src/runner/helpers.js";
import { EmptySummarizer } from "../src/runner/summaries.js";
import type { ProviderAdapter } from "../src/runner/types.js";

function testAcpAdapter(config: RelayConfig): ProviderAdapter<DelegateInput, GrokRelayResult> {
  return {
    provider: "grok",
    displayName: "Grok",
    command: () => ({ command: config.command, args: config.commandArgs }),
    authenticate(initialized) {
      const authIds = authMethodIds(initialized);
      const preferred = process.env.XAI_API_KEY && authIds.includes("xai.api_key")
        ? "xai.api_key"
        : authIds.includes("cached_token") ? "cached_token" : undefined;
      if (!preferred) {
        throw new RelayFailure("AUTH_UNAVAILABLE", "No non-interactive Grok authentication is available (xai.api_key or cached_token)");
      }
      return preferred;
    },
    authenticateParams(methodId) {
      return { methodId, _meta: { headless: true } };
    },
    capabilities: {},
    permissionWarning: () => "Grok workspace sandboxing allows its state directory and child network access; built-in web search/fetch are disabled. This is not complete network isolation.",
    prompt: (task) => task,
    sessionMetadata: () => ({}),
    createSummarizer: () => new EmptySummarizer(),
    handlePermission(_params, rt) {
      rt.markRequested();
      queueMicrotask(() => rt.abort(new RelayFailure(
        "UNEXPECTED_PERMISSION",
        "Grok requested permission despite --always-approve",
        rt.partial(),
      )));
      return cancelledPermission();
    },
  };
}

export class TestAcpRunner extends AcpRunner<DelegateInput, GrokRelayResult> {
  constructor(config: RelayConfig, store: SessionStore) {
    super(config, store, testAcpAdapter(config));
  }
}

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const grokFixture = join(fixtures, "fake-agent.mjs");
export const cursorFixture = grokFixture;
export const opencodeFixture = join(fixtures, "fake-opencode-agent.mjs");
export const dshFixture = join(fixtures, "fake-dsh-headless.mjs");
export const codexFixture = join(fixtures, "fake-codex-server.mjs");
export const claudeFixture = join(fixtures, "fake-claude-agent.mjs");
export const backpressureFixture = join(fixtures, "backpressure-agent.mjs");

export async function tempDir(dirs: string[], prefix = "relay-"): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(path);
  return path;
}

export async function cleanupDirs(dirs: string[]): Promise<void> {
  await Promise.all(dirs.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  })));
}

export function baseConfig(stateDir: string, overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    command: process.execPath,
    commandArgs: [grokFixture],
    cursorCommand: process.execPath,
    cursorCommandArgs: [cursorFixture],
    opencodeCommand: process.execPath,
    opencodeCommandArgs: [opencodeFixture],
    dshCommand: process.execPath,
    dshCommandArgs: [dshFixture],
    codexCommand: process.execPath,
    codexCommandArgs: [codexFixture],
    claudeCommand: process.execPath,
    claudeCommandArgs: [claudeFixture],
    stateDir,
    phaseTimeoutMs: 2_000,
    totalTimeoutMs: 15_000,
    cancelGraceMs: 100,
    termGraceMs: 100,
    killConfirmMs: 5_000,
    textLimitBytes: 256 * 1024,
    stderrLimitBytes: 64 * 1024,
    progressIntervalMs: 1,
    ...overrides,
  };
}

export async function waitForLog(path: string, needle: string, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, "utf8")).includes(needle)) return;
    } catch { /* wait */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(needle)} in ${path}`);
}

export function clearDelegatedEnv(): void {
  if (process.env.AGENT_RELAY_DELEGATED === "1") {
    vi.stubEnv("AGENT_RELAY_DELEGATED", "");
  }
}

export function useRunnerCleanup(dirs: string[]): void {
  beforeEach(async () => {
    clearDelegatedEnv();
    vi.stubEnv("CURSOR_CONFIG_DIR", await tempDir(dirs, "cursor-source-"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    try {
      await cleanupAllChildren();
    } finally {
      await cleanupDirs(dirs);
    }
  });
}
