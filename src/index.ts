import { FocusController } from './workflow';
import { TavernPlatform, type TavernApi } from './tavern';
import { mountUI } from './ui';

const scope = globalThis as unknown as TavernApi;
const doc = window.parent.document;
const previous = window.parent as unknown as { nationalFocusDispose?: () => void };
previous.nationalFocusDispose?.();
try {
  const platform = new TavernPlatform(scope, window.parent.localStorage);
  const controller = new FocusController(platform);
  const removeUI = mountUI(controller, doc);
  const dispose = () => {
    controller.dispose();
    platform.dispose();
    removeUI();
  };
  previous.nationalFocusDispose = dispose;
  window.addEventListener('pagehide', dispose, { once: true });
  void controller.initialize();
  // Tavern Helper creates the iframe's Mvu getter through this public API.
  void scope
    .waitGlobalInitialized?.('Mvu')
    .then(() => controller.refresh())
    .catch((error) => controller.report(error));
} catch (error) {
  const message = doc.createElement('div');
  message.textContent = `國策腳本初始化失敗：${error instanceof Error ? error.message : String(error)}`;
  Object.assign(message.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    padding: '15px',
    background: '#54382a',
    color: 'white',
    zIndex: '2147483000',
  });
  doc.body.append(message);
  window.addEventListener('pagehide', () => message.remove(), { once: true });
}
