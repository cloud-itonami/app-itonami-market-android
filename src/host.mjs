// restricted-wasm-v1 host (KOTOBA-159). This page is the trusted shell: it holds the canonical
// runtime and broker, verifies the guest document against the SHA-256 and source commit pinned
// at build time, and mounts it with mountRestrictedClientApp in an opaque-origin sandbox. The
// guest reaches the network only through this broker, one consent per operation, for the two
// operations the descriptor declares. The host reads nothing but ./host-data.js.
import { createClientConsentHost, createClientOperationBroker, mountRestrictedClientApp, verifyClientArtifact } from './kotoba-client-runtime.js';
import host from './host-data.js';

const container = document.getElementById('app');
try {
  const { descriptor } = host;
  const broker = createClientOperationBroker({
    runtime: descriptor,
    requestedCapabilities: descriptor.operations.map(({ capability }) => capability),
    hostSupportedOperations: descriptor.operations.map(({ capability, service, operation }) => [capability, service, operation]),
    approvedOperations: descriptor.operations,
    consentHost: createClientConsentHost({ locale: 'ja' }),
    app: { name: '営 市場情報' },
  });
  const artifact = await verifyClientArtifact(new TextEncoder().encode(host.guest), host.artifact);
  await mountRestrictedClientApp({ artifact, container, broker });
} catch (error) {
  const problem = document.createElement('p');
  problem.className = 'problem';
  problem.textContent = 'アプリを起動できませんでした。 ' + String(error?.message ?? error);
  container.replaceChildren(problem);
}
