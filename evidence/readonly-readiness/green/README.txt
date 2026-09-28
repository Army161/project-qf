Green evidence for CFG-TYPE and BODY-LIMIT (2026-09-27, Node v22.22.2).

1. reviewer-diagnostic-unmodified-against-repaired.txt: the reviewer's tool, unmodified, run against the repaired
   adapter and verifier. It now exits 1 at its own assertion `produced === chunks` (actual 5 of 128 chunks read),
   i.e. the BODY-LIMIT deficiency no longer reproduces. Because it stops there, it never reaches CONFIG-TYPE.
2. reproduce-variant.mjs (diff in reviewer-diagnostic-variant.diff): the same tool with its two "deficiency must
   reproduce" assertions replaced by recording, and the repaired verifier's two new constants (CONFIG_ROUTES,
   DAMM_V2_CONFIG_TYPES) supplied to its vm context. Output: targeted-observations-variant-repaired.json.
   BODY-LIMIT: 5 of 128 chunks read, stream cancelled. CONFIG-TYPE: type 0 FAIL, type 1 PASS, type 255 FAIL.
   The "interpretation" strings in that JSON are the tool's original wording and describe the OLD behaviour; read the
   numeric/status fields.
3. verifier.txt and adapter-body-limit.txt: the regression tests that expect the secure result.
