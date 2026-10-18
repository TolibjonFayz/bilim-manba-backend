// Maktab o'quvchilari uchun bo'lim: SchoolService (soxta AI) + PGlite
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
const { SchoolService } = require(BE + "dist/school/school.service");
const { DraftsService } = require(BE + "dist/drafts/drafts.service");
const { QuizService } = require(BE + "dist/quiz/quiz.service");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5501, host: "127.0.0.1" });
await server.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({})] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5501, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, AdminModule, ArticlesModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });
await app.init();
const admin = app.get(AdminService), articles = app.get(ArticlesService), school = app.get(SchoolService), drafts = app.get(DraftsService);
clearTimeout(app.get(QuizService).timer); clearTimeout(drafts.timer);
await new Promise((r) => setTimeout(r, 500));

check("bitta SchoolService nusxasi (maqolalar va qoralamalar)", drafts.school === school && articles.school === school);

const bio = await admin.createCategory({ name: "Biologiya", slug: "Biologiya" });
await admin.createCategory({ name: "Tarix", slug: "Tarix" });
await admin.createCategory({ name: "Sport", slug: "Sport" });
await db.query(`INSERT INTO users ("fullName", email, password, role, "createdAt", "updatedAt") VALUES ('Admin','a@b.c','x','admin',now(),now())`);
const mk = (slug, status = "published") => admin.createArticle({ title: `Maqola ${slug}`, slug, categoryId: bio.id, type: "free", status, content: "https://r2.example/x.json", excerpt: `Tavsif ${slug}` });
const a1 = await mk("hujayra"), a2 = await mk("futbol"), a3 = await mk("qoralama", "draft");

// Soxta AI
const prompts = []; let reply = {};
school.llmOverride = { name: "fake", sourceBudget: 30000, json: async (sys, user) => { prompts.push({ sys, user }); return JSON.stringify(typeof reply === "function" ? reply(sys, user) : reply); } };

// 1) Mavjud maqolalarni belgilash
const pool = (await db.query(`SELECT id FROM articles WHERE status='published' ORDER BY "createdAt" DESC`)).rows.map((r) => r.id);
reply = { picks: [{ n: pool.indexOf(a1.id), subject: "Biologiya", grade: 6 }, { n: pool.indexOf(a1.id), subject: "Biologiya", grade: 6 }, { n: 99, subject: "x", grade: 5 }, { n: pool.indexOf(a2.id), subject: "", grade: 7 }] };
const marked = await school.classifyExisting();
check("belgilash: faqat yaroqli, takrorsiz (1 ta)", marked.length === 1 && marked[0].id === a1.id, JSON.stringify(marked));
check("belgilash: prompt sport va film sharhlarini chiqarib tashlashni so'raydi", /sport yangiliklari/.test(prompts.at(-1).sys) && !prompts.at(-1).user.includes("Maqola qoralama"));
const page = await articles.findBySlug("hujayra");
check("maqola sahifasi: school {Biologiya, 6}", page.school?.subject === "Biologiya" && page.school.grade === 6, JSON.stringify(page.school));
check("belgilanmagan maqola: school null", (await articles.findBySlug("futbol")).school === null);
await school.mark(a3.id, "Biologiya", 9);
const list = await school.listPublic();
check("/maktab ro'yxati: faqat chop etilganlar", list.length === 1 && list[0].slug === "hujayra" && list[0].grade === 6, JSON.stringify(list.map((x) => x.slug)));

// 2) Navbatni to'ldirish
reply = { topics: [
  { title: "Fotosintez", topic: "Photosynthesis", subject: "biologiya", grade: 6 },
  { title: "Amir Temur davlati", topic: "Timurid Empire", subject: "Tarix", grade: 7 },
  { title: "Noma'lum fan", topic: "Something", subject: "Astrologiya", grade: 8 },
  { title: "Takror", topic: "photosynthesis", subject: "Biologiya", grade: 6 },
  { title: "Sinfsiz", topic: "Cell (biology)", subject: "Biologiya", grade: 15 },
] };
const q = await school.refill();
check("to'ldirish: noma'lum fan va takror tashlandi, fan bo'lim nomiga moslandi", q.length === 3 && q[0].subject === "Biologiya" && q.every((t) => t.subject !== "Astrologiya"), JSON.stringify(q));
check("to'ldirish: noto'g'ri sinf → null", q.find((t) => t.topic === "Cell (biology)").grade === null);
check("to'ldirish: prompt 5–11-sinf, bo'limlar va mavjud maqolalar bilan", /5–11-sinflar/.test(prompts.at(-1).sys) && prompts.at(-1).sys.includes("Biologiya, Tarix, Sport") && prompts.at(-1).sys.includes("Maqola hujayra"));

