// AI qoralamalar fakt-tekshiruvi: FactCheckService (soxta AI) + PGlite
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const BE = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(BE);
const require = createRequire(BE + "package.json");
require("reflect-metadata");
const { Test } = require("@nestjs/testing");
const { SequelizeModule } = require("@nestjs/sequelize");
const { ConfigModule } = require("@nestjs/config");
const { AdminModule } = require(BE + "dist/admin/admin.module");
const { AdminService } = require(BE + "dist/admin/admin.service");
const { AdminController } = require(BE + "dist/admin/admin.controller");
const { DatabaseModule } = require(BE + "dist/database/database.module");
const { QuizService } = require(BE + "dist/quiz/quiz.service");
const { DraftsService } = require(BE + "dist/drafts/drafts.service");
const { FactCheckService, normalizeIssues } = require(BE + "dist/drafts/fact-check.service");
const { AdminAlertService } = require(BE + "dist/publishing/admin-alert.service");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) Sof: AI javobini tozalash
const text = "Napoleon 1769-yilda Korsikada tug‘ilgan. U 1804-yilda imperator bo'ldi va 50 ta jangda g'olib chiqdi.";
const n = normalizeIssues({ issues: [
  { quote: "U 1804-yilda imperator bo'ldi", type: "zid", note: "Manbada 1805", fix: "1805" },
  { quote: "«Korsikada tug'ilgan»", type: "nimadir", note: "Manbada yo'q" },
  { quote: "Bu jumla maqolada umuman yo'q", type: "zid", note: "to'qilgan" },
  { quote: "U 1804-yilda imperator bo'ldi", type: "zid", note: "takror" },
  { quote: "qisqa", type: "zid", note: "juda qisqa" },
  { quote: "50 ta jangda g'olib chiqdi", type: "tasdiqlanmagan", note: "" },
] }, text);
check("normalize: faqat maqolada bor, takrorsiz, izohli parchalar (2 ta)", n.length === 2, JSON.stringify(n));
check("normalize: noma'lum tur → 'tasdiqlanmagan', tutuq belgilari moslashadi", n[1].type === "tasdiqlanmagan" && n[1].quote === "Korsikada tug'ilgan");
check("normalize: fix saqlanadi", n[0].fix === "1805" && n[1].fix === undefined);
check("normalize: yaroqsiz javob → []", normalizeIssues(null, text).length === 0 && normalizeIssues({ issues: "x" }, text).length === 0);

// 2) Nest ilova
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5504, host: "127.0.0.1" });
await server.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({})] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5504, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, AdminModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });
await app.init();
const admin = app.get(AdminService), fc = app.get(FactCheckService), drafts = app.get(DraftsService), ctrl = app.get(AdminController), alerts = app.get(AdminAlertService);
clearTimeout(app.get(QuizService).timer); clearTimeout(drafts.timer);
await sleep(500);
check("bitta FactCheckService (qoralamalar va admin)", drafts.factCheck === fc);

const cat = await admin.createCategory({ name: "Tarix", slug: "Tarix" });
await db.query(`INSERT INTO users ("fullName", email, password, role, "createdAt", "updatedAt") VALUES ('Admin','a@b.c','x','admin',now(),now())`);
const art = await admin.createArticle({ title: "Napoleon", slug: "napoleon", categoryId: cat.id, type: "free", status: "draft", content: "https://r2.example/napoleon.json", excerpt: "t" });

check("AI kaliti yo'q — tekshiruv o'tkazib yuboriladi (null)", (await fc.check(art.id, `<p>${text}</p>`, "[1] manba")) === null);
check("tekshirilmagan maqola: state none, count null", (await fc.get(art.id)).state === "none" && (await fc.count(art.id)) === null);

// Soxta AI
const prompts = []; let reply = {}; let failNext = false;
fc.llmOverride = { name: "fake", sourceBudget: 30000, json: async (sys, user) => { prompts.push({ sys, user }); if (failNext) { failNext = false; throw new Error("Gemini 503"); } return JSON.stringify(reply); } };

