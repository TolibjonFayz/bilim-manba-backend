// Saytning o'z statistikasi: AnalyticsService (hodisalarni qabul qilish + hisobot)
// va email manbasi (ro'yxatdan o'tish / obuna)
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
const jwt = require("jsonwebtoken");
const { AdminModule } = require(BE + "dist/admin/admin.module");
const { AdminService } = require(BE + "dist/admin/admin.service");
const { ArticlesModule } = require(BE + "dist/articles/articles.module");
const { DatabaseModule } = require(BE + "dist/database/database.module");
const { AnalyticsModule } = require(BE + "dist/analytics/analytics.module");
const { AnalyticsService, classifySource, parseUa } = require(BE + "dist/analytics/analytics.service");
const { SubscribersService } = require(BE + "dist/subscribers/subscribers.service");
const { AuthModule } = require(BE + "dist/auth/auth.module");
const { AuthService } = require(BE + "dist/auth/auth.service");
const { QuizService } = require(BE + "dist/quiz/quiz.service");
const { DraftsService } = require(BE + "dist/drafts/drafts.service");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

const SECRET = "test-jwt-secret";
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5507, host: "127.0.0.1" });
await server.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ JWT_SECRET: SECRET, JWT_EXPIRES_IN: "7d" })] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5507, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, AdminModule, ArticlesModule, AnalyticsModule, AuthModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });
await app.init();
const admin = app.get(AdminService), an = app.get(AnalyticsService), subs = app.get(SubscribersService), auth = app.get(AuthService);
clearTimeout(app.get(QuizService).timer); clearTimeout(app.get(DraftsService).timer);
await new Promise((r) => setTimeout(r, 500));

// --- Yordamchi funksiyalar ---
check("manba: utm telegram", classifySource(null, "telegram") === "Telegram");
check("manba: google referrer", classifySource("https://www.google.com/", null) === "Google");
check("manba: yandex", classifySource("https://yandex.uz/search", null) === "Yandex");
check("manba: o'z sayti = to'g'ridan-to'g'ri", classifySource("https://bilimmanba.uz/articles", null) === "To'g'ridan-to'g'ri");
check("manba: bo'sh", classifySource(null, null) === "To'g'ridan-to'g'ri");
check("manba: telegram android ilovasi", classifySource("android-app://org.telegram.messenger/", null) === "Telegram");
const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const IPHONE_TG = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Telegram-iOS";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
check("UA: android telefon chrome", JSON.stringify(parseUa(ANDROID)) === JSON.stringify({ device: "Telefon", os: "Android", browser: "Chrome" }), JSON.stringify(parseUa(ANDROID)));
check("UA: iPhone Telegram ichida", parseUa(IPHONE_TG).browser === "Telegram ichida" && parseUa(IPHONE_TG).os === "iOS");
check("UA: windows kompyuter", parseUa(WIN).device === "Kompyuter" && parseUa(WIN).os === "Windows");

// --- Ma'lumotlar ---
const cat = await admin.createCategory({ name: "Kino", slug: "Kino" });
const art = await admin.createArticle({ title: "Interstellar sharhi", slug: "interstellar", categoryId: cat.id, type: "free", status: "published", content: "https://r2.example/x.json", excerpt: "x" });
await db.query(`INSERT INTO users ("fullName", email, password, role, "createdAt", "updatedAt") VALUES ('Admin','admin@x.uz','x','admin',now(),now()), ('Ali Valiyev','ali@x.uz','x','user',now(),now())`);
const ids = (await db.query(`SELECT id, role FROM users ORDER BY id`)).rows;
const adminTk = jwt.sign({ sub: ids[0].id, role: "admin" }, SECRET);
const userTk = jwt.sign({ sub: ids[1].id, role: "user" }, SECRET);

