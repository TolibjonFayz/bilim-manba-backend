// Telegram kanaldagi "Kun savoli": ChannelQuizService (soxta Telegram) + PGlite
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
const { ChannelQuizService } = require(BE + "dist/publishing/channel-quiz.service");
const { TelegramService } = require(BE + "dist/publishing/telegram.service");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5502, host: "127.0.0.1" });
await server.start();
const env = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHANNEL_ID: "@bilim_test", SITE_URL: "https://bilimmanba.uz" };
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5502, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, AdminModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });
await app.init();
const admin = app.get(AdminService), cq = app.get(ChannelQuizService), tg = app.get(TelegramService), ctrl = app.get(AdminController);
clearTimeout(app.get(QuizService).timer); clearTimeout(app.get(DraftsService).timer); clearTimeout(cq.timer);
await new Promise((r) => setTimeout(r, 500));

check("bitta TelegramService (kanal post va kun savoli)", cq.telegram === tg);

// Soxta Telegram
const calls = []; let tgFail = false;
tg.call = async (method, body) => { if (tgFail) throw new Error("Telegram sendPoll: Bad Request"); calls.push({ method, body }); return { message_id: calls.length }; };

// Maqola chop etilganda kanalga oddiy post ham ketadi — faqat so'rovnomalarni sanaymiz
const polls = () => calls.filter((c) => c.method === "sendPoll");

// 1) Sof: Telegram cheklovlari
const Q = (q, options, answer = 0, explain = "Chunki shunday.") => ({ q, options, answer, explain });
check("fit: oddiy savol sig'adi", ChannelQuizService.fit(Q("Savol?", ["a", "b", "c", "d"])) !== null);
check("fit: 300+ belgili savol sig'maydi", ChannelQuizService.fit(Q("x".repeat(290), ["a", "b"])) === null);
check("fit: 100+ belgili variant sig'maydi", ChannelQuizService.fit(Q("Savol?", ["a", "b".repeat(101)])) === null);
check("fit: noto'g'ri javob indeksi", ChannelQuizService.fit(Q("Savol?", ["a", "b"], 5)) === null);

// 2) Ma'lumot: 3 ta chop etilgan maqola (biri sig'maydigan testli), 1 qoralama, 1 testsiz
const cat = await admin.createCategory({ name: "Fan", slug: "Fan" });
await db.query(`INSERT INTO users ("fullName", email, password, role, "createdAt", "updatedAt") VALUES ('Admin','a@b.c','x','admin',now(),now())`);
const mk = (slug, status = "published") => admin.createArticle({ title: `Maqola ${slug}`, slug, categoryId: cat.id, type: "free", status, content: "https://r2.example/x.json", excerpt: "t" });
const a1 = await mk("qora-tuynuk"), a2 = await mk("fotosintez"), a3 = await mk("uzun"), a4 = await mk("qoralama", "draft"), a5 = await mk("testsiz");
const setQuiz = (id, qs) => db.query(`INSERT INTO article_quizzes ("articleId", questions) VALUES ($1, $2)`, [id, JSON.stringify(qs)]);
await setQuiz(a1.id, [Q("Qora tuynukdan nima chiqa olmaydi?", ["Yorug'lik", "Tovush", "Issiqlik", "Hech narsa"], 0, "Tortishish kuchi juda katta: hatto yorug'lik ham qochib qutula olmaydi va shuning uchun u qora ko'rinadi. ".repeat(3))]);
await setQuiz(a2.id, [Q("Fotosintez qayerda boradi?", ["Xloroplastda", "Yadroda", "Ildizda", "Po'stda"], 0)]);
await setQuiz(a3.id, [Q("Uzun?", ["a", "b".repeat(150)])]);
await setQuiz(a4.id, [Q("Qoralama savoli?", ["a", "b"])]);

// 3) Tanlash: qoralama va sig'maydigan test chiqmaydi
const seen = new Set();
for (let i = 0; i < 30; i++) seen.add((await cq.pick()).slug);
check("pick: faqat chop etilgan va sig'adigan testli maqolalar", [...seen].sort().join() === "fotosintez,qora-tuynuk", [...seen].join());

