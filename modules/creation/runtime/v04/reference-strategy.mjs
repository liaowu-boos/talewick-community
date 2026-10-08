/** Mechanisms describe evidence relations, not a replacement for the current story problem.
 * New selections carry a bounded problem; legacy selections retain their actual user quote.
 */
export const REFERENCE_STRATEGIES = Object.freeze({
  reinterpret_past_action: {
    description: '同一人物在获得新信息后，重新理解另一人过去的行为；不预定原来是误解，也不预定原谅。',
    question: '同一人物对另一人过去行为的理解如何在新信息出现后发生变化，文本如何连接原有理解、新信息与新的理解？',
    evidenceNeeds: ['同一人物在新信息出现前后对另一人过去行为的理解，以及新信息与理解变化之间可定位的文本联系。'],
    contextNeeds: ['足以辨认原有理解、新信息及后续理解的前因与前后文；心理、叙述、对话或行动均可作为证据。'],
  },
  emotion_development: {
    description: '情绪如何随人物的经历、理解或感受发展，保留触发与前后状态的联系。',
    question: '文本如何呈现同一人物的情绪随经历、理解或感受发展，怎样连接触发因素与前后情绪状态？',
    evidenceNeeds: ['同一人物可定位的前后情绪状态，以及使其发展或转变的经历、理解或感受之间的联系。'],
    contextNeeds: ['理解情绪起点与变化所需的前因和前后文；内心描写、叙述、对话与行动均可，不预定情绪方向。'],
  },
  motive_expression: {
    description: '人物已有欲望、顾虑或动机怎样通过具体表达让读者理解，而不是只贴性格标签。',
    question: '文本如何把人物的欲望或顾虑与其表达联系起来，使读者能够理解表达背后的动机？',
    evidenceNeeds: ['同一人物的欲望或顾虑与其表达之间有可定位的文本联系，而不只是分析者给出的性格标签。'],
    contextNeeds: ['判断动机与表达联系所需的情境；心理描写、叙述、对白与行动均可，不要求刻意隐瞒或外部动作。'],
  },
  setup_payoff: {
    description: '同一细节、承诺或意象如何在前后出现时形成可辨认的回应。',
    question: '叙事中的细节、承诺或意象如何在后文得到回应，前后文本如何建立这一联系？',
    evidenceNeeds: ['同一细节、承诺或意象的前文铺设、后文回应及二者之间有文本依据的联系。'],
    contextNeeds: ['足以理解铺设与回应的前后语境；不预定结局、情绪方向或是否反转。'],
  },
});
const sourceAt=(request,path)=>({'/idea':request?.idea,'/instruction':request?.instruction,'/context/instruction':request?.context?.instruction})[path];
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&JSON.stringify(Object.keys(x).sort())===JSON.stringify([...keys].sort());
const text=(x,n)=>typeof x==='string'&&x.length>0&&x.length<=n&&x===x.trim();
export function validateStoryProblem(value) {
  if (!exact(value, ['relationship', 'trigger', 'desiredEffect', 'constraints'])
    || !['relationship', 'trigger', 'desiredEffect'].every(k => text(value[k], 80))
    || !Array.isArray(value.constraints) || value.constraints.length > 3
    || !value.constraints.every(s => text(s, 80)) || new Set(value.constraints).size !== value.constraints.length)
    throw Error('storyProblem 须含当前 relationship、trigger、desiredEffect（各1–80字符）和 constraints（0–3条，每条1–80字符）；未知须明确写未知，不推定剧情');
  return structuredClone(value);
}
export function compileReferenceStrategy(value,request) {
  const hasProblem = value?.storyProblem !== undefined;
  if(!exact(value,['status','mechanism','basis','quote','reason',...(hasProblem?['storyProblem']:[])])||value.status!=='selected'||!Object.hasOwn(REFERENCE_STRATEGIES,value.mechanism)||!text(value.quote,240)||!text(value.reason,400))throw Error('invalid reference strategy');
  const source=sourceAt(request,value.basis);
  if(!text(value.basis,64)||typeof source!=='string'||!source.includes(value.quote))throw Error('reference strategy quote is not current instruction');
  const selected=REFERENCE_STRATEGIES[value.mechanism];
  const problem = hasProblem ? validateStoryProblem(value.storyProblem) : null;
  const referenceQuestion = problem
    ? `当前关系：${problem.relationship}；触发：${problem.trigger}；希望呈现：${problem.desiredEffect}；迁移限制：${problem.constraints.join('、') || '未指定'}。${selected.question}`
    : value.quote.length + selected.question.length + 10 <= 240
      ? `本篇需要：${value.quote}。${selected.question}` : value.quote;
  if (referenceQuestion.length > 240) throw Error('具体参考问题超过240字符；压缩 storyProblem，不能退回通用模板或截掉限制');
  return {referenceQuestion,referenceIntent:{purpose:'expression',basis:[value.basis],evidenceNeeds:[...selected.evidenceNeeds],contextNeeds:[...selected.contextNeeds]},
    selection:{...structuredClone(value),origin:problem?'model_selected_story_problem':'model_selected_program_template',verification:'literal_quote_only_mechanism_fit_requires_review'}};
}
export function strategySelectionInput(request) {
  return {userInstructions:['/idea','/instruction','/context/instruction'].map(path=>({path,text:sourceAt(request,path)})).filter(x=>typeof x.text==='string'&&x.text.trim()),mechanisms:Object.entries(REFERENCE_STRATEGIES).map(([id,v])=>({id,description:v.description}))};
}
export const REFERENCE_STRATEGY_CONTRACT = `表达参考可以使用以下已定义机制：${JSON.stringify(Object.entries(REFERENCE_STRATEGIES).map(([id,v])=>({id,description:v.description})))}。
若当前最需要的参考关系与其中一项直接对应，在同一需求JSON中输出referenceStrategy={"status":"selected","mechanism":"对应id","basis":"当前原指令字段路径","quote":"该字段中支持选择的连续原句，1–240字符","reason":"选择依据，1–400字符","storyProblem":{"relationship":"当前谁与谁相互需要或冲突，或人物与自身处境的关系","trigger":"本次打破原状态的具体经历或信息","desiredEffect":"本题希望呈现的情绪、理解或表达难点","constraints":["迁移到本篇时需保留的限制"]}}。只允许这六键，字符串trim。storyProblem前三项各1–80字符，constraints为0–3条各1–80字符；整体尽量控制在130字符内，编译后的主问题仍不得超过240字符。程序保留这些具体内容生成referenceQuestion和referenceIntent，因此同时省略referenceQuestion、referenceIntent与retrievalHints。
同一机制不等于同一问题。提炼关系、触发及表达难点，不能只填“情绪发展”“发生变化”；勿靠替换职业、人名使泛化问题看似不同。不虚构需求未说明的触发、情绪方向或结局；确实未知写明未知，没有具体需要则省略策略。constraints是目标使用边界，不要求来源拥有同一职业、人名或道具；若用户正在研究特定身份关系本身则保留。不强制每题经历误解、忍耐、爆发、和解，也不强制认知变化一定导致行动。
选择依据只能来自当前/idea、/instruction或/context/instruction；不是从旧稿推测用户意图。逐字引用只证明来源，仍须判断机制真正适配。不得因表达类型接近而强行选择：若用户研究特定身份、对象或文体本身且模板会遗漏该条件，或要求事实、指标或其他未覆盖机制，省略referenceStrategy并按原有referenceQuestion/referenceIntent协议保留其具体需要；没有参考需要时全部省略。不得因模板可用而改变用户的目的。新作的人物、设定、时间、因果、篇幅及结局要求仍完整写入原有需求字段。`;
export const STRATEGY_SELECTION_SYSTEM=`为本次小说创作选择当前最需要借鉴的一个表达机制。只依据userInstructions，不推定具体剧情答案。${REFERENCE_STRATEGY_CONTRACT} 独立选择时只返回referenceStrategy对象；若所需是事实/指标核验、未覆盖机制或没有具体需要，返回{"status":"unsupported","reason":"未覆盖的原需求及原因"}。不输出来源内容。`;
