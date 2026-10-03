// First profile is the default. Ambiguous names must never pick an arbitrary token.
export function resolveProfile(profiles: { name: string; token: string; parentId: string }[], workspace: string | null) {
  if (workspace === null) {
    if (!profiles.length) throw new Error('Add a workspace profile in Notion Sync settings.');
    return profiles[0];
  }
  const matches = profiles.filter((profile) => profile.name.trim().toLowerCase() === workspace.trim().toLowerCase());
  if (!matches.length) throw new Error(`Notion workspace "${workspace}" has no matching profile. Add it in Notion Sync settings.`);
  if (matches.length > 1) throw new Error(`Multiple profiles named "${workspace}". Rename them in Notion Sync settings.`);
  return matches[0];
}
