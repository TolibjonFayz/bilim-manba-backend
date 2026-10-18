// Maqolalar seriyasi: PGlite + soxta AI (Wikipedia tekshiruvi haqiqiy)
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
const { AdminController } = require(BE + "dist/admin/admin.controller");
const { ArticlesModule } = require(BE + "dist/articles/articles.module");
const { ArticlesService } = require(BE + "dist/articles/articles.service");
const { DatabaseModule } = require(BE + "dist/database/database.module");
const { SeriesService } = require(BE + "dist/series/series.service");
const { SeriesController } = require(BE + "dist/series/series.controller");
const { DraftsService } = require(BE + "dist/drafts/drafts.service");
const { QuizService } = require(BE + "dist/quiz/quiz.service");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5500, host: "127.0.0.1" });
await server.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({})] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5500, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, AdminModule, ArticlesModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });
await app.init();
const admin = app.get(AdminService), ctrl = app.get(AdminController), articles = app.get(ArticlesService), series = app.get(SeriesService), pub = app.get(SeriesController), drafts = app.get(DraftsService);
clearTimeout(app.get(QuizService).timer); clearTimeout(drafts.timer);
await new Promise((r) => setTimeout(r, 500));

check("bitta SeriesService nusxasi (admin, maqolalar, qoralamalar)", drafts.series === series && articles.series === series);

const cat = await admin.createCategory({ name: "Fan", slug: "Fan" });
await db.query(`INSERT INTO users ("fullName", email, password, role, "createdAt", "updatedAt") VALUES ('Admin','a@b.c','x','admin',now(),now())`);
const mk = (slug, status = "published") => admin.createArticle({ title: `Maqola ${slug}`, slug, categoryId: cat.id, type: "free", status, content: "https://r2.example/x.json", excerpt: `Tavsif ${slug}` });
const a1 = await mk("a1"), a2 = await mk("a2"), a3 = await mk("a3", "draft"), a4 = await mk("a4");

// Yaratish
const s1 = await ctrl.seriesCreate({ title: "  Koinot sirlari  ", description: "Yulduzlardan qora tuynuklargacha" });
const s2 = await ctrl.seriesCreate({ title: "Koinot sirlari" });
check("yaratish: slug lotincha, takrorlansa -2", s1.slug === "koinot-sirlari" && s2.slug === "koinot-sirlari-2" && s1.title === "Koinot sirlari", `${s1.slug} ${s2.slug}`);
let e = null; try { await ctrl.seriesCreate({ title: "  " }); } catch (x) { e = x; }
check("yaratish: nomsiz → 400", e?.status === 400);

// Qismlar tartibi
await ctrl.seriesUpdate(String(s1.id), { articleIds: [a2.id, a1.id, a3.id] });
const adm = (await ctrl.seriesList()).find((s) => s.id === s1.id);
check("admin: qismlar tartib bilan, qoralama ham ko'rinadi", JSON.stringify(adm.parts.map((p) => [p.slug, p.position, p.status])) === JSON.stringify([["a2", 1, "published"], ["a1", 2, "published"], ["a3", 3, "draft"]]), JSON.stringify(adm.parts.map((p) => p.slug)));

// Maqola sahifasi
const p1 = await articles.findBySlug("a1");
check("maqola sahifasi: 2-qism / 2 (qoralama sanalmaydi)", p1.series?.part === 2 && p1.series.total === 2 && p1.series.slug === "koinot-sirlari" && p1.series.parts.map((p) => p.slug).join() === "a2,a1", JSON.stringify(p1.series));
check("seriyasiz maqola: series null", (await articles.findBySlug("a4")).series === null);

// Ochiq ro'yxat va sahifa
const lst = await pub.findAll();
check("ochiq ro'yxat: faqat chop etilgan qismi borlar, qismlar soni", lst.length === 1 && lst[0].slug === "koinot-sirlari" && lst[0].partCount === 2, JSON.stringify(lst));
const page = await pub.findOne("koinot-sirlari");
check("seriya sahifasi: chop etilgan qismlar tartib bilan", page.parts.map((p) => p.slug).join() === "a2,a1" && page.description.startsWith("Yulduz"));
e = null; try { await pub.findOne("koinot-sirlari-2"); } catch (x) { e = x; }
check("bo'sh seriya sahifasi → 404", e?.status === 404);

// Boshqa seriyaga ko'chirish
await ctrl.seriesUpdate(String(s2.id), { articleIds: [a1.id, a4.id], title: "Yulduzlar olami" });
const after = await ctrl.seriesList();
check("maqola boshqa seriyaga ko'chdi, nom va slug yangilandi", after.find((s) => s.id === s1.id).parts.map((p) => p.slug).join() === "a2,a3" && after.find((s) => s.id === s2.id).slug === "yulduzlar-olami");
check("1 qismi qolgan seriya: maqolada seriya bloki chiqmaydi", (await articles.findBySlug("a2")).series === null);

