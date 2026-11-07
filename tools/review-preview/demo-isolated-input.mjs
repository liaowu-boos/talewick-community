// A wholly synthetic partial archive. No provider calls or real reviewer judgments.
import {buildReadingPlan, sha256, validateResponse} from '../isolated-anchor-reading/review-tools.mjs';
import {chapterIds, manuscripts, makeResponse} from '../isolated-anchor-reading/synthetic-fixture.mjs';

export function createDemoInput() {
  const plan = buildReadingPlan({chapterIds, manuscripts});
  const evidence = new Map();
  function put(id, value) {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    evidence.set(id, {bytes, entry: {id, sha256:sha256(bytes)}});
    return id;
  }
  function get(id) {
    const record = evidence.get(id);
    if (!record) throw new Error('Unknown fixture evidence ID');
    return {bytes:Buffer.from(record.bytes), entry:{...record.entry}};
  }
  const requests = plan.requests.map(({requestId, packet, packetSHA256}) => {
    if (requestId === 'C1') return {requestId};
    let raw;
    if (requestId === 'S1') {
      raw = '合成示例：回包止于此处，未形成 JSON。';
    } else {
      const response = makeResponse(packet);
      const opening = packet.anchors.find(a => a.field === 'body' && a.chapterId === 'opening');
      const citation = response.evidence.find(e => e.anchorId === opening.anchorId);
      response.factualChecks[0] = {...response.factualChecks[0],
        claim:'访客在结尾拿走了柜台上的钥匙。', evidenceIds:[citation.id]};
      raw = JSON.stringify(response);
    }
    const rawId = put(requestId.toLowerCase() + '-raw', raw);
    const inspectionId = put(requestId.toLowerCase() + '-check', validateResponse({
      packet, expectedPacketSHA256:packetSHA256, raw, expectedRawSHA256:sha256(raw),
    }));
    const row = {requestId, rawId, inspectionId};
    if (requestId === 'S2') row.semanticReviewId = put('s2-human-example', {
      schemaVersion:'isolated-reading-semantic-review-2', planSHA256:plan.planSHA256,
      packetSHA256, requestId, rawSHA256:sha256(raw), fullManuscriptAccepted:false,
      status:'failed', scope:'合成复核示例，仅针对第一条事实主张',
      summary:'引文只写访客把伞靠在门边，没有写他取走钥匙。结尾摸空衣袋也不能证明拿走；这条主张没有得到所引原句支持。',
    });
    return row;
  });
  return {plan, expectedPlanSHA256:plan.planSHA256, manifest:{planSHA256:plan.planSHA256, requests},
    get, ref:id=>({id, sha256:get(id).entry.sha256})};
}
