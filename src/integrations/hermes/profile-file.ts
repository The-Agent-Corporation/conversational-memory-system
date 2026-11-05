import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function writeHermesMcpProfile(options: {
  directory: string;
  databasePath: string;
  profileName?: string;
  personId: string;
  scopeId: string;
}): Promise<{ configPath: string; profileName: string; databasePath: string }> {
  const profileName = options.profileName ?? "hermes";
  const databasePath = resolve(options.databasePath);
  const sourceRoot = resolve(options.directory, "sources");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(dirname(databasePath), { recursive: true });
  const configPath = resolve(options.directory, "profiles.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    profiles: {
      [profileName]: {
        databasePath,
        personId: options.personId,
        allowedScopeIds: [options.scopeId],
        ingestScopeId: options.scopeId,
        scopeAliases: { [options.scopeId]: "workspace" },
        sourceRoots: { synthetic: sourceRoot }
      }
    }
  }, null, 2));
  return { configPath, profileName, databasePath };
}
