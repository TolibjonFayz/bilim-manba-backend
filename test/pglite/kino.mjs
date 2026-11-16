// Kino: navbatdagi filmlar har kuni bittadan (18:00 da avtomatik chop etiladi)
// va navbat bo'sh bo'lsa haftasiga kamida bitta kino maqola
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
const { BadRequestException } = require("@nestjs/common");
const { AdminModule } = require(BE + "dist/admin/admin.module");
const { AdminService } = require(BE + "dist/admin/admin.service");
const { ArticlesModule } = require(BE + "dist/articles/articles.module");
const { DatabaseModule } = require(BE + "dist/database/database.module");
const { DraftsService, KINO_START_TOPICS } = require(BE + "dist/drafts/drafts.service");
const { QuizService } = require(BE + "dist/quiz/quiz.service");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5508, host: "127.0.0.1" });
await server.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({})] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5508, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, AdminModule, ArticlesModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });
await app.init();
const admin = app.get(AdminService), drafts = app.get(DraftsService);
clearTimeout(app.get(QuizService).timer); clearTimeout(drafts.timer);
await new Promise((r) => setTimeout(r, 500));

// Toshkent vaqti → Date
const T = (day, hh, mm = 0) => new Date(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:00`);

// --- Chop etish vaqti ---
check("chop etish: ertalab yozilsa — 18:00", DraftsService.kinoPublishAt(T("2026-11-13", 10)).getTime() === T("2026-11-13", 18).getTime());
check("chop etish: 19:00 da yozilsa — 30 daqiqadan keyin", DraftsService.kinoPublishAt(T("2026-11-13", 19)).getTime() === T("2026-11-13", 19, 30).getTime());
check("boshlang'ich ro'yxat: 5 ta film, Odyssey birinchi", KINO_START_TOPICS.length === 5 && /Odyssey/.test(KINO_START_TOPICS[0]) && /Doctor_Strange/.test(KINO_START_TOPICS[4]));

// --- Navbat ---
await db.query(`INSERT INTO app_settings (key, value) VALUES ('kino_queue', '["Coco (2017 film)"]')`);
await drafts.kinoKickoffOnce();
await drafts.kinoKickoffOnce();
let st = await drafts.getKinoSettings();
check("kickoff: 5 film boshida, eskisi oxirida, takrorlanmaydi", st.queue.length === 6 && st.queue[0] === KINO_START_TOPICS[0] && st.queue[5] === "Coco (2017 film)", JSON.stringify(st.queue));
check("Kino bo'limi yo'q — o'tkazib yuboriladi", st.hasCategory === false && (drafts.llmOverride = { name: "fake", sourceBudget: 30000, json: async () => "{}" }) && (await drafts.runKinoIfDue(T("2026-11-13", 10))) === "skipped");

const kino = await admin.createCategory({ name: "Kino", slug: "Kino" });
const other = await admin.createCategory({ name: "Tarix", slug: "Tarix" });
await db.query(`INSERT INTO users ("fullName", email, password, role, "createdAt", "updatedAt") VALUES ('Admin','a@b.c','x','admin',now(),now())`);

// Soxta yozuvchi va xabarlar
const calls = []; let fail = null; let n = 0;
drafts.generate = async (opts) => {
  calls.push(opts);
  if (fail) throw fail;
  n++;
  return admin.createArticle({ title: `Film maqolasi ${n}`, slug: `film-${n}`, categoryId: opts.categoryId ?? other.id, type: "free", status: "draft", content: "https://r2.example/x.json", excerpt: "x" });
};
const alerts = []; drafts.alerts.send = async (text) => { alerts.push(text); return true; };
const failed = []; drafts.alerts.draftFailed = async (e, t) => { failed.push([e, t]); return true; };
let refreshed = 0; drafts.publishing.refreshSchedule = async () => { refreshed++; };

check("05:00 da — hali erta", (await drafts.runKinoIfDue(T("2026-11-13", 5))) === "skipped" && calls.length === 0);

const refreshedBefore = refreshed;
let r = await drafts.runKinoIfDue(T("2026-11-13", 10));
let art = (await db.query(`SELECT * FROM articles WHERE slug='film-1'`)).rows[0];
check("1-kun: Odyssey yozildi", r === "done" && calls[0].topic === KINO_START_TOPICS[0] && calls[0].skipCheck === true && calls[0].categoryId === kino.id, JSON.stringify(calls[0]));
check("1-kun: 18:00 ga rejalashtirildi, qoralama", art.status === "draft" && new Date(art.scheduledAt).getTime() === T("2026-11-13", 18).getTime(), String(art.scheduledAt));
check("1-kun: chop etish taymeri yangilandi", refreshed > refreshedBefore);
check("1-kun: admin'ga xabar (vaqti bilan)", alerts.length === 1 && alerts[0].includes("18:00") && alerts[0].includes("Film maqolasi 1"));
st = await drafts.getKinoSettings();
check("1-kun: navbatdan olib tashlandi (5 qoldi)", st.queue.length === 5 && st.queue[0] === KINO_START_TOPICS[1]);
check("1-kun: o'sha kuni qayta yozilmaydi", (await drafts.runKinoIfDue(T("2026-11-13", 15))) === "skipped" && calls.length === 1);

r = await drafts.runKinoIfDue(T("2026-11-14", 7));
check("2-kun: Spider-Man", r === "done" && calls[1].topic === KINO_START_TOPICS[1]);

// Xato: Wikipedia'da yo'q → navbatdan chiqadi, keyingi kun keyingisi
fail = new BadRequestException("topilmadi");
r = await drafts.runKinoIfDue(T("2026-11-15", 7));
st = await drafts.getKinoSettings();
check("3-kun xato: failed, mavzu olib tashlandi, xato saqlandi", r === "failed" && st.queue[0] === KINO_START_TOPICS[3] && /topilmadi/.test(st.lastError) && failed.length === 1, JSON.stringify(st.queue));
fail = null;

// Tarmoq xatosi — mavzu qoladi
fail = new Error("Gemini 503");
r = await drafts.runKinoIfDue(T("2026-11-16", 7));
st = await drafts.getKinoSettings();
check("4-kun tarmoq xatosi: mavzu navbatda qoladi", r === "failed" && st.queue[0] === KINO_START_TOPICS[3]);
fail = null;

// O'chirib qo'yilsa
await drafts.updateKinoSettings({ daily: false });
check("o'chirilgan: yozilmaydi", (await drafts.runKinoIfDue(T("2026-11-17", 7))) === "skipped");
await drafts.updateKinoSettings({ daily: true });

// Navbat bo'sh — qo'shimcha kino YO'Q; haftalik kino oddiy kunlik maqola o'rnida yoziladi
await drafts.updateKinoSettings({ queue: ["Coco (2017 film)"] });
await db.query(`UPDATE articles SET "createdAt" = '2026-11-01T10:00:00Z' WHERE "categoryId" = $1`, [kino.id]);
check("navbatda film bor — haftalik kino kerak emas", (await drafts.weeklyKinoDue(T("2026-11-20", 10))) === null);
await drafts.updateKinoSettings({ queue: [] });
const before = calls.length;
check("navbat bo'sh — qo'shimcha kino yozilmaydi (kino eski bo'lsa ham)", (await drafts.runKinoIfDue(T("2026-11-20", 10))) === "skipped" && calls.length === before);
await db.query(`UPDATE articles SET "createdAt" = '2026-11-15T10:00:00Z' WHERE "categoryId" = $1`, [kino.id]);
check("haftalik: oxirgi kino 4 kun oldin — hali kerak emas", (await drafts.weeklyKinoDue(T("2026-11-19", 10))) === null);
await db.query(`UPDATE articles SET "createdAt" = '2026-11-12T10:00:00Z' WHERE "categoryId" = $1`, [kino.id]);
check("haftalik: 8 kun kino yo'q — Kino bo'limi", (await drafts.weeklyKinoDue(T("2026-11-20", 10)))?.id === kino.id);
await drafts.updateKinoSettings({ daily: false });
check("haftalik: kino o'chirilgan — kerak emas", (await drafts.weeklyKinoDue(T("2026-11-20", 10))) === null);
await drafts.updateKinoSettings({ daily: true });

// Kunlik maqola: haftalik kino kuni — o'sha kunning YAGONA maqolasi kino haqida (navbatdagi mavzu ertaga)
await drafts.updateSettings({ autoSeries: false, topics: ["Amir Temur"] });
const ready = []; drafts.alerts.draftReady = async (a) => { ready.push(a.title); return true; };
r = await drafts.runDailyIfDue(T("2026-11-20", 10));
check("kunlik (haftalik kino kuni): kino yozildi, mavzu navbatda qoldi", r === "done" && calls.length === before + 1 && calls.at(-1).categoryId === kino.id && calls.at(-1).topic === undefined && (await drafts.getSettings()).topics[0] === "Amir Temur", JSON.stringify(calls.at(-1)));
const weekly = (await db.query(`SELECT status, "scheduledAt" FROM articles ORDER BY id DESC LIMIT 1`)).rows[0];
check("haftalik kino — oddiy qoralama (avtomatik chiqmaydi), admin'ga xabar", weekly.status === "draft" && weekly.scheduledAt === null && ready.length === 1);
check("o'sha kuni ikkinchi maqola yo'q", (await drafts.runDailyIfDue(T("2026-11-20", 15))) === "skipped" && (await drafts.runKinoIfDue(T("2026-11-20", 15))) === "skipped" && calls.length === before + 1);
// Kino endi yangi (stub maqola hozir yaratildi) — ertasi kuni odatdagi mavzu
await db.query(`UPDATE articles SET "createdAt" = '2026-11-20T05:00:00Z' WHERE id = (SELECT MAX(id) FROM articles)`);
r = await drafts.runDailyIfDue(T("2026-11-21", 10));
check("ertasi kuni: odatdagi navbat (Amir Temur), kuniga bitta", r === "done" && calls.length === before + 2 && calls.at(-1).topic === "Amir Temur" && (await drafts.runKinoIfDue(T("2026-11-21", 11))) === "skipped", JSON.stringify(calls.at(-1)));

// Navbatda film bor kunda: oddiy maqola HAM, kino HAM (kuniga 2 ta)
await drafts.updateSettings({ topics: ["Ibn Sino"] });
await drafts.updateKinoSettings({ queue: ["Coco (2017 film)"] });
const b2 = calls.length;
const d1 = await drafts.runDailyIfDue(T("2026-11-22", 7)), k1 = await drafts.runKinoIfDue(T("2026-11-22", 7));
check("film navbatda: kunlik maqola + kino (2 ta)", d1 === "done" && k1 === "done" && calls.length === b2 + 2 && calls[b2].topic === "Ibn Sino" && calls[b2 + 1].topic === "Coco (2017 film)" && calls[b2 + 1].skipCheck === true, JSON.stringify(calls.slice(b2)));

// Admin tugmasi: navbatni o'zgartirish va hozir yozish
st = await drafts.updateKinoSettings({ queue: ["  Inside Out 2 ", "", "Paddington 2"] });
check("navbatni tahrirlash: bo'sh qatorlar tashlanadi", JSON.stringify(st.queue) === JSON.stringify(["Inside Out 2", "Paddington 2"]));
const startedBefore = calls.length;
drafts.runKinoNow();
let threw = false; try { drafts.runKinoNow(); } catch { threw = true; }
check("hozir yozish: ikkinchi bosish rad etiladi", threw);
await new Promise((r) => setTimeout(r, 1500));
check("hozir yozish: o'sha kuni ham yozadi (force)", calls.length === startedBefore + 1 && calls.at(-1).topic === "Inside Out 2");

// 2026-11-16: yozilmay qolgan film — darhol chop etish (kutilmagan 18:00 emas)
const published = []; drafts.publishing.publishWithResults = async (id) => { published.push(id); await db.query(`UPDATE articles SET status='published' WHERE id=$1`, [id]); return { telegram: true, instagram: true }; };
const beforeNow = calls.length;
const rNow = await drafts.runKinoIfDue(T("2026-11-16", 9), true, true);
const nowArt = (await db.query(`SELECT * FROM articles ORDER BY id DESC LIMIT 1`)).rows[0];
check("darhol: navbatdagi film yozilib, kutmasdan chop etiladi", rNow === "done" && calls.length === beforeNow + 1 && calls.at(-1).topic === "Paddington 2" && published.includes(nowArt.id) && nowArt.status === "published" && !nowArt.scheduledAt, JSON.stringify({ rNow, topic: calls.at(-1)?.topic, published }));
check("darhol: navbatdan olib tashlanadi va admin'ga 'chop etildi' xabari", !(await drafts.getKinoSettings()).queue.includes("Paddington 2") && /chop etildi/.test(alerts.at(-1)));
check("bir martalik ish: ikkinchi marta ishlamaydi", await (async () => { const c = calls.length; await drafts.kinoRetryNowOnce(); await drafts.kinoRetryNowOnce(); return calls.length === c + 1; })());

await app.close();
await server.stop();
console.log(fails ? `\n${fails} ta tekshiruv yiqildi` : "\nHammasi o'tdi");
process.exit(fails ? 1 : 0);
