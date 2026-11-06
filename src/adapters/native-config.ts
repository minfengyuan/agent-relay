import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RelayFailure } from "../types.js";
import type { PreparedSpawn } from "../runner/types.js";

export async function prepareNativeConfig(
  stateDir: string,
  provider: string,
  prepare: (directory: string) => Promise<Omit<PreparedSpawn, "dispose">>,
): Promise<PreparedSpawn> {
  let directory: string | undefined;
  try {
    await mkdir(resolve(stateDir), { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(resolve(stateDir), `${provider}-config-`));
    const prepared = await prepare(directory);
    const configDirectory = directory;
    return {
      ...prepared,
      dispose: () => rm(configDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    if (directory && !(error instanceof RelayFailure && error.code === "PROCESS_CLEANUP_FAILED")) {
      await rm(directory, { recursive: true, force: true });
    }
    if (error instanceof RelayFailure) throw error;
    throw new RelayFailure("CONFIG_UNSUPPORTED", `Cannot prepare ${provider} native permission configuration`);
  }
}
