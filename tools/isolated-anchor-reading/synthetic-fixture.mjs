export const chapterIds=['opening','middle','ending'];
export const manuscripts={
  A:[{id:'opening',title:'门廊',body:'访客把伞靠在门边。\r\n\r\n“先留在这里。”店主说。'},{id:'middle',title:'柜台',body:'店主将备用钥匙收进抽屉。\n\n风铃响了一声。'},{id:'ending',title:'路口',body:'访客在路口停下，摸了摸空衣袋。'}],
  B:[{id:'opening',title:'门廊',body:'访客把伞靠在门边。\r\n\r\n“带走也可以。”店主说。'},{id:'middle',title:'柜台',body:'店主将备用钥匙留在柜台上。\n\n风铃响了一声。'},{id:'ending',title:'路口',body:'访客在路口停下，摸了摸空衣袋。'}]
};
const dims=['consequence_credibility','character_pressure','pacing','ending_force','causal_continuity'];
export function makeResponse(packet){
  const single=packet.mode==='single',versions=single?['X']:['A','B'];
  const evidence=packet.anchors.map((a,i)=>({id:'E'+(i+1),version:a.version,chapterId:a.chapterId,anchorId:a.anchorId,supports:'合成字段示例，是否支持主张仍需人工审查。'}));
  const idOf=anchorId=>evidence.find(e=>e.anchorId===anchorId).id;
  const bodyIds=(version,chapterId)=>packet.anchors.filter(a=>a.version===version&&a.field==='body'&&(!chapterId||a.chapterId===chapterId)).map(a=>idOf(a.anchorId));
  const all=versions.flatMap(v=>bodyIds(v));
  return {
    kind:single?'single_reading':'assisted_comparison',
    freeReading:'仅演示独立阅读的响应结构，不是实际文学评阅。',
    ...(!single?{textIdentity:packet.identity.identical?'identical':'different'}:{}),
    overall:{assessment:'合成示例保留不确定性。',...(!single?{preference:'no_clear_preference'}:{}),evidenceIds:all},
    dimensions:dims.map(id=>single?{id,assessment:'该维度需要人工判断。',evidenceIds:bodyIds('X')}:{id,A:{assessment:'不能凭锚点成立直接推论效果。',evidenceIds:bodyIds('A')},B:{assessment:'不能凭锚点成立直接推论效果。',evidenceIds:bodyIds('B')},comparison:'此处不把差异等同于改善。'}),
    chapterReadings:versions.flatMap(version=>packet.chapterIds.map(chapterId=>({...(!single?{version}:{}),chapterId,observation:'只记录当前提供章节的观察。',evidenceIds:bodyIds(version,chapterId)}))),
    ...(!single?{changeReadings:packet.differences.map(d=>({differenceId:d.differenceId,description:'这处精确定位包含文本或位置差异。',effect:'no_material_effect',assessment:'存在差异仍可能没有阅读改善。',counterReading:'另一种读法可能认为位置改变有影响。',evidenceIds:versions.flatMap(v=>(d[v].regionAnchorIds.length?d[v].regionAnchorIds:d[v].contextAnchorIds.slice(0,1)).map(idOf))}))}:{}),
    factualChecks:(single?['X','X','X']:['A','B','both','both']).map((scope,i)=>({id:'F'+(i+1),...(!single?{scope}:{}),kind:i===3?'inference':'observation',claim:'这是合成主张，不能据此作真实内容判断。',evidenceIds:scope==='both'?all:bodyIds(scope),uncertainty:'原句与主张的支持关系仍待人工核对。'})),
    counterReading:{assessment:'可对上述读感提出相反解释。',evidenceIds:all},
    evidence,
    scopeLimit:'只涉及chapterIds声明的章节范围；没有全稿验收结论。'
  };
}
