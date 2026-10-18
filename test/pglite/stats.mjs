// Statistika hisobotlari, foydalanuvchilar ro'yxati va Search Console (soxta Google API)
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { generateKeyPairSync, createVerify } from "crypto";

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
const { CommentsModule } = require(BE + "dist/comments/comments.module");
const { ArticlesService } = require(BE + "dist/articles/articles.service");
const { DatabaseModule } = require(BE + "dist/database/database.module");
const { StatsService } = require(BE + "dist/stats/stats.service");
const { SearchConsoleService } = require(BE + "dist/search-console/search-console.service");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

// --- Soxta Google (JWT imzosi haqiqiy kalit bilan tekshiriladi) ---
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const creds = { client_email: "bilim@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
const google = { token: 0, sites: 0, query: [], sitemaps: 0, inspect: [], jwtOk: null };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === "https://oauth2.googleapis.com/token") {
    google.token++;
    const assertion = new URLSearchParams(String(init.body)).get("assertion");
    const [h, p, sig] = assertion.split(".");
    google.jwtOk = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url"));
    google.claims = JSON.parse(Buffer.from(p, "base64url").toString());
    return J({ access_token: "ya29.test", expires_in: 3600 });
  }
  if (u.startsWith("https://www.googleapis.com/webmasters/v3/")) {
    if (init?.headers?.Authorization !== "Bearer ya29.test") return J({ error: { message: "no auth" } }, 401);
    if (u.endsWith("/sites")) { google.sites++; return J({ siteEntry: [{ siteUrl: "https://other.com/", permissionLevel: "siteOwner" }, { siteUrl: "sc-domain:bilimmanba.uz", permissionLevel: "siteFullUser" }] }); }
    if (u.endsWith("/sitemaps")) { google.sitemaps++; return J({ sitemap: [{ path: "https://bilimmanba.uz/sitemap.xml", lastSubmitted: "2026-10-01T00:00:00Z", lastDownloaded: "2026-10-11T00:00:00Z", isPending: false, errors: "0", warnings: "1", contents: [{ type: "web", submitted: "71" }] }] }); }
    if (u.includes("/searchAnalytics/query")) {
      const b = JSON.parse(init.body); google.query.push({ url: u, body: b });
      const dim = b.dimensions?.[0];
      if (!dim) return J({ rows: [{ clicks: b.startDate < "2026-09-01" ? 50 : 80, impressions: 4000, ctr: 0.02, position: 12.34 }] });
      if (dim === "date") return J({ rows: [{ keys: ["2026-10-09"], clicks: 3, impressions: 150, ctr: 0.02, position: 11 }, { keys: ["2026-10-10"], clicks: 5, impressions: 160, ctr: 0.031, position: 10 }] });
      if (dim === "query") return J({ rows: [
        { keys: ["qora tuynuk nima"], clicks: 20, impressions: 900, ctr: 0.022, position: 3.2 },   // lowCtr
        { keys: ["amir temur"], clicks: 4, impressions: 300, ctr: 0.013, position: 11.6 },         // page2
        { keys: ["messi"], clicks: 9, impressions: 40, ctr: 0.225, position: 2.1 },                // yaxshi
        { keys: ["kam ko'rilgan"], clicks: 0, impressions: 3, ctr: 0, position: 15 },              // juda kam
      ] });
      if (dim === "page") return J({ rows: [{ keys: ["https://bilimmanba.uz/articles/qora-tuynuk"], clicks: 20, impressions: 900, ctr: 0.022, position: 3.2 }] });
      if (dim === "country") return J({ rows: [{ keys: ["uzb"], clicks: 70, impressions: 3500, ctr: 0.02, position: 10 }] });
      if (dim === "device") return J({ rows: [{ keys: ["MOBILE"], clicks: 60, impressions: 3000, ctr: 0.02, position: 11 }] });
    }
  }
  if (u === "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect") {
    const b = JSON.parse(init.body); google.inspect.push(b);
    const indexed = b.inspectionUrl.endsWith("/eski");
    return J({ inspectionResult: { inspectionResultLink: `https://search.google.com/search-console/inspect?resource_id=sc-domain:bilimmanba.uz&id=INSPECT${google.inspect.length}&utm_medium=link`, indexStatusResult: indexed
      ? { verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-10-05T10:00:00Z" }
      : { verdict: "NEUTRAL", coverageState: "Discovered - currently not indexed" } } });
  }
  return realFetch(url, init);
};

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5498, host: "127.0.0.1" });
await server.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ GSC_CREDENTIALS: Buffer.from(JSON.stringify(creds)).toString("base64"), SITE_URL: "https://bilimmanba.uz" })] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5498, username: "postgres", password: "postgres",
      database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, AdminModule, ArticlesModule, CommentsModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });
