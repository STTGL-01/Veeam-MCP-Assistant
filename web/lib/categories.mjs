// Groups of Veeam actions that an approver can be made responsible for.
//
// Derived from the VBR 13.1/13.2 action policy in the Veeam MCP server
// (src/actions/policies/vbr_13.1.ts). Each action Veeam Intelligence proposes
// carries the REST path it will call; the first group whose pattern matches
// that path owns the approval. Anything unmatched falls into "other", so a new
// kind of action is never left without an owner.

export const CATEGORIES = [
  {
    id: 'jobs',
    label: 'Backup jobs',
    description: 'Start, stop, retry, enable or disable jobs.',
    match: /\/jobs(\/|$)/i,
  },
  {
    id: 'restore',
    label: 'Restores and recovery',
    description: 'Instant Recovery, VM, file share, object storage and AD forest restores, plus migrate and unmount.',
    match: /\/restore(\/|$)/i,
  },
  {
    id: 'infrastructure',
    label: 'Backup infrastructure',
    description: 'Proxies, scale-out repository modes, managed server components, agent upgrades and product updates.',
    match: /\/(backupInfrastructure|agents|vbrinfo|mountservers?)(\/|$)/i,
  },
  {
    id: 'license',
    label: 'Licensing',
    description: 'Install, update or revoke licenses and change license consumption settings.',
    match: /\/license(\/|$)/i,
  },
  {
    id: 'security',
    label: 'Malware and encryption scans',
    description: 'Scan backups for malware and analyse encryption activity.',
    match: /\/malwareDetection(\/|$)/i,
  },
  {
    id: 'destructive',
    label: 'Deletions and removals',
    description: 'Anything that permanently removes jobs, backups, restore points or configuration. Cannot be undone from here.',
    match: null,
  },
  {
    id: 'other',
    label: 'Everything else',
    description: 'Any action that does not fit a group above, such as exporting logs for analysis.',
    match: null,
  },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

export function categorize(pathValue) {
  const p = String(pathValue || '');
  for (const c of CATEGORIES) {
    if (c.match && c.match.test(p)) return c.id;
  }
  return 'other';
}

export function publicCategories() {
  return CATEGORIES.map(({ id, label, description }) => ({ id, label, description }));
}

export function labelFor(id) {
  return (CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1]).label;
}
