import type { AppState, Chapter, InspirationContext, LibraryItem, Mode, Project, StoryDirection } from './types';

/** All text below is the existing small frontend demo fixture, not production novel data. */
const clone = <T>(value: T): T => structuredClone(value);
export const emptyContext = (): InspirationContext => ({ character: '', world: '', plot: '', theme: '' });
export const directions: StoryDirection[] = [
  { id: 'letter', title: '未来来信', description: '拆迁前夜，她收到一个月后的自己寄来的信。信上只叮嘱她：雨停之前，别交出钥匙。', tag: '悬念 · 亲情' },
  { id: 'reader', title: '最后一位读者', description: '一家即将消失的书店里，陌生人归还了一本母亲从未登记借出的书，书页中夹着她的秘密。', tag: '人物 · 治愈' },
  { id: 'drawer', title: '蓝色抽屉', description: '母亲留下的抽屉锁了二十年。拆迁清单上的一行签字，让女儿第一次怀疑自己记住的往事。', tag: '家庭 · 反转' }
];

const demoChapters: Chapter[] = [
  {
    id: 'demo-chapter-1', title: '第一章　那封没有寄出的信',
    body: '傍晚六点，雨把书店门前的台阶洗成了深灰色。林晚回来交接钥匙，门缝里却卡着一只湿透的信封。收件人写的是她小时候的名字，那个名字，母亲去世后就再没人叫过。\n\n她在柜台上摊开信。纸上只有三行字：“明天，他们会来拆书店。雨停之前，别交出钥匙。先打开蓝色抽屉。”落款是林晚，邮戳的日期却在一个月以后。\n\n她把钥匙攥紧，指节渐渐发白。街对面的路灯亮了，她却没有往前走。信末有一个习惯性的停笔，最后一横总会微微往上翘；她低头看了看自己刚签完的交接单，两处笔迹像从同一支笔里长出来的。'
  },
  {
    id: 'demo-chapter-2', title: '第二章　蓝色抽屉',
    body: '柜台最下面的抽屉早已褪了色。林晚小时候问过里面放着什么，母亲说是不好看的账，没必要看。她把钥匙一把把试过去，最后用那把没有标签的小钥匙转开了锁。\n\n里面没有钱，也没有借据。只有一盘磁带、一本借阅簿和一张折成四折的旧平面图。磁带侧面贴着母亲的字：“留给晚晚，等她愿意听的时候。”\n\n借阅簿的最后一页，记着一笔与书无关的东西：“五月十七日，向自己借三十天。”归还日期空着。林晚摸过那行字，忽然想起母亲住院前，曾让她替书店买一台新的录音机；她当时忙着赶回公司，答应完就忘了。'
  },
  {
    id: 'demo-chapter-3', title: '第三章　借来的声音',
    body: '修钟的周叔还没收摊。他把磁带翻来覆去看了两遍，从柜子深处取出一台旧录音机。电池盖坏了，用一圈透明胶带固定着。他说，林晚的母亲最后来修它时，带了两盒新电池。\n\n“她想把书店留下来？”林晚问。周叔没有答，只指了指卷帘门外被雨压低的灯牌：“你先听完，再替她说话。”\n\n磁带转起来，先是一段空白，然后是母亲清嗓子的声音。“晚晚，如果你正在找一份让我替你决定的答案，这里面没有。”窗外有人推车经过，水声盖住了后半句话。林晚猛地按下暂停，仿佛只要磁带不再转，母亲就还坐在那段没说完的沉默里。'
  },
  {
    id: 'demo-chapter-4', title: '第四章　签字的人',
    body: '第二天八点，交接人员准时来了。林晚说自己还要整理些东西，对方递来一份复印件，让她核对柜台和书架的数量。她顺着清单往下看，在最末一页看到了母亲的签名。\n\n日期是母亲入院前两周。那时林晚还在电话里劝她别太固执，为守住这间小店把自己的日子也关了进去。母亲只说：“你忙你的，我这里有安排。”\n\n她一直以为母亲至死都不愿意离开。可复印件上写得清楚：书店可以腾退，店里的旧书须先完成捐赠交接。附页的接收地址，是林晚工作的城市。'
  },
  {
    id: 'demo-chapter-5', title: '第五章　她原本要去的地方',
    body: '林晚把门关上，重新按下播放键。母亲的声音断断续续地响着：“我去看过你住的那条街，早餐店的包子太咸，门口的树倒是很好。我本来想，搬过去以后，早上可以一起吃饭。”\n\n“这间店让我有地方站着，也让我好多年没往外走。我喜欢它，但不是每一件喜欢的东西，都得守到最后一天。”母亲笑了一下，像是怕这句话太郑重，又补了一句：“那张摇椅别扔，我还要坐的。”\n\n磁带末尾，母亲说了一个小小的请求：把借阅簿上没还的书都划掉。有人搬了家，有人过世了，有人实在喜欢那本书。她不想别人为了归还一本早就忘记的书，专门赶回来道歉。'
  },
  {
    id: 'demo-chapter-6', title: '第六章　不再追讨的书',
    body: '林晚在门上贴了一张手写纸：“今天开门，旧书免费带走。借阅不用归还。”先来的是住楼上的小学生，后来是早餐店老板，最后连从前总在门口避雨的快递员也进来翻了两页。\n\n周叔替她拆下墙上的钟，问她要把书送去哪里。林晚摊开那张旧平面图，才看明白母亲圈出的不是新店铺，而是社区活动室里靠窗的一段墙。两排书架，一张长桌，旁边还认真画着摇椅的尺寸。\n\n她照着接收单拨出电话。对面的人说已经等了很久，以为书店不打算来了。林晚看着空出一半的书架，说：“会来的。我想先去看看窗户朝哪边。”'
  },
  {
    id: 'demo-chapter-7', title: '第七章　雨停之前',
    body: '下午的雨忽然大了。后窗漏水，几箱打包好的书靠墙放着，很快湿了纸角。林晚和周叔把箱子往外挪，搬最后一箱时，柜台底下翘起的铁皮划过她的右手，一道细小的口子横在拇指根部。\n\n她用纸巾按住伤口，忽然停下来。未来的信里夹着一张照片：搬空的书店门口，一只手托着那把钥匙。那只手的同一个地方，也有一道短短的疤。\n\n五点四十，雨声慢慢收了。林晚把摇椅搬上车，最后一次回到柜台前。她没有找到另一封解释一切的信，只在借阅簿的空白处写下：“五月十七日，归还。”随后合上门，把钥匙放进等在门口的掌心。'
  },
  {
    id: 'demo-chapter-8', title: '第八章　一个月以后',
    body: '新书架安在社区活动室的西窗下。傍晚有人下班后来坐一会儿，孩子们把借阅卡画得五颜六色。林晚每周来两个晚上，有时忙不过来，就请楼下的阿姨帮忙开门。\n\n她终于没有把生活重新塞回另一间必须独自守住的书店。母亲的摇椅靠在窗边，谁累了都可以坐。椅子有点响，她打算下次带把螺丝刀来；这一次，她记进了手机。\n\n月底整理纸箱时，林晚又看见那只信封。信纸背面压着自己的旧地址，邮戳日期正是今天。她盯了很久，取出一张白纸，把记得的三句话写上去。写最后一横时，拇指根部那道快要愈合的疤微微发紧。'
  },
  {
    id: 'demo-chapter-9', title: '第九章　下一页',
    body: '邮筒就在街角。林晚走到跟前，却没有立刻松手。她想补一句“别怕”，又觉得那时的自己不会相信；想告诉她母亲已经安排好了去处，又怕她因此不肯再认真听那盘磁带。\n\n最后，她把信投了进去。它会不会真的抵达一个月前，她并不知道。她只是忽然明白，自己可以写出一封没有替别人决定结局的信，即使收信人就是自己。\n\n手机响了，是活动室的孩子问书架上的空位留给谁。林晚抬头，云缝里透出很浅的一点光。“留给下一本书。”她说。街边积水还没干，她绕过去，向亮着灯的窗户走去。'
  }
];

