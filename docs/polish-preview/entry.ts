import { DemoPlatform, demoTree } from '../../src/demo';
import { installCountry } from '../../src/engine';
import { FocusController } from '../../src/workflow';
import { mountUI } from '../../src/ui';
import polish from './polish.css';
import card from '../../src/news-card/card.html';

async function main() {
  const platform = new DemoPlatform();
  await platform.periodSample(false);
  const snapshot = await platform.read();
  let state = installCountry(snapshot.state, demoTree('north', '北境聯邦'), snapshot.day);
  state = installCountry(state, demoTree('coast', '蒼海同盟'), snapshot.day);
  state.countries.north.control = 'ai';
  state.countries.coast.control = 'ai';
  state.countries.north.periodTitle = '在長冬到來之前';
  state.countries.north.agenda = '聯合山谷自治領，建立共同儲糧與越冬運輸。';
  state.countries.coast.periodTitle = '重啟群島的航路';
  state.countries.coast.agenda = '修復港口與燈塔，讓商船重新連結沿海城市。';
  await platform.commit(snapshot, state);
  const controller = new FocusController(platform);
  await controller.initialize();
  mountUI(controller, document, platform);
  const host = document.getElementById('national-focus-root')!;
  const root = host.shadowRoot!;
  const base = document.createElement('style');
  base.textContent =
    '.shell{top:64px}.preview-eyebrow{display:none}@media(max-width:760px){.shell{top:104px}}';
  root.append(base);
  const finish = document.createElement('style');
  root.append(finish);
  let refined = true;
  const paint = () => {
    const selected = root.querySelector<HTMLElement>('.nation-tab.active')?.dataset.country;
    host.dataset.nation = selected || 'augustium';
    const heading = root.querySelector('.nation-copy');
    if (heading && !heading.querySelector('.preview-eyebrow')) {
      const eyebrow = document.createElement('span');
      eyebrow.className = 'preview-eyebrow';
      eyebrow.textContent =
        selected === 'north'
          ? '北方諸領 · 聯邦議事廳'
          : selected === 'coast'
            ? '群島諸城 · 航務議會'
            : '七省之上 · 帝國樞密院';
      heading.prepend(eyebrow);
    }
  };
  root.addEventListener('click', () => queueMicrotask(paint));
  root.addEventListener('change', () => queueMicrotask(paint));
  controller.subscribe(paint);
  const setStyle = (value: boolean) => {
    refined = value;
    finish.textContent = refined ? polish : '';
    document.querySelectorAll<HTMLButtonElement>('[data-style]').forEach((button) => {
      button.setAttribute('aria-pressed', String((button.dataset.style === 'refined') === refined));
    });
    const frame = document.querySelector<HTMLIFrameElement>('#newspaper')!;
    const style = frame.contentDocument?.getElementById('paper-polish');
    if (style) {
      style.textContent = refined ? paperStyle : '';
    }
    paint();
    window.dispatchEvent(new Event('resize'));
  };
  const paperStyle = `
    :root{--paper:#f5edda;--ink:#26251e;--ink3:#665c4c;--line:#b5a789}
    .nb{margin:0}.strip{border-radius:0;padding:16px 22px}.strip .mast{font-size:19px}
    .paper{padding:24px 36px}.masthead{letter-spacing:.18em;padding:18px 0;font-size:clamp(26px,4vw,48px)}
    .lead h1{font-size:clamp(24px,2.6vw,35px);line-height:1.5;margin:18px 0 12px}
    .cols{font-size:17px;line-height:2}.deck{font-size:16px;line-height:1.8}
    .index{width:220px}.it{padding:12px 16px;font-size:14px}.it small{font-size:12px;line-height:1.7}
    .section{margin-top:30px}.slip{box-shadow:2px 5px 0 #b4a48055}
    .btn,.toggle,.ctl .b{min-height:36px}.old{opacity:.85}
    @media(max-width:760px){.paper{padding:18px}.cols{font-size:16px}.strip{padding:12px}.masthead{letter-spacing:.08em}}
  `;
  const frame = document.querySelector<HTMLIFrameElement>('#newspaper')!;
  let paperLoaded = false;
  const openPaper = () => {
    if (paperLoaded) {
      return;
    }
    paperLoaded = true;
    const current = structuredClone(controller.state!);
    const time = '复兴纪元490年-10月-15日-星期三-14:25';
    const variables = {
      stat_data: {
        世界: { 时间: time, 地点: '奧古斯提姆帝國' },
        新闻: {
          阿斯塔利亞快訊: {
            帝國向北境提出糧運協議:
              '樞密院今日宣布，帝國願意在信用爭議尚未解決前，先恢復通往北境的民用糧運。首批車隊將沿舊驛道北上，沿線糧倉已開始清點存糧。\n\n商人們仍在等待關稅與護送安排。對邊境居民而言，這份協議的意義暫時很簡單：在第一場雪落下以前，麵包能否回到市集。',
            港口準備迎接秋季糧船:
              '港務署完成泊位檢查，將為運糧船保留卸貨時段。船主要求先確認倉儲費用，工會則希望延長夜間照明。',
          },
          酒館留言板: {
            驛道上的新告示:
              '北行商隊正在招募護衛。告示未提及戰事，只要求應募者熟悉山路，並能在寒夜守住營火。',
            來自海邊的消息:
              '一位旅人說，蒼海同盟的燈塔又亮了。有人把它當成通航的信號，也有人認為那只是守塔人不願離開。',
          },
        },
      },
      国策: {
        ...current,
        快讯: {
          floor: 7,
          time,
          location: '奧古斯提姆帝國',
          newsPath: '新闻',
          insiders: ['augustium'],
          changed: ['阿斯塔利亞快訊/帝國向北境提出糧運協議', '阿斯塔利亞快訊/港口準備迎接秋季糧船'],
          updated: {},
        },
      },
    };
    const json = JSON.stringify(variables).replaceAll('<', '\\u003c');
    const bridge = `window.getCurrentMessageId=()=>7;window.getVariables=(o)=>o.type==='global'?{}:${json};window.insertOrAssignVariables=()=>{};window.eventOn=()=>({stop(){}});window.eventEmit=(name)=>{if(name==='national-focus:open-news'){parent.document.querySelector('[data-view="focus"]').click();}return Promise.resolve();};`;
    frame.srcdoc =
      '<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>' +
      bridge +
      '</script></head>' +
      card.replace(
        '</body>',
        '<style id="paper-polish">' +
          (refined ? paperStyle : '') +
          '</style><script>document.getElementById("strip").click();</script></body>',
      ) +
      '</html>';
  };
  document.querySelectorAll<HTMLButtonElement>('[data-style]').forEach((button) => {
    button.addEventListener('click', () => setStyle(button.dataset.style === 'refined'));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      const newspaper = button.dataset.view === 'paper';
      document.getElementById('paper-screen')!.hidden = !newspaper;
      host.style.display = newspaper ? 'none' : '';
      document
        .querySelectorAll('[data-view]')
        .forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      if (newspaper) {
        openPaper();
      } else {
        window.dispatchEvent(new Event('resize'));
      }
    });
  });
  setStyle(true);
}
void main().catch((error) => {
  document.getElementById('failure')!.textContent = '樣品載入失敗：' + String(error);
  console.error(error);
});
