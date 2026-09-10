import assert from 'node:assert/strict';
import test from 'node:test';

const previousProfile = process.env.CLOUDCLI_PROVIDER_PROFILE;
process.env.CLOUDCLI_PROVIDER_PROFILE = 'codex-only';
const { providerRegistry } = await import('@/modules/providers/provider.registry.js');
const { providerCapabilitiesService } = await import(
  '@/modules/providers/services/provider-capabilities.service.js'
);
if (previousProfile === undefined) delete process.env.CLOUDCLI_PROVIDER_PROFILE;
else process.env.CLOUDCLI_PROVIDER_PROFILE = previousProfile;

test('codex-only runtime loads only Codex and hides disabled provider capabilities', () => {
  assert.equal(providerRegistry.profile, 'codex-only');
  assert.deepEqual(providerRegistry.listProviderIds(), ['codex']);
  assert.deepEqual(
    providerCapabilitiesService.listAllProviderCapabilities().map(({ provider }) => provider),
    ['codex'],
  );
  assert.throws(
    () => providerRegistry.resolveProvider('claude'),
    { code: 'UNSUPPORTED_PROVIDER' },
  );
});
