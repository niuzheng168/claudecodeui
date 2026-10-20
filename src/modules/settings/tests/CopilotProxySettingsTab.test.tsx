import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import CopilotProxySettingsTab from '@/modules/settings/tabs/CopilotProxySettingsTab';

const requests = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock('@/shared/api', () => ({
  api: { settings: { copilotProxies: requests.read, saveCopilotProxies: requests.save } },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}));

const snapshot = {
  enabled: true, settingsFile: '/node/.config/codey/settings.json', revision: 'a'.repeat(64),
  additionalCopilotProxies: [{
    id: 'claude-proxy', enabled: true, endpoint: 'https://proxy.example',
    keyConfigured: true, models: ['claude-opus-5.5'],
  }],
};
const ok = () => ({ ok: true, json: async () => structuredClone(snapshot) });

beforeEach(() => {
  requests.read.mockReset().mockResolvedValue(ok());
  requests.save.mockReset().mockResolvedValue(ok());
});

test('reads the node file and never displays or resends an existing key', async () => {
  render(<CopilotProxySettingsTab />);
  await screen.findByText(snapshot.settingsFile);
  expect((screen.getByLabelText('Key') as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByText('Save to node'));
  await waitFor(() => expect(requests.save).toHaveBeenCalledTimes(1));
  expect(requests.save.mock.calls[0][0]).toEqual({
    revision: snapshot.revision,
    additionalCopilotProxies: [{
      id: 'claude-proxy', enabled: true, endpoint: 'https://proxy.example', models: ['claude-opus-5.5'],
    }],
  });
  await screen.findByText('Saved to this node. No restart required.');
});

test('replacement keys are transient and cleared when save succeeds', async () => {
  render(<CopilotProxySettingsTab />);
  await screen.findByText(snapshot.settingsFile);
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'new-private-key' } });
  fireEvent.change(screen.getByLabelText('Model IDs — one per line'), {
    target: { value: 'claude-opus-5.5\ngpt-6.1-sol' },
  });
  fireEvent.click(screen.getByText('Save to node'));
  await screen.findByText('Saved to this node. No restart required.');
  expect(requests.save.mock.calls[0][0].additionalCopilotProxies[0]).toMatchObject({
    key: 'new-private-key', models: ['claude-opus-5.5', 'gpt-6.1-sol'],
  });
  expect((screen.getByLabelText('Key') as HTMLInputElement).value).toBe('');
  expect(document.body.textContent).not.toContain('new-private-key');
});

test('a bulk-edit conflict preserves unsaved input until the owner explicitly reloads', async () => {
  requests.save.mockResolvedValue({
    ok: false, json: async () => ({ error: { message: 'The node settings changed. Reload before saving.' } }),
  });
  render(<CopilotProxySettingsTab />);
  await screen.findByText(snapshot.settingsFile);
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'unsaved-key' } });
  fireEvent.click(screen.getByText('Save to node'));
  expect((await screen.findByRole('alert')).textContent).toContain('Reload before saving');
  expect((screen.getByLabelText('Key') as HTMLInputElement).value).toBe('unsaved-key');
  fireEvent.click(screen.getByText('Reload file'));
  await waitFor(() => expect(requests.read).toHaveBeenCalledTimes(2));
  await waitFor(() => expect((screen.getByLabelText('Key') as HTMLInputElement).value).toBe(''));
});

test('removing a proxy is staged until save and adding one does not persist automatically', async () => {
  render(<CopilotProxySettingsTab />);
  await screen.findByText(snapshot.settingsFile);
  fireEvent.click(screen.getByText('Remove proxy'));
  expect(requests.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Save to node'));
  await waitFor(() => expect(requests.save).toHaveBeenCalledTimes(1));
  expect(requests.save.mock.calls[0][0].additionalCopilotProxies).toEqual([]);
});

test('older nodes show an upgrade requirement without trying to parse their HTML 404 page', async () => {
  requests.read.mockResolvedValue({ ok: false, status: 404, json: () => { throw Error('HTML must not be parsed'); } });
  render(<CopilotProxySettingsTab />);
  expect((await screen.findByRole('alert')).textContent).toContain('needs a Codey update');
  expect((screen.getByText('Save to node') as HTMLButtonElement).disabled).toBe(true);
});
