import type { SourceEntry, SourceScope, SourceType } from '@aaif/goose-acp-client';
import { getAcpClient } from './acpConnection';

const SKILL_SOURCE_TYPES: SourceType[] = ['skill', 'builtinSkill'];
const inFlightSkillSourceLoads = new Map<string, Promise<SourceEntry[]>>();

export async function listSkillSources(projectDir: string): Promise<SourceEntry[]> {
  const inFlightLoad = inFlightSkillSourceLoads.get(projectDir);
  if (inFlightLoad) {
    return inFlightLoad;
  }

  const load = loadSkillSources(projectDir);
  inFlightSkillSourceLoads.set(projectDir, load);

  try {
    return await load;
  } finally {
    if (inFlightSkillSourceLoads.get(projectDir) === load) {
      inFlightSkillSourceLoads.delete(projectDir);
    }
  }
}

async function loadSkillSources(projectDir: string): Promise<SourceEntry[]> {
  const client = await getAcpClient();
  const responses = await Promise.all(
    SKILL_SOURCE_TYPES.map((type) =>
      client.goose.sourcesList_unstable({
        type,
        projectDir,
      })
    )
  );

  return responses
    .flatMap((response) => response.sources)
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
        a.path.localeCompare(b.path)
    );
}

/**
 * Skill authoring and distribution, used by the skills page.
 *
 * `SourceEntry.content` already carries the whole SKILL.md body, so the detail panel needs
 * no extra read call. Writes go through the same ACP surface the kernel uses for its own
 * skill CRUD; `target` decides whether the skill lands in the user's global skills
 * directory or inside the current project.
 */
export interface SkillDraft {
  name: string;
  description: string;
  content: string;
}

export async function createSkillSource(
  draft: SkillDraft,
  target: SourceScope
): Promise<SourceEntry> {
  const client = await getAcpClient();
  const response = await client.goose.sourcesCreate_unstable({
    type: 'skill',
    name: draft.name,
    description: draft.description,
    content: draft.content,
    target,
  });
  inFlightSkillSourceLoads.clear();
  return response.source;
}

export async function updateSkillSource(path: string, draft: SkillDraft): Promise<SourceEntry> {
  const client = await getAcpClient();
  const response = await client.goose.sourcesUpdate_unstable({
    type: 'skill',
    path,
    name: draft.name,
    description: draft.description,
    content: draft.content,
  });
  inFlightSkillSourceLoads.clear();
  return response.source;
}

export async function deleteSkillSource(path: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.sourcesDelete_unstable({ type: 'skill', path });
  inFlightSkillSourceLoads.clear();
}

/** Portable JSON payload for one skill, produced by the kernel. */
export async function exportSkillSource(path: string): Promise<{ json: string; filename: string }> {
  const client = await getAcpClient();
  const response = await client.goose.sourcesExport_unstable({ type: 'skill', path });
  return { json: response.json, filename: response.filename };
}

/** Imports a payload produced by {@link exportSkillSource}. */
export async function importSkillSources(json: string, target: SourceScope): Promise<SourceEntry[]> {
  const client = await getAcpClient();
  const response = await client.goose.sourcesImport_unstable({ data: json, target });
  inFlightSkillSourceLoads.clear();
  return response.sources;
}
