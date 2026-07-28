# 11-REDACTOR-AUDIT — why `secret-redactor.ts` missed the GAP-11-F credential, and what to do about it

**Plan:** 11-30 (GAP-11-F, detection half) · **Date:** 2026-07-28 · **Requirement:** REQ-053

**Disclosure discipline for this document.** No live credential value appears here. All census
output was passed through a character-class masking function before being written anywhere: lowercase
letters become `a`, uppercase `A`, digits `9`, runs collapse to `x{n}`, and punctuation is preserved.
Where a shape is quoted below it is a *shape*, not a value. All test fixtures referenced are synthetic.
The corpus was opened `readOnly: true` throughout; `~/.memory/aaron.db` was never opened for writing and
none of the four backups (`pre-v4`, `pre-rebuild-v3`, `pre-anchor-prune`, `pre-phase11`) were touched.

---

## 1. The escaped shape

The credential that escaped is a **quoted user/password pair following a prose lead-in**. Masked:

```
… Your MC login: `<a{5}>` / `<Aa{7}9{2}>$!2026` …
```

That is: the word `login`, a colon, a backtick-quoted username, a space-slash-space, and a
backtick-quoted human-chosen password containing letters, digits, `$` and `!`. It has no entropy
signature, no vendor prefix, and no fixed length — as GAP-11-F predicted, this is a materially harder
detection target than an API key.

Confirmed present in exactly one distinct rendering in each of `canonical_events.content`,
`summaries.summaryText`, and `anchors.content`. (Note for §5: the 143 contaminated summaries GAP-11-F
counted do **not** all carry this verbatim rendering — only one does. The rest carry summariser
paraphrases of it. This matters for the propagation question.)

---

## 2. Why each shipped rule failed to fire — by its actual predicate

`src/imports/secret-redactor.ts` applies four replacements in sequence. Each is evaluated below against
the escaped input. Every claim in this section was verified empirically by calling the shipped
`redactKnownSecrets()` on synthetic reconstructions, not by reading the regex alone.

### Rule 1 — PEM private-key block

```
/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/
```

**Predicate:** the literal ASCII-armor delimiters must both be present. **Why it did not fire:** the
input contains no PEM armor. Correctly inapplicable — not a defect.

### Rule 2 — vendor-prefixed token

```
/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/
```

**Predicate:** a literal `sk-`, `rk-` or `pk-` prefix, followed by ≥16 characters drawn from
`[A-Za-z0-9_-]`. **Why it did not fire:** two independent reasons. The password has no vendor prefix
(it is human-chosen, not issued), and its character set includes `$` and `!`, which are outside the
allowed class — so even a prefixed variant of this password would terminate the match early.

### Rule 3 — `Bearer` header

```
/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i
```

**Predicate:** the literal word `Bearer` must immediately precede the value. **Why it did not fire:**
the lead-in is `login`, not `Bearer`. Correctly inapplicable.

### Rule 4 — keyword/value pair (the rule that *should* have caught this class)

```
/((?:["']?\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)\b["']?)\s*[:=]\s*["']?)([^"'\s,;}]+)/i
```

This rule failed for **three separate reasons**, each of which is independently sufficient. They are
listed separately because fixing only one of them would not have caught the credential, and because
reasons (b) and (c) turn out to affect far more of the corpus than the incident itself.

**(a) The lead-in word is not in the keyword alternation.** The alternation is
`api[_-]?key | access[_-]?token | auth[_-]?token | token | password | secret`. The escaped text's
lead-in is `login`, which is absent. The rule never even begins to match. This is the proximate cause.

**(b) The value grammar cannot express a `user / pass` pair.** Suppose (a) were fixed by adding `login`
to the alternation. The rule would still fail to redact the password, because its value capture is
`["']?([^"'\s,;}]+)` — a single optional quote followed by a run of non-whitespace, non-quote
characters. Against ``login: `aaron` / `Pass99$!2026` `` the optional quote class `["']?` does not
include the **backtick**, so the capture begins at the backtick and terminates at the first space —
capturing `` `aaron` `` and nothing more. The password sits after ` / ` as a separate token and is left
in plaintext. Verified: the unquoted variant `login: aaron / Pass99$!2026` also survives, for the same
reason — the capture stops at the space after the username.

**(c) The rule cannot skip a backslash between the keyword and its separator.** This one was found by
the census rather than by the incident, and it is the highest-volume defect. In text of the form
`\"password\":\"…\"` — which is what JSON bodies embedded inside `[Tool call: Bash]` / `execute_code`
content look like after one level of unescaping — the character sequence between `password` and `:` is
`\` then `"`. Rule 4's post-keyword `["']?` matches at most one character and `\` is not in that class,
so it matches empty; `\s*` then matches empty; and `[:=]` is required to match `\`, which fails. There
is no backtracking path that succeeds. **Escaped-JSON secrets are invisible to rule 4 entirely.**
Verified empirically:

| synthetic input | shipped result |
|---|---|
| `{"email":"a@b.com","password":"Synth99$"}` | HIT — redacted |
| `-d \"{\"email\":\"a@b.com\",\"password\":\"Synth99$\"}\"` | **MISS** |
| `Your MC login: \`aaron\` / \`Synth99$!2026\`` | **MISS** |
| `Your MC login: aaron / Synth99$!2026` | **MISS** |
| `API key: abc123def456ghi789` | **MISS** (see §3, C3) |
| `postgresql://postgres:trustno1@localhost:5432/db` | **MISS** (see §3, C4) |
| `MC api key 0123…64 hex chars…abcd` | **MISS** (see §3, C5 — deliberately left missing) |

