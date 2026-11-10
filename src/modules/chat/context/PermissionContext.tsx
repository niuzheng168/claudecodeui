import { createContext, useContext } from 'react';

import type { PendingPermissionRequest } from '@/shared/types';

export type PermissionContextValue = {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
};

/**
 * The tool approvals waiting in the viewed session and how to answer them, for
 * PlanDisplay's inline plan decision. Provided by chat's ChatInterface and by
 * the shared-session module (through the chat barrel), which lists only the
 * approvals a shared session's owner lets its reader answer.
 */
const PermissionContext = createContext<PermissionContextValue | null>(null);

export function usePermission(): PermissionContextValue | null {
  return useContext(PermissionContext);
}

export default PermissionContext;