await app.init();
const admin = app.get(AdminService), stats = app.get(StatsService), articles = app.get(ArticlesService), gsc = app.get(SearchConsoleService);
await new Promise((r) => setTimeout(r, 300)); // migratsiyalar (daily_views) tugasin

// --- Ma'lumotlar: "bugun" = 2026-10-12 (Toshkent) ---
const NOW = new Date("2026-10-12T09:00:00Z"); // Toshkentda 14:00
const fan = await admin.createCategory({ name: "Fan", slug: "Fan" });
const sport = await admin.createCategory({ name: "Sport", slug: "Sport" });
const a1 = await admin.createArticle({ title: "Qora tuynuk", slug: "qora-tuynuk", categoryId: fan.id, type: "free", status: "published", content: "x", excerpt: "x" });
const a2 = await admin.createArticle({ title: "Messi", slug: "messi", categoryId: sport.id, type: "free", status: "published", content: "x", excerpt: "x" });
const a3 = await admin.createArticle({ title: "Eski", slug: "eski", categoryId: fan.id, type: "free", status: "published", content: "x", excerpt: "x" });
await admin.createArticle({ title: "Qoralama", slug: "qoralama", categoryId: fan.id, type: "free", status: "draft", content: "x", excerpt: "x" });
await db.query(`UPDATE articles SET "createdAt" = '2026-09-01T10:00:00Z' WHERE slug = 'eski'`);
await db.query(`UPDATE articles SET "createdAt" = '2026-10-12T05:00:00Z' WHERE slug IN ('qora-tuynuk','messi')`);
const dv = (id, day, n) => db.query(`INSERT INTO daily_views ("articleId", day, views) VALUES ($1, $2, $3)`, [id, day, n]);
await dv(a1.id, "2026-10-12", 30); await dv(a2.id, "2026-10-12", 10);   // bugun 40
await dv(a1.id, "2026-10-11", 20);                                       // kecha 20
await dv(a2.id, "2026-10-08", 50);                                       // hafta ichida
await dv(a3.id, "2026-10-01", 100);                                      // o'tgan hafta
await dv(a3.id, "2026-06-15", 400);                                      // yil ichida
const user = async (name, created, extra = "") => (await db.query(`INSERT INTO users ("fullName", email, password, role, plan, "isActive", "isPublic", "createdAt", "updatedAt") VALUES ($1, $2, 'x', $3, $4, true, false, $5, $5) RETURNING id`, [name, name.toLowerCase().replace(/\s/g, "") + "@t.uz", extra === "admin" ? "admin" : "user", extra === "premium" ? "premium" : "free", created])).rows[0].id;
const u1 = await user("Ali Valiyev", "2026-10-12T03:00:00Z");   // bugun (Toshkent 08:00)
const u2 = await user("Vali", "2026-10-11T20:30:00Z");           // Toshkentda 12-okt 01:30 → bugun!
const u3 = await user("Sardor", "2026-10-11T10:00:00Z", "premium"); // kecha
await user("Admin", "2026-01-01T00:00:00Z", "admin");
await db.query(`INSERT INTO likes ("userId","articleId","createdAt","updatedAt") VALUES ($1,$2,'2026-10-12T06:00:00Z','2026-10-12T06:00:00Z'), ($3,$2,'2026-10-11T06:00:00Z','2026-10-11T06:00:00Z')`, [u1, a1.id, u3]);
await db.query(`INSERT INTO article_views ("userId","articleId","readDuration","createdAt","updatedAt") VALUES ($1,$2,0,'2026-10-12T07:00:00Z','2026-10-12T07:00:00Z'), ($1,$3,0,'2026-10-12T07:30:00Z','2026-10-12T07:30:00Z'), ($4,$2,0,'2026-10-11T07:00:00Z','2026-10-11T07:00:00Z')`, [u1, a1.id, a2.id, u3]);

