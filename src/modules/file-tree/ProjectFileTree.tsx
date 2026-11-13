import { useEffect, useRef, useState } from 'react';
import { Folder, GitBranch, GitFork } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { useWorkbenchFiles } from '@/shared/codeyWorkbench';
import type { DirectoryRevealRequest, Project, WorkbenchFileContext, WorkbenchFileRoot } from '@/shared/types';
import FileTree from '@/modules/file-tree/FileTree';
import FileTreeLoadingState from '@/modules/file-tree/FileTreeLoadingState';

type ProjectFileTreeProps = {
  selectedProject: Project;
  sessionId?: string;
  onFileOpen: (filePath: string, project: Project) => void;
  revealDirectory?: DirectoryRevealRequest | null;
};

function pathKey(path: string): string {
  let normalized = path.trim().replace(/\\/g, '/');
  const unc = normalized.startsWith('//');
  normalized = normalized.replace(/\/{2,}/g, '/');
  if (unc) normalized = `/${normalized}`;
  if (normalized.length > 1 && !/^[a-z]:\/$/i.test(normalized)) normalized = normalized.replace(/\/+$/, '');
  return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function rootForDirectory(context: WorkbenchFileContext, path: string): WorkbenchFileRoot {
  const current = context.roots.find((root) => root.id === context.currentRootId)!;
  const target = pathKey(path);
  if (!/^(?:\/|[a-z]:)/i.test(target)) return current;
  // Chat references belong to the session's machine, never a remote root with the same path.
  return context.roots.filter((candidate) => candidate.nodeId === current.nodeId
    && (target === pathKey(candidate.path) || target.startsWith(`${pathKey(candidate.path).replace(/\/$/, '')}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0] ?? current;
}

/** Resolves only a visited root. A missing/stale checkout is never recreated by browsing it. */
function RootFiles({ root, onFileOpen, revealDirectory }: {
  root: WorkbenchFileRoot;
  onFileOpen: ProjectFileTreeProps['onFileOpen'];
  revealDirectory?: DirectoryRevealRequest | null;
}) {
  const { t } = useTranslation();
  // Node-local ID for a folder that has never hosted a session, plus its load diagnostic.
  const [resolution, setResolution] = useState<{ project?: Project; error?: string } | null>(null);
  // Explicit retries repeat only this root's failed lookup.
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (root.projectId) return;
    const controller = new AbortController();
    void api.resolveFileProject(root.path, { apiBasePath: root.basePath, signal: controller.signal })
      .then((response) => readApiJson<{ project: Project }>(response))
      .then(({ project }) => {
        if (!project?.projectId || !project.fullPath) throw new Error(t('fileTree.rootUnavailable'));
        if (!controller.signal.aborted) setResolution({ project });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setResolution({ error: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => controller.abort();
  }, [root.projectId, root.path, root.basePath, retry, t]);

  if (!root.projectId && !resolution) return <FileTreeLoadingState />;
  if (resolution?.error && !root.projectId) {
    return (
      <div role="alert" className="space-y-2 break-words p-3 text-sm text-muted-foreground">
        <p>{t('fileTree.rootUnavailable')}</p>
        <p>{resolution.error}</p>
        <button type="button" className="text-primary underline" onClick={() => {
          setResolution(null);
          setRetry((value) => value + 1);
        }}>
          {t('buttons.retry')}
        </button>
      </div>
    );
  }
  const project: Project = {
    projectId: root.projectId || resolution!.project!.projectId,
    displayName: root.name,
    path: resolution?.project?.fullPath || root.path,
    fullPath: resolution?.project?.fullPath || root.path,
    fileApiBasePath: root.basePath,
    fileRootLabel: [root.machine, root.name, root.branch].filter(Boolean).join(' · '),
  };
  return <FileTree selectedProject={project} onFileOpen={(path) => onFileOpen(path, project)} revealDirectory={revealDirectory} />;
}

function ProjectRoots({ context, onFileOpen, revealDirectory }: {
  context: WorkbenchFileContext;
  onFileOpen: ProjectFileTreeProps['onFileOpen'];
  revealDirectory?: DirectoryRevealRequest | null;
}) {
  const { t } = useTranslation();
  // Browsing is independent of the conversation; a listing refresh must not reset the user's root.
  const [selectedId, setSelectedId] = useState(context.currentRootId);
  // Keep visited trees mounted so each retains its own expansion, search and pending uploads.
  const [visited, setVisited] = useState(() => new Set([context.currentRootId]));
  // A chat reference is a one-shot navigation, not a reason to reset later manual browsing.
  const servedReveal = useRef<DirectoryRevealRequest | null>(null);
  const active = context.roots.find((root) => root.id === selectedId)
    ?? context.roots.find((root) => root.id === context.currentRootId)!;
  const revealRoot = revealDirectory ? rootForDirectory(context, revealDirectory.path) : null;

  useEffect(() => {
    if (!revealDirectory || servedReveal.current === revealDirectory) return;
    servedReveal.current = revealDirectory;
    const root = rootForDirectory(context, revealDirectory.path);
    setSelectedId(root.id);
    setVisited((previous) => new Set(previous).add(root.id));
  }, [context.currentRootId, context.roots, revealDirectory]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border p-3">
        <div className="mb-2 flex items-center justify-between gap-2 text-sm">
          <h3 className="truncate font-medium" title={context.name}>{context.name || t('fileTree.projectFiles')}</h3>
          <span className="shrink-0 text-xs text-muted-foreground">{t('fileTree.rootCount', { count: context.roots.length })}</span>
        </div>
        <div className="max-h-40 space-y-1 overflow-y-auto" role="group" aria-label={t('fileTree.projectFiles')}>
          {context.roots.map((root) => {
            const Icon = root.kind === 'worktree' ? GitFork : root.kind === 'repository' ? GitBranch : Folder;
            return (
              <button
                type="button" key={root.id} aria-pressed={root.id === active.id}
                disabled={!root.available} title={`${root.machine} · ${root.path}`}
                className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs disabled:opacity-50 ${root.id === active.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'}`}
                onClick={() => {
                  setSelectedId(root.id);
                  setVisited((previous) => new Set(previous).add(root.id));
                }}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap gap-x-2">
                    <span className="max-w-full truncate font-medium">{root.name}</span>
                    <span className="max-w-full truncate text-muted-foreground">{t(`fileTree.rootKind.${root.kind}`)}{root.branch ? ` · ${root.branch}` : ''}</span>
                    {root.id === context.currentRootId && <span className="text-primary">{t('fileTree.sessionRoot')}</span>}
                    {!root.available && <span>{t('fileTree.rootOffline')}</span>}
                  </span>
                  <span className="block truncate text-muted-foreground">{root.machine} · {root.path}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t('fileTree.rootScopeHint')}</p>
      </div>
      {context.roots.filter((root) => visited.has(root.id) || root.id === active.id).map((root) => (
        <div key={root.id} className={root.id === active.id ? 'min-h-0 flex-1' : 'hidden'}>
          {root.available
            ? <RootFiles root={root} onFileOpen={onFileOpen} revealDirectory={root.id === revealRoot?.id ? revealDirectory : null} />
            : <p className="p-3 text-sm text-muted-foreground">{t('fileTree.rootOffline')}</p>}
        </div>
      ))}
    </div>
  );
}

/** Project-workspace uses this explorer for all project roots while chat keeps its original working directory. */
export function ProjectFileTree({ selectedProject, sessionId, onFileOpen, revealDirectory }: ProjectFileTreeProps) {
  const context = useWorkbenchFiles();
  const current = context?.roots.find((root) => root.id === context.currentRootId);
  // Parent and frame navigation are asynchronous. Never show another session's roots during the hand-off.
  const matches = context && current && context.sessionId === (sessionId || '')
    && pathKey(current.path) === pathKey(selectedProject.path || selectedProject.fullPath);
  if (!matches) {
    return <FileTree key={selectedProject.projectId} selectedProject={selectedProject} onFileOpen={(path) => onFileOpen(path, selectedProject)} revealDirectory={revealDirectory} />;
  }
  return <ProjectRoots key={`${context.projectId}:${context.sessionId}:${context.currentRootId}`} context={context} onFileOpen={onFileOpen} revealDirectory={revealDirectory} />;
}
