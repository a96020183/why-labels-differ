// Official Meterless conformance suites against our two engines:
//   Markovian    engine/markovian/index.ts    (the night scan)
//   World Model  engine/world-model/index.ts  (the case state the "why" agents share)
// The runners are third-party (github.com/Meterless/Meterless at commit 1742dec5); they are downloaded into vendor/ on
// first use rather than committed. The output is also written to runs/conformance.log; the runners print the
// implementation's absolute path, which is shown as <repo> (no local path leaves this machine).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suites = [
  { name: "Markovian", runner: "vendor/markovian_spec/conformance/runner.ts", url: "engines/markovian/conformance/runner.ts", env: "MARKOVIAN_IMPL", impl: "engine/markovian/index.ts" },
  { name: "World Model", runner: "vendor/world_model_conformance/runner.ts", url: "engines/world-model/conformance/runner.ts", env: "WORLD_MODEL_IMPL", impl: "engine/world-model/index.ts" },
];
const mask = (t) => [root, root.split(path.sep).join("/")].reduce((x, r) => x.split(r).join("<repo>"), t ?? "");
const log = [];
let failed = 0;
for (const s of suites) {
  const runner = path.join(root, s.runner);
  if (!existsSync(runner)) {
    const r = await fetch("https://raw.githubusercontent.com/Meterless/Meterless/1742dec5/" + s.url);
    if (!r.ok) { log.push(`${s.name}: could not download the conformance runner (HTTP ${r.status})`); failed++; continue; }
    mkdirSync(path.dirname(runner), { recursive: true }); writeFileSync(runner, await r.text());
  }
  const out = spawnSync(process.execPath, ["--no-warnings", runner], { env: { ...process.env, [s.env]: path.join(root, s.impl).split(path.sep).join("/") }, encoding: "utf8" });
  log.push(`== ${s.name}`, mask(out.stdout) + mask(out.stderr));
  if (out.status) failed++;
}
const text = log.join("\n").replace(/\n*$/, "\n");
process.stdout.write(text);
mkdirSync(path.join(root, "runs"), { recursive: true });
writeFileSync(path.join(root, "runs", "conformance.log"), text);
process.exit(failed ? 1 : 0);
