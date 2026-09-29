import { DemoPlatform } from './demo';
import { FocusController } from './workflow';
import { mountUI } from './ui';

const preview = new DemoPlatform();
const controller = new FocusController(preview);
void controller.initialize().then(() => mountUI(controller, document, preview));
