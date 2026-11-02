// Local evidence annotations; no suitability verdicts and no source-file mutations.
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const DEEP_REFERENCE_EVIDENCE_NOTES = freeze([
  {
    "sourceId": "ad43085f-6922-40ee-af5e-2f9672532fd4",
    "functionId": "craft:CH3",
    "binding": {
      "sourceTextSha256": "5d24ab9b0cbec8e4fa25a32d4728fdc78700706534868c0d452020ed0544cdd7",
      "candidateSha256": "2021f27c04406e26c1d4a2246c4852fe6a3fa3e3b9c55f548b8d2645d22be6a9",
      "packetSha256": "aa30a397e5806932437c3a1bdf345490c9815d0b45948b09035bb8b41fce38e1",
      "reportSha256": "0bcbc37920355343d256e631fa4cb9da96d029f31325ad259725e7cc85268010",
      "functionSha256": "f2ecbaa53fc6887b222aea3f065a7c14442e3aa75fd1c21dcd77c09bd7c8a709"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent; frozen literal quotations from actual-family-r05 / actual-workplace-r04 query packets; local interpretation, not new independent semantic approval"
    },
    "fields": {
      "actor": {
        "value": "江景深的照顾行动、第一人称母亲的筹款、壮壮的选择须分别看待。",
        "anchors": [
          {
            "evidenceId": "EV-a349db2b4196cb0b9a9c215d",
            "quote": "江景深小心翼翼地扶住寡嫂"
          },
          {
            "evidenceId": "EV-a44c21cee2d091d5908f6e2d",
            "quote": "壮壮的小脑袋摇得像拨浪鼓"
          }
        ]
      },
      "acknowledgmentObject": {
        "value": "母亲承认的是孩子未来认父的选择权；不能混成江景深已充分承认母亲全部劳动。",
        "anchors": [
          {
            "evidenceId": "EV-217ead2133d631c79e953b0b",
            "quote": "至于他愿不愿意认你，那是他的选择，我尊重他。"
          }
        ]
      },
      "costBearer": {
        "value": "现场医药费不足由母亲筹钱面对，孩子面临治疗延误；不是只描写父亲悔恨。",
        "anchors": [
          {
            "evidenceId": "EV-a349db2b4196cb0b9a9c215d",
            "quote": "我这就去凑钱。"
          },
          {
            "evidenceId": "EV-a349db2b4196cb0b9a9c215d",
            "quote": "孩子这情况，真的拖不起了"
          }
        ]
      }
    },
    "limitations": [
      "技法功能包含多个行动者，不把他们的行动拼为同一人的心理转变。",
      "存在重生、疾病与长期离散前提；不直接迁移目标故事的事件。"
    ]
  },
  {
    "sourceId": "ad43085f-6922-40ee-af5e-2f9672532fd4",
    "functionId": "emotion:EP2:EP3",
    "binding": {
      "sourceTextSha256": "5d24ab9b0cbec8e4fa25a32d4728fdc78700706534868c0d452020ed0544cdd7",
      "candidateSha256": "2021f27c04406e26c1d4a2246c4852fe6a3fa3e3b9c55f548b8d2645d22be6a9",
      "packetSha256": "aa30a397e5806932437c3a1bdf345490c9815d0b45948b09035bb8b41fce38e1",
      "reportSha256": "0bcbc37920355343d256e631fa4cb9da96d029f31325ad259725e7cc85268010",
      "functionSha256": "9cfe1cd60dd44c9b28426945ba95dafc07e9c49957ff0af93dc6ed20922d9ff5"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent; frozen literal quotations from actual-family-r05 / actual-workplace-r04 query packets; local interpretation, not new independent semantic approval"
    },
    "fields": {
      "actor": {
        "value": "第一人称母亲（被称清音）；江景深提出补偿，孩子的选择另列。",
        "anchors": [
          {
            "evidenceId": "EV-e91026a6e84dcc4199f7b771",
            "quote": "清音，对不起，我……"
          },
          {
            "evidenceId": "EV-217ead2133d631c79e953b0b",
            "quote": "我和壮壮的人生，已经翻篇了。"
          }
        ]
      },
      "emotionalDirection": {
        "value": "拒收津贴、维持母子生活，至迟来忏悔时继续设界限；平静外观不证明内心没有波动。",
        "anchors": [
          {
            "evidenceId": "EV-e91026a6e84dcc4199f7b771",
            "quote": "他给的信封我没拆，原封不动寄回了部队。"
          },
          {
            "evidenceId": "EV-217ead2133d631c79e953b0b",
            "quote": "你的忏悔，你的补偿，你的积蓄，对我们而言早就没有意义了。"
          }
        ]
      },
      "acknowledgmentObject": {
        "value": "母亲明确承认壮壮认父与否的选择权，拒绝用补偿强迫关系修复。",
        "anchors": [
          {
            "evidenceId": "EV-217ead2133d631c79e953b0b",
            "quote": "至于他愿不愿意认你，那是他的选择，我尊重他。"
          },
          {
            "evidenceId": "EV-217ead2133d631c79e953b0b",
            "quote": "这些，你都拿回去吧。"
          }
        ]
      },
      "costBearer": {
        "value": "母亲回忆自己抱病儿走十里且只剩五毛；当下选择不收补偿。",
        "anchors": [
          {
            "evidenceId": "EV-e91026a6e84dcc4199f7b771",
            "quote": "我抱着他硬生生走了十里路去卫生所。"
          },
          {
            "evidenceId": "EV-e91026a6e84dcc4199f7b771",
            "quote": "我身上只有五毛钱"
          },
          {
            "evidenceId": "EV-217ead2133d631c79e953b0b",
            "quote": "这些，你都拿回去吧。"
          }
        ]
      }
    },
    "limitations": [
      "只支持边界行动与补偿被拒；没有证明隐形劳动已被所有人物理解。",
      "不把伤病、死亡、重生前提或原句移植进七天关店故事。"
    ]
  },
  {
    "sourceId": "ad43085f-6922-40ee-af5e-2f9672532fd4",
    "functionId": "psychology:PD3",
    "binding": {
      "sourceTextSha256": "5d24ab9b0cbec8e4fa25a32d4728fdc78700706534868c0d452020ed0544cdd7",
      "candidateSha256": "2021f27c04406e26c1d4a2246c4852fe6a3fa3e3b9c55f548b8d2645d22be6a9",
      "packetSha256": "aa30a397e5806932437c3a1bdf345490c9815d0b45948b09035bb8b41fce38e1",
      "reportSha256": "0bcbc37920355343d256e631fa4cb9da96d029f31325ad259725e7cc85268010",
      "functionSha256": "4c64331612906f0052af49dabb8766c886fc09a85a4fb31146adf32df618c545"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent; frozen literal quotations from actual-family-r05 / actual-workplace-r04 query packets; local interpretation, not new independent semantic approval"
    },
    "fields": {
      "actor": {
        "value": "江景深；此功能不是母亲或孩子的心理转变。",
        "anchors": [
          {
            "evidenceId": "EV-a13e09c6d9ae7be31b279499",
            "quote": "江景深低下头，双手互相用力搓着"
          }
        ]
      },
      "emotionalDirection": {
        "value": "从坚持照顾嫂子并责怪清音，转为自述无资格求原谅及后悔；内心因果仍是有限解释。",
        "anchors": [
          {
            "evidenceId": "EV-1ed1c5eb33c1907d70f30dfa",
            "quote": "我答应过要照顾你一辈子！"
          },
          {
            "evidenceId": "EV-1ed1c5eb33c1907d70f30dfa",
            "quote": "沈清音，你看看你把嫂子逼成什么样了？"
          },
          {
            "evidenceId": "EV-a13e09c6d9ae7be31b279499",
            "quote": "我知道我没资格求你原谅"
          }
        ]
      },
      "acknowledgmentObject": {
        "value": "江景深承认自己伤人的话、签声明离开和家庭损失；未完整展开母亲独自承担的所有代价。",
        "anchors": [
          {
            "evidenceId": "EV-a13e09c6d9ae7be31b279499",
            "quote": "是我说出那句伤人的话时"
          },
          {
            "evidenceId": "EV-a13e09c6d9ae7be31b279499",
            "quote": "是我签下那张声明"
          },
          {
            "evidenceId": "EV-a13e09c6d9ae7be31b279499",
            "quote": "我毁了我们的家"
          }
        ]
      },
      "costBearer": {
        "value": "他自述边防腿痛和失去家庭并称惩罚；这是自我解释，不是代价归属的客观全景。",
        "anchors": [
          {
            "evidenceId": "EV-a13e09c6d9ae7be31b279499",
            "quote": "边防那几年腿疼得想死的时候"
          },
          {
            "evidenceId": "EV-a13e09c6d9ae7be31b279499",
            "quote": "这是活该，是惩罚。"
          }
        ]
      }
    },
    "limitations": [
      "忏悔可能源于孤独、伤残与失去；不能等同充分理解照护者代价或持续承担。"
    ]
  },
  {
    "sourceId": "235a5c4f-573b-44f1-b623-2af4fb163401",
    "functionId": "psychology:PD1",
    "binding": {
      "sourceTextSha256": "993ebe8e6b180c2bf34ffb3b4ba5650b5298959f6fd28a1ff1926a0a2a8bcf61",
      "candidateSha256": "09a774c15eaef05e428955ba6146b120ee20600a54af29145d3e7968a064d722",
      "packetSha256": "a09e658dc2522e03ce5b82ff21b7b0d911b4c17c39bb81cd419919496a1686b4",
      "reportSha256": "1e44695b60389807e3eab0efc858a1e0ad1d775232a40f18d9b36a71f5ea45a7",
      "functionSha256": "c78b3b846631c134993d01b7aea04d90499a8bd69b34f0c5267060c37e914a86"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent; frozen literal quotations from actual-family-r05 / actual-workplace-r04 query packets; local interpretation, not new independent semantic approval"
    },
    "fields": {
      "actor": {
        "value": "第一人称聂世晨；江澄心与许诺飞是其他行动者。",
        "anchors": [
          {
            "evidenceId": "EV-9f146e600a3e72e91b85148f",
            "quote": "聂世晨，世界上怎么会有你这么恶心的人？"
          }
        ]
      },
      "emotionalDirection": {
        "value": "前世阻止输血保护对方，重生后让开并催促多抽，解释为放任、自保或报复；不是已证实的自认责任。",
        "anchors": [
          {
            "evidenceId": "EV-3e2bfbc6fa37e412a7db3e2c",
            "quote": "我拼死拦着"
          },
          {
            "evidenceId": "EV-9f146e600a3e72e91b85148f",
            "quote": "让开了输血的位置"
          },
          {
            "evidenceId": "EV-9f146e600a3e72e91b85148f",
            "quote": "自己种的恶果，必须自己亲口品尝才行。"
          }
        ]
      },
      "costBearer": {
        "value": "叙述者将恶果归给对方；前世自己遭害。不能等同主角主动承担自身过错后果。",
        "anchors": [
          {
            "evidenceId": "EV-3e2bfbc6fa37e412a7db3e2c",
            "quote": "女友联合同学将我绑架"
          },
          {
            "evidenceId": "EV-9f146e600a3e72e91b85148f",
            "quote": "自己种的恶果，必须自己亲口品尝才行。"
          }
        ]
      }
    },
    "limitations": [
      "复仇和恐惧份量不确定；疾病内容只是故事断言，不作现实医学陈述。",
      "承认自身责任这一字段没有足够本功能证据，保持unknown。"
    ]
  },
  {
    "sourceId": "235a5c4f-573b-44f1-b623-2af4fb163401",
    "functionId": "emotion:EP1:EP2",
    "binding": {
      "sourceTextSha256": "993ebe8e6b180c2bf34ffb3b4ba5650b5298959f6fd28a1ff1926a0a2a8bcf61",
      "candidateSha256": "09a774c15eaef05e428955ba6146b120ee20600a54af29145d3e7968a064d722",
      "packetSha256": "a09e658dc2522e03ce5b82ff21b7b0d911b4c17c39bb81cd419919496a1686b4",
      "reportSha256": "1e44695b60389807e3eab0efc858a1e0ad1d775232a40f18d9b36a71f5ea45a7",
      "functionSha256": "804bec0a6b6e540a065d63440887fea89b48cfa068a9400a53f35e85ce439378"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent; frozen literal quotations from actual-family-r05 / actual-workplace-r04 query packets; local interpretation, not new independent semantic approval"
    },
    "fields": {
      "actor": {
        "value": "第一人称聂世晨及逼近他的同学；不是许诺飞的恶意自白。",
        "anchors": [
          {
            "evidenceId": "EV-9f146e600a3e72e91b85148f",
            "quote": "聂世晨，世界上怎么会有你这么恶心的人？"
          },
          {
            "evidenceId": "EV-0b25978b8f517da7e41bac33",
            "quote": "同学们都一拥而上，死死按住我"
          }
        ]
      },
      "emotionalDirection": {
        "value": "从让开位置，至自己受直接身体威胁时恐惧、挣扎并报警求生。",
        "anchors": [
          {
            "evidenceId": "EV-9f146e600a3e72e91b85148f",
            "quote": "让开了输血的位置"
          },
          {
            "evidenceId": "EV-0b25978b8f517da7e41bac33",
            "quote": "我一身冷汗"
          },
          {
            "evidenceId": "EV-0b25978b8f517da7e41bac33",
            "quote": "我一脚踢在了紧急报警器上。"
          }
        ]
      },
      "costBearer": {
        "value": "这里直接面临风险的是叙述者自身；没有主动承担先前过错代价的说明。",
        "anchors": [
          {
            "evidenceId": "EV-0b25978b8f517da7e41bac33",
            "quote": "将那根被无数人用过的针头逼近我的血管。"
          }
        ]
      }
    },
    "limitations": [
      "报警是人物主动动作；不能仅因外部救援就断言无动机的外力解围。",
      "不能把求生反应等同承担责任。"
    ]
  },
  {
    "sourceId": "235a5c4f-573b-44f1-b623-2af4fb163401",
    "functionId": "craft:CH4",
    "binding": {
      "sourceTextSha256": "993ebe8e6b180c2bf34ffb3b4ba5650b5298959f6fd28a1ff1926a0a2a8bcf61",
      "candidateSha256": "09a774c15eaef05e428955ba6146b120ee20600a54af29145d3e7968a064d722",
      "packetSha256": "a09e658dc2522e03ce5b82ff21b7b0d911b4c17c39bb81cd419919496a1686b4",
      "reportSha256": "1e44695b60389807e3eab0efc858a1e0ad1d775232a40f18d9b36a71f5ea45a7",
      "functionSha256": "142f24a7f7c38f47d84bc1cc3bb9d8b7b1cc3242b8ac49a020580eb3ff89ca1d"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent; frozen literal quotations from actual-family-r05 / actual-workplace-r04 query packets; local interpretation, not new independent semantic approval"
    },
    "fields": {
      "actor": {
        "value": "许诺飞是自白者；聂世晨是被转指的人，不能合并角色。",
        "anchors": [
          {
            "evidenceId": "EV-94b04dab272fc0622d10db30",
            "quote": "许诺飞脸上只剩下惨白和慌乱"
          },
          {
            "evidenceId": "EV-94b04dab272fc0622d10db30",
            "quote": "聂世晨，我知道江澄心不要你了"
          }
        ]
      },
      "emotionalDirection": {
        "value": "表演委屈并否认，至恶意自白被公开；这是揭示反转，不是主角担责成长。",
        "anchors": [
          {
            "evidenceId": "EV-94b04dab272fc0622d10db30",
            "quote": "我明明从来没交过女朋友"
          },
          {
            "evidenceId": "EV-37ed4a2b6a7a885b506bd257",
            "quote": "我要你们所有人，都为我陪葬！"
          }
        ]
      },
      "acknowledgmentObject": {
        "value": "许诺飞承认要他人陪葬的恶意，非聂世晨承认自己的责任。",
        "anchors": [
          {
            "evidenceId": "EV-37ed4a2b6a7a885b506bd257",
            "quote": "我要你们所有人，都为我陪葬！"
          }
        ]
      },
      "costBearer": {
        "value": "他把后果施加于同学群体；故事叙述的疾病断言未经现实验证。",
        "anchors": [
          {
            "evidenceId": "EV-37ed4a2b6a7a885b506bd257",
            "quote": "我要你们所有人，都为我陪葬！"
          }
        ]
      }
    },
    "limitations": [
      "恶意自白与承担责任方向不同；本卡不据此自动输出inapplicable。"
    ]
  },
  {
    "sourceId": "0789aca8-8225-4607-a6f4-d0a9c3be9dc2",
    "functionId": "emotion:EP1:EP2",
    "binding": {
      "sourceTextSha256": "a70579db025cb6cfec3c9eba5047347bc1b2042e4a75ff919329143a96e8cf98",
      "candidateSha256": "b283afa70011508629effe7576c6e738ff2f77009811fe61a0799a7dc9e00bc3",
      "packetSha256": "57a20fcf677076a3249e3c935429c6294b7f5f24acf6e2ebef7c65e87fe44201",
      "reportSha256": "f4ee415d461045d2f5a6636ac2ecf25599b9dbd01ef52a5cd640e04b48f70afa",
      "functionSha256": "369048d13604a8239caa070e40e3d26b1cc7511a379c2d7212224a67b0295770"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent; frozen literal quotations from actual-family-r05 / actual-workplace-r04 query packets; local interpretation, not new independent semantic approval"
    },
    "fields": {
      "actor": {
        "value": "第一人称何宛；丈夫与律师是不同的行为及信息提供者。",
        "anchors": [
          {
            "evidenceId": "EV-6d86f02f6428372ad49d26ee",
            "quote": "何小姐，据我调查"
          }
        ]
      },
      "emotionalDirection": {
        "value": "从另寻工作到身体、资产与债务危机后的应对；并未呈现本人自认过错。",
        "anchors": [
          {
            "evidenceId": "EV-e69d82d94f66ce90240e30f7",
            "quote": "次日，我就请假面试了业内的另一家头部公司"
          },
          {
            "evidenceId": "EV-6d86f02f6428372ad49d26ee",
            "quote": "净身出户，外加巨额债务。"
          }
        ]
      },
      "costBearer": {
        "value": "身体与资产危险落在何宛身上，属于遭受的损失，不能改写为她应为受害担责。",
        "anchors": [
          {
            "evidenceId": "EV-ce41bb852048dbb9fca9e8fc",
            "quote": "无数玻璃碎片，和金属支架刺进我的身体"
          },
          {
            "evidenceId": "EV-6d86f02f6428372ad49d26ee",
            "quote": "您不仅分不到一分钱，还会得到一笔巨额债务"
          }
        ]
      }
    },
    "limitations": [
      "多个触发及外部专业支持不能归因为单一心理变化；医学/法律风险只按叙事处理。"
    ]
  },
  {
    "sourceId": "0789aca8-8225-4607-a6f4-d0a9c3be9dc2",
    "functionId": "emotion:EP2:EP3",
    "binding": {
      "sourceTextSha256": "a70579db025cb6cfec3c9eba5047347bc1b2042e4a75ff919329143a96e8cf98",
      "candidateSha256": "b283afa70011508629effe7576c6e738ff2f77009811fe61a0799a7dc9e00bc3",
      "packetSha256": "57a20fcf677076a3249e3c935429c6294b7f5f24acf6e2ebef7c65e87fe44201",
      "reportSha256": "f4ee415d461045d2f5a6636ac2ecf25599b9dbd01ef52a5cd640e04b48f70afa",
      "functionSha256": "0594fd3c4f9a4f22539d0a5501681c227c3dbc55f3c83ab77132ca61d224dc2e"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent; frozen literal quotations from actual-family-r05 / actual-workplace-r04 query packets; local interpretation, not new independent semantic approval"
    },
    "fields": {
      "actor": {
        "value": "第一人称何宛进行取证与展示；律师、职业机构作外部支持和认可。",
        "anchors": [
          {
            "evidenceId": "EV-cd3e725e5c7f79d08328430b",
            "quote": "何宛！你不要在这里信口开河！"
          },
          {
            "evidenceId": "EV-7fd18e2727f2e137c9ecd594",
            "quote": "次日我在律师团队的指引下完成了证据搜集"
          }
        ]
      },
      "emotionalDirection": {
        "value": "从收集证据准备离开到公开展示技术、取得成果与财产切割。",
        "anchors": [
          {
            "evidenceId": "EV-7fd18e2727f2e137c9ecd594",
            "quote": "次日我在律师团队的指引下完成了证据搜集"
          },
          {
            "evidenceId": "EV-cd3e725e5c7f79d08328430b",
            "quote": "我穿着利落的西装，站在演示屏前"
          },
          {
            "evidenceId": "EV-803eeb03f7c0dc2e1cf88b82",
            "quote": "当我拿着属于自己的那份文件走出律师事务所时"
          }
        ]
      },
      "acknowledgmentObject": {
        "value": "被认可的是何宛的专业创意及成果，不是她承认自己先前过错。",
        "anchors": [
          {
            "evidenceId": "EV-cd3e725e5c7f79d08328430b",
            "quote": "甲方的代表眼睛一亮，不断点头。"
          },
          {
            "evidenceId": "EV-803eeb03f7c0dc2e1cf88b82",
            "quote": "董事会给你记头功！"
          }
        ]
      }
    },
    "limitations": [
      "最后一个字段只说明证据不足，不把受害归责给何宛；成功不证明长期创伤已经消失。",
      "当前返回片段没有足够主动自认过错后承担工作/信任代价的证据；costBearer保留unknown，不能泛推整本书不存在。"
    ]
  },
  {
    "sourceId": "4caf23e2-43e9-44b7-9aed-e08364ef998a",
    "functionId": "craft:CH1",
    "binding": {
      "sourceTextSha256": "c83f533a986042a69f6ca2069b6fb4156ea54713129436c32750a274408e6cf3",
      "candidateSha256": "c66c19572c46bd48d8bc055d190a7b35dc93f09b32359e9ed2efbf5eecb9cff7",
      "packetSha256": "64bc5c70f358bdeb30a435f833e3f3f4884231d9d55f91259ad905f5b1c49f73",
      "reportSha256": "163ac136a580a14bcd1ab7a842987f11fc0605133bbd0fe53cc9774beeedcfd4",
      "functionSha256": "13855431c4b171dfbfef6f8a821d478da21f21e69319bfb6900b24527577b2cc"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent local annotation, 2026-10-26; saved real family goal query, literal evidence only; not semantic approval"
    },
    "fields": {
      "actor": {
        "value": "第一人称女儿、母亲、父亲与妹妹是不同的行动者；父母去向互换不能拼成一个人的转变。",
        "anchors": [
          {
            "evidenceId": "EV-384dc118faa5eee9b7f860e6",
            "quote": "爸妈年迈后急需我们两个女儿养老。"
          },
          {
            "evidenceId": "EV-58c2661a14b3906ba1ea122c",
            "quote": "妹妹和外国老公生了三个孩子，他们把孩子全扔给了爸爸，自己倒是潇洒了。"
          }
        ]
      },
      "emotionalDirection": {
        "value": "母亲从否定女儿的养老付出转为落难后道歉；女儿在结尾仍坚持分责，不把道歉当成恢复照护的义务。",
        "anchors": [
          {
            "evidenceId": "EV-384dc118faa5eee9b7f860e6",
            "quote": "这辈子，我就不该选你这个没本事的女儿养老！"
          },
          {
            "evidenceId": "EV-7f85a39e211219d4bb37141e",
            "quote": "我告诉他们，既然签了协议，我就绝对不会再管妈妈。"
          },
          {
            "evidenceId": "EV-7f85a39e211219d4bb37141e",
            "quote": "真真，妈知道错了，妈真的对不起你，只有你才是妈妈的好孩子……"
          }
        ]
      },
      "acknowledgmentObject": {
        "value": "丈夫以赠礼回应父亲送早餐、送孩子；母亲另有笼统后悔和道歉，不能将两者合并为对女儿全部劳动的具体承认。",
        "anchors": [
          {
            "evidenceId": "EV-da50ab3f9d7b9288ec42df70",
            "quote": "吃完饭，爸爸又马不停蹄地送我女儿上学。"
          },
          {
            "evidenceId": "EV-da50ab3f9d7b9288ec42df70",
            "quote": "老公心里特别感动，抱着我说要给我爸买礼物。"
          },
          {
            "evidenceId": "EV-7f85a39e211219d4bb37141e",
            "quote": "真真，妈知道错了，妈真的对不起你，只有你才是妈妈的好孩子……"
          }
        ]
      },
      "costBearer": {
        "value": "前段女儿承受多重照护与住房挤占，父亲在国外承担带孩子；母亲后段落难属于另一人的后果。",
        "anchors": [
          {
            "evidenceId": "EV-384dc118faa5eee9b7f860e6",
            "quote": "可人到中年，我不仅要照顾妈妈，还要照顾即将高考的女儿和患有颈椎病的老公，更别说还有年迈的公公婆婆。"
          },
          {
            "evidenceId": "EV-58c2661a14b3906ba1ea122c",
            "quote": "妹妹和外国老公生了三个孩子，他们把孩子全扔给了爸爸，自己倒是潇洒了。"
          },
          {
            "evidenceId": "EV-7f85a39e211219d4bb37141e",
            "quote": "她一个人孤苦伶仃，睡了好几天公园长椅。"
          }
        ]
      }
    },
    "limitations": [
      "照护互换建立在重生叙述和报应结构内，不是现实对照实验或合法分责范本。",
      "母亲的道歉并未逐项承认劳动；赠礼承认的对象是父亲的帮助。不能跨行动者补成目标链。"
    ]
  },
  {
    "sourceId": "4caf23e2-43e9-44b7-9aed-e08364ef998a",
    "functionId": "psychology:PD1",
    "binding": {
      "sourceTextSha256": "c83f533a986042a69f6ca2069b6fb4156ea54713129436c32750a274408e6cf3",
      "candidateSha256": "c66c19572c46bd48d8bc055d190a7b35dc93f09b32359e9ed2efbf5eecb9cff7",
      "packetSha256": "64bc5c70f358bdeb30a435f833e3f3f4884231d9d55f91259ad905f5b1c49f73",
      "reportSha256": "163ac136a580a14bcd1ab7a842987f11fc0605133bbd0fe53cc9774beeedcfd4",
      "functionSha256": "b99b0837cc85d740cd5c8fff6032464588df15c63a8d1727757d86231a609a76"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent local annotation, 2026-10-26; saved real family goal query, literal evidence only; not semantic approval"
    },
    "fields": {
      "actor": {
        "value": "陈真是提出分责并安排独立住房的女儿；丈夫的照护意愿与母亲的指责分别呈现。",
        "anchors": [
          {
            "evidenceId": "EV-ddc211faa34305373f144b2d",
            "quote": "我也站了起来：“爸，你要是想跟我一起养老也不能什么都不出，房子一人一套！”"
          },
          {
            "evidenceId": "EV-4c62fdf4d282328c173ab758",
            "quote": "我听了这些话就当是放屁，而自己则租下了隔壁给我爸住。"
          }
        ]
      },
      "emotionalDirection": {
        "value": "从回忆一家三口让出住房的委屈，转为坚持分担和另租空间；保护小家不等于完全原谅父亲。",
        "anchors": [
          {
            "evidenceId": "EV-ddc211faa34305373f144b2d",
            "quote": "这辈子，我不会再让他们受这种委屈！"
          },
          {
            "evidenceId": "EV-4c62fdf4d282328c173ab758",
            "quote": "我听了这些话就当是放屁，而自己则租下了隔壁给我爸住。"
          }
        ]
      },
      "acknowledgmentObject": {
        "value": "父亲说有钱没钱都是女儿；丈夫感动并赠礼回应父亲的帮助。这里没有母亲明确承认陈真旧付出的证据。",
        "anchors": [
          {
            "evidenceId": "EV-4c62fdf4d282328c173ab758",
            "quote": "老大也挺好，不管有钱没钱都是我们的女儿！"
          },
          {
            "evidenceId": "EV-da50ab3f9d7b9288ec42df70",
            "quote": "老公心里特别感动，抱着我说要给我爸买礼物。"
          }
        ]
      },
      "costBearer": {
        "value": "女儿夫妻先前挤住房间，孩子失去书桌空间；今生陈真另租住房，费用数额未写明。",
        "anchors": [
          {
            "evidenceId": "EV-ddc211faa34305373f144b2d",
            "quote": "上辈子老公连我们主卧都让了出去，我们一家三口挤在一个小房间里，他都没有一点怨言。"
          },
          {
            "evidenceId": "EV-ddc211faa34305373f144b2d",
            "quote": "而女儿更是连个书桌都没地方放，每天还要弯腰趴在茶几上写作业。"
          },
          {
            "evidenceId": "EV-4c62fdf4d282328c173ab758",
            "quote": "我听了这些话就当是放屁，而自己则租下了隔壁给我爸住。"
          }
        ]
      }
    },
    "limitations": [
      "所引功能可供比较空间与责任边界，不能把父亲在新生活中的协作视作所有旧账均已解决。",
      "前世与今生来自同一叙述者；承认对象、付出者和提出边界者不能自动视作同一人。"
    ]
  },
  {
    "sourceId": "69f4e20c-db17-44ef-a498-7af229f286a2",
    "functionId": "craft:CH1",
    "binding": {
      "sourceTextSha256": "817e59af1c25fba0e6437a41166a09b58ed2aee24a411b868eae63fd6bfc3fe5",
      "candidateSha256": "f9f193bfcfc942c836cedb084624386af77654a534f7487ea47dbaf1ca452aca",
      "packetSha256": "6c7081208fa73e3082989a362dfdb3cd61808fb24807377591a345a0160a8de4",
      "reportSha256": "0bcbc37920355343d256e631fa4cb9da96d029f31325ad259725e7cc85268010",
      "functionSha256": "0dd74eccd6a8856d6e39c610bb34b4f35a00896a18fa4e38f3a19699b6f0edd2"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent local annotation, 2026-10-26; saved real family goal query, literal evidence only; not semantic approval"
    },
    "fields": {
      "actor": {
        "value": "早段沈知年向温夏说话，后段温夏向沈知年复述近似台词；不是同一行动者连续尊重对方。",
        "anchors": [
          {
            "evidenceId": "EV-58243d2bfb10ca119c527a6d",
            "quote": "生命是自己的，我尊重你的选择。如果你觉得这样能解脱也挺好。"
          },
          {
            "evidenceId": "EV-abcfe33f1bdeb6c46579a884",
            "quote": "可是我变心了，沈知年。"
          }
        ]
      },
      "emotionalDirection": {
        "value": "温夏由哀求挽回转为表示变心、对他的情绪无动于衷；台词回声表现关系位置反转。",
        "anchors": [
          {
            "evidenceId": "EV-58243d2bfb10ca119c527a6d",
            "quote": "那天过后我闹了很久，打他、骂他，甚至翻出曾经的回忆哀求他。"
          },
          {
            "evidenceId": "EV-abcfe33f1bdeb6c46579a884",
            "quote": "很奇怪吧，我以前那么喜欢你，现在竟然可以对你的情绪无动于衷了。"
          }
        ]
      },
      "costBearer": {
        "value": "早段温夏受到伤害，后段叙述描述沈知年哭泣离开；这些代价不能合成主角自认责任后主动承担的选择。",
        "anchors": [
          {
            "evidenceId": "EV-58243d2bfb10ca119c527a6d",
            "quote": "他会心疼人，只是不是我。"
          },
          {
            "evidenceId": "EV-abcfe33f1bdeb6c46579a884",
            "quote": "真是该死啊，他好像哭了将手中的酒一饮而尽，迈着踉跄的步子离开这个他精心布置的会场。"
          }
        ]
      }
    },
    "limitations": [
      "acknowledgmentObject保持unknown：“尊重”在此是伤害性的台词，不是劳动被认可。",
      "近句回声可作为结构候选；其自伤语境与伤害性回敬不能直接搬作尊重或和解。原句并非写作建议。",
      "只确认可见言行与叙述，不保证报复、释然或长期创伤状态的唯一解释。"
    ]
  },
  {
    "sourceId": "69f4e20c-db17-44ef-a498-7af229f286a2",
    "functionId": "psychology:PD2",
    "binding": {
      "sourceTextSha256": "817e59af1c25fba0e6437a41166a09b58ed2aee24a411b868eae63fd6bfc3fe5",
      "candidateSha256": "f9f193bfcfc942c836cedb084624386af77654a534f7487ea47dbaf1ca452aca",
      "packetSha256": "6c7081208fa73e3082989a362dfdb3cd61808fb24807377591a345a0160a8de4",
      "reportSha256": "0bcbc37920355343d256e631fa4cb9da96d029f31325ad259725e7cc85268010",
      "functionSha256": "274c363fdfd5babb26636e20ea0cc7f8354f4637a63071cfa4ecc311b7e8d12e"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent local annotation, 2026-10-26; saved real family goal query, literal evidence only; not semantic approval"
    },
    "fields": {
      "actor": {
        "value": "温夏提出退出条件；沈母另行说明自己的隐瞒与求她放弃追诉。两者不是同一承认主体。",
        "anchors": [
          {
            "evidenceId": "EV-50346a57e4f05484aaa4f8bc",
            "quote": "房子，全部给我。公司股票，百分之十。现金，一千万。"
          },
          {
            "evidenceId": "EV-703891ec564c58674c8822ff",
            "quote": "沈母冷笑，“因为是我跪在她面前求她的！”"
          }
        ]
      },
      "emotionalDirection": {
        "value": "温夏被羞辱后愤怒反抗，随后乏力、提出财产条件并离开；不能概括为一直冷静。",
        "anchors": [
          {
            "evidenceId": "EV-fb66c50a13f5a56394b957f1",
            "quote": "浑身血液发凉。"
          },
          {
            "evidenceId": "EV-50346a57e4f05484aaa4f8bc",
            "quote": "听完这些话我大脑空白一瞬，回过神来不管不顾地抄起手上的包往他身上砸。"
          },
          {
            "evidenceId": "EV-50346a57e4f05484aaa4f8bc",
            "quote": "然后拖着疲惫的身体离开。"
          }
        ]
      },
      "acknowledgmentObject": {
        "value": "沈母承认自己求温夏放弃追诉，并说对不起；对象是旧伤害及为儿子前途而隐瞒，不是承认温夏的照护劳动。",
        "anchors": [
          {
            "evidenceId": "EV-703891ec564c58674c8822ff",
            "quote": "沈母冷笑，“因为是我跪在她面前求她的！”"
          },
          {
            "evidenceId": "EV-703891ec564c58674c8822ff",
            "quote": "我知道这样对不起温夏，可我没有别的选择。"
          }
        ]
      },
      "costBearer": {
        "value": "温夏承受羞辱与身体冲突，并提出财产条件；此处沈知年仅口头答应，实际支付和全部后果不能用本片段补足。",
        "anchors": [
          {
            "evidenceId": "EV-50346a57e4f05484aaa4f8bc",
            "quote": "被拉开时，余圆圆趁乱在我脸上打了一巴掌。"
          },
          {
            "evidenceId": "EV-50346a57e4f05484aaa4f8bc",
            "quote": "“房子，全部给我。公司股票，百分之十。现金，一千万。”\n“好。”"
          }
        ]
      }
    },
    "limitations": [
      "财产条件有经济安全或报复等替代解释，不自动等于承认劳动。",
      "沈母的说明是角色陈述；旧伤害、医学状态或法律后果不作现实核验。本组引文不足以单独证明最终原谅或彻底释然。"
    ]
  },
  {
    "sourceId": "69f4e20c-db17-44ef-a498-7af229f286a2",
    "functionId": "psychology:PD3",
    "binding": {
      "sourceTextSha256": "817e59af1c25fba0e6437a41166a09b58ed2aee24a411b868eae63fd6bfc3fe5",
      "candidateSha256": "f9f193bfcfc942c836cedb084624386af77654a534f7487ea47dbaf1ca452aca",
      "packetSha256": "6c7081208fa73e3082989a362dfdb3cd61808fb24807377591a345a0160a8de4",
      "reportSha256": "0bcbc37920355343d256e631fa4cb9da96d029f31325ad259725e7cc85268010",
      "functionSha256": "75c0ecb8f45f4991431637f2dc308efbe53013ff59601a7e4d595ab67b88a80a"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent local annotation, 2026-10-26; saved real family goal query, literal evidence only; not semantic approval"
    },
    "fields": {
      "actor": {
        "value": "沈知年从主动为余圆圆的喜悦庆祝，到电话中拒绝承担她的身体不适；温夏是前段被忽略的另一人物。",
        "anchors": [
          {
            "evidenceId": "EV-92894cbd12752d162e2606fd",
            "quote": "相反，圆圆治牙的时候说自己终于可以自信地笑了，我还挺高兴的。"
          },
          {
            "evidenceId": "EV-c728566fceafc1972697b448",
            "quote": "他将烟摁灭，扔进旁边的垃圾桶，“余圆圆，我不是医生。”"
          }
        ]
      },
      "emotionalDirection": {
        "value": "沈知年从表露对余圆圆动心，转到冷淡地让她去医院；仅能确认这次回应变化，不能推出关系已经永久终结。",
        "anchors": [
          {
            "evidenceId": "EV-92894cbd12752d162e2606fd",
            "quote": "我确实对她动心了。"
          },
          {
            "evidenceId": "EV-c728566fceafc1972697b448",
            "quote": "沈知年看着雨，目光淡淡，“病情严重就去医院吧。”"
          }
        ]
      },
      "acknowledgmentObject": {
        "value": "沈知年承认的是对余圆圆动心；并未在这两段承认温夏的付出或自己的责任。",
        "anchors": [
          {
            "evidenceId": "EV-92894cbd12752d162e2606fd",
            "quote": "我确实对她动心了。"
          }
        ]
      }
    },
    "limitations": [
      "costBearer保持unknown：本组没有足够承受新增代价的完整后果。",
      "照护退出可以是烦躁、自保或关系变化；不能仅凭边界词视作正向担责，也不能当作家庭劳动得到承认。"
    ]
  },
  {
    "sourceId": "6cb6ac58-67b1-4766-bfc6-2f6bc8806dc7",
    "functionId": "psychology:PD1",
    "binding": {
      "sourceTextSha256": "a865ecea1c449b40fd4adf359ad0ca5719afb57d53a6d364278cbac9e9620cf2",
      "candidateSha256": "f5c436a9c8cb635e8a57316e691a8deb34611dced571029532c0c55b63e04cf9",
      "packetSha256": "cfb2bf6b0bbfb5e2831758b4174552e531c7fa99aae5a7f77041697ab9640c92",
      "reportSha256": "e8818489ec45108b1b85e7aed6e4971d2082f45363980d7b7eadb196515e9858",
      "functionSha256": "c51db97a5966889d69fcf5f02a4df9a3b250a88a68d27b81ee89d49cb2d217ce"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent local annotation, 2026-10-26; saved real family goal query, literal evidence only; not semantic approval"
    },
    "fields": {
      "actor": {
        "value": "第一人称教师投入额外辅导；小冉父亲是先受帮助、后在会上点头的另一行动者。",
        "anchors": [
          {
            "evidenceId": "EV-5fa346a72c18ac6a08de82e8",
            "quote": "高三（1）班，这个所谓的“火箭班”，是我从高一带上来的心血。"
          },
          {
            "evidenceId": "EV-e8b5884c65cf8c680c402f3a",
            "quote": "那是小冉的爸爸。"
          }
        ]
      },
      "emotionalDirection": {
        "value": "教师从倾力投入到感到信任受损，再转为只执行新方案和准点离开；不把这解释为永久撤回全部关心。",
        "anchors": [
          {
            "evidenceId": "EV-e8b5884c65cf8c680c402f3a",
            "quote": "那个点头的动作，像一根烧红的钢针扎进了我的心脏。"
          },
          {
            "evidenceId": "EV-d0b98ba3e53d7734616931a1",
            "quote": "下午五点铃声一响，我第一个走出教室，留下满屋子茫然失措的学生。"
          }
        ]
      },
      "acknowledgmentObject": {
        "value": "父亲曾以鞠躬感谢垫费和陪护，当前却在声讨时点头；不是当前重新承认教师劳动的情节。",
        "anchors": [
          {
            "evidenceId": "EV-e8b5884c65cf8c680c402f3a",
            "quote": "他当时握着我的手，眼眶通红，话说得语无伦次，一个劲地鞠躬。"
          },
          {
            "evidenceId": "EV-e8b5884c65cf8c680c402f3a",
            "quote": "而现在，这个男人，在范建明慷慨陈词的时候，在庄雅淇妈妈痛哭流涕的时候，他只是认同地点了点头。"
          }
        ]
      },
      "costBearer": {
        "value": "教师牺牲假期、社交并垫付医药费；额外陪伴撤回后学生面对其缺席，不由此推出成绩或教育效果因果。",
        "anchors": [
          {
            "evidenceId": "EV-5fa346a72c18ac6a08de82e8",
            "quote": "所以，我推掉了所有社交，陪着他们上晚自习，只要他们有任何一个知识点不明白，我都会讲到他们懂为止。"
          },
          {
            "evidenceId": "EV-e8b5884c65cf8c680c402f3a",
            "quote": "是我，二话不说，先垫付了全部医药费，签了字，又在医院守了一整夜，直到他风尘仆仆地赶回来。"
          },
          {
            "evidenceId": "EV-d0b98ba3e53d7734616931a1",
            "quote": "现在，这一切都没了。"
          }
        ]
      }
    },
    "limitations": [
      "呈现的是互信破裂后的减少付出，不能反写成劳动已被承认；也不是教育方法正确性的证明。",
      "父亲点头的内部理由未知；教师第一人称解释与学生实际利益不能自动等同。"
    ]
  },
  {
    "sourceId": "e82265c9-8789-4a79-b91b-5c1e881d7a37",
    "functionId": "psychology:PD2",
    "binding": {
      "sourceTextSha256": "901c195a8122b99f8ae3c54371506cfd29fdac061d0eb9163540ef4d34628424",
      "candidateSha256": "9d346a7d917e378981688ada8836732735fc51210a16322f32283f1155ffcbe5",
      "packetSha256": "d64e83766e4b8587bc82a2ebe8f235646fc35130f7e3f39e5a6e76e87519d6a9",
      "reportSha256": "e458ec2e4cc73fb3b0b0dcdb492fc2a84ff87ad6940a961738ae5a05e4e5c20b",
      "functionSha256": "233def7ca2053333461b5ed7d0c03552c3570a53daf815ec1e4e9ddfa1fa1954"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent local annotation, 2026-10-26; saved real family goal query, literal evidence only; not semantic approval"
    },
    "fields": {
      "actor": {
        "value": "慕瑶拒绝沈鹤的旧婚约；林砚深安排旅行和治疗，母亲提出自己的愿望。三人的选择权须分别核对。",
        "anchors": [
          {
            "evidenceId": "EV-30d643935d2c939205ab6b20",
            "quote": "我最后再说一遍，三天前我就说了，我不会和你哥哥结婚，我不会跟你抢他，麻烦你们走远点，别碍事好吗？"
          },
          {
            "evidenceId": "EV-ee7777fd22db255891f90d84",
            "quote": "林砚深也说在那边早就联系好了专家，什么都不要我们操心。"
          }
        ]
      },
      "acknowledgmentObject": {
        "value": "母亲承认女儿为自己吃苦；林砚深尾段询问上午表态。这不是女儿已经完成爱情确认或旧婚约得到谅解。",
        "anchors": [
          {
            "evidenceId": "EV-ee7777fd22db255891f90d84",
            "quote": "本来我想拒绝了，可母亲一边说想见见老朋友，一边说为难我这么长时间为了她吃苦，索性去国外转转，就当散心度蜜月了。"
          },
          {
            "evidenceId": "EV-b04b04f0d4cde7ad4818b020",
            "quote": "“上午你说的话是认真的吗？”"
          }
        ]
      }
    },
    "limitations": [
      "emotionalDirection与costBearer保持unknown：所选片段未完整呈现契约戒备前态与新选择的实际代价。",
      "原假说称持续尊重选择，但结尾写她松手且挣脱不开；不能把此动作自动当成自愿亲近。",
      "领证争执引文没有直接呈现林砚深登记前再次确认；不能借其他未供给片段补证。重病治疗和外部资源是本题迁移限制。",
      "逐字反证：EV-b04b04f0d4cde7ad4818b020 中“可他力气很大，怎么都挣脱不开。”；EV-ee7777fd22db255891f90d84 中“话说到这个份上，我只有答应的份儿。”"
    ]
  },
  {
    "sourceId": "e82265c9-8789-4a79-b91b-5c1e881d7a37",
    "functionId": "emotion:EP3:EP4",
    "binding": {
      "sourceTextSha256": "901c195a8122b99f8ae3c54371506cfd29fdac061d0eb9163540ef4d34628424",
      "candidateSha256": "9d346a7d917e378981688ada8836732735fc51210a16322f32283f1155ffcbe5",
      "packetSha256": "d64e83766e4b8587bc82a2ebe8f235646fc35130f7e3f39e5a6e76e87519d6a9",
      "reportSha256": "e458ec2e4cc73fb3b0b0dcdb492fc2a84ff87ad6940a961738ae5a05e4e5c20b",
      "functionSha256": "77a55063b0704550acb9d981e096fe81a9bdbd699b9aa8e4d037e18fbb43b6bd"
    },
    "provenance": {
      "kind": "local_evidence_note",
      "origin": "DATA agent local annotation, 2026-10-26; saved real family goal query, literal evidence only; not semantic approval"
    },
    "fields": {
      "actor": {
        "value": "慕瑶是公开拒绝沈鹤并谈幸福的人；沈鹤道歉、母亲承认女儿吃苦、林砚深询问是不同主体的动作。",
        "anchors": [
          {
            "evidenceId": "EV-bb35ad61486fddcf1cd6e59f",
            "quote": "过去那些事，我不想提了，就这样吧，我已经结婚了，我现在很幸福。"
          },
          {
            "evidenceId": "EV-b04b04f0d4cde7ad4818b020",
            "quote": "回去的路上，人流拥挤，林砚深忽然抓住我的手。"
          }
        ]
      },
      "emotionalDirection": {
        "value": "慕瑶公开称幸福并拒绝旧关系，私下对询问耳红、回避回答并松手；不把含混和挣脱不开读成明确自愿接受。",
        "anchors": [
          {
            "evidenceId": "EV-bb35ad61486fddcf1cd6e59f",
            "quote": "过去那些事，我不想提了，就这样吧，我已经结婚了，我现在很幸福。"
          },
          {
            "evidenceId": "EV-b04b04f0d4cde7ad4818b020",
            "quote": "说着，我松开他的手。\n\n可他力气很大，怎么都挣脱不开。"
          }
        ]
      },
      "acknowledgmentObject": {
        "value": "沈鹤承认纵容家人、逼她道歉，母亲提到女儿为自己吃苦；这些承认不要求慕瑶回到旧关系。",
        "anchors": [
          {
            "evidenceId": "EV-bb35ad61486fddcf1cd6e59f",
            "quote": "瑶瑶，别这样看着我，我知道错了，我不该一味地纵容家人欺负你，不该逼你道歉，你打得对，打得好，是她活该，是她欠打。"
          },
          {
            "evidenceId": "EV-ee7777fd22db255891f90d84",
            "quote": "本来我想拒绝了，可母亲一边说想见见老朋友，一边说为难我这么长时间为了她吃苦，索性去国外转转，就当散心度蜜月了。"
          }
        ]
      }
    },
    "limitations": [
      "costBearer保持unknown：这些片段未给出她因拒绝和解主动付出的完整新代价。",
      "不能把“我只有答应的份儿”或“挣脱不开”自动美化为持续尊重选择；当前假说须由适用性阶段审查。",
      "公开幸福也可服务拒绝沈鹤；重病、出国治疗和新伴侣资源不能直接搬到家庭固定边界内。"
    ]
  }
]);
