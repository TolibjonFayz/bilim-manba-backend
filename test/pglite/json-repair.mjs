// AI javobidagi buzuq JSON'ni o'qish (src/drafts/json-repair.ts).
// 2026-11-16: "Spider-Man: Brand New Day" kino maqolasi shu sabab yozilmagan edi.
import { createRequire } from "module";
import { fileURLToPath } from "url";
const BE = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(BE + "package.json");
const { parseLlmJson, repairJson } = require(BE + "dist/drafts/json-repair");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };
const tryParse = (s) => { try { return parseLlmJson(s); } catch (e) { return { __err: e.message }; } };

// Aynan o'sha xato: sarlavha ichida ekranlanmagan qo'shtirnoq
const broken = '{"title": "O\'rgimchak-odam: "Yangi kun" filmi", "html": "<p>Film haqida <a href=\\"x\\">havola</a></p>", "tags": ["kino", "marvel"]}';
let err = null; try { JSON.parse(broken); } catch (e) { err = e.message; }
check("asl xato takrorlanadi (JSON.parse yiqiladi)", /Expected ',' or '}'/.test(err ?? ""), err);
const fixed = tryParse(broken);
check("tuzatiladi: sarlavha ichidagi qo'shtirnoq saqlanadi", fixed.title === 'O\'rgimchak-odam: "Yangi kun" filmi', JSON.stringify(fixed));
check("to'g'ri ekranlangan qo'shtirnoq buzilmaydi", fixed.html === '<p>Film haqida <a href="x">havola</a></p>');
check("massiv joyida", fixed.tags?.[1] === "marvel");
check("html atributidagi qo'shtirnoq (ekranlanmagan)", tryParse('{"html": "<a href="https://x.uz/a">bu</a> va <b class="k">q</b>", "excerpt": "e"}').html === '<a href="https://x.uz/a">bu</a> va <b class="k">q</b>');
check("qator ichida xom qator ko'chirish", tryParse('{"html": "<p>1</p>\n<p>2</p>"}').html === "<p>1</p>\n<p>2</p>");
check("oxirgi vergul", tryParse('{"a": [1, 2,], "b": "x",}').a?.length === 2);
check("```json o'rami va oldi-keyidagi matn", tryParse('Mana:\n```json\n{"a": "b"}\n```\nTamom').a === "b");
check("toza JSON o'zgarmaydi", JSON.stringify(tryParse('{"a":"x\\"y","n":1,"o":{"p":[true,null]}}')) === '{"a":"x\\"y","n":1,"o":{"p":[true,null]}}');
check("qator oxirida ':' — kalit", tryParse('{"q": "Kim "yutdi"?", "answer": 2}').answer === 2);
check("butunlay buzuq — xato otadi (jim o'tmaydi)", !!tryParse('{"a": ').__err);
check("repairJson toza matnga tegmaydi", repairJson('{"a":"b"}') === '{"a":"b"}');

console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
