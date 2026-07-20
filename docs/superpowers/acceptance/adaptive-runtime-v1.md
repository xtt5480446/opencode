# Adaptive Runtime V1 Acceptance

Baseline source: OpenCode `5f7091ab4e261cca5383cbd57aa6aa589ed9ee86`

Baseline Git tag: `upstream-baseline-5f7091a`

Only the user changes a gate result to `accepted`. Build revision, evidence export, automated verification, and user notes are required before acceptance.

| Gate | Build revision | Date       | Result   | Evidence export                                                                                                                              | User notes                                                                                        |
| ---- | -------------- | ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| G1   | `0346bd4c06`   | 2026-07-20 | accepted | [`evidence/g1/`](./evidence/g1/) checksum 已验证；Linux x64 binary SHA256 `70c6ecd957ed9e2d92ec0807ff52b57fc45f4a3f0845f5700a198822ea045099` | DeepSeek default/explicit baseline 均返回 `BASELINE_OK`；live doctor 单一模型审计有效；用户已验收 |
| G2   |                |            | blocked  |                                                                                                                                              |                                                                                                   |
| G3   |                |            | blocked  |                                                                                                                                              |                                                                                                   |
| G4   |                |            | blocked  |                                                                                                                                              |                                                                                                   |
| G5   |                |            | blocked  |                                                                                                                                              |                                                                                                   |
| G6   |                |            | blocked  |                                                                                                                                              |                                                                                                   |
