// Order never routes notes. Missing names are safe only with one workspace.
export function resolveProfile(profiles: { name: string; token: string; parentId: string }[], workspace: string | null) {
  if (!profiles.length) throw new Error('Add a workspace profile in Notion Handoff settings.');
  if (workspace === null) {
    if (profiles.length > 1) throw new Error('Choose a workspace for this note before syncing.');
    if (!profiles[0].name.trim()) throw new Error('A workspace name is required in Notion Handoff settings.');
    return profiles[0];
  }
  if (!workspace.trim()) throw new Error('A workspace name is required before syncing.');
  const matches = profiles.filter((profile) => profile.name.trim().toLowerCase() === workspace.trim().toLowerCase());
  if (!matches.length) throw new Error(`Notion workspace "${workspace}" has no matching profile. Add it in Notion Handoff settings.`);
  if (matches.length > 1) throw new Error(`Multiple profiles named "${workspace}". Rename them in Notion Handoff settings.`);
  return matches[0];
}
