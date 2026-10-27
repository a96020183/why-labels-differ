// Port of the spec's reference/scripts/measured-run.ts against OUR engine: same 20-step task, same mock outputs,
// Markovian vs naive full history. All numbers estimated (chars/4). Then one real Nightshift call to show a
// measured number with the served model. Usage: node engine/measured-run.ts [--live]
import { Markovian, estimateTokens } from "./markovian/index.ts";
import { chat } from "./nightshift.ts";

const STEPS = 20;
const out = (s: number) => `Step ${s}: derived requirements, compared options, recorded the decision for this stage. `.repeat(12) + "\n" +
  (s >= STEPS ? "[TASK_COMPLETE]" : `[STATE_CHECKPOINT]\nCOMPLETED: steps 1-${s}\nREMAINING: steps ${s + 1}-${STEPS}\nDECISIONS: option-${s} locked\nCONTEXT: measured-run demo`);
const goal = "Design a rollout plan for a local-first sync engine across 20 workstreams";
const mk: number[] = [];
await new Markovian({ chunkConfig: { chunkSize: 4000, carryoverTokens: 640 }, clock: () => 0 })
  .run({ goal, reflect: false, generator: async (p) => { mk.push(estimateTokens(p)); return { text: out(mk.length) }; } });
const nv: number[] = []; let h = "";
for (let s = 1; s <= STEPS; s++) { nv.push(estimateTokens(`${goal}\n\n[FULL HISTORY]\n${h}\n\nContinue with step ${s}.`)); h += "\n" + out(s); }
let a = 0, b = 0; console.log("step | naive cum | markovian cum | max markovian step");
for (let i = 0; i < STEPS; i++) { a += nv[i]; b += mk[i]; if ((i + 1) % 5 === 0) console.log(`${i + 1} | ${a} | ${b} | ${Math.max(...mk.slice(0, i + 1))}`); }
console.log(`saved ${a - b} input tokens (${(((a - b) / a) * 100).toFixed(1)}%, estimated); largest Markovian step prompt ${Math.max(...mk)} tokens`);
if (process.argv.includes("--live")) {
  const r = await chat([{ role: "user", content: "Reply with the single word: ready" }], { model: "nvidia/nemotron-3.5-lightning-30b-a3b", maxTokens: 400, tag: "aprime-smoke" });
  console.log(`live: requested nvidia/nemotron-3.5-lightning-30b-a3b, served ${r.served}, usage ${JSON.stringify(r.usage)} (measured), think stripped=${r.hadThink}, text="${r.text.slice(0, 40)}"`);
}
