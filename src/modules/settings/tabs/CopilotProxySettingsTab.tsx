import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { CODEY_MODEL_API_SETTINGS_CHANGED_EVENT } from '@/shared/constants';
import type { CodeyProxySetting, CodeyProxySettingsSnapshot } from '@/shared/types';
import { Button, Input } from '@/shared/ui';

type DraftProxy = CodeyProxySetting & { key: string; modelText: string };

/** Settings renders this node-local, file-backed model API configuration editor. */
export default function CopilotProxySettingsTab() {
  const { t } = useTranslation('settings');
  // Keep the server file revision separate from edits so bulk changes are not overwritten.
  const [snapshot, setSnapshot] = useState<CodeyProxySettingsSnapshot | null>(null);
  // Secrets exist only in transient form state and are cleared after a successful save.
  const [drafts, setDrafts] = useState<DraftProxy[]>([]);
  // Block concurrent UI mutations while a file read/save is pending.
  const [busy, setBusy] = useState(true);
  // Surface file, validation and revision failures without logging request bodies.
  const [error, setError] = useState('');
  // Tell the owner whether edits have actually been saved to this node.
  const [saved, setSaved] = useState(false);

  const accept = useCallback((value: CodeyProxySettingsSnapshot) => {
    setSnapshot(value);
    setDrafts(value.additionalCopilotProxies.map(proxy => ({
      ...proxy, key: '', modelText: proxy.models.join('\n'),
    })));
  }, []);

  const decode = async (response: Response): Promise<CodeyProxySettingsSnapshot> => {
    if (response.status === 404) {
      throw new Error('This node needs a Codey update before proxy settings can be edited.');
    }
    const body = await response.json();
    if (!response.ok) {
      throw new Error(typeof body.error === 'string' ? body.error
        : body.error?.message || body.message || 'Unable to access the node settings.');
    }
    return body as CodeyProxySettingsSnapshot;
  };

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      accept(await decode(await api.settings.copilotProxies()));
      window.dispatchEvent(new Event(CODEY_MODEL_API_SETTINGS_CHANGED_EVENT));
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to read settings.'); }
    finally { setBusy(false); }
  }, [accept]);

  useEffect(() => { void load(); }, [load]);

  const edit = (index: number, update: Partial<DraftProxy>) => {
    setDrafts(current => current.map((proxy, currentIndex) => currentIndex === index ? { ...proxy, ...update } : proxy));
    setSaved(false);
  };
  const save = async () => {
    if (!snapshot) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const additionalCopilotProxies = drafts.map(({ keyConfigured: _configured, modelText, key, models: _models, ...proxy }) => ({
        ...proxy,
        models: modelText.split(/\r?\n/).map(model => model.trim()).filter(Boolean),
        ...(key ? { key } : {}),
      }));
      accept(await decode(await api.settings.saveCopilotProxies({
        revision: snapshot.revision, additionalCopilotProxies,
      })));
      setSaved(true);
      window.dispatchEvent(new Event(CODEY_MODEL_API_SETTINGS_CHANGED_EVENT));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to save settings.');
    } finally { setBusy(false); }
  };

  return (
    <section className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold">
          {t('modelApi.title', { defaultValue: 'Additional Copilot proxies' })}
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('modelApi.description', { defaultValue: 'Configure this node’s model API. Exact model IDs use their assigned proxy; all other models keep the default route. Claude models use the Claude Code harness.' })}
        </p>
        {snapshot && (
          <p className="mt-2 break-all text-xs text-muted-foreground">
            {t('modelApi.file', { defaultValue: 'Node settings file' })}: <code>{snapshot.settingsFile}</code>
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {t('modelApi.fileHelp', { defaultValue: 'This file is the source of truth. Bulk file edits hot-load on the next model request. Keys are never returned by this page. Invalid files block model requests rather than silently changing routes.' })}
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {saved && <p role="status" className="text-sm text-green-600">{t('modelApi.saved', { defaultValue: 'Saved to this node. No restart required.' })}</p>}
      {drafts.map((proxy, index) => (
        <fieldset key={index} disabled={busy} className="space-y-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium">Proxy {index + 1}</legend>
          <label className="block space-y-1 text-sm">
            <span>{t('modelApi.id', { defaultValue: 'Proxy ID' })}</span>
            <Input value={proxy.id} readOnly={proxy.keyConfigured} onChange={event => edit(index, { id: event.target.value })} placeholder="claude-proxy" />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Endpoint</span>
            <Input value={proxy.endpoint} onChange={event => edit(index, { endpoint: event.target.value })} placeholder="https://proxy.example.com" />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Key</span>
            <Input type="password" autoComplete="new-password" value={proxy.key}
              onChange={event => edit(index, { key: event.target.value })}
              placeholder={proxy.keyConfigured
                ? t('modelApi.keepKey', { defaultValue: 'Key saved — leave blank to keep it' })
                : t('modelApi.enterKey', { defaultValue: 'Enter this proxy’s API key' })} />
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t('modelApi.models', { defaultValue: 'Model IDs — one per line' })}</span>
            <textarea className="min-h-24 w-full rounded-md border border-input bg-background p-2 font-mono text-sm"
              value={proxy.modelText} onChange={event => edit(index, { modelText: event.target.value })}
              placeholder="claude-opus-5.5" />
          </label>
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={proxy.enabled} onChange={event => edit(index, { enabled: event.target.checked })} />
              {t('modelApi.enabled', { defaultValue: 'Enabled' })}
            </label>
            <Button variant="ghost" onClick={() => { setDrafts(current => current.filter((_, currentIndex) => currentIndex !== index)); setSaved(false); }}>
              {t('modelApi.remove', { defaultValue: 'Remove proxy' })}
            </Button>
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || !snapshot?.enabled} onClick={() => {
          setDrafts(current => [...current, {
            id: '', enabled: true, endpoint: '', key: '', keyConfigured: false, models: [], modelText: '',
          }]);
          setSaved(false);
        }}>{t('modelApi.add', { defaultValue: 'Add proxy' })}</Button>
        <Button disabled={busy || !snapshot?.enabled} onClick={() => void save()}>
          {t('modelApi.save', { defaultValue: 'Save to node' })}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void load()}>
          {t('modelApi.reload', { defaultValue: 'Reload file' })}
        </Button>
      </div>
    </section>
  );
}