const now = Date.now();
const V1 = "visitor-aaaa1111", S1 = "session-aaaa1111";
const batch1 = {
  v: V1, s: S1, now,
  ctx: { ref: "", us: "telegram", um: "channel", landing: "/", sc: "390x844" },
  e: [
    { t: "page_view", p: "/", ts: now - 60000, d: { pv: "pv1" } },
    { t: "page_exit", p: "/", ts: now - 50000, d: { pv: "pv1", sec: 10, add: 10, scroll: 40 } },
    { t: "link_click", p: "/", ts: now - 50000, d: { to: "/articles/interstellar", area: "home-latest", text: "Interstellar" } },
    { t: "page_view", p: "/articles/interstellar", ts: now - 49000, d: { pv: "pv2" } },
    { t: "page_exit", p: "/articles/interstellar", ts: now - 30000, d: { pv: "pv2", sec: 19, add: 19, scroll: 50 } },
    { t: "nonsense", p: "/", ts: now },
  ],
};
let r = await an.ingest(batch1, { ua: ANDROID, country: "UZ" });
check("qabul: 5 ta hodisa (noma'lum tur tashlandi)", r.ok && r.stored === 5, JSON.stringify(r));
// Ikkinchi to'plam: o'sha sahifa — o'qish davom etdi (yakuniy 140 s, 95%)
r = await an.ingest({ v: V1, s: S1, now, e: [
  { t: "page_exit", p: "/articles/interstellar", ts: now - 5000, d: { pv: "pv2", sec: 140, add: 121, scroll: 95 } },
  { t: "email_focus", p: "/articles/interstellar", ts: now - 4000, d: { form: "newsletter_footer" } },
  { t: "email_submit", p: "/articles/interstellar", ts: now - 3000, d: { form: "newsletter_footer", ok: true } },
  { t: "like", p: "/articles/interstellar", ts: now - 2000 },
] }, { ua: ANDROID, country: "UZ" });
check("qabul: 2-to'plam", r.stored === 4);
let s1 = (await db.query(`SELECT * FROM analytics_sessions WHERE id = $1`, [S1])).rows[0];
check("sessiya: manba Telegram, telefon, UZ", s1.source === "Telegram" && s1.device === "Telefon" && s1.country === "UZ", `${s1.source} ${s1.device}`);
check("sessiya: 2 sahifa, faol vaqt 150 s", s1.pageviews === 2 && s1.activeSeconds === 150, `${s1.pageviews} ${s1.activeSeconds}`);
check("sessiya: yangi tashrifchi", s1.isNew === true);

// Ikkinchi tashrifchi: Google, kompyuter, kirgan foydalanuvchi; ro'yxatdan o'tishda xato
const V2 = "visitor-bbbb2222", S2 = "session-bbbb2222";
r = await an.ingest({ v: V2, s: S2, tk: userTk, now, ctx: { ref: "https://www.google.com/" }, e: [
  { t: "page_view", p: "/articles/interstellar", ts: now - 20000, d: { pv: "pv3" } },
  { t: "page_exit", p: "/articles/interstellar", ts: now - 10000, d: { pv: "pv3", sec: 8, add: 8, scroll: 20 } },
  { t: "search", p: "/articles/interstellar", ts: now - 9000, d: { q: "Qora tuynuk", results: 0 } },
  { t: "email_focus", p: "/register", ts: now - 8000, d: { form: "register" } },
  { t: "email_submit", p: "/register", ts: now - 7000, d: { form: "register", ok: false, err: "Bu email allaqachon ro'yxatdan o'tgan" } },
] }, { ua: WIN, country: "KZ" });
const s2 = (await db.query(`SELECT * FROM analytics_sessions WHERE id = $1`, [S2])).rows[0];
check("kirgan foydalanuvchi: userId yozildi", s2.userId === ids[1].id && s2.source === "Google");

// Yozilmasligi kerak bo'lganlar
const cnt = async () => Number((await db.query(`SELECT COUNT(*) n FROM analytics_events`)).rows[0].n);
const before = await cnt();
check("bot: yozilmaydi", (await an.ingest({ v: "visitor-cccc3333", s: "session-cccc3333", e: [{ t: "page_view", p: "/" }] }, { ua: "Googlebot/2.1 (+http://www.google.com/bot.html)" })).stored === 0);
check("admin tokeni: yozilmaydi", (await an.ingest({ v: "visitor-dddd4444", s: "session-dddd4444", tk: adminTk, e: [{ t: "page_view", p: "/" }] }, { ua: WIN })).stored === 0);
check("internal (admin brauzeri): yozilmaydi", (await an.ingest({ v: "visitor-eeee5555", s: "session-eeee5555", internal: true, e: [{ t: "page_view", p: "/" }] }, { ua: WIN })).stored === 0);
check("noto'g'ri id: rad", (await an.ingest({ v: "x';drop", s: "session-ffff6666", e: [{ t: "page_view", p: "/" }] }, { ua: WIN })).ok === false);
check("soxta token: userId yo'q, lekin yoziladi", (await an.ingest({ v: "visitor-gggg7777", s: "session-gggg7777", tk: "abc.def.ghi", e: [{ t: "page_view", p: "/about", ts: now }] }, { ua: WIN })).stored === 1);
check("hodisalar soni (+1)", (await cnt()) === before + 1);

