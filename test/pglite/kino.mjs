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

// Navbat bo'sh — haftalik
await drafts.updateKinoSettings({ queue: [] });
const before = calls.length;
await db.query(`UPDATE articles SET "createdAt" = '2026-11-15T10:00:00Z' WHERE "categoryId" = $1`, [kino.id]);
check("navbat bo'sh, oxirgi kino 4 kun oldin — yozilmaydi", (await drafts.runKinoIfDue(T("2026-11-19", 10))) === "skipped" && calls.length === before);
await db.query(`UPDATE articles SET "createdAt" = '2026-11-12T10:00:00Z' WHERE "categoryId" = $1`, [kino.id]);
r = await drafts.runKinoIfDue(T("2026-11-20", 10));
check("navbat bo'sh, 8 kun kino yo'q — AI o'zi film tanlaydi", r === "done" && calls.at(-1).topic === undefined && calls.at(-1).categoryId === kino.id && !calls.at(-1).skipCheck, JSON.stringify(calls.at(-1)));

// Admin tugmasi: navbatni o'zgartirish va hozir yozish
st = await drafts.updateKinoSettings({ queue: ["  Inside Out 2 ", "", "Paddington 2"] });
check("navbatni tahrirlash: bo'sh qatorlar tashlanadi", JSON.stringify(st.queue) === JSON.stringify(["Inside Out 2", "Paddington 2"]));
const startedBefore = calls.length;
drafts.runKinoNow();
let threw = false; try { drafts.runKinoNow(); } catch { threw = true; }
check("hozir yozish: ikkinchi bosish rad etiladi", threw);
await new Promise((r) => setTimeout(r, 1500));
check("hozir yozish: o'sha kuni ham yozadi (force)", calls.length === startedBefore + 1 && calls.at(-1).topic === "Inside Out 2");

await app.close();
await server.stop();
console.log(fails ? `\n${fails} ta tekshiruv yiqildi` : "\nHammasi o'tdi");
process.exit(fails ? 1 : 0);
