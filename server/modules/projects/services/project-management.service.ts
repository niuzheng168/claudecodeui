import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import type {
  CreateProjectPathResult,
  ProjectRepositoryRow,
  WorkspacePathValidationResult,
} from '@/shared/index.js';
import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/index.js';

type CreateProjectInput = {
  projectPath: string;
  customName?: string | null;
};

type CreateProjectDependencies = {
  validatePath: (projectPath: string) => Promise<WorkspacePathValidationResult>;
  ensureWorkspaceDirectory: (projectPath: string) => Promise<void>;
  persistProjectPath: (projectPath: string, customName: string | null) => CreateProjectPathResult;
  getProjectByPath: (projectPath: string) => ProjectRepositoryRow | null;
};

type ProjectApiView = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  customName: string | null;
  isArchived: boolean;
  isStarred: boolean;
  sessions: [];
  sessionMeta: {
    hasMore: false;
    total: 0;
  };
};

type CreateProjectServiceResult = {
  outcome: 'created' | 'reactivated_archived';
  project: ProjectApiView;
};

const defaultDependencies: CreateProjectDependencies = {
  validatePath: validateWorkspacePath,
  ensureWorkspaceDirectory: async (projectPath: string): Promise<void> => {
    await fs.mkdir(projectPath, { recursive: true });
    const directoryStats = await fs.stat(projectPath);
    if (!directoryStats.isDirectory()) {
      throw new AppError('Path exists but is not a directory', {
        code: 'PROJECT_PATH_NOT_DIRECTORY',
        statusCode: 400,
      });
    }
  },
  persistProjectPath: (projectPath: string, customName: string | null): CreateProjectPathResult =>
    projectsDb.createProjectPath(projectPath, customName),
  getProjectByPath: (projectPath: string): ProjectRepositoryRow | null =>
    projectsDb.getProjectPath(projectPath),
};

function resolveDisplayName(customName: string | null | undefined, projectPath: string): string {
  const trimmedCustomName = typeof customName === 'string' ? customName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  return path.basename(projectPath) || projectPath;
}

function mapProjectRowToApiView(projectRow: ProjectRepositoryRow): ProjectApiView {
  return {
    projectId: projectRow.project_id,
    path: projectRow.project_path,
    fullPath: projectRow.project_path,
    displayName: resolveDisplayName(projectRow.custom_project_name, projectRow.project_path),
    customName: projectRow.custom_project_name,
    isArchived: Boolean(projectRow.isArchived),
    isStarred: Boolean(projectRow.isStarred),
    sessions: [],
    sessionMeta: {
      hasMore: false,
      total: 0,
    },
  };
}

export async function createProject(
  input: CreateProjectInput,
  dependencies: CreateProjectDependencies = defaultDependencies,
): Promise<CreateProjectServiceResult> {
  const normalizedPath = normalizeProjectPath(input.projectPath || '');
  if (!normalizedPath) {
    throw new AppError('path is required', {
      code: 'PROJECT_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  const pathValidation = await dependencies.validatePath(normalizedPath);
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    throw new AppError('Invalid project path', {
      code: 'INVALID_PROJECT_PATH',
      statusCode: 400,
      details: pathValidation.error ?? 'Path validation failed',
    });
  }

  const resolvedProjectPath = normalizeProjectPath(pathValidation.resolvedPath);
  await dependencies.ensureWorkspaceDirectory(resolvedProjectPath);

  const normalizedCustomName = resolveDisplayName(input.customName ?? null, resolvedProjectPath);
  const persistedProject = dependencies.persistProjectPath(resolvedProjectPath, normalizedCustomName);

  if (persistedProject.outcome === 'active_conflict') {
    throw new AppError('Project path already exists and is active', {
      code: 'PROJECT_ALREADY_EXISTS',
      statusCode: 409,
      details: `Project path already exists: ${resolvedProjectPath}`,
    });
  }

  const projectRow = persistedProject.project ?? dependencies.getProjectByPath(resolvedProjectPath);
  if (!projectRow) {
    throw new AppError('Failed to resolve project after creation', {
      code: 'PROJECT_CREATE_FAILED',
      statusCode: 500,
    });
  }

  // Archived rows intentionally remain archived when reused, as requested.
  return {
    outcome: persistedProject.outcome,
    project: mapProjectRowToApiView(projectRow),
  };
}

type ResolveDirectoryDependencies = {
  validatePath: CreateProjectDependencies['validatePath'];
  isDirectory: (projectPath: string) => Promise<boolean>;
  getProjectByPath: CreateProjectDependencies['getProjectByPath'];
  persistProjectPath: CreateProjectDependencies['persistProjectPath'];
};

/**
 * Projects routes uses this idempotent resolver for multi-root file browsing.
 * Register only an existing, policy-allowed directory; never create a missing
 * checkout, rename an existing project, or unarchive one merely to preview it.
 */
export async function resolveProjectDirectory(
  projectPath: string,
  dependencies: ResolveDirectoryDependencies = {
    validatePath: validateWorkspacePath,
    isDirectory: async (candidate) => (await fs.stat(candidate)).isDirectory(),
    getProjectByPath: defaultDependencies.getProjectByPath,
    persistProjectPath: defaultDependencies.persistProjectPath,
  },
): Promise<{ project: ProjectApiView }> {
  if (!projectPath || !path.isAbsolute(projectPath)) {
    throw new AppError('An absolute directory path is required', { code: 'INVALID_PROJECT_PATH', statusCode: 400 });
  }
  const validation = await dependencies.validatePath(projectPath);
  if (!validation.valid || !validation.resolvedPath) {
    throw new AppError('Invalid project path', { code: 'INVALID_PROJECT_PATH', statusCode: 403 });
  }
  const resolvedPath = normalizeProjectPath(validation.resolvedPath);
  if (!await dependencies.isDirectory(resolvedPath).catch(() => false)) {
    throw new AppError('Directory does not exist or is not accessible', { code: 'PROJECT_DIRECTORY_NOT_FOUND', statusCode: 404 });
  }
  const existing = dependencies.getProjectByPath(resolvedPath);
  const row = existing ?? dependencies.persistProjectPath(resolvedPath, null).project;
  if (!row) {
    throw new AppError('Failed to resolve directory', { code: 'PROJECT_RESOLVE_FAILED', statusCode: 500 });
  }
  return { project: mapProjectRowToApiView(row) };
}

/**
 * Sets `projects.custom_project_name` for the given `projectId` (or clears it when empty).
 */
export function updateProjectDisplayName(projectId: string, newDisplayName: unknown): void {
  const trimmed = typeof newDisplayName === 'string' ? newDisplayName.trim() : '';
  projectsDb.updateCustomProjectNameById(projectId, trimmed.length > 0 ? trimmed : null);
}
