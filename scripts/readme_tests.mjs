// Runs the test suite and writes its count into README.md between <!-- tests --> markers, so the README never states a
// number the suite does not produce. Usage: node scripts/readme_tests.mjs (exit 1 if a test fails; the README then
// says how many failed).
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync(process.execPath, ["--no-warnings", "--test", "test/app.test.ts"], { cwd: root, encoding: "utf8", env: { ...process.env, SAMPLE_MODE: "true" } });
const num = (k) => Number((r.stdout.match(new RegExp(`^ℹ ${k} (\\d+)`, "m")) ?? [])[1] ?? NaN);
const tests = num("tests"), fail = num("fail");
if (!Number.isFinite(tests)) { console.error("could not read the test count"); process.exit(2); }
const text = `<!-- tests -->${tests} tests${fail ? `, ${fail} failing` : ""}<!-- /tests -->`;
const p = path.join(root, "README.md");
const s = readFileSync(p, "utf8");
if (!/<!-- tests -->.*?<!-- \/tests -->/.test(s)) { console.error("README.md has no <!-- tests --> marker"); process.exit(2); }
writeFileSync(p, s.replace(/<!-- tests -->.*?<!-- \/tests -->/, text));
console.log(text);
process.exit(fail ? 1 : 0);
