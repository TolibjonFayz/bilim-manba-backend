// Maqola oxiridagi test: soxta AI + PGlite
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createRequire } from "module";
import { fileURLToPath } from "url";

// Backend ildizi (test/pglite/ dan ikki pog'ona yuqori); testlar dist/ ni ishlatadi — avval `npm run build`
const BE = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(BE);
const require = createRequire(BE + "package.json");
require("reflect-metadata");
const { Test } = require("@nestjs/testing");
const { SequelizeModule } = require("@nestjs/sequelize");
const { ConfigModule } = require("@nestjs/config");
const { AdminModule } = require(BE + "dist/admin/admin.module");
const { AdminService } = require(BE + "dist/admin/admin.service");
const { ArticlesModule } = require(BE + "dist/articles/articles.module");
const { ArticlesService } = require(BE + "dist/articles/articles.service");
const { DatabaseModule } = require(BE + "dist/database/database.module");
const { QuizService, normalizeQuiz, quizText } = require(BE + "dist/quiz/quiz.service");
const { DraftsService } = require(BE + "dist/drafts/drafts.service");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

// 1) Sof funksiyalar
const good = { questions: [
  { q: "Qora tuynukdan nima chiqa olmaydi?", options: ["Yorug'lik", "Faqat tovush", "Faqat issiqlik", "Hech narsa ushlamaydi"], answer: 0, explain: "Tortishish kuchi juda katta." },
  { q: "Savol 2?", options: ["a", "b", "c", "d"], answer: 2, explain: "x" },
  { q: "Savol 3?", options: ["e", "f", "g", "h"], answer: 3, explain: "y" },
  { q: "Ortiqcha 4-savol", options: ["1", "2", "3", "4"], answer: 1, explain: "z" },
] };
let seed = 7; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
const nq = normalizeQuiz(good, rnd);
check("normalize: aynan 3 ta savol", nq.length === 3);
check("normalize: aralashtirilgandan keyin ham to'g'ri javob saqlandi", nq[0].options[nq[0].answer] === "Yorug'lik" && nq[1].options[nq[1].answer] === "c" && nq[2].options[nq[2].answer] === "h", JSON.stringify(nq.map((q) => [q.options, q.answer])));
check("normalize: yaroqsizlar tashlanadi (3 variant, takror, noto'g'ri indeks) → test yo'q", normalizeQuiz({ questions: [
  { q: "a", options: ["1", "2", "3"], answer: 0 },
  { q: "b", options: ["1", "1", "2", "3"], answer: 0 },
  { q: "c", options: ["1", "2", "3", "4"], answer: 4 },
  good.questions[1],
] }).length === 0);
const html = "<h2>Kirish</h2><p>Matn &amp; yana matn.</p><h2>Shuningdek o'qing</h2><ul><li><a href='/x'>X</a></li></ul><h2>Manbalar</h2><ul><li>Wiki</li></ul>";
const qt = quizText(html);
check("quizText: teglar va 'Shuningdek o'qing'/'Manbalar' olib tashlanadi", qt.includes("Matn & yana matn.") && !qt.includes("Wiki") && !qt.includes("X") && !qt.includes("<"), qt);

// 2) Nest ilova
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5499, host: "127.0.0.1" });
await server.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({})] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5499, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, AdminModule, ArticlesModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });
await app.init();
const admin = app.get(AdminService), articles = app.get(ArticlesService), quiz = app.get(QuizService), drafts = app.get(DraftsService);
clearTimeout(quiz.timer); clearTimeout(drafts.timer);
await new Promise((r) => setTimeout(r, 500));

// R2 kontent va soxta AI
const longHtml = "<h2>Qora tuynuklar</h2>" + "<p>Qora tuynuk — tortishish kuchi shunchalik kuchli bo'lgan joyki, undan hatto yorug'lik ham chiqa olmaydi.</p>".repeat(12);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => String(url).startsWith("https://r2.example/") ? new Response(JSON.stringify({ message: longHtml }), { headers: { "content-type": "application/json" } }) : realFetch(url, init);
const prompts = []; let badNext = false; let failNext = 0;
quiz.llmOverride = { name: "fake", sourceBudget: 30000, json: async (sys, user) => {
  prompts.push({ sys, user });
  if (failNext > 0) { failNext--; throw new Error("Gemini 503"); }
  return JSON.stringify(badNext ? { questions: [] } : good);
} };

const cat = await admin.createCategory({ name: "Fan", slug: "Fan" });
await db.query(`INSERT INTO users ("fullName", email, password, role, "createdAt", "updatedAt") VALUES ('Admin','a@b.c','x','admin',now(),now())`);
const mk = (slug, status = "published", views = 0) => admin.createArticle({ title: `Maqola ${slug}`, slug, categoryId: cat.id, type: "free", status, content: "https://r2.example/" + slug + ".json", excerpt: "x" }).then(async (a) => { await db.query(`UPDATE articles SET "viewCount"=$1 WHERE id=$2`, [views, a.id]); return a; });

