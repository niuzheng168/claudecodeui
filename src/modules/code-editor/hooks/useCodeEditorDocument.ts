import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { CodeEditorFile } from '@/shared/types';
import { isBinaryFile } from '@/modules/code-editor/utils/binaryFile';
import { getPreviewKind } from '@/modules/code-editor/utils/previewableFile';

type UseCodeEditorDocumentParams = {
  file: CodeEditorFile;
  projectPath?: string;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

async function readFileError(response: Response, action: string): Promise<string> {
  const fallback = `${action}: ${response.status} ${response.statusText}`.trim();
  try {
    if (response.headers.get('content-type')?.includes('json')) {
      const payload: unknown = await response.json();
      if (typeof payload === 'object' && payload !== null && 'error' in payload) {
        const error = payload.error;
        const message = typeof error === 'string'
          ? error
          : typeof error === 'object' && error !== null && 'message' in error
            ? error.message
            : null;
        if (typeof message === 'string' && message.trim()) {
          return `${fallback}: ${message}`;
        }
      }
    }
  } catch {
    // Proxy HTML, empty bodies, and malformed JSON should keep the HTTP status
    // rather than replacing the useful error with a JSON parse exception.
  }
  return fallback;
}

/** CodeEditor uses this hook to load, edit, and save one project-scoped document. */
export const useCodeEditorDocument = ({ file, projectPath }: UseCodeEditorDocumentParams) => {
  // Holds the loaded text and subsequent edits shown by CodeMirror.
  const [content, setContent] = useState('');
  // Prevents editing or saving a stale buffer while another file is loading.
  const [loading, setLoading] = useState(true);
  // Separates load diagnostics from file contents so they can never be saved.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Tracks the in-flight save for toolbar feedback.
  const [saving, setSaving] = useState(false);
  // Briefly acknowledges a successful write in the toolbar.
  const [saveSuccess, setSaveSuccess] = useState(false);
  // Retains write failures for the editor's existing error banner.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Chooses the binary placeholder instead of the editable text surface.
  const [isBinary, setIsBinary] = useState(false);
  // Some binaries (images, PDFs, audio, video) can be rendered natively, so the
  // editor shows an inline preview instead of the generic binary placeholder.
  const previewKind = getPreviewKind(file.name);
  // `fileProjectId` is the DB primary key passed down from the editor sidebar;
  // the fallback to `projectPath` preserves older callers that didn't yet
  // propagate the identifier.
  const fileProjectId = file.projectId ?? projectPath;
  const filePath = file.path;
  const fileName = file.name;
  const fileDiffNewString = file.diffInfo?.new_string;
  const fileDiffOldString = file.diffInfo?.old_string;

  useEffect(() => {
    let active = true;
    const loadFileContent = async () => {
      try {
        setLoading(true);
        setLoadError(null);
        setSaveError(null);
        setSaveSuccess(false);
        setIsBinary(false);

        // Natively previewable media (image/pdf/audio/video) is rendered by
        // CodeEditorMediaPreview, so there is nothing to read as text here.
        // Clear any buffer left over from a previously opened text file so a
        // stray save can't write stale content over the binary file.
        if (getPreviewKind(file.name)) {
          setContent('');
          setLoading(false);
          return;
        }

        // Check if file is binary by extension
        if (isBinaryFile(file.name)) {
          setContent('');
          setIsBinary(true);
          setLoading(false);
          return;
        }

        // Diff payload may already include full old/new snapshots, so avoid disk read.
        if (file.diffInfo && fileDiffNewString !== undefined && fileDiffOldString !== undefined) {
          setContent(fileDiffNewString);
          setLoading(false);
          return;
        }

        if (!fileProjectId) {
          throw new Error('Missing project identifier');
        }

        const response = await api.readFile(fileProjectId, filePath);
        if (!response.ok) {
          throw new Error(await readFileError(response, 'Failed to load file'));
        }

        const data = await response.json();
        if (typeof data?.content !== 'string') {
          throw new Error('Invalid file response: missing text content');
        }
        if (active) setContent(data.content);
      } catch (error) {
        if (!active) return;
        const message = getErrorMessage(error);
        console.error('Error loading file:', error);
        setLoadError(message);
        setContent(`// Error loading file: ${message}\n// File: ${fileName}\n// Path: ${filePath}`);
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadFileContent();
    // A slow response for the previous file must not replace the current buffer.
    return () => { active = false; };
  }, [file.diffInfo, file.name, fileDiffNewString, fileDiffOldString, fileName, filePath, fileProjectId]);

  const handleSave = useCallback(async () => {
    // Preview-only and binary files have no editable text buffer; never write
    // them back (e.g. via Cmd/Ctrl+S) or we'd corrupt the file on disk.
    if (previewKind || isBinaryFile(fileName)) {
      return;
    }
    if (loading || loadError) {
      setSaveError(loadError ?? 'Wait for the file to finish loading before saving');
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      if (!fileProjectId) {
        throw new Error('Missing project identifier');
      }

      const response = await api.saveFile(fileProjectId, filePath, content);

      if (!response.ok) {
        throw new Error(await readFileError(response, 'Save failed'));
      }

      await response.json();

      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('Error saving file:', error);
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [content, filePath, fileProjectId, previewKind, fileName, loading, loadError]);

  const handleDownload = useCallback(() => {
    if (loading || loadError) return;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = file.name;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, [content, file.name, loading, loadError]);

  return {
    content,
    setContent,
    loading,
    saving,
    saveSuccess,
    saveError,
    isBinary,
    previewKind,
    fileProjectId,
    handleSave,
    handleDownload,
  };
};
