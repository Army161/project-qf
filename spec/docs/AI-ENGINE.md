# AI-ENGINE — AI Launch Architect

AI output is **advisory JSON only**.

## 1. Pipeline
```
structured inputs (validation, scores, constraints)
 → LLM (no tools with side effects)
 → strict JSON Schema validation (reject on failure; no repair loops that loosen schema)
 → deterministic validation → Policy Engine → Tx builder → Simulation → human review → wallet signature
```

## 2. May propose
quote asset (from validated candidates), curve template id, fee values within template ranges, migration threshold within MigrationPolicy bounds, reward strategy, launch timing window, metadata/narrative suggestions.

## 3. Must never
sign · send · approve · create authorities · change multisigs · move treasury funds · override Policy Engine · override Validator · disable simulation · change compliance rules · write policies · output profit/return predictions.

## 4. Output schema (abridged)
```json
{ "$id": "LaunchProposal@1", "type": "object", "additionalProperties": false,
  "required": ["quoteMint","templateId","fees","migration","reward","rationale","risks"],
  "properties": {
    "quoteMint": {"type":"string","pattern":"^[1-9A-HJ-NP-Za-km-z]{32,44}$"},
    "templateId": {"enum":["STANDARD_V1"]},
    "fees": {"type":"object","additionalProperties":false,"properties":{"baseFeeBps":{"type":"integer"},"creatorTradingFeePct":{"type":"integer"}}},
    "migration": {"type":"object","additionalProperties":false,"properties":{"targetUsd":{"type":"number"}}},
    "reward": {"enum":["NONE","TRADING_FEE","DIRECT","MERKLE","EPOCH_PROPORTIONAL"]},
    "timing": {"type":"string"},
    "rationale": {"type":"array","items":{"type":"object","required":["claim","evidenceRef"]}},
    "risks": {"type":"array","items":{"type":"string"}} } }
```
Every rationale claim must reference an evidence id from the input bundle; unreferenced claims are dropped.

## 5. Prompt-injection controls
- External text (metadata, social, news, READMEs) is passed only inside typed data fields with explicit "untrusted data" framing; never concatenated into instructions.
- Sanitize: strip control characters, URLs rendered as plain text, length caps.
- Output filter rejects banned phrases (COMPLIANCE.md §3) and any key-like strings.
- Red-team suite in TESTING.md.

## 6. Evaluation
Offline eval set of historical launches: proposal validity rate, policy-accept rate, clamp frequency, rationale-evidence coverage, banned-phrase rate (must be 0).

## 7. Model/provider
Model choice is OPEN (not decided in this spec). Whatever provider is chosen must support structured output, no training on QF data by contract, and region/data-retention terms reviewed in DATA-LICENSES.md.