// 1) recordView kunlik jadvalga yozadi (haqiqiy bugungi sana bilan)
const snapshot = (await db.query(`SELECT "articleId", to_char(day,'YYYY-MM-DD') d, views FROM daily_views`)).rows;
const before = Number((await db.query(`SELECT COALESCE(SUM(views),0) s FROM daily_views WHERE day = ((now() AT TIME ZONE 'UTC') + interval '5 hours')::date`)).rows[0].s);
await articles.recordView("messi"); await articles.recordView("messi"); await articles.recordView("qoralama");
const after = Number((await db.query(`SELECT COALESCE(SUM(views),0) s FROM daily_views WHERE day = ((now() AT TIME ZONE 'UTC') + interval '5 hours')::date`)).rows[0].s);
check("recordView → daily_views (+2, qoralama hisoblanmaydi)", after - before === 2, `${before} → ${after}`);
// recordView qo'shgan yozuvlarni qaytaramiz (bugungi sana testdagi "bugun" bilan bir xil bo'lishi mumkin)
await db.query(`DELETE FROM daily_views`);
for (const r of snapshot) await dv(r.articleId, r.d, r.views);

// 2) Kunlik
const d = await stats.report("day", NOW);
check("kunlik oralig'i: bugun ↔ kecha", d.range.from === "2026-10-12" && d.range.to === "2026-10-12" && d.previousRange.from === "2026-10-11", JSON.stringify(d.range));
check("kunlik ko'rishlar 40 ↔ 20", d.current.views === 40 && d.previous.views === 20, `${d.current.views} ↔ ${d.previous.views}`);
check("yangi foydalanuvchilar Toshkent vaqtida (UTC 20:30 → ertasi)", d.current.newUsers === 2 && d.previous.newUsers === 1, `${d.current.newUsers} ↔ ${d.previous.newUsers}`);
check("like, chop etilgan, faol o'quvchilar", d.current.likes === 1 && d.previous.likes === 1 && d.current.published === 2 && d.current.activeReaders === 1 && d.previous.activeReaders === 1, JSON.stringify(d.current));
check("kunlik grafik: 14 kun, bo'shlar 0", d.series.points.length === 14 && d.series.points.at(-1).bucket === "2026-10-12" && d.series.points.at(-1).views === 40 && d.series.points.at(-3).views === 0, JSON.stringify(d.series.points.slice(-3)));
check("eng ko'p o'qilganlar (bugun)", d.topArticles[0].slug === "qora-tuynuk" && d.topArticles[0].views === 30 && d.topArticles[0].category === "Fan", JSON.stringify(d.topArticles));
check("kategoriyalar (bugun)", d.topCategories[0].name === "Fan" && d.topCategories[0].views === 30 && d.topCategories[1].name === "Sport");

// 3) Haftalik / oylik / yillik
const w = await stats.report("week", NOW);
check("haftalik: 06–12 okt ↔ 29 sen–05 okt", w.range.from === "2026-10-06" && w.previousRange.to === "2026-10-05" && w.current.views === 110 && w.previous.views === 100, `${w.current.views} ↔ ${w.previous.views}`);
check("haftalik grafik: 12 hafta (dushanbadan)", w.series.unit === "week" && w.series.points.length === 12 && w.series.points.at(-1).bucket === "2026-10-12", w.series.points.at(-1).bucket);
const m = await stats.report("month", NOW);
check("oylik: 30 kun, ko'rishlar 210", m.series.points.length === 30 && m.current.views === 210, String(m.current.views));
const y = await stats.report("year", NOW);
check("yillik: 12 oy, ko'rishlar 610", y.series.unit === "month" && y.series.points.length === 12 && y.series.points[0].bucket === "2025-11-01" && y.current.views === 610, `${y.series.points[0].bucket} ${y.current.views}`);
check("yillik grafik: iyun oyi 400", y.series.points.find((p) => p.bucket === "2026-06-01")?.views === 400);
let bad = null; try { await stats.report("decade", NOW); } catch (e) { bad = e; }
check("noto'g'ri davr → 400", bad?.status === 400);

// 4) Jami
const t = d.totals;
check("jami: foydalanuvchi, premium, maqola, qoralama, like", t.users === 4 && t.premium === 1 && t.articles === 3 && t.drafts === 1 && t.likes === 2, JSON.stringify(t));
check("ko'rishlar hisoboti qachondan", t.viewsTrackedSince === "2026-06-15", t.viewsTrackedSince);
const st = await admin.getStats();
check("dashboard: o'qishlar = viewCount yig'indisi, maqola = chop etilgan", st.articleCount === 3 && st.viewCount === 2, JSON.stringify(st));

