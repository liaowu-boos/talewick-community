// Synthetic public protocol fixture, not a private manuscript or provider response.
export default {
  "schemaVersion": "cross-chapter-protocol-protection-case-1",
  "caseId": "deictic-role-relative-time-minimal-groups-1",
  "purpose": "Generic non-domain-specific protection fixture for retrospective actor roles, relative dates, immediate deixis, atomic claims, minimal grouping, and host evidence location.",
  "boundary": "This fixture tests protocol wording, compact response shape, and exact host location only. Passing it is not a semantic-quality judgment and does not prove a model will detect every conflict.",
  "manuscript": {
    "id": "generic-ledger-protection-1",
    "chapters": [
      {
        "id": "g1",
        "title": "请求",
        "body": "周一上午，仓库主管说：“现在打开东门。”检查员回答：“我先核对清单，明天再开。”当日清单还记着：上周旧轮次清点了三件货。"
      },
      {
        "id": "g2",
        "title": "回顾",
        "body": "周二上午，值班表写着：记录从昨天上午开始，到现在正好一天。检查员回顾说：“前天主管不让我打开东门。”"
      },
      {
        "id": "g3",
        "title": "即时复核",
        "body": "本轮复核时，屏幕显示四件，检查员也在表上写下“本轮四件”。客户随即问：“刚才不是点完了吗？”检查员回答：“刚才只有三件。”没有开始新的复核轮次。"
      }
    ]
  },
  "compactExtractionResponse": {
    "schemaVersion": "cross-chapter-extraction-compact-1",
    "chapterCoverage": [
      {
        "chapterId": "g1",
        "extractionNote": "核对请求者、拒绝者、原事件日期与旧轮次记录。"
      },
      {
        "chapterId": "g2",
        "extractionNote": "核对回顾中的施事、否定和相对日期。"
      },
      {
        "chapterId": "g3",
        "extractionNote": "核对当前轮次、刚才指代和即时数量断言。"
      }
    ],
    "comparisons": [
      {
        "dimension": "actor",
        "subject": "东门开启请求",
        "aspect": "主管是要求开启还是阻止开启",
        "rationale": "事后回顾中的施事、否定和动作需要与原请求对照。",
        "claims": [
          {
            "chapterId": "g1",
            "quote": "仓库主管说：“现在打开东门。”",
            "value": "主管要求检查员打开东门",
            "timeScope": "周一上午",
            "eventRound": "原请求",
            "epistemic": "narrated_fact"
          },
          {
            "chapterId": "g2",
            "quote": "检查员回顾说：“前天主管不让我打开东门。”",
            "value": "检查员回顾主管阻止自己打开东门",
            "timeScope": "周二上午的回顾",
            "eventRound": "原请求回顾",
            "epistemic": "dialogue_claim"
          }
        ]
      },
      {
        "dimension": "time",
        "subject": "东门请求日期",
        "aspect": "回顾所指请求距周二上午几天",
        "rationale": "相对日期必须同时对照本章时间锚和原事件。",
        "claims": [
          {
            "chapterId": "g1",
            "quote": "周一上午，仓库主管说：“现在打开东门。”",
            "value": "原事件发生在周一上午",
            "timeScope": "周一上午",
            "eventRound": "原请求",
            "epistemic": "narrated_fact"
          },
          {
            "chapterId": "g2",
            "quote": "周二上午，值班表写着：记录从昨天上午开始，到现在正好一天。",
            "value": "回顾所在章节当前为周二上午，周一是昨天",
            "timeScope": "周二上午",
            "eventRound": "章节时间锚",
            "epistemic": "narrated_fact"
          },
          {
            "chapterId": "g2",
            "quote": "检查员回顾说：“前天主管不让我打开东门。”",
            "value": "回顾把原请求标成前天",
            "timeScope": "周二上午的回顾",
            "eventRound": "原请求回顾",
            "epistemic": "dialogue_claim"
          }
        ]
      },
      {
        "dimension": "count",
        "subject": "当前复核轮次的件数",
        "aspect": "刚才完成的当前轮次记录了几件",
        "rationale": "刚才的回答必须与紧邻的当前轮次屏幕记录组成最小对照，不能跳回上周旧轮次。",
        "claims": [
          {
            "chapterId": "g3",
            "quote": "屏幕显示四件",
            "value": "当前轮次四件",
            "timeScope": "本轮复核时",
            "eventRound": "当前轮次",
            "epistemic": "narrated_fact"
          },
          {
            "chapterId": "g3",
            "quote": "检查员回答：“刚才只有三件。”",
            "value": "对刚才当前轮次报告三件",
            "timeScope": "客户随即提问后",
            "eventRound": "当前轮次即时回指",
            "epistemic": "dialogue_claim"
          }
        ]
      }
    ],
    "unpaired": []
  },
  "expectedProtocol": {
    "comparisonCount": 3,
    "claimCount": 7,
    "checkedChapterIds": [
      "g1",
      "g2",
      "g3"
    ],
    "reusedQuote": "检查员回顾说：“前天主管不让我打开东门。”",
    "hostMustLocateEveryQuote": true,
    "hostMustNotInferStatus": true
  }
};