// Chop etilganda test fonda tuziladi
const a1 = await mk("birinchi");
for (let i = 0; i < 40 && !(await quiz.forArticle(a1.id)); i++) await new Promise((r) => setTimeout(r, 100));
const q1 = await quiz.forArticle(a1.id);
check("chop etilganda test avtomatik tuzildi", Array.isArray(q1) && q1.length === 3, JSON.stringify(q1)?.slice(0, 120));
check("AI promptida qoidalar va maqola matni", /Aynan 3 ta savol/.test(prompts.at(-1).sys) && /Islom/.test(prompts.at(-1).sys) && prompts.at(-1).user.includes("Sarlavha: Maqola birinchi") && prompts.at(-1).user.includes("Qora tuynuk"));

// Maqola sahifasi testni qaytaradi; ro'yxatlar og'irlashmaydi
const page = await articles.findBySlug("birinchi");
check("maqola sahifasida quiz bor", page.quiz?.length === 3 && page.quiz[0].options.length === 4);
const list = await articles.findAll();
check("maqolalar ro'yxatida quiz yo'q", list.length >= 1 && list.every((x) => x.toJSON().quiz === undefined));
const draft = await mk("qoralama", "draft");
check("qoralama chop etilmaguncha test tuzilmaydi", (await quiz.forArticle(draft.id)) === null);

// Natija
check("natija: 2 to'g'ri → saqlandi", (await articles.quizResult("birinchi", 2)).ok === true);
await articles.quizResult("birinchi", 3);
check("natija: noto'g'ri qiymat (5, -1, NaN) qabul qilinmaydi", (await articles.quizResult("birinchi", 5)).ok === false && (await articles.quizResult("birinchi", -1)).ok === false && (await articles.quizResult("birinchi", NaN)).ok === false);
const st = (await db.query(`SELECT attempts, "correctTotal" FROM article_quizzes WHERE "articleId"=$1`, [a1.id])).rows[0];
check("natija: urinishlar 2, to'g'ri javoblar 5", st.attempts === 2 && st.correctTotal === 5, JSON.stringify(st));
let nf = null; try { await articles.quizResult("yoq-maqola", 1); } catch (e) { nf = e; }
check("natija: yo'q maqola → 404", nf?.status === 404);

// Eski maqolalarni to'ldirish: ko'p o'qilganidan boshlab, testi borlar o'tkaziladi
await db.query(`DELETE FROM article_quizzes`);
const old1 = await mk("eski-kam", "draft", 5), old2 = await mk("eski-kop", "draft", 500);
await db.query(`UPDATE articles SET status='published' WHERE id IN ($1,$2)`, [old1.id, old2.id]); // afterPublish'siz (eski maqolalar)
await quiz.generateFor(a1.id);
prompts.length = 0;
const n = await quiz.backfill(0);
check("to'ldirish: testi yo'q 2 ta maqola, ko'p o'qilgani birinchi", n === 2 && prompts[0].user.includes("eski-kop") && prompts[1].user.includes("eski-kam") && !prompts.some((p) => p.user.includes("Maqola birinchi")), prompts.map((p) => p.user.slice(0, 25)).join(" | "));
await db.query(`DELETE FROM article_quizzes WHERE "articleId" IN ($1,$2)`, [old1.id, old2.id]);
failNext = 5;
check("to'ldirish: ketma-ket 3 xato → to'xtaydi", (await quiz.backfill(0)) === 0 && failNext === 3, String(failNext));
failNext = 0;
badNext = true;
check("AI yaroqsiz test qaytarsa — saqlanmaydi", (await quiz.generateFor(old1.id)) === false && (await quiz.forArticle(old1.id)) === null);
badNext = false;

// Admin chop etilgan maqola matnini o'zgartirsa — test qayta tuziladi
await quiz.generateFor(old1.id);
prompts.length = 0;
await admin.updateArticle(old1.id, { content: "https://r2.example/eski-kam-v2.json" });
for (let i = 0; i < 30 && !prompts.length; i++) await new Promise((r) => setTimeout(r, 100));
check("admin matnni o'zgartirdi → test qayta tuzildi", prompts.length === 1);
prompts.length = 0;
await admin.updateArticle(old1.id, { title: "Faqat sarlavha" });
await new Promise((r) => setTimeout(r, 500));
check("faqat sarlavha o'zgarsa — test qayta tuzilmaydi", prompts.length === 0);

// Kalit yo'q — jim
quiz.llmOverride = undefined;
check("AI kaliti yo'q — generateFor false, backfill 0", (await quiz.generateFor(old2.id)) === false && (await quiz.backfill(0)) === 0);

await app.close(); await server.stop(); await db.close();
console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
