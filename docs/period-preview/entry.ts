import { FocusController } from '../../src/workflow';
import { mountUI } from '../../src/ui';
import { PeriodPreview } from './platform';

const preview=new PeriodPreview();
const controller=new FocusController(preview);
void controller.initialize().then(()=>mountUI(controller,document,preview)).catch(error=>{
  const output=document.getElementById('startup-error');
  if (output) {
    output.textContent=`樣品初始化失敗：${error instanceof Error ? error.message : String(error)}`;
  }
});
