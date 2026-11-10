import type { FileTreeNode } from '@/shared/types';

// A reference written inside a chat message carries neither a canonical
// separator nor a canonical shape, so trailing slashes, `./` prefixes and
// Windows separators are levelled before anything is compared.
const normalizePath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

const isAbsolutePath = (value: string): boolean => /^(\/|[A-Za-z]:\/)/.test(value);

/**
 * The paths to expand, root first, so `reference` becomes visible in the file
 * tree; empty when the reference is not inside the loaded tree.
 *
 * Each level is looked up by name in the tree that is already loaded, rather
 * than composed as a string: an in-chat reference is usually relative
 * (`decisions/`, as the model wrote it) while every node is keyed by the
 * absolute path the server built with its own platform separator. Expansion
 * stops at the last level actually present, so a folder hidden by `.gitignore`
 * still opens as far as the tree goes. `complete` is false while it stopped at
 * a folder whose entries are not loaded yet: expanding it loads them, and the
 * walk can then go further.
 */
export function directoryRevealPaths(
  files: FileTreeNode[],
  projectPath: string,
  reference: string,
): { paths: string[]; complete: boolean } {
  const root = normalizePath(projectPath);
  const target = normalizePath(reference);

  let relative = target;
  if (isAbsolutePath(target)) {
    if (!target.startsWith(`${root}/`)) {
      // Either the project root itself (nothing to expand) or a path outside
      // it — `/workspace/apple` must not be read as a child of `/workspace/app`.
      return { paths: [], complete: true };
    }
    relative = target.slice(root.length + 1);
  }

  const paths: string[] = [];
  let level: FileTreeNode[] | undefined = files;
  for (const segment of relative.split('/').filter(Boolean)) {
    if (!level) {
      return { paths, complete: false };
    }
    const directory: FileTreeNode | undefined = level.find((node) => node.type === 'directory' && node.name === segment);
    if (!directory) {
      break;
    }
    paths.push(directory.path);
    level = directory.children;
  }

  return { paths, complete: true };
}