The redactor is not broken. Rules 2 and 4 fire on 17,981 spans in `canonical_events.content` alone. It
has a missing class and a quoting blind spot.

---

## 3. Census and precision measurement

### Method

Scanned `canonical_events.content` (292,407 rows), `summaries.summaryText` (138,373 active +
superseded), and `anchors.content` (18,938) — the **content fields only**, parsed out of each row's
payload JSON.

A first pass that scanned whole payload JSON was discarded as invalid: it counted every row's
`contentHash` as a 64-hex "secret", inflating one candidate to 292,988 hits. That artifact is recorded
here because it is exactly the kind of measurement error that would have justified a bad rule.

The oracle for "would this be a *new* catch?" is the **shipped `redactKnownSecrets()` itself**: a match
counts as new only if its value survives the shipped redactor. Values that are already `[REDACTED]`,
`$VARS`, `{{templates}}`, `<placeholders>`, truncated `…`, or shorter than 6 characters are excluded
from the numerator. True/false positives were then judged by inspecting masked context windows.

Scripts are in the session scratchpad, not committed — they embed corpus-shaped output.

### Results

| # | Candidate rule | New catches (canonical / summaries / anchors) | False positives | Verdict |
|---|---|---|---|---|
| **C1** | Rule 4, made tolerant of backslash-escaped quotes | **193 / 80 / 27** | **0** in a 40-sample inspection (all `password`, `apiKey`, `api_key` fields with real-shaped values) | **SHIP** |
| **C2** | Credential lead-in + **quoted** `user / pass` pair | **1 / 1 / 1** | **0** across 292,407 canonical events | **SHIP** |
| C2u | Same, quotes optional | 2 / 2 / 1 | **1 of 2** canonical hits is prose — an antipattern label of the form `"Xxxx / XxxABC xxx"` — a **50% false-positive rate** | **REJECT** |
| C3 | Key phrase with a **space** separator (`API key:`, `auth token:`) | 7 TP / 5 FP · 10 TP / 5 FP · 0 TP / 1 FP | **~40%.** FPs are single prose words after a heading: `API key: rotation`, `API key: pending`, and env-var *names* like `MC_API_KEY` | **REJECT as written** |
| **C3n** | C3 narrowed: value ≥16 chars and containing both a letter and a digit | **4 / 5 / 0** | **0** — the narrowing drops every prose FP and keeps the 35-character vendor tokens | **SHIP** |
| **C4** | URI userinfo password (`scheme://user:pass@host`) | **33 / 18 / 0** | **0** — all are DSN passwords (Postgres, HTTP basic) | **SHIP** |
| C5 | Bare 64-hex blob | 581 / 373 / 128 | **Overwhelming.** 45/35/2 sit within 40 characters of an explicit `sha256:`/`digest`/`commit` marker; sampling the unlabelled remainder found the same thing — content digests, git object IDs, and `~/.memory/` cache paths. GAP-11-F reports only **8** anchor rows carry the real 64-hex API key, against **128** anchor matches — a floor of ~94% FP in that table alone | **REJECT** |

### Reading these numbers honestly

Two of the six candidates are rejected on measured precision, and one only survives after narrowing.
That is the point of the exercise: **C5 in particular is the rule a plan without a false-positive
budget would have shipped.** It catches the incident's 64-hex API key. It would also redact roughly
1,080 content digests and object IDs across the corpus, which are exactly the identifiers that make
derived memory traceable back to its source. Shipping it would have made memory less useful in order to
catch one key that a targeted rule catches anyway — the 64-hex MC key appears in text alongside
`api_key`/`apiKey` fields that C1 already covers.

C1 deserves separate emphasis. It **does not widen the keyword set at all** — it takes the keyword set
already shipped and trusted since ADR 0045 and makes it robust to one level of JSON escaping. Its
false-positive profile is therefore identical to rule 4's, which is a rule already in production. It is
also the largest win by volume: 300 previously-plaintext secret values across the three tables, in a
corpus where agent tool-call bodies are a dominant content form.

---

## 4. Recommendation

Ship **C1, C2, C3n, C4**. Reject **C2u** and **C5** with the numbers above.

C2 alone would close GAP-11-F's literal incident. C1 is what stops the *next* one: escaped-JSON tool
call bodies are how this corpus records nearly every credential it has ever seen, and rule 4 is blind
to all of them.

Every rejected rule's false-positive control cases should be pinned as passing assertions in
`tests/imports/secret-redactor.test.ts`, so that a future widening of C2 to C2u, or an addition of C5,
breaks a test rather than silently shredding memory.

---

## 5. Input to the propagation question (Task 3)

One census finding bears directly on whether derivation should re-scan for secrets, and is recorded
here so Task 3 can reason from evidence:

**The verbatim escaped rendering survives into exactly one summary — not 143.** GAP-11-F correctly
counts 143 contaminated summaries, but the summariser *paraphrased* the credential into most of them.
A re-scan at derivation time using import-shaped rules would therefore have caught approximately one of
those 143 rows. A second scanner on the derivation path would have bought roughly 0.7% of the
contamination it appears to promise, at the cost of running a regex battery over every contraction
slice. That asymmetry is the strongest argument in the propagation debate and it is empirical, not
architectural.