// 4) Yuborish
const p1 = await cq.post();
const poll = polls().at(-1);
check("sendPoll: quiz turi, anonim, kanalga", poll.method === "sendPoll" && poll.body.type === "quiz" && poll.body.is_anonymous === true && poll.body.chat_id === "@bilim_test");
check("sendPoll: savol 'Kun savoli' bilan, variantlar {text}", poll.body.question.startsWith("🧠 Kun savoli: ") && poll.body.options.every((o) => typeof o.text === "string") && poll.body.options[poll.body.correct_option_id].text === p1.question.options[p1.question.answer]);
check("sendPoll: izoh 200 belgidan oshmaydi", !poll.body.explanation || poll.body.explanation.length <= 200, String(poll.body.explanation?.length));
const btn = poll.body.reply_markup.inline_keyboard[0][0];
check("sendPoll: tugma maqolaga, utm_medium=quiz", btn.url === `https://bilimmanba.uz/articles/${p1.slug}?utm_source=telegram&utm_medium=quiz`, btn.url);
const p2 = await cq.post();
check("ikkinchi savol boshqa maqoladan (takrorlanmaydi)", p2.slug !== p1.slug, `${p1.slug} / ${p2.slug}`);
await cq.post();
check("hammasi ishlatilgach — boshidan (xato yo'q)", polls().length === 3, String(polls().length));

// 5) Kunlik jadval (Toshkent = UTC+5; standart soat 19:00)
const at = (h) => new Date(Date.UTC(2026, 9, 20, h - 5, 10));
const r18 = await cq.runIfDue(at(18)); check("19:00 dan oldin — yuborilmaydi", r18 === "skipped", r18 + " " + JSON.stringify(await cq.status()));
check("19:10 da — yuboriladi", (await cq.runIfDue(at(19))) === "sent");
check("o'sha kuni yana — yuborilmaydi", (await cq.runIfDue(at(22))) === "skipped" && polls().length === 4);
const next = new Date(at(19).getTime() + 86400e3);
await ctrl.channelQuizUpdate({ enabled: false });
check("o'chirilgan — yuborilmaydi", (await cq.runIfDue(next)) === "skipped");
await ctrl.channelQuizUpdate({ enabled: true, hour: 9 });
check("soat 09:00 ga o'zgardi — ertangi 10:00 da yuboriladi", (await cq.runIfDue(new Date(next.getTime() - 9 * 3600e3))) === "sent");
clearTimeout(cq.timer);
tgFail = true;
const r = await cq.runIfDue(new Date(next.getTime() + 86400e3));
const st = await ctrl.channelQuizStatus();
check("Telegram xatosi — 'failed', xato holatda ko'rinadi", r === "failed" && /sendPoll/.test(st.lastError ?? ""), JSON.stringify(st));
tgFail = false;

// 6) Admin
check("holat: soat 9, yoqilgan, testli maqolalar 3 ta, oxirgi post bor", st.hour === 9 && st.enabled && st.withQuiz === 3 && st.lastPost?.question && st.configured);
const sent = await ctrl.channelQuizSend();
check("hozir yuborish: savol qaytadi, bugungi kun belgilanadi", sent.question && (await ctrl.channelQuizStatus()).lastError === null);
await ctrl.channelQuizUpdate({ hour: 99 });
check("noto'g'ri soat e'tiborsiz", (await ctrl.channelQuizStatus()).hour === 9);
clearTimeout(cq.timer);
await db.query(`DELETE FROM article_quizzes`);
let err = ""; try { await ctrl.channelQuizSend(); } catch (e) { err = e.constructor.name + ": " + e.message; }
check("test yo'q — tushunarli xato (400)", /BadRequest.*test/.test(err), err);

// 7) Kanal sozlanmagan
Object.defineProperty(tg, "configured", { get: () => false });
check("kanal sozlanmagan — jadval o'tkazib yuboradi", (await cq.runIfDue(new Date(Date.UTC(2030, 0, 1, 15)))) === "skipped");

clearTimeout(cq.timer);
await app.close(); await server.stop(); await db.close();
console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
