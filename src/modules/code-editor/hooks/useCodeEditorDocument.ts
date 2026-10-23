import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

// CodeMirror reports its document with LF line endings whatever the file used,
// so a CRLF file would look edited from the first keystroke (and stay "edited"
// after an undo) unless both sides of the comparison are normalised.
const normalizeLineEndings = (text: string) => text.replace(/\r\n?/g, '\n');

/** CodeEditor uses this hook to load, edit, and save one project-scoped document. */
export const useCodeEditorDocument = ({ file, projectPath }: UseCodeEditorDocumentParams) => {
  // Holds the loaded text and subsequent edits shown by CodeMirror.
  const [content, setContent] = useState('');
  // The text as last loaded from disk or written back by a save. The buffer is
  // compared against it to tell whether closing or switching files would
  // discard edits; nothing else in the app knows that baseline.
  const [savedContent, setSavedContent] = useState('');
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
  // Counts the loads this editor has performed. A read or save still in flight
  // when another file is opened belongs to the previous file and must not land
  // on the new one's buffer, baseline or save state.
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    const loadGeneration = ++loadGenerationRef.current;
    const isStaleLoad = () => loadGenerationRef.current !== loadGeneration;

    // Every load path resets the saved baseline together with the buffer, so a
    // freshly opened file (or an error placeholder) never counts as dirty.
    const applyLoadedContent = (text: string) => {
      setContent(text);
      setSavedContent(text);
    };

    const loadFileContent = async () => {
      try {
        setLoading(true);
        setLoadError(null);
        setIsBinary(false);
        // Any save still in flight, failed or just acknowledged belongs to the
        // previous file.
        setSaving(false);
        setSaveError(null);
        setSaveSuccess(false);

        // Natively previewable media (image/pdf/audio/video) is rendered by
        // CodeEditorMediaPreview, so there is nothing to read as text here.
        // Clear any buffer left over from a previously opened text file so a
        // stray save can't write stale content over the binary file.
        if (getPreviewKind(file.name)) {
          applyLoadedContent('');
          setLoading(false);
          return;
        }

        // Check if file is binary by extension
        if (isBinaryFile(file.name)) {
          applyLoadedContent('');
          setIsBinary(true);
          setLoading(false);
          return;
        }

        // Diff payload may already include full old/new snapshots, so avoid disk read.
        if (file.diffInfo && fileDiffNewString !== undefined && fileDiffOldString !== undefined) {
          applyLoadedContent(fileDiffNewString);
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
        // A slow response for the previous file must not replace the current buffer.
        if (isStaleLoad()) {
          return;
        }
        applyLoadedContent(data.content);
      } catch (error) {
        if (isStaleLoad()) {
          return;
        }
        const message = getErrorMessage(error);
        console.error('Error loading file:', error);
        setLoadError(message);
        applyLoadedContent(`// Error loading file: ${message}\n// File: ${fileName}\n// Path: ${filePath}`);
      } finally {
        if (!isStaleLoad()) {
          setLoading(false);
        }
      }
    };

    void loadFileContent();
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

    const saveGeneration = loadGenerationRef.current;
    const isStaleSave = () => loadGenerationRef.current !== saveGeneration;

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

      // Another file loaded while this write was in flight: it owns the buffer,
      // the baseline and the save state now.
      if (isStaleSave()) {
        return;
      }

      // Baseline is the text that was actually sent: anything typed while the
      // request was in flight is still unsaved.
      setSavedContent(content);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('Error saving file:', error);
      if (!isStaleSave()) {
        setSaveError(message);
      }
    } finally {
      if (!isStaleSave()) {
        setSaving(false);
      }
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

  // The baseline only changes on load and save, so it is not re-normalised on
  // every keystroke.
  const normalizedSavedContent = useMemo(() => normalizeLineEndings(savedContent), [savedContent]);

  // Preview and binary files have no editable buffer, and while a file loads
  // the buffer still belongs to the previous one. A load error's placeholder
  // can never be saved, so it is never a change to keep either. Memoised so
  // renders that do not change the buffer (a save's spinner and tick) skip the
  // comparison.
  const hasUnsavedChanges = useMemo(
    () => (
      !loading
      && !loadError
      && !previewKind
      && !isBinary
      && content !== savedContent
      && normalizeLineEndings(content) !== normalizedSavedContent
    ),
    [content, isBinary, loadError, loading, normalizedSavedContent, previewKind, savedContent],
  );

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
    hasUnsavedChanges,
    handleSave,
    handleDownload,
  };
};
