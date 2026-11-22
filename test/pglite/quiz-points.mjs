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
const ctx = (userId) => ({ user: userId ? { userId } : undefined });
const pick = (slug, i, choice, userId) => quizCtrl.check(slug, { i, choice }, ctx(userId));
// Foydalanuvchi har savolni bosadi (birinchi tanlov serverda yoziladi), keyin natija yuboriladi
const send = async (slug, answers, userId, correct = 3) => {
  for (let i = 0; i < answers.length; i++) if (answers[i] >= 0 && answers[i] <= 3) await pick(slug, i, answers[i], userId).catch(() => {});
  return articlesCtrl.quizResult(slug, { correct, answers }, ctx(userId));
};

// 3) Javobni tekshirish (to'g'ri javob sahifaga berilmaydi)
const c1 = await pick("a", 1, 2);
check("check: to'g'ri javob → correct, answer va izoh qaytadi", c1.correct === true && c1.answer === 2 && "explain" in c1, JSON.stringify(c1));
const c2 = await pick("a", 1, 0);
check("check: noto'g'ri javob → correct false, to'g'risi 2", c2.correct === false && c2.answer === 2);
let bad = ""; try { await pick("a", 7, 0); } catch (e) { bad = e.constructor.name; }
let bad2 = ""; try { await pick("a", 0, 9); } catch (e) { bad2 = e.constructor.name; }
check("check: yo'q savol / variant 0–3 dan tashqari → BadRequest", bad === "BadRequestException" && bad2 === "BadRequestException", bad + " " + bad2);
check("mehmon check — bazaga tanlov yozilmaydi", (await db.query(`SELECT COUNT(*)::int n FROM quiz_picks`)).rows[0].n === 0);

// 4) Natija yozish
const r1 = await send("a", [0, 2, 3], ali, 0);
check("ball serverdagi tanlovlardan: 3/3, 40 ball (mijoz 'correct' e'tiborsiz)", r1.correct === 3 && r1.awarded && r1.points === 40, JSON.stringify(r1));
check("javobda haftalik ball va o'rin", r1.week.points === 40 && r1.week.rank === 1);
const r2 = await send("a", [0, 0, 0], ali);
check("o'sha testni qayta yechish — ball berilmaydi", r2.awarded === false && r2.points === 0 && r2.correct === 3, JSON.stringify(r2));
// Aldash: avval noto'g'ri bosib, keyin to'g'ri javobni bilib "answers" bilan yuborish
await pick("b", 0, 1, guli); await pick("b", 1, 1, guli); await pick("b", 2, 1, guli);
const cheat = await articlesCtrl.quizResult("b", { correct: 3, answers: [0, 2, 3] }, ctx(guli));
check("aldash: mijoz to'g'ri 'answers' yuborsa ham — birinchi tanlovlar bo'yicha 0 ball", cheat.awarded === true && cheat.correct === 0 && cheat.points === 0, JSON.stringify(cheat));
const partial = await articlesCtrl.quizResult("c", { correct: 3, answers: [0, 2, 3] }, ctx(ali));
check("savollar bosilmagan (tanlov yo'q) — ball yo'q, faqat statistika", partial.ok && partial.awarded === undefined, JSON.stringify(partial));
const g = await send("b", [0, 2, 3], undefined);
check("mehmon: natija statistikaga, ball yo'q", g.ok && g.correct === 3 && g.awarded === undefined);
const stat = (await db.query(`SELECT attempts, "correctTotal" FROM article_quizzes WHERE "articleId" = $1`, [A.id])).rows[0];
check("statistika: har urinish sanaladi", stat.attempts === 2 && stat.correctTotal === 4, JSON.stringify(stat));
let nf = ""; try { await send("yoq", [0, 0, 0], ali); } catch (e) { nf = e.constructor.name; }
check("yo'q maqola — NotFound", nf === "NotFoundException");

// 5) Mehmon natijasini yangi akkauntga saqlash (claim)
const newbie = await mkUser("Yangi Mehmon");
const cl = await quizCtrl.claim({ slug: "c", answers: [0, 2, 0] }, { user: { userId: newbie } });
check("claim: yangi akkaunt → 2/3, 20 ball", cl.awarded === true && cl.correct === 2 && cl.points === 20, JSON.stringify(cl));
let again = ""; try { await quizCtrl.claim({ slug: "a", answers: [0, 2, 3] }, { user: { userId: newbie } }); } catch (e) { again = e.constructor.name; }
check("claim: ikkinchi marta — Forbidden (bali bor)", again === "ForbiddenException", again);
const oldUser = await mkUser("Eski Akkaunt");
await db.query(`UPDATE users SET "createdAt" = now() - interval '3 days' WHERE id = $1`, [oldUser]);
let old = ""; try { await quizCtrl.claim({ slug: "a", answers: [0, 2, 3] }, { user: { userId: oldUser } }); } catch (e) { old = e.constructor.name; }
check("claim: 24 soatdan eski akkaunt — Forbidden", old === "ForbiddenException", old);
let badc = ""; try { await quizCtrl.claim({ slug: "a", answers: [0, 2] }, { user: { userId: await mkUser("Boshqa Yangi") } }); } catch (e) { badc = e.constructor.name; }
check("claim: noto'g'ri javoblar soni — BadRequest", badc === "BadRequestException", badc);
await db.query(`DELETE FROM quiz_scores WHERE "userId" IN ($1, $2)`, [newbie, guli]);

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