// Email manbasi: obuna va ro'yxatdan o'tish
await subs.subscribe("obuna@x.uz", "newsletter_footer", "/articles/interstellar");
const reg = await auth.register({ fullName: "Yangi Odam", email: "yangi@x.uz", password: "secret12", signupSource: "register", signupPath: "/register?from=/articles/interstellar" });
const sub = (await db.query(`SELECT "signupSource", "signupPath" FROM subscribers WHERE email='obuna@x.uz'`)).rows[0];
const usr = (await db.query(`SELECT "signupSource", "signupPath", password FROM users WHERE id=$1`, [reg.userId])).rows[0];
check("obuna: qaysi forma va sahifa", sub.signupSource === "newsletter_footer" && sub.signupPath === "/articles/interstellar", JSON.stringify(sub));
check("ro'yxatdan o'tish: forma va sahifa, parol hash", usr.signupSource === "register" && usr.signupPath.startsWith("/register") && usr.password !== "secret12");

// --- Hisobot ---
const rep = await an.report("week");
check("hisobot: 3 tashrifchi, 3 sessiya", rep.current.visitors === 3 && rep.current.sessions === 3, JSON.stringify(rep.current));
check("hisobot: sahifa ko'rishlar 4", rep.current.pageviews === 4, String(rep.current.pageviews));
check("hisobot: obuna 1 (forma bo'yicha)", rep.current.subscribes === 1 && rep.current.signups === 0);
const a = rep.articles.find((x) => x.path === "/articles/interstellar");
check("maqola: sarlavha, 2 ko'rish, 2 o'quvchi", a && a.title === "Interstellar sharhi" && a.views === 2 && a.readers === 2, JSON.stringify(a));
check("maqola: o'rtacha vaqt (140+8)/2=74 s, oxirigacha 50%", a?.avgSeconds === 74 && a?.finishRate === 50, `${a?.avgSeconds} ${a?.finishRate}`);
check("manbalar: Telegram va Google", rep.sources.some((x) => x.name === "Telegram") && rep.sources.some((x) => x.name === "Google"));
check("qurilmalar: telefon va kompyuter", rep.devices.length === 2);
const nf = rep.forms.forms.find((f) => f.form === "newsletter_footer"), rf = rep.forms.forms.find((f) => f.form === "register");
check("formalar: obuna 1/1/1, ro'yxat 1/1/0", nf?.started === 1 && nf.ok === 1 && rf?.submitted === 1 && rf.ok === 0, JSON.stringify(rep.forms.forms));
check("formalar: xato matni", rep.forms.errors[0]?.error.includes("allaqachon"));
check("emaillar: obuna va ro'yxat, manbasi bilan", rep.forms.recent.some((e) => e.email === "obuna@x.uz" && e.kind === "newsletter" && e.form === "newsletter_footer") && rep.forms.recent.some((e) => e.email === "yangi@x.uz" && e.kind === "register"));
check("voronka: ochdi 2, 30s+ 1, oxirigacha 1, email boshladi 2, aylandi 1", rep.funnel.opened === 2 && rep.funnel.read30 === 1 && rep.funnel.finished === 1 && rep.funnel.emailStarted === 2 && rep.funnel.converted === 1, JSON.stringify(rep.funnel));
check("bosishlar: home-latest 1 (maqolaga)", rep.clicks.areas[0]?.area === "home-latest" && rep.clicks.areas[0].toArticles === 1);
check("qidiruv: natijasiz so'rov", rep.searches[0]?.query === "qora tuynuk" && rep.searches[0].noResults === true);
check("harakatlar: like 1, qidiruv 1", rep.actions.like === 1 && rep.actions.search === 1);
check("issiqlik xaritasi bor", rep.heatmap.length >= 1);
check("grafik: 14 kun", rep.series.points.length === 14 && rep.series.points.at(-1).visitors === 3, JSON.stringify(rep.series.points.at(-1)));
check("hozir saytda: 3", rep.live.count === 3);
check("so'nggi tashriflar: foydalanuvchi ismi", rep.sessions.some((x) => x.userName === "Ali Valiyev"));
check("sahifa turlari: maqola o'rtacha 74 s", rep.pages.find((p) => p.name.startsWith("Maqolalar (bitta"))?.avgSeconds === 74);

const det = await an.session(S1);
check("tashrif tafsiloti: 9 qadam, tartibda, maqola nomi bilan", det.events.length === 9 && det.events[0].type === "page_view" && det.events.some((e) => e.articleTitle === "Interstellar sharhi"), String(det.events.length));
check("tashrif tafsiloti: noto'g'ri id", await an.session("bad id").then(() => false, () => true));

const prev = await an.report("day", new Date(now + 3 * 86400000));
check("boshqa kun: bo'sh, xato yo'q", prev.current.sessions === 0 && prev.articles.length === 0);

await app.close();
await server.stop();
console.log(fails ? `\n${fails} ta tekshiruv yiqildi` : "\nHammasi o'tdi");
process.exit(fails ? 1 : 0);
