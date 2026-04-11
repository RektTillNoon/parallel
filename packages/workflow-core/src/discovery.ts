import { promises as fs } from 'node:fs';
import path from 'node:path';

import fg from 'fast-glob';

import { pathExists } from './utils';

const DISCOVERY_IGNORES = [
  '**/node_modules/**',
  '**/.pnpm/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/.next/**',
  '**/coverage/**',
];

export async function discoverGitRepos(roots: string[]) {
  const discovered = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) {
      continue;
    }

    const rootGitDir = path.join(root, '.git');
    if (await pathExists(rootGitDir)) {
      discovered.add(path.resolve(root));
    }

    const matches = await fg('**/.git', {
      cwd: root,
      dot: true,
      unique: true,
      onlyFiles: false,
      onlyDirectories: false,
      ignore: DISCOVERY_IGNORES,
    });

    for (const match of matches) {
      const repoRoot = path.resolve(root, path.dirname(match));
      discovered.add(repoRoot);
    }
  }

  return Array.from(discovered).sort((left, right) => left.localeCompare(right));
}

export async function loadDirectoryChildren(root: string) {
  try {
    return await fs.readdir(root);
  } catch {
    return [];
  }
}
