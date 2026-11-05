export const manuscripts = {
  A:[{id:'ch-1',title:'雨后',body:'访客把账本留在柜台上。\n\n门外的雨已经停了。'},{id:'ch-2',title:'交班',body:'值班人收回了备用钥匙，访客退到门边。\n\n他听见里屋有人叫自己的名字。'},{id:'ch-3',title:'路口',body:'访客把空绳圈塞进衣袋，走到路口。'}],
  B:[{id:'ch-1',title:'雨后',body:'访客把账本留在柜台上。\n\n门外的雨已经停了。'},{id:'ch-2',title:'交班',body:'值班人只看了他一眼，说晚些时候再谈。\n\n他听见里屋有人叫自己的名字。'},{id:'ch-3',title:'路口',body:'访客在路口接到电话，备用钥匙明早交回。'}]
};
export function makeResponse() {
  const evidence=Object.entries(manuscripts).flatMap(([version,chapters])=>chapters.map((c,i)=>({id:version+(i+1),version,chapterId:c.id,quote:c.body.split('\n\n')[0],supports:'仅供离线格式测试，不能作为文学结论。'})));
  const pair=['A2','B2'];
  return {
    freeReading:['A','B'].map(version=>({version,overallImpression:'离线示例的整体观察。',progression:'阅读范围为三章。',strongestMoment:'留存动作带来停顿。',uncertainty:'无法据此判断前文。'})),
    overall:{assessment:'两种安排有取舍，样例不构成真实评阅。',preference:'tradeoff',evidenceIds:pair},
    counterReading:{assessment:'也可能读出相反的节奏效果。',evidenceIds:['A3','B3']},
    dimensions:['consequence_credibility','character_pressure','pacing','ending_force','causal_continuity'].map(id=>({id,A:{assessment:'需要结合上下文人工判断。',evidenceIds:['A2']},B:{assessment:'需要结合上下文人工判断。',evidenceIds:['B2']},comparison:'此处只演示字段。'})),
    chapterReadings:evidence.map(e=>({version:e.version,chapterId:e.chapterId,observation:'该章参与连续推进。',evidenceIds:[e.id]})),
    factualChecks:[{id:'F1',scope:'A',kind:'observation',claim:'文本出现钥匙被收回。',evidenceIds:['A2'],uncertainty:'动作之外的动机待核。'},{id:'F2',scope:'B',kind:'observation',claim:'文本出现晚些再谈。',evidenceIds:['B2'],uncertainty:'不能因此判定实际处分。'},{id:'F3',scope:'both',kind:'observation',claim:'两稿路口段的文字不同。',evidenceIds:['A3','B3'],uncertainty:'不同不等于优劣。'},{id:'F4',scope:'both',kind:'inference',claim:'动作可能形成不同压力。',evidenceIds:pair,uncertainty:'文学效果需由读者判断。'}],
    evidence,scopeLimit:'合成三章只验证工具，不代表真实稿件或全稿验收。'
  };
}