// 3) Navbatdan olish
const t1 = await school.nextTopic();
check("navbat: birinchisi olindi, qolgani 2 ta", t1.topic === "Photosynthesis" && (await school.queue()).length === 2);
await school.nextTopic(); await school.nextTopic();
reply = { topics: [{ title: "Fotosintez", topic: "Photosynthesis", subject: "Biologiya", grade: 6 }, { title: "Yangi", topic: "Mitosis", subject: "Biologiya", grade: 9 }] };
const t4 = await school.nextTopic();
check("navbat tugadi → AI qayta to'ldirdi, ishlatilgan mavzu takrorlanmadi", t4?.topic === "Mitosis", JSON.stringify(t4));
reply = { topics: [] };
check("AI hech narsa bermasa → null", (await school.nextTopic()) === null);

// 5) Admin: ro'yxat, olib tashlash, qaytarish, fan/sinf, qo'shish
const { AdminController } = require(BE + "dist/admin/admin.controller");
const ctrl = app.get(AdminController);
let al = await ctrl.schoolList();
check("admin ro'yxati: qoralama ham, hidden=false", al.length === 2 && al.every((r) => r.hidden === false) && al.some((r) => r.status === "draft"), JSON.stringify(al.map((r) => [r.slug, r.status, r.hidden])));
await ctrl.schoolSave(String(a1.id), { hidden: true });
check("olib tashlandi: /maktab'da yo'q", (await school.listPublic()).length === 0);
check("olib tashlandi: maqolada belgi yo'q", (await articles.findBySlug("hujayra")).school === null);
check("olib tashlandi: fan va sinf saqlandi", (await ctrl.schoolList()).find((r) => r.id === a1.id)?.subject === "Biologiya");
school.llmOverride = { name: "fake", sourceBudget: 30000, json: async (sys, user) => { prompts.push({ sys, user }); return JSON.stringify({ picks: [] }); } };
await school.classifyExisting();
check("AI qayta belgilashda yashirilgan maqola ro'yxatga kirmaydi", !prompts.at(-1).user.includes("Maqola hujayra") && prompts.at(-1).user.includes("Maqola futbol"));
await school.mark(a1.id, "Biologiya", 7);
check("AI mark() yashirishni bekor qilmaydi", (await school.listPublic()).length === 0);
await ctrl.schoolSave(String(a1.id), { hidden: false, subject: "  Kimyo ", grade: "8" });
const back = await school.listPublic();
check("qaytarildi + fan/sinf o'zgardi", back.length === 1 && back[0].subject === "Kimyo" && back[0].grade === 8, JSON.stringify(back));
await ctrl.schoolSave(String(a2.id), { subject: "Tarix", grade: 99 });
check("yangi maqola qo'shildi, noto'g'ri sinf → null", (await school.listPublic()).find((r) => r.slug === "futbol")?.grade === null);
let err = ""; try { await ctrl.schoolSave("99999", { subject: "Tarix" }); } catch (e) { err = e.constructor.name; }
check("yo'q maqola → NotFound", err === "NotFoundException", err);
err = ""; try { const a4 = await mk("yangi4"); await ctrl.schoolSave(String(a4.id), { grade: 5 }); } catch (e) { err = e.constructor.name; }
check("yangi maqola fansiz → BadRequest", err === "BadRequestException", err);

// 4) Kalit yo'q
school.llmOverride = undefined;
check("AI kaliti yo'q → refill [] va classify []", (await school.refill()).length === 0 && (await school.classifyExisting()).length === 0);

await app.close(); await server.stop(); await db.close();
console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
