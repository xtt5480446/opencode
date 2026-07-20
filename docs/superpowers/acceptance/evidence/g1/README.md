# G1 Execution Boundary Evidence

G1 was accepted by the user on 2026-07-20 after running the packaged Linux x64 binary against a real provider.

- Binary revision: `0346bd4c06`
- Trial HEAD: `1c30791595`
- Worktree dirty before trial: `false`
- Binary SHA256: `70c6ecd957ed9e2d92ec0807ff52b57fc45f4a3f0845f5700a198822ea045099`
- Model identity: `deepseek/deepseek-chat/default`
- Effective context limit: `1000000`

The omitted-runtime and explicit `--runtime baseline` commands both returned exactly `BASELINE_OK`. The live doctor completed one Coordinator generation and one successful model request with `modelPolicyValid=true`. Structured credential scanning found no credential-like key or value in `doctor.json`, `model-requests.jsonl`, or `process.json`.

Run the integrity check from this directory:

```bash
sha256sum -c SHA256SUMS
```

DeepSeek was used only to validate the G1 execution boundary after the selected Kimi account exhausted its quota. This evidence does not substitute for the later Kimi 256k short-context benchmark.
