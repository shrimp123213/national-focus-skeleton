import { playerCountries } from './engine';
import type { State } from './model';

/**
 * Data the newspaper (news bar) of one AI floor needs besides the national state, saved at
 * `国策.快讯` with the floor. The card only reads its own floor, so a swipe or an older floor
 * always shows what was true there.
 *
 * - `insiders`: countries whose unpublished news the player may read on this floor, the ones the
 *   player steers plus the ones the player is inside (`location`).
 * - `updated`: story time each field of the card's own news (`新闻`) last changed, carried from
 *   floor to floor; `changed` lists the fields that changed on this floor.
 */
export type NewsBar = {
  floor: number;
  time: string;
  location: string;
  insiders: string[];
  newsPath: string;
  timePath?: string;
  locationPath?: string;
  updated: Record<string, string>;
  changed: string[];
};

/** Board and field of the card's news, flattened in their own order: `阿斯塔利亚快讯/军事行动`. */
export function newsFields(value: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  const text = (item: unknown): string => {
    // Older MVU saves keep [value, description] pairs.
    if (Array.isArray(item) && item.length && typeof item[0] !== 'object') {
      return String(item[0]);
    }
    return typeof item === 'string' ? item : item == null ? '' : JSON.stringify(item);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fields;
  }
  for (const [board, content] of Object.entries(value as Record<string, unknown>)) {
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      for (const [field, item] of Object.entries(content as Record<string, unknown>)) {
        fields[`${board}/${field}`] = text(item);
      }
    } else {
      fields[board] = text(content);
    }
  }
  return fields;
}

/**
 * Traditional → simplified pairs for characters common in place and country names, so a location
 * written in simplified Chinese still matches a country the model named in traditional Chinese.
 */
const variants =
  '國国東东陸陆區区島岛灣湾龍龙鳳凤門门鐵铁爐炉臨临穀谷聯联亞亚蘭兰爾尔維维羅罗薩萨蘇苏齊齐瑪玛諾诺倫伦華华陽阳陰阴衛卫軍军團团營营廠厂業业會会議议黨党權权貴贵領领屬属邊边寧宁遼辽滿满漢汉們们從从來来時时間间當当為为與与風风雲云電电爭争戰战勝胜敗败聖圣靈灵獸兽蟲虫鳥鸟魚鱼馬马驛驿劍剑帥帅將将師师廟庙觀观樓楼閣阁臺台壘垒關关橋桥澤泽淵渊濤涛瀾澜灘滩嶺岭巖岩峽峡礦矿銀银銅铜錫锡鋼钢鑄铸鍛锻輝辉燈灯爍烁煙烟熱热凍冻霧雾氣气燼烬歲岁紀纪曆历歷历傳传說说語语詩诗書书圖图畫画夢梦萬万億亿無无極极盡尽滅灭殘残絕绝斷断續续開开啟启階阶級级層层輪轮環环圓圆實实寶宝貿贸幣币價价錢钱買买賣卖貨货財财稅税務务產产農农糧粮麥麦豐丰饑饥飢饥餘余鄉乡鎮镇縣县莊庄園园圍围場场壇坛墳坟塊块壞坏奪夺奮奋學学孫孙審审寫写對对專专導导屆届岡冈崗岗嶼屿巒峦帳帐帶带幫帮廣广廢废張张彈弹彌弥徑径徵征復复恆恒惡恶愛爱態态慶庆憂忧應应懷怀戀恋戲戏戶户據据擊击擁拥擇择擴扩攝摄敵敌數数斂敛暉晖暢畅曉晓條条楊杨榮荣構构槍枪樂乐標标樞枢樣样橫横檢检櫃柜歐欧歸归殺杀毀毁決决沒没滄沧淚泪淨净淺浅渦涡溫温滯滞漁渔潔洁潛潜澗涧濟济濱滨濺溅災灾烏乌煉炼爺爷牆墙犧牺狀状獄狱獨独獵猎現现瑣琐畢毕異异疊叠療疗盜盗盤盘眾众礎础禮礼禍祸禦御禪禅種种稱称穩稳窮穷競竞筆笔節节範范築筑簡简糾纠紅红納纳紋纹紗纱紛纷終终組组結结統统絲丝經经綠绿網网緣缘練练縱纵織织繞绕繼继纏缠罰罚義义習习聞闻聲声職职聽听肅肃脈脉腦脑腳脚艦舰艱艰藝艺薦荐號号蠻蛮衝冲補补裝装製制複复襲袭見见規规視视覺觉親亲覽览觸触計计訊讯討讨訓训記记許许設设證证評评詞词試试誠诚調调談谈請请論论諸诸謀谋謝谢識识護护讀读變变讓让豬猪貓猫貝贝負负貢贡貧贫責责賊贼資资賜赐賞赏賦赋質质賴赖贈赠趕赶趙赵躍跃車车軌轨軟软載载輕轻輸输轉转辦办迴回這这連连進进遊游運运過过達达違违遙遥遠远適适遲迟遷迁選选遺遗還还邏逻鄭郑醫医釋释裡里裏里針针鈴铃鋒锋錄录錯错鍵键鎖锁鏡镜鐘钟鑑鉴長长閃闪閉闭閑闲閒闲閘闸閱阅闊阔隊队際际隨随險险隱隐雜杂雙双離离難难靜静韓韩頂顶項项順顺須须預预頭头題题額额顏颜願愿類类顧顾顯显飛飞飯饭飲饮養养館馆驅驱驕骄驗验驚惊體体髮发鬥斗鬧闹魯鲁鮮鲜鯨鲸鷹鹰鹽盐麗丽黃黄點点齒齿龜龟凱凯奧奥賽赛瓊琼萊莱瓏珑紐纽約约夥伙劉刘閩闽贛赣臉脸盧卢瀨濑鄧邓蔣蒋馮冯譚谭鄒邹嚴严韋韦鍾钟費费賈贾陳陈吳吴蕭萧葉叶賀贺龔龚聶聂湯汤塗涂樸朴喬乔輿舆輔辅軸轴較较輯辑輩辈巔巅燦灿爛烂獻献瑤瑶璽玺畝亩瘋疯皚皑盞盏瞞瞒矯矫碼码磚砖祿禄禱祷穌稣窩窝竄窜竅窍絞绞綁绑綱纲綴缀緊紧緒绪線线締缔編编緩缓縛缚縫缝總总績绩繩绳繪绘繡绣纖纤罷罢羨羡聳耸膽胆臟脏興兴舉举艙舱蓋盖蔭荫蕩荡薈荟藍蓝蘆芦蘋苹虛虚虧亏蝕蚀螢萤蠟蜡覓觅訂订詐诈詢询該该誤误誘诱誰谁課课誼谊諜谍謎谜謠谣譜谱譯译豈岂豎竖豔艳貞贞貫贯販贩貪贪貸贷賄贿賠赔賢贤贊赞贏赢趨趋跡迹蹤踪軀躯輻辐轄辖轟轰辭辞遞递邁迈鄰邻醜丑釀酿鈞钧鉛铅銳锐鋪铺錦锦鍊炼鎧铠鏈链鑰钥鑽钻闖闯陣阵隴陇雖虽雞鸡韌韧韻韵響响頁页頌颂頗颇頓顿頻频顆颗颱台颶飓飄飘餅饼餓饿饒饶駐驻駕驾駭骇騎骑騰腾騷骚驟骤鬆松鬍胡鬱郁鳴鸣鴉鸦鴻鸿鵝鹅鶴鹤鷗鸥麼么齋斋龐庞頒颁佈布佔占彙汇採采';