// 5) Foydalanuvchilar
const us = await stats.users();
const ali = us.find((x) => x.fullName === "Ali Valiyev");
check("foydalanuvchilar: yangisi birinchi", us[0].fullName === "Ali Valiyev" && us.length === 4, us.map((x) => x.fullName).join(", "));
check("faollik: o'qigan, like, oxirgi faollik", ali.reads === 2 && ali.likes === 1 && new Date(ali.lastActiveAt).toISOString() === "2026-10-12T07:30:00.000Z", JSON.stringify({ r: ali.reads, l: ali.likes, a: ali.lastActiveAt }));
check("parol qaytmaydi", !("password" in ali));

// 6) Search Console
const o = await gsc.overview(28);
check("GSC: JWT imzosi to'g'ri, scope readonly", google.jwtOk === true && google.claims.scope === "https://www.googleapis.com/auth/webmasters.readonly" && google.claims.iss === creds.client_email);
check("GSC: sayt avtomatik topildi (sc-domain)", o.site === "sc-domain:bilimmanba.uz");
check("GSC: jami va oldingi davr", o.totals.clicks === 80 && o.totals.ctr === 2 && o.totals.position === 12.3 && o.previous.clicks === 50, JSON.stringify([o.totals, o.previous]));
check("GSC: 28 kunlik oraliq, dataState=all", google.query.every((q) => q.body.dataState === "all") && (new Date(o.range.endDate) - new Date(o.range.startDate)) / 864e5 === 27);
check("GSC: kunlik, so'rovlar, sahifalar, mamlakat, qurilma", o.daily.length === 2 && o.daily[1].ctr === 3.1 && o.queries[0].key === "qora tuynuk nima" && o.pages[0].path === "/articles/qora-tuynuk" && o.countries[0].key === "uzb" && o.devices[0].key === "MOBILE");
const kinds = Object.fromEntries(o.opportunities.map((x) => [x.key, x.kind]));
check("GSC: imkoniyatlar (2-sahifa, past CTR)", kinds["amir temur"] === "page2" && kinds["qora tuynuk nima"] === "lowCtr" && !kinds["messi"] && !kinds["kam ko'rilgan"], JSON.stringify(kinds));
check("GSC: sitemap holati", o.sitemaps[0].submitted === 71 && o.sitemaps[0].warnings === 1 && o.sitemaps[0].errors === 0);
const nq = google.query.length;
await gsc.overview(28);
check("GSC: kesh (3 soat) — qayta so'ramaydi, token bir marta", google.query.length === nq && google.token === 1 && google.sites === 1);

const ix = await gsc.indexing();
check("Indekslash: 3 ta maqola tekshirildi, 1 tasi indeksda", ix.items.length === 3 && ix.indexedCount === 1 && google.inspect.length === 3 && google.inspect[0].siteUrl === "sc-domain:bilimmanba.uz", `${ix.indexedCount}/${ix.items.length}`);
const eski = ix.items.find((i) => i.url.endsWith("/eski"));
check("Indekslash: Google bergan havola ishlatildi", eski.indexed && eski.coverageState === "Submitted and indexed" && /\/inspect\?resource_id=sc-domain:bilimmanba\.uz&id=INSPECT\d+&utm_medium=link$/.test(eski.inspectLink), eski.inspectLink);
await gsc.indexing();
check("Indekslash: 24 soat kesh (bazada)", google.inspect.length === 3);
await gsc.indexing(20, true);
check("Indekslash: refresh → qayta tekshiradi", google.inspect.length === 6);
// Birinchi versiyadan qolgan havolasiz kesh — qayta tekshiriladi
const cacheRow = (await db.query(`SELECT value FROM app_settings WHERE key = 'gsc_inspect_cache'`)).rows[0].value;
const legacy = Object.fromEntries(Object.entries(JSON.parse(cacheRow)).map(([k, v]) => [k, { ...v, link: undefined }]));
await db.query(`UPDATE app_settings SET value = $1 WHERE key = 'gsc_inspect_cache'`, [JSON.stringify(legacy)]);
const ix2 = await gsc.indexing();
check("Indekslash: havolasiz eski kesh qayta tekshirildi", google.inspect.length === 9 && ix2.items.every((i) => i.inspectLink.includes("&id=INSPECT")));

// 7) Sozlanmagan holat
const cfg = app.get(require("@nestjs/config").ConfigService);
const origGet = cfg.get.bind(cfg);
cfg.get = (k) => (k === "GSC_CREDENTIALS" ? "" : origGet(k));
const nc = await gsc.overview(28);
check("GSC sozlanmagan → configured:false (xato emas)", nc.configured === false);
cfg.get = origGet;

await app.close(); await server.stop();
console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