export const premise = '演示故事方案｜《雨停之前》\n\n核心设定：母亲去世后，林晚在老书店拆迁前夜收到一个月后的自己寄来的信。来信要求她暂缓交出钥匙，打开一个蓝色抽屉。\n\n人物与冲突：林晚以为留下书店才是忠于母亲；母亲的磁带与亲笔签字，却揭示了另一种愿望。她需要决定，到底保存一间房子，还是让房子里发生过的连接继续。\n\n故事结构：未来来信 → 抽屉与录音 → 第四章签字反转 → 旧书告别 → 交出钥匙 → 社区书架 → 寄回那封信。\n\n叙述约束：第三人称贴近林晚；用物件和动作承载情绪；保留来信的奇异感，不展开时间旅行规则。本方案为固定前端演示素材。';
export const turn = '第四章转折｜签字的人\n\n林晚坚持拖延书店交接，却发现母亲生前已经亲自同意腾退。附页显示，她把旧书的去处安排在女儿工作的城市。\n\n本章落点：“接收地址，是林晚工作的城市。”\n\n这个发现将故事从“替母亲守住书店”推向“重新认识母亲未说完的愿望”。后续通过录音逐步解释，不在此处一次揭开全部答案。此为固定演示节点。';

export function makeChapters(): Chapter[] {
  // Intentionally deterministic sample text; this prototype never calls a model.
  return clone(demoChapters);
}

