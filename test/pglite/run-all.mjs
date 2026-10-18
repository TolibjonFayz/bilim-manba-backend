// Hamma integratsion testlarni ketma-ket ishga tushiradi va yakunini chiqaradi.
// Ishlatish (backend ildizidan): npm run test:pglite
// Faqat bittasini: node test/pglite/run-all.mjs school quiz
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const ALL = ["alerts", "quiz", "quiz-points", "fact-check", "school", "series", "stats", "channel-quiz", "drafts"];
const pick = process.argv.slice(2);
const suites = pick.length ? ALL.filter((s) => pick.includes(s)) : ALL;

const results = [];
for (const s of suites) {
  console.log(`\n===== ${s} =====`);
  const t = Date.now();
  const r = spawnSync(process.execPath, [`${DIR}${s}.mjs`], { stdio: "inherit" });
  results.push({ s, ok: r.status === 0, sec: Math.round((Date.now() - t) / 1000) });
}
console.log("\n===== YAKUN =====");
for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.s.padEnd(14)} ${r.sec}s`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} ta to'plam yiqildi` : "\nHammasi o'tdi");
process.exit(failed ? 1 : 0);