// Sitemap
const sm = await articles.getSitemapData();
check("sitemap: chop etilgan qismli seriyalar", sm.series.map((s) => s.slug).sort().join() === "koinot-sirlari,yulduzlar-olami", JSON.stringify(sm.series));

// AI reja (soxta AI, haqiqiy Wikipedia tekshiruvi)
const prompts = [];
series.llmOverride = { name: "fake", sourceBudget: 30000, json: async (sys, user) => { prompts.push(sys); return JSON.stringify({ parts: [
  { title: "Yulduzlar qanday tug'iladi", topic: "Star formation" },
  { title: "Oq mittilar", topic: "White dwarf" },
  { title: "Uydirma qism", topic: "Zzqxqzzq no such topic xyz" },
  { title: "", topic: "Nebula" },
] }); } };
const plan = await ctrl.seriesPlan(String(s2.id), { parts: 4 });
check("reja: bo'sh nomli qism tashlandi, Wikipedia tekshirildi", plan.parts.length === 3 && plan.parts[0].found === true && plan.parts[2].found === false, JSON.stringify(plan.parts));
check("reja: prompt seriya nomi, mavjud qismlar va qoidalar bilan", prompts[0].includes('"Yulduzlar olami"') && prompts[0].includes("Maqola a1") && /LGBT/.test(prompts[0]) && /3 ta qism|4 ta qism/.test(prompts[0]));

// Navbatga qo'shish
await drafts.updateSettings({ topics: ["Fotosintez"] });
const enq = await ctrl.seriesEnqueue(String(s2.id), { parts: plan.parts.filter((p) => p.found) });
const st = await drafts.getSettings();
check("navbat: qismlar oxiriga qo'shildi (avvalgi mavzu birinchi)", JSON.stringify(st.topics) === JSON.stringify(["Fotosintez", plan.parts[0].topic, plan.parts[1].topic]) && enq.added === 2, JSON.stringify(st.topics));
const ql = (await ctrl.seriesList()).find((s) => s.id === s2.id).queued;
check("admin: navbatdagi qismlar 3- va 4-o'rinda", ql.length === 2 && ql[0].position === 3 && ql[1].position === 4 && ql[0].title === "Yulduzlar qanday tug'iladi", JSON.stringify(ql));

// Qoralama yozildi → seriyaga biriktirildi
const d1 = await mk("yulduz-tugilishi", "draft");
check("biriktirish: navbatdagi mavzu → seriyaga o'z o'rniga", (await series.attachQueued(plan.parts[0].topic, d1.id)) === true);
const s2p = (await ctrl.seriesList()).find((s) => s.id === s2.id);
check("seriyada: a1, a4, yangi qism (3-o'rin); navbatda 1 ta qoldi", s2p.parts.map((p) => `${p.slug}:${p.position}`).join() === "a1:1,a4:2,yulduz-tugilishi:3" && s2p.queued.length === 1, JSON.stringify([s2p.parts.map((p) => p.slug), s2p.queued]));
check("biriktirish: navbatda yo'q mavzu → false", (await series.attachQueued("Boshqa mavzu", d1.id)) === false && (await series.attachQueued(undefined, d1.id)) === false);

// O'chirish
await ctrl.seriesRemove(String(s2.id));
check("o'chirish: seriya va bog'lanishlar ketdi, maqolalar qoldi", !(await ctrl.seriesList()).some((s) => s.id === s2.id) && (await articles.findBySlug("a1")).series === null && (await db.query(`SELECT count(*)::int n FROM articles`)).rows[0].n === 5);
check("o'chirish: navbat bog'lanishi ham tozalandi", (await series.attachQueued(plan.parts[1].topic, d1.id)) === false);

