// Claude yozuvchi (src/drafts/llm.ts): so'rov shakli, JSON ajratish, zaxiraga o'tish.
// Haqiqiy API chaqirilmaydi (soxta mijoz). REAL=1 bo'lsa — .env dagi kalit bilan
// bitta kichik so'rov (pul ketadi!).
import { createRequire } from "module";
import { fileURLToPath } from "url";

const BE = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(BE);
const require = createRequire(BE + "package.json");
const { createClaudeLlm, createLlm, withFallback, extractJson } = require(BE + "dist/drafts/llm");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

check("extractJson: ```json o'rami", extractJson('Mana:\n```json\n{"a":1}\n```') === '{"a":1}');
check("extractJson: oldi-keyidagi matn", extractJson('Javob {"a":{"b":2}} tamom') === '{"a":{"b":2}}');
check("extractJson: toza JSON o'zgarmaydi", extractJson(' {"x":"y"} ') === '{"x":"y"}');

// Soxta Anthropic mijozi: so'rovni yozib oladi, berilgan javobni qaytaradi
const fake = (reply) => {
  const calls = [];
  return {
    calls,
    messages: {
      stream(params) {
        calls.push(params);
        return { finalMessage: async () => (typeof reply === "function" ? reply(params) : reply) };
      },
    },
  };
};
const msg = (text, stop_reason = "end_turn") => ({ stop_reason, content: [{ type: "thinking", thinking: "" }, { type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } });

const c1 = fake(msg('```json\n{"title":"Sarlavha","html":"<p>Matn</p>"}\n```'));
const llm = createClaudeLlm("k", undefined, undefined, c1);
const out = JSON.parse(await llm.json("Sen muharrirsan.", "Maqola yoz"));
const p = c1.calls[0];
check("javob JSON bo'lib qaytadi", out.title === "Sarlavha");
check("standart model claude-opus-5-5, effort medium", p.model === "claude-opus-5-5" && p.output_config?.effort === "medium", JSON.stringify({ m: p.model, e: p.output_config }));
check("system + JSON qoidasi, user xabari", p.system.startsWith("Sen muharrirsan.") && /FAQAT bitta JSON/.test(p.system) && p.messages[0].role === "user" && p.messages[0].content === "Maqola yoz");
check("temperature/thinking/prefill yuborilmaydi", !("temperature" in p) && !("thinking" in p) && p.messages.length === 1);
check("max_tokens 32000 (streaming)", p.max_tokens === 32000);
check("nomi claude:...", llm.name === "claude:claude-opus-5-5");

const c2 = fake(msg('{"pick":1}'));
await createClaudeLlm("k", "claude-sonnet-5-5", "high", c2).vision("Tanla", "Qaysi rasm?", [{ mime: "image/jpeg", data: "QUJD" }]);
const v = c2.calls[0];
check("vision: rasm base64 blok + matn, model/effort env'dan", v.model === "claude-sonnet-5-5" && v.output_config.effort === "high" && v.messages[0].content[0].type === "image" && v.messages[0].content[0].source.data === "QUJD" && v.messages[0].content[1].text === "Qaysi rasm?" && v.max_tokens === 4000);

for (const [name, reply] of [["refusal", msg("", "refusal")], ["max_tokens", msg('{"a":', "max_tokens")], ["bo'sh javob", msg("  ")]]) {
  let err = null;
  try { await createClaudeLlm("k", undefined, undefined, fake(reply)).json("s", "u"); } catch (e) { err = e; }
  check(`${name} → xato (zaxiraga o'tish uchun)`, !!err, err?.message);
}

// Zaxira: Claude yiqilsa — Gemini javobi
const broken = { name: "claude:x", sourceBudget: 40000, json: async () => { throw new Error("credit balance is too low"); }, vision: async () => { throw new Error("x"); } };
const backup = { name: "gemini:y", sourceBudget: 30000, json: async (s, u) => `{"from":"gemini","u":"${u}"}`, vision: async () => '{"v":"gemini"}' };
const wf = withFallback(broken, backup);
check("zaxira: Claude xato → Gemini javobi", JSON.parse(await wf.json("s", "salom")).from === "gemini");
check("zaxira: vision ham", JSON.parse(await wf.vision("s", "u", [])).v === "gemini");
check("zaxira: nomi ikkalasini ko'rsatadi, budjet kichigi", wf.name === "claude:x (zaxira: gemini:y)" && wf.sourceBudget === 30000);
const okFirst = withFallback({ ...backup, name: "claude:ok", json: async () => '{"from":"claude"}' }, backup);
check("zaxira: Claude ishlasa Gemini chaqirilmaydi", JSON.parse(await okFirst.json("s", "u")).from === "claude");

const combo = createLlm({ claudeKey: "k", geminiKey: "g" });
check("createLlm: claude + gemini zaxira", combo.name === "claude:claude-opus-5-5 (zaxira: gemini:gemini-flash-latest)", combo.name);
check("createLlm: claudeKey'siz — avvalgidek Gemini", createLlm({ geminiKey: "g" }).name === "gemini:gemini-flash-latest");

if (process.env.REAL === "1") {
  require("dotenv").config({ quiet: true });
  try {
    const r = await createClaudeLlm(process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_MODEL || undefined, "low").json("Sen o'zbek tilida yozasan.", 'Kitob haqida bitta gap yoz. {"gap": "..."} ko\'rinishida.');
    console.log("REAL:", r);
  } catch (e) { console.log("REAL xato:", String(e.message).slice(0, 300)); }
}

console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
