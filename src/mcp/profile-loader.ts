import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { createProfileAuthority, type ProfileAuthority } from "./authority.js";

const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, "path must be absolute");
const IdentifierSchema = z.string().trim().min(1).max(256);
const SafeAliasSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9 -]*$/i, "alias must use a bounded coarse vocabulary");

const ProfileConfigSchema = z.object({
  databasePath: AbsolutePathSchema,
  personId: IdentifierSchema,
  allowedScopeIds: z.array(IdentifierSchema).min(1),
  ingestScopeId: IdentifierSchema,
  sourceRoots: z.record(z.string().trim().min(1).max(64), AbsolutePathSchema),
  scopeAliases: z.record(IdentifierSchema, SafeAliasSchema)
}).strict().superRefine((profile, context) => {
  if (!profile.allowedScopeIds.includes(profile.ingestScopeId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ingestScopeId"],
      message: "ingestScopeId must be included in allowedScopeIds"
    });
  }
});

export const MemoryMcpProfileConfigSchema = z.object({
  version: z.literal(1),
  profiles: z.record(z.string().trim().min(1).max(128), ProfileConfigSchema)
}).strict();

export type MemoryMcpProfileConfig = z.infer<typeof MemoryMcpProfileConfigSchema>;

export interface LoadMemoryMcpProfileOptions {
  readonly configPath?: string;
  readonly profileName?: string;
}

export const loadMemoryMcpProfile = async (
  options: LoadMemoryMcpProfileOptions
): Promise<ProfileAuthority> => {
  if (!options.configPath || !isAbsolute(options.configPath)) {
    throw new Error("An explicit absolute config path is required");
  }
  if (!options.profileName?.trim()) {
    throw new Error("An explicit profile name is required");
  }

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(await readFile(resolve(options.configPath), "utf8"));
  } catch {
    throw new Error("Memory MCP configuration could not be loaded");
  }

  const parsedConfig = MemoryMcpProfileConfigSchema.safeParse(rawConfig);
  if (!parsedConfig.success) {
    throw new Error("Invalid memory MCP configuration");
  }
  const profile = parsedConfig.data.profiles[options.profileName];
  if (!profile) throw new Error("Unknown memory MCP profile");

  return createProfileAuthority({
    profileName: options.profileName,
    databasePath: resolve(profile.databasePath),
    personId: profile.personId,
    allowedScopeIds: profile.allowedScopeIds,
    ingestScopeId: profile.ingestScopeId,
    sourceRoots: Object.fromEntries(
      Object.entries(profile.sourceRoots).map(([name, path]) => [name, resolve(path)])
    ),
    scopeAliases: profile.scopeAliases
  });
};
