// Synthetic public protocol fixture, not a private manuscript or provider response.
export default {
  "schemaVersion": "cross-chapter-frozen-expected-1",
  "caseId": "fixed-positive-negative-entities-events-1",
  "chapterIds": [
    "chapter-1",
    "chapter-2",
    "chapter-3",
    "chapter-4"
  ],
  "expectedFindings": [
    {
      "groupId": "boxes-same-batch",
      "status": "confirmed_conflict",
      "resolutionReason": "direct_conflict"
    },
    {
      "groupId": "entry-deliberate-lie",
      "status": "ambiguous",
      "resolutionReason": "insufficient_context"
    },
    {
      "groupId": "arrival-misremembered",
      "status": "ambiguous",
      "resolutionReason": "insufficient_context"
    },
    {
      "groupId": "key-normal-transition",
      "status": "resolved",
      "resolutionReason": "normal_change"
    },
    {
      "groupId": "clock-different-rounds",
      "status": "resolved",
      "resolutionReason": "different_rounds"
    },
    {
      "groupId": "letter-delayed-disclosure",
      "status": "resolved",
      "resolutionReason": "intentional_omission"
    },
    {
      "groupId": "linlan-different-people",
      "status": "resolved",
      "resolutionReason": "different_entity"
    },
    {
      "groupId": "folder-unexplained",
      "status": "ambiguous",
      "resolutionReason": "insufficient_context"
    },
    {
      "groupId": "same-chapter-clock-conflict",
      "status": "confirmed_conflict",
      "resolutionReason": "direct_conflict"
    }
  ],
  "invariants": {
    "allChaptersCoveredTwice": true,
    "everyFindingHasTwoSidedExactEvidence": true,
    "mainEvidenceRestrictedToOriginalGroup": true,
    "chapterThreeExternalCounterevidenceAccepted": true,
    "unpairedClaimCounterevidenceAccepted": true,
    "noNoChangeStatus": true,
    "qualityPreset": false,
    "blindStagesReceiveDiagnosis": false
  }
};