export function createInitialState(): AppState {
  const now = new Date();
  const date = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
  const defaults = (): Omit<Project, 'id' | 'title' | 'idea'> => ({ docExpanded: false, libraryIds: [], styleId: null, attachments: [], draftInput: '', mode: 'light', phase: 'direction', status: 'draft', messages: [], chapters: [], versions: [], pendingEdits: [], docOpen: false, docClosedByUser: false, selectedChapter: 0, docMode: 'read', compare: 'after', updatedAt: date(0), context: emptyContext() });
  const mainChapters = makeChapters();
  const firstDraft = makeChapters();
  firstDraft[0].body = firstDraft[0].body.replace('她把钥匙攥紧，指节渐渐发白。街对面的路灯亮了，她却没有往前走。', '她觉得很害怕，也很想念母亲。街对面的路灯亮了，她站在原地，不知道该怎么办。');
  const otherChapters = [
    { id: 'tide-chapter-1', title: '第一章　停航通知', body: '渡船停航的通知贴出来时，岛上的风还不算大。许舟收起售票窗后的零钱盒，发现里面多了一张没有盖章的船票，目的地是一座早已更名的小岛。\n\n票背面写着父亲的名字。父亲失踪那年，许舟还够不到这个窗口。他把船票塞进胸前的口袋，第一次没有准时落下铁闸。' },
    { id: 'tide-chapter-2', title: '第二章　灯塔有人', body: '退休的船长说，那条航线最后一班船从没开出去，所有售出的票都退了。许舟问为什么还会剩下一张，船长端着茶杯，望向海上沉下去的灯。\n\n“因为有个人买它，不是为了离开。”他说。许舟走出屋时，废弃灯塔的窗户忽然亮了一下。天还没有完全黑，那点光却像一直在等他看见。' }
  ];
  return {
    schemaVersion: 1, attachments: [], page: 'create', activeProjectId: null, homeIdea: '', homeMode: 'light', context: emptyContext(), quote: '', selectedLibrary: [], selectedStyle: null,
    settings: { reduceMotion: false, fontSize: 18, autoSave: true },
    account: { name: '林晚', email: 'linwan@example.com', signedIn: true },
    projects: [
      {
        ...defaults(), id: 'project-rain', title: '雨停之前', idea: '写一个悬念与亲情交织的故事：年轻女人在已故母亲的书店拆迁前夜，收到未来的自己寄来的信。', mode: 'pro', phase: 'complete', status: 'ready', docOpen: true,
        messages: [
          { role: 'user', text: '我想写一个关于母亲和旧书店的故事。女主在拆迁前夜，收到未来的自己寄来的信。结尾想要有希望，但不要直接讲道理。' },
          { role: 'assistant', text: '可以把那封信当作悬念的入口，把“母亲真正想留下什么”作为情感核心。这份演示选择了“未来来信”方向。' },
          { role: 'user', text: '保留第四章发现母亲已经签字的转折。情绪尽量通过动作和物件表达。' },
          { role: 'assistant', text: '九章演示稿已经整理好。你可以在右侧阅读、直接编辑，或选中一段后把修改想法发给我。当前文字为本地固定演示素材。' }
        ],
        chapters: mainChapters,
        versions: [
          { id: 'rain-version-1', label: '初稿', date: date(2), chapters: firstDraft },
          { id: 'rain-version-2', label: '情绪描写调整', date: date(0), chapters: clone(mainChapters) }
        ],
        context: { character: '林晚，28岁，离乡工作的女儿；已故母亲经营一间旧书店。', world: '当代沿海小城，雨季，一条即将改造的旧街。', plot: '未来来信 → 母亲录音 → 拆迁签字反转 → 旧书迁移 → 寄信闭环。', theme: '告别与继续：关系可以在地点消失后延续。' }
      },
      {
        ...defaults(), id: 'project-tide', title: '潮汐档案', idea: '渡船管理员在停航前，找到一张写着失踪父亲名字的旧船票。', mode: 'light', phase: 'opening', status: 'ready', updatedAt: date(1), docOpen: true,
        messages: [{ role: 'user', text: '想从一张不应该存在的船票开始写，带一点海岛悬疑的感觉。' }, { role: 'assistant', text: '这里保留了两章本地示例开篇，可以继续编辑，或用它练习版本比较。后续生成操作将使用统一的《雨停之前》演示稿。' }],
        chapters: clone(otherChapters), versions: [{ id: 'tide-version-1', label: '开篇示例', date: date(1), chapters: clone(otherChapters) }]
      },
      {
        ...defaults(), id: 'project-birds', title: '候鸟不回信', idea: '退休邮递员决定替一封无法投递的信，走完收件人离开的路线。', mode: 'light', updatedAt: date(3),
        messages: [{ role: 'user', text: '先记一个念头：一位退休邮递员，替一封没有地址的信找人。想写得有点轻盈。' }, { role: 'assistant', text: '这个想法已保存在本机。可以继续补充人物、场景与情绪，再选择下一步的创作方向。' }]
      }
    ],
    library: ([
      { id: 'library-rain', title: '雨巷来信 · 个人短篇', type: '小说', content: '晚上九点，最后一家修鞋铺关了灯。她站在檐下，把那封拆过的信重新折好。纸上有一道旧折痕，怎么压也压不平。\n\n她没有再打那个电话，只把伞留在门边。第二天早晨，伞还在，水已经干了。\n\n这是一段用于演示个人写作资料管理的虚构样文。', chars: 0, status: 'ready', date: date(8), tags: ['动作叙事', '留白'] },
      { id: 'library-bookstore', title: '旧书店的物件清单', type: '素材', content: '蓝色抽屉：柜台最下层，油漆褪成灰蓝色，钥匙没有标签。\n摇椅：扶手被磨得发亮，右侧螺丝松动，会发出很轻的吱呀声。\n借阅簿：牛皮纸封面，用不同颜色的笔补过页码。\n录音机：电池盖损坏，透明胶带固定，播放时有细小的机械底噪。', chars: 0, status: 'ready', date: date(6), tags: ['场景', '物件'] },
      { id: 'library-lin', title: '林晚 · 人物小传', type: '设定', content: '林晚，28岁，在外地工作。习惯先安排好事情，再处理自己的感受。母亲去世后，她把许多未说出口的话折成日程表和待办事项。\n\n小动作：紧张时捏钥匙；不愿回答时整理桌面。\n人物变化：从替母亲守住一个地点，到理解母亲希望她继续生活。\n避免：用长篇自白一次解释她的全部动机。', chars: 0, status: 'ready', date: date(4), tags: ['人物', '成长'] }
    ] satisfies LibraryItem[]).map(item => ({ ...item, chars: Array.from(item.content).length })),
    styles: [
      { id: 'style-quiet', name: '克制的日常', description: '让物件、动作和停顿承载人物的情绪。', sourceIds: ['library-rain'], traits: ['动作承载情绪', '日常物件', '留白结尾'], rules: '优先写人物做了什么，再写她注意到了什么。减少直接命名情绪。允许对话保留未说完的意思。结尾落在一个具体动作上。', active: true, date: date(5) },
      { id: 'style-suspense', name: '缓慢揭示', description: '用一个小小的不协调开启悬念，逐章补全信息。', sourceIds: ['library-bookstore', 'library-lin'], traits: ['物件线索', '有限视角', '章节悬念'], rules: '使用第三人称有限视角。每章只推进一条关键线索。反转应能回指前文细节。避免用解释性独白一次揭开谜底。此风格卡是可编辑的演示内容。', active: false, date: date(2) }
    ]
  };
}



/** Make a project only; the calling UI decides when to run the demo generation timer. */
export function createProject(idea: string, mode: Mode = 'light'): Project {
  const now = new Date().toISOString();
  return {
    id: createId('project'), title: '未命名的故事', idea: idea.trim(), mode,
    phase: mode === 'pro' ? 'premise' : 'direction', status: 'draft',
    messages: [
      { id: createId('message'), role: 'user', text: idea.trim(), date: now },
      { id: createId('message'), role: 'assistant', text: '一个故事的起点，已经有了。我们先找到它最值得被讲述的那一面。\n\n这是交互演示：我会用预置故事《雨停之前》，带你体验从灵感到成稿的完整过程。', date: now },
    ],
    chapters: [], versions: [], pendingEdits: [], docOpen: false, docClosedByUser: false,
    docExpanded: false, docMode: 'read', compare: 'diff', selectedChapter: 0,
    updatedAt: now, context: emptyContext(), libraryIds: [], styleId: null,
    attachments: [], draftInput: '', extraIdeas: [], paused: false,
  };
}

export function createId(prefix = 'item'): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}