const simplified = new Map<string, string>();
for (let i = 0; i + 1 < variants.length; i += 2) {
  simplified.set(variants[i], variants[i + 1]);
}
/** Fold traditional characters to simplified ones for matching only; the text shown is unchanged. */
export function foldChinese(text: string): string {
  let result = '';
  for (const char of text) {
    result += simplified.get(char) ?? char;
  }
  return result;
}

/**
 * Countries the player may read unpublished news of: the ones the player steers, and the ones the
 * player's location names (by country name or one of its keywords, traditional or simplified).
 */
export function insiders(state: State, location: string): string[] {
  const place = foldChinese(location);
  const inside = Object.values(state.countries)
    .filter((country) => country.enabled)
    .filter((country) =>
      [country.name, ...(country.keywords ?? [])]
        .map((word) => foldChinese(word.trim()))
        .some((word) => word.length >= 2 && place.includes(word)),
    )
    .map((country) => country.id);
  return [...new Set([...playerCountries(state), ...inside])];
}

/**
 * The news bar for a finished AI floor. `previous` is the bar of the AI floor before it and
 * `previousNews` that floor's card news; without a previous AI floor every field counts as new,
 * without a saved bar the times of unchanged fields stay unknown.
 */
export function buildNewsBar(input: {
  state: State;
  floor: number;
  time: string;
  location: string;
  newsPath: string;
  timePath?: string;
  locationPath?: string;
  news: unknown;
  previousNews?: unknown;
  hasPrevious: boolean;
  previous?: Partial<NewsBar>;
}): NewsBar {
  const fields = newsFields(input.news);
  const before = input.hasPrevious ? newsFields(input.previousNews) : {};
  const changed = Object.keys(fields).filter((key) => !input.hasPrevious || before[key] !== fields[key]);
  const updated: Record<string, string> = {};
  for (const key of Object.keys(fields)) {
    const known = input.previous?.updated?.[key];
    updated[key] = changed.includes(key) ? input.time : (known ?? '');
  }
  return {
    floor: input.floor,
    time: input.time,
    location: input.location,
    insiders: insiders(input.state, input.location),
    newsPath: input.newsPath,
    timePath: input.timePath,
    locationPath: input.locationPath,
    updated,
    changed,
  };
}

/** Story time as the card shows it; `世界.时间` is usually already a readable string. */
export function timeText(value: unknown): string {
  if (Array.isArray(value) && value.length && typeof value[0] !== 'object') {
    return String(value[0]);
  }
  return value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
}