// ---------- Avtomatik seriyalar ----------
const autoPrompts = []; let ideaTitle = "Buyuk ixtirolar tarixi"; let groupsReply = null;
series.llmOverride = { name: "fake", sourceBudget: 30000, json: async (sys, user) => {
  autoPrompts.push({ sys, user });
  if (user === "Yangi seriya") return JSON.stringify({ title: ideaTitle, description: "Dunyoni o'zgartirgan kashfiyotlar." });
  if (sys.includes("Saytdagi mavjud maqolalardan SERIYA")) return JSON.stringify(groupsReply);
  return JSON.stringify({ parts: [
    { title: "Bosmaxona", topic: "Printing press" },
    { title: "Bug' mashinasi", topic: "Steam engine" },
    { title: "Telefon", topic: "Telephone" },
    { title: "Uydirma", topic: "Zzqxqzzq no such topic xyz" },
  ] });
} };
// Mavjud maqolalardan: yaroqsiz raqamlar, takror, 3 tadan kam guruh tashlanadi
await db.query(`DELETE FROM series_articles`); await db.query(`DELETE FROM series`);
await drafts.updateSettings({ topics: [] });
const b1 = await mk("b1"), b2 = await mk("b2"), b3 = await mk("b3"), b4 = await mk("b4");
const poolList = (await db.query(`SELECT a.id FROM articles a WHERE a.status='published' ORDER BY a."createdAt" DESC LIMIT 200`)).rows.map((r) => r.id);
const idx = (id) => poolList.indexOf(id);
groupsReply = { groups: [
  { title: "Kimyo asoslari", description: "Atomdan molekulagacha.", numbers: [idx(b1.id), idx(b2.id), idx(b3.id), 999, idx(b1.id)] },
  { title: "Kam qismli", description: "x", numbers: [idx(b4.id), idx(b1.id)] },
] };
const g = await drafts.seriesFromExisting();
check("mavjud maqolalardan: 1 seriya, 3 qism (yaroqsiz/takror tashlandi, 2 qismli guruh rad)", g.length === 1 && g[0].parts === 3 && g[0].title === "Kimyo asoslari", JSON.stringify(g));
const gs = (await ctrl.seriesList()).find((s) => s.title === "Kimyo asoslari");
check("mavjud maqolalardan: tartib AI bergandek", gs.parts.map((p) => p.slug).join() === "b1,b2,b3", gs.parts.map((p) => p.slug).join());
check("mavjud maqolalardan: prompt majburlamaslikni so'raydi", /Majburlama/.test(autoPrompts.at(-1).sys));
groupsReply = { groups: [] };
check("mos guruh bo'lmasa — hech narsa yaratilmaydi", (await drafts.seriesFromExisting()).length === 0);

// Yangi avtomatik seriya
await db.query(`DELETE FROM app_settings WHERE key IN ('series_last_auto','ai_auto_series')`);
const n1 = await drafts.maybeAutoSeries();
check("avto: yangi seriya yaratildi, Wikipedia'da topilgan 3 qism navbatda", n1 && n1.title === ideaTitle && n1.parts.length === 3, JSON.stringify(n1));
check("avto: g'oya promptida mavjud seriyalar va qoidalar", autoPrompts.find((x) => x.user === "Yangi seriya").sys.includes("Kimyo asoslari") && /LGBT/.test(autoPrompts.find((x) => x.user === "Yangi seriya").sys));
const st2 = await drafts.getSettings();
check("avto: kunlik navbatda 3 qism, sozlamada autoSeries yoqiq", st2.topics.length === 3 && st2.autoSeries === true && st2.autoSeriesEveryDays === 10, JSON.stringify(st2.topics));
check("avto: seriya hali navbatda — yangisi boshlanmaydi (force bo'lsa ham)", (await drafts.maybeAutoSeries(true)) === null);
// Navbat tugadi, lekin 10 kun o'tmagan
await drafts.updateSettings({ topics: [] });
check("avto: 10 kun o'tmagan — boshlanmaydi", (await drafts.maybeAutoSeries()) === null);
await db.query(`UPDATE app_settings SET value = $1 WHERE key = 'series_last_auto'`, [new Date(Date.now() - 11 * 864e5).toISOString()]);
ideaTitle = "Inson tanasi mo'jizalari";
const n2 = await drafts.maybeAutoSeries();
check("avto: 11 kun o'tdi → yangi seriya", n2?.title === "Inson tanasi mo'jizalari");
await drafts.updateSettings({ topics: [], autoSeries: false });
await db.query(`UPDATE app_settings SET value = $1 WHERE key = 'series_last_auto'`, [new Date(Date.now() - 30 * 864e5).toISOString()]);
check("avto: o'chirilgan → boshlanmaydi; sozlamada autoSeries=false", (await drafts.maybeAutoSeries()) === null && (await drafts.getSettings()).autoSeries === false);
await drafts.updateSettings({ autoSeries: true });
// Wikipedia'da 3 tadan kam qism → seriya bekor
series.llmOverride.json = async (sys, user) => user === "Yangi seriya" ? JSON.stringify({ title: "Bo'sh seriya", description: "x" }) : JSON.stringify({ parts: [{ title: "a", topic: "Zzqxqzzq no such topic xyz" }, { title: "b", topic: "Zzqxqzzq no such topic abc" }, { title: "c", topic: "Printing press" }] });
check("avto: qismlar yetmasa — seriya o'chiriladi", (await drafts.maybeAutoSeries(true)) === null && !(await ctrl.seriesList()).some((s) => s.title === "Bo'sh seriya"));
// Admin endpointlari
check("admin endpoint: yangi seriya (natija yo'q → created null)", (await ctrl.seriesAutoNew()).created === null);

// Navbat xavfsizligi: yozish davomida qo'shilgan mavzu yo'qolmaydi
await drafts.updateSettings({ topics: ["Birinchi", "Ikkinchi"] });
await drafts.updateSettings({ topics: ["Birinchi", "Ikkinchi", "Yangi seriya qismi"] });
await drafts.removeTopic("Birinchi");
check("navbat: olingan mavzu chiqdi, keyin qo'shilgani qoldi", JSON.stringify((await drafts.getSettings()).topics) === '["Ikkinchi","Yangi seriya qismi"]');

await app.close(); await server.stop(); await db.close();
console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
