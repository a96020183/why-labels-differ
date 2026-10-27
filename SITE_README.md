# A′ · Why Labels Differ — recorded demo

Open `index.html` directly, or serve this entire folder with any static web server. There is no installation, build step, account, key, Docker service or internet connection to configure. Keep the `assets` and `data` folders beside the HTML file. Paths work under a project subdirectory, including GitHub Pages.

Start with the loaded **Gemcitabine and DRESS** case. Choose another recorded case and select **Open recorded case**. The badge distinguishes an agent-approved draft from a hand-off. Neither is a pharmacist's sign-off. The product prepares drafts for hospital medication-safety pharmacists; a pharmacist reviews and signs off before release. This is not medical advice and has not been reviewed by a pharmacist.

## Explore the recording

- **Evidence chain:** compare tested explanations, expand the review decisions, inspect the four regulatory positions, and select an evidence chip to open its passage and SQL receipt.
- **Open trace drawer:** inspect returned drafts and the recorded responses. Select **Open full agent trace** for every event, including structured Writer drafts, Skeptic findings, model responses and program checks. The saved requested and served models remain visible.
- **Agent trace:** replay the saved events, pause, step forward, or choose Instant playback. The evidence chain continues to show the final snapshot; playback does not run an investigation.
- **Night scan:** inspect the recorded prompt-size chart, saved scan steps and divergence ledger. Only entries with a bundled investigation offer an Open recorded case button. The Markovian engine is not executed in the browser.
- **Reopen:** show two real 2026 label changes, with the stored warning-section and all-section query receipts. The committee decisions in this demonstration are illustrative.
- **Scoreboard:** inspect the source repository's results, including the stronger S′ comparison and the confidence intervals. Answer keys were labelled by an independent AI reviewer, not a pharmacist.
- **About this replay:** read limitations and download the exported data and source hashes.

## Recorded data and final offline checks

The five cases use saved Zetaris answers and Nightshift model replies. They match the committed case traces before public-display redaction. The final checks were applied offline, without asking a model again. The five-case outcome is **2 approved drafts and 3 hand-offs**.

For the separate 10-question v6 evaluation, **the original recording approved 6, with 4 correct**. Under the final offline checks, **5 are approved, with 4 correct; 5 are handed to a person**. R161 changes to a hand-off. The single-classification arm is distinct from the full agent loop. S′ answers more of the 35 U.S.-label questions correctly. See the Scoreboard and repository README, Results and Limits, before quoting any result.

The Skeptic can interpret the same evidence in opposite ways across rounds, and the Evaluator can request opposite changes. Sertraline and valproate retain these unresolved problems. Darolutamide's approved undetermined cause would be better described as the same position. Some MHRA and FDA publications are absent from the loaded evidence. R167 is counted wrong against an uncertain answer key that was not changed after the run.

## Public-display boundaries

Patient counts are synthetic: Synthea plus a seeded overlay. No patient list or personal identifiers are included. A visitor cannot vote, sign off, release advice, ask a new question, query a live system or run a new scan. The two approved cases expose only their saved committee outcome; the reopen demonstration labels its committee decisions illustrative.

Manufacturer and unrelated provider names are replaced with `[name omitted]` in passages, SQL and record identifiers. Database service identities are also omitted. These excerpts are not byte-exact originals. Recorded exact-quote checks describe what the original program checked; this website does not rerun them against redacted text. Receipt result hashes belong to the original replay results, not the displayed redacted excerpts. Case-event times come from committed traces; receipt and reopen-export times come from the offline export.

Regulatory source URLs are plain text inside evidence drawers. There are no remote fonts, images, analytics or API calls. Content Security Policy blocks connections. All working site links are relative. The required GitHub README link retains the literal `https://github.com/a96020183/why-labels-differ` placeholder. Until the coordinator replaces it, clicking it explains that the repository link is pending. It does not navigate to a broken address. Required sponsor and hosting-service names remain where the brief explicitly calls for them.

The required fixed notice stays on one line. On a narrow screen, scroll the notice horizontally to read all of it; keyboard users can focus it and scroll. The rest of the page reflows without horizontal page scrolling. Wide data tables scroll within their own region.

## Data and provenance

`data/replay.json` is the canonical public export. `assets/replay-data.js` carries exactly the same JSON through a classic script so direct file opening does not require a fetch request. Individual case trace JSON files and `data/provenance.json` preserve traceability to repository-relative source paths and SHA-256 hashes. The source repository stays outside this delivery folder and is not needed to view it.

Source commit: `f0d1319bde83b4b8f80b2ab228f8e63a30e8f242`.

The visual language and core evidence-chain, review-trail, stage-ladder, receipt, scan-chart and scoreboard renderers are adapted from the product UI. Typography uses the product CSS's installed-system fallbacks. No font binaries or remote font requests are included.
