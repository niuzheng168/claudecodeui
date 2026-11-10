import { AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FileTreeDirectoryStatus } from '@/shared/types';

type FileTreeStatusRowProps = {
  status: FileTreeDirectoryStatus;
  // The depth of the folder's entries, which the row lines up with.
  level: number;
};

/** Rendered below an open folder, or the project root, to say its entries are loading, failed to load, or were cut short. */
export default function FileTreeStatusRow({ status, level }: FileTreeStatusRowProps) {
  const { t } = useTranslation();

  return (
    <div
      className="flex items-center gap-1.5 py-[3px] pr-2 text-xs text-muted-foreground"
      style={{ paddingLeft: `${level * 16 + 22}px` }}
    >
      {status.state === 'loading' && (
        <>
          <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
          <span>{t('fileTree.loadingFolder', 'Loading...')}</span>
        </>
      )}
      {status.state === 'failed' && (
        <>
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
          <span className="truncate" title={status.error}>{status.error}</span>
        </>
      )}
      {status.state === 'truncated' && (
        <span>
          {t('fileTree.folderTruncated', 'Only the first {{shown}} entries are shown', {
            shown: status.shown.toLocaleString(),
          })}
        </span>
      )}
    </div>
  );
}