const html = `<h2>Kirish</h2><p>${text}</p><h2>Shuningdek o'qing</h2><ul><li>Boshqa maqola 1804-yilda</li></ul><h2>Manbalar</h2><ul><li>Wikipedia</li></ul>`;
reply = { issues: [{ quote: "U 1804-yilda imperator bo'ldi", type: "zid", note: "Manbada 1805-yil", fix: "1805-yilda" }, { quote: "Boshqa maqola 1804-yilda", type: "zid", note: "bu Shuningdek o'qing qismida" }] };
const issues = await fc.check(art.id, html, "[1] Wikipedia — Napoleon\nNapoleon 1769-yilda tug'ilgan, 1805-yilda imperator.");
check("tekshiruv: 1 ta shubhali joy ('Shuningdek o'qing' va 'Manbalar' tekshirilmaydi)", issues?.length === 1 && issues[0].fix === "1805-yilda", JSON.stringify(issues));
check("prompt: manbalar va maqola matni (teglarsiz) bilan", prompts.at(-1).user.includes("MANBALAR:") && prompts.at(-1).user.includes("1805-yilda imperator") && !prompts.at(-1).user.includes("<p>") && !prompts.at(-1).user.includes("Boshqa maqola"));
check("prompt: umumma'lum faktlarni belgilamaslik so'raladi", /umumma'lum/.test(prompts.at(-1).sys));
let st = await ctrl.factCheck(String(art.id));
check("admin GET: done, 1 ta, qayta tekshirsa bo'ladi", st.state === "done" && st.issues.length === 1 && st.canRecheck === true, JSON.stringify(st));
check("count: 1", (await fc.count(art.id)) === 1);

// 3) Telegram xabari
const sent = []; alerts.send = async (text, btn) => { sent.push(text); return true; };
await alerts.draftReady({ id: 1, title: "Napoleon" }, true, 2);
await alerts.draftReady({ id: 1, title: "Napoleon" }, false, 0);
await alerts.draftReady({ id: 1, title: "Napoleon" }, false, null);
check("xabar: '2 ta shubhali joy'", /2 ta shubhali joy/.test(sent[0]));
check("xabar: 0 — 'topilmadi'", /shubhali joy topilmadi/.test(sent[1]));
check("xabar: tekshirilmagan — fakt-tekshiruv qatori yo'q", !/Fakt-tekshiruv/.test(sent[2]));

// 4) Qayta tekshirish (admin tahrirlagan matn R2'dan olinadi)
const realFetch = globalThis.fetch;
let r2 = `<p>${text.replace("1804", "1805")}</p>`;
globalThis.fetch = async (url, init) => String(url).startsWith("https://r2.example/") ? new Response(JSON.stringify({ message: r2 }), { headers: { "content-type": "application/json" } }) : realFetch(url, init);
reply = { issues: [] };
const started = await ctrl.factRecheck(String(art.id));
check("qayta tekshirish: darhol 'running' qaytadi", started.state === "running");
check("tekshirilayotganda GET ham 'running'", (await ctrl.factCheck(String(art.id))).state === "running");
for (let i = 0; i < 50 && (await fc.get(art.id)).state === "running"; i++) await sleep(50);
st = await ctrl.factCheck(String(art.id));
check("qayta tekshiruv: yangi matn va saqlangan manbalar bilan, 0 ta", st.state === "done" && st.issues.length === 0 && prompts.at(-1).user.includes("1805-yilda imperator bo'ldi") && prompts.at(-1).user.includes("Napoleon 1769-yilda tug'ilgan"), JSON.stringify(st));

failNext = true;
await ctrl.factRecheck(String(art.id));
for (let i = 0; i < 50 && (await fc.get(art.id)).state === "running"; i++) await sleep(50);
st = await ctrl.factCheck(String(art.id));
check("AI xatosi: failed, xato matni, manbalar saqlanib qoladi", st.state === "failed" && /503/.test(st.error) && st.canRecheck === true, JSON.stringify(st));
check("failed bo'lsa count null", (await fc.count(art.id)) === null);

const manual = await admin.createArticle({ title: "Qo'lda", slug: "qolda", categoryId: cat.id, type: "free", status: "draft", content: "https://r2.example/q.json", excerpt: "t" });
let err = ""; try { await ctrl.factRecheck(String(manual.id)); } catch (e) { err = e.constructor.name; }
check("qo'lda yozilgan maqola (manbasiz) — tushunarli xato", err === "NotFoundException", err);
err = ""; try { await ctrl.factRecheck("99999"); } catch (e) { err = e.constructor.name; }
check("yo'q maqola — BadRequest", err === "BadRequestException", err);

globalThis.fetch = realFetch;
await app.close(); await server.stop(); await db.close();
console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
