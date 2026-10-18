// Test ballari va reyting: QuizPointsService + QuizService.recordResult (PGlite)
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
const { ArticlesModule } = require(BE + "dist/articles/articles.module");
const { ArticlesController } = require(BE + "dist/articles/articles.controller");
const { DatabaseModule } = require(BE + "dist/database/database.module");
const { QuizService } = require(BE + "dist/quiz/quiz.service");
const { QuizController } = require(BE + "dist/quiz/quiz.controller");
const { QuizPointsService, periodStart, publicName, pointsFor } = require(BE + "dist/quiz/quiz-points.service");
const { DraftsService } = require(BE + "dist/drafts/drafts.service");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

// 1) Sof funksiyalar
check("ball: 3/3 → 40, 2/3 → 20, 0/3 → 0", pointsFor(3, 3) === 40 && pointsFor(2, 3) === 20 && pointsFor(0, 3) === 0);
check("ism: familiya qisqaradi", publicName("Tolibjon Fayzullayev") === "Tolibjon F." && publicName("Ali") === "Ali" && publicName("") === "Foydalanuvchi");
// 2026-10-21 chorshanba 02:00 Toshkent = 2026-10-20 21:00 UTC → hafta boshi dushanba 19-oktabr 00:00 Toshkent
const wed = new Date(Date.UTC(2026, 9, 20, 21, 0));
check("hafta boshi: Toshkent dushanbasi 00:00", periodStart("week", wed).toISOString() === "2026-10-18T19:00:00.000Z", periodStart("week", wed).toISOString());
check("oy boshi: 1-oktabr 00:00 Toshkent", periodStart("month", wed).toISOString() === "2026-09-30T19:00:00.000Z");
// Yakshanba 23:30 Toshkent hali o'tgan haftaga tegishli
check("yakshanba kechasi — o'sha hafta", periodStart("week", new Date(Date.UTC(2026, 9, 25, 18, 30))).toISOString() === "2026-10-18T19:00:00.000Z");
check("all → null", periodStart("all") === null);

// 2) Nest ilova
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5503, host: "127.0.0.1" });
await server.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({})] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5503, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, AdminModule, ArticlesModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });
await app.init();
const admin = app.get(AdminService), quiz = app.get(QuizService), points = app.get(QuizPointsService);
const articlesCtrl = app.get(ArticlesController), quizCtrl = app.get(QuizController);
clearTimeout(quiz.timer); clearTimeout(app.get(DraftsService).timer);
await new Promise((r) => setTimeout(r, 500));
check("bitta QuizPointsService (QuizService va controller)", quiz.points === points && quizCtrl.points === points);

const cat = await admin.createCategory({ name: "Fan", slug: "Fan" });
const mkUser = async (name, role = "user") => (await db.query(`INSERT INTO users ("fullName", email, password, role, "createdAt", "updatedAt") VALUES ($1, $2, 'x', $3, now(), now()) RETURNING id`, [name, `${name.replace(/\W/g, "")}@t.uz`, role])).rows[0].id;
const adminId = await mkUser("Admin Bek", "admin");
const ali = await mkUser("Ali Valiyev"), vali = await mkUser("Vali Karimov"), guli = await mkUser("Guli");
const mk = (slug) => admin.createArticle({ title: `Maqola ${slug}`, slug, categoryId: cat.id, type: "free", status: "published", content: "https://r2.example/x.json", excerpt: "t" });
const A = await mk("a"), B = await mk("b"), C = await mk("c");
const QS = [
  { q: "1?", options: ["a", "b", "c", "d"], answer: 0, explain: "" },
  { q: "2?", options: ["a", "b", "c", "d"], answer: 2, explain: "" },
  { q: "3?", options: ["a", "b", "c", "d"], answer: 3, explain: "" },
];
for (const a of [A, B, C]) await db.query(`INSERT INTO article_quizzes ("articleId", questions) VALUES ($1, $2)`, [a.id, JSON.stringify(QS)]);
const send = (slug, answers, userId, correct = 3) => articlesCtrl.quizResult(slug, { correct, answers }, { user: userId ? { userId } : undefined });

// 3) Natija yozish
const r1 = await send("a", [0, 2, 3], ali, 0);
check("javoblar serverda tekshiriladi (mijoz 'correct' e'tiborsiz): 3/3, 40 ball", r1.correct === 3 && r1.awarded && r1.points === 40, JSON.stringify(r1));
check("javobda haftalik ball va o'rin", r1.week.points === 40 && r1.week.rank === 1);
const r2 = await send("a", [0, 0, 0], ali);
check("o'sha testni qayta yechish — ball berilmaydi", r2.awarded === false && r2.points === 0 && r2.correct === 1);
const r3 = await send("b", [0, 2], ali);
check("javoblar soni noto'g'ri — ball yo'q, faqat statistika", r3.ok && r3.awarded === undefined, JSON.stringify(r3));
const r4 = await send("b", [0, 2, 9], ali);
check("variant 0–3 dan tashqarida — ball yo'q", r4.awarded === undefined);
const g = await send("b", [0, 2, 3], undefined);
check("mehmon: natija statistikaga, ball yo'q", g.ok && g.correct === 3 && g.awarded === undefined);
const stat = (await db.query(`SELECT attempts, "correctTotal" FROM article_quizzes WHERE "articleId" = $1`, [A.id])).rows[0];
check("statistika: har urinish sanaladi", stat.attempts === 2 && stat.correctTotal === 4, JSON.stringify(stat));
let nf = ""; try { await send("yoq", [0, 0, 0], ali); } catch (e) { nf = e.constructor.name; }
check("yo'q maqola — NotFound", nf === "NotFoundException");

await send("b", [0, 2, 0], vali);   // 20
await send("c", [0, 2, 3], vali);   // 40 → vali 60
await send("b", [1, 1, 1], guli);   // 0
await send("a", [0, 2, 3], adminId); // admin 40
// O'tgan oydagi natija: faqat "umumiy"da ko'rinadi
await db.query(`INSERT INTO quiz_scores ("userId", "articleId", correct, total, points, "createdAt") VALUES ($1, 999, 3, 3, 100, now() - interval '40 days')`, [ali]);

// 4) Reyting
const wk = await quizCtrl.leaderboard("week", { user: { userId: vali } });
check("hafta: Vali 60 > Ali 40, 0 balli Guli va admin yo'q", wk.top.map((t) => `${t.name}:${t.points}`).join() === "Vali K.:60,Ali V.:40", JSON.stringify(wk.top));
check("hafta: 'me' belgisi va o'z o'rni", wk.top[0].me === true && wk.top[1].me === false && wk.me.rank === 1 && wk.me.points === 60);
check("aniqlik foizi: Vali 5/6 → 83%", wk.top[0].accuracy === 83);
const all = await quizCtrl.leaderboard("all", {});
check("umumiy: Ali 140 birinchi (eski natija bilan), me null", all.top[0].name === "Ali V." && all.top[0].points === 140 && all.me === null);
check("noto'g'ri davr → hafta", (await quizCtrl.leaderboard("yil", {})).period === "week");
const me = await quizCtrl.me({ user: { userId: ali } });
check("profil: umumiy 140 (1-o'rin), hafta 40 (2-o'rin)", me.all.points === 140 && me.all.rank === 1 && me.week.points === 40 && me.week.rank === 2, JSON.stringify(me));
const none = await quizCtrl.me({ user: { userId: await mkUser("Yangi Odam") } });
check("hali test yechmagan: 0 ball, o'rin yo'q", none.all.points === 0 && none.all.rank === null && none.all.quizzes === 0);

await app.close(); await server.stop(); await db.close();
console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
