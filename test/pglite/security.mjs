// Xavfsizlik testlari (2026-11 audit): haqiqiy HTTP so'rovlar bilan — birovning
// profiliga kirish, soxta token, parol tiklash, obunani bekor qilish imzosi,
// so'rov cheklovi, Payme avtorizatsiyasi, izoh/like qoidalari.
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
const { ValidationPipe } = require("@nestjs/common");
const { APP_GUARD } = require("@nestjs/core");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { DatabaseModule } = require(BE + "dist/database/database.module");
const { AdminModule } = require(BE + "dist/admin/admin.module");
const { AdminService } = require(BE + "dist/admin/admin.service");
const { ArticlesModule } = require(BE + "dist/articles/articles.module");
const { CategoriesModule } = require(BE + "dist/categories/categories.module");
const { AuthModule } = require(BE + "dist/auth/auth.module");
const { UsersModule } = require(BE + "dist/users/users.module");
const { SubscribersModule } = require(BE + "dist/subscribers/subscribers.module");
const { LikesModule } = require(BE + "dist/likes/likes.module");
const { BookmarksModule } = require(BE + "dist/bookmarks/bookmarks.module");
const { CommentsModule } = require(BE + "dist/comments/comments.module");
const { PaymentModule } = require(BE + "dist/payment/payment.module");
const { MailerService } = require(BE + "dist/mailer/mailer.service");
const { DraftsService } = require(BE + "dist/drafts/drafts.service");
const { QuizService } = require(BE + "dist/quiz/quiz.service");
const { RateLimitGuard, resetRateLimits, takeToken } = require(BE + "dist/common/rate-limit");
const { unsubscribeToken, checkUnsubscribeToken } = require(BE + "dist/common/unsubscribe-token");
const { escHtml, safeUrl } = require(BE + "dist/common/html");
const { applyHttpSecurity, originAllowed } = require(BE + "dist/common/http-security");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

const SECRET = "test-secret-for-security-suite-0123456789";
process.env.JWT_SECRET = SECRET;
process.env.PAYME_IS_TEST = "true";
process.env.PAYME_MERCHANT_ID = "merchant-1";
process.env.PAYME_TEST_SECRET_KEY = "payme-test-key";

// 1) Sof funksiyalar
check("escHtml: teglar va qo'shtirnoq", escHtml(`<a href="x">'&`) === "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
check("safeUrl: javascript: o'tmaydi", safeUrl("javascript:alert(1)") === "" && safeUrl("https://a.uz/x") === "https://a.uz/x");
check("unsubscribe imzo: to'g'ri/noto'g'ri/katta-kichik harf", checkUnsubscribeToken("Ali@T.uz", unsubscribeToken("ali@t.uz")) && !checkUnsubscribeToken("vali@t.uz", unsubscribeToken("ali@t.uz")) && !checkUnsubscribeToken("ali@t.uz", undefined) && !checkUnsubscribeToken("ali@t.uz", ["x"]));
check("takeToken: limitdan keyin rad etadi, oynadan so'ng ochiladi", takeToken("k", 2, 1000, 0) && takeToken("k", 2, 1000, 1) && !takeToken("k", 2, 1000, 2) && takeToken("k", 2, 1000, 1001));
resetRateLimits();
check("CORS ro'yxati: o'z saytimiz ha, begona yo'q", originAllowed(undefined) && originAllowed("https://bilimmanba.uz") && originAllowed("https://www.bilimmanba.uz") && originAllowed("http://localhost:3400") && originAllowed("https://bilim-manba-frontend-abc123.vercel.app") && !originAllowed("https://evil.example") && !originAllowed("https://bilimmanba.uz.evil.example") && !originAllowed("http://bilimmanba.uz") && !originAllowed("https://xbilimmanba.uz") && !originAllowed("null"));

// 2) Nest ilova (HTTP)
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5531, host: "127.0.0.1" });
await server.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ JWT_SECRET: SECRET, JWT_EXPIRES_IN: "7d", PAYME_IS_TEST: "true", PAYME_MERCHANT_ID: "merchant-1", PAYME_TEST_SECRET_KEY: "payme-test-key" })] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5531, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, AuthModule, UsersModule, CategoriesModule, ArticlesModule, AdminModule,
    SubscribersModule, LikesModule, BookmarksModule, CommentsModule, PaymentModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });
app.setGlobalPrefix("api");
applyHttpSecurity(app);
app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
await app.init();
clearTimeout(app.get(QuizService).timer); clearTimeout(app.get(DraftsService).timer);
await app.listen(0);
const BASE = `http://127.0.0.1:${app.getHttpServer().address().port}/api`;

let resetUrl = null;
// MailerService bir nechta modulda alohida nusxada — hammasiga ta'sir qilsin
MailerService.prototype.sendResetPasswordEmail = async (_to, _name, url) => { resetUrl = url; };
MailerService.prototype.sendNewArticleEmail = async () => {};

let ipN = 0;
/** Har so'rov boshqa IP dan (cheklov testlariga xalaqit bermasin); ip berilsa — o'sha */
const call = async (method, path, { body, token, ip, headers } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": ip ?? `10.0.${Math.floor(++ipN / 250)}.${ipN % 250}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
};

const admin = app.get(AdminService);
await db.query(`INSERT INTO users ("fullName", email, password, role, plan, "createdAt", "updatedAt") VALUES ('Admin', 'admin@test.uz', $1, 'admin', 'free', now(), now())`, [bcrypt.hashSync("admin123", 4)]);
const cat = await admin.createCategory({ name: "Fan", slug: "Fan bo'limi" });
const pub = await admin.createArticle({ title: "Ochiq maqola", slug: "ochiq", categoryId: cat.id, type: "free", status: "published", content: "http://x/ochiq.json", excerpt: "100% foiz_li matn" });
const pub2 = await admin.createArticle({ title: "Ikkinchi maqola", slug: "ikkinchi", categoryId: cat.id, type: "free", status: "published", content: "http://x/2.json", excerpt: "oddiy" });
const draft = await admin.createArticle({ title: "Qoralama", slug: "qoralama", categoryId: cat.id, type: "free", status: "draft", content: "http://x/q.json" });

// --- CORS va sarlavhalar (haqiqiy sozlama) ---
const pre = (origin, path = "/auth/login") => fetch(BASE + path, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" } });
const okPre = await pre("https://bilimmanba.uz"), badPre = await pre("https://evil.example");
check("CORS: bilimmanba.uz ga ruxsat (preflight)", okPre.headers.get("access-control-allow-origin") === "https://bilimmanba.uz" && /authorization/i.test(okPre.headers.get("access-control-allow-headers") ?? "") && /DELETE/.test(okPre.headers.get("access-control-allow-methods") ?? ""));
check("CORS: begona saytga ruxsat yo'q", badPre.headers.get("access-control-allow-origin") === null);
const plain = await fetch(BASE + "/articles/all", { headers: { origin: "https://www.bilimmanba.uz" } });
check("CORS: oddiy GET javobida ham sarlavha bor", plain.status === 200 && plain.headers.get("access-control-allow-origin") === "https://www.bilimmanba.uz");
const noOrigin = await fetch(BASE + "/articles/all");
check("Origin'siz so'rov (SSR, monitoring) ishlaydi", noOrigin.status === 200);
check("xavfsizlik sarlavhalari bor, x-powered-by yo'q", noOrigin.headers.get("x-content-type-options") === "nosniff" && noOrigin.headers.get("x-frame-options") === "DENY" && !!noOrigin.headers.get("strict-transport-security") && noOrigin.headers.get("x-powered-by") === null);

// --- Ro'yxatdan o'tish / kirish ---
const reg = async (name, email, password = "parol123") => (await call("POST", "/auth/register", { body: { fullName: name, email, password } }));
const a = await reg("Ali Valiyev", "ali@t.uz"), b = await reg("Vali Karimov", "vali@t.uz");
const aliTok = a.data.token.access_token, valiTok = b.data.token.access_token, aliId = a.data.userId, valiId = b.data.userId;
check("ro'yxatdan o'tish ishlaydi", a.status === 201 && b.status === 201 && aliId && valiId);
check("ro'yxat: rolni body orqali berib bo'lmaydi", (await call("POST", "/auth/register", { body: { fullName: "Hacker", email: "h@t.uz", password: "parol123", role: "admin" } })).status === 201 && (await db.query(`SELECT role FROM users WHERE email = 'h@t.uz'`)).rows[0].role === "user");
check("ro'yxat: juda uzun ism rad etiladi", (await reg("x".repeat(81), "long@t.uz")).status === 400);
check("ro'yxat: noto'g'ri email rad etiladi", (await reg("Test", "emas-email")).status === 400);
check("kirish: noto'g'ri parol → 401", (await call("POST", "/auth/login", { body: { email: "ali@t.uz", password: "xato" } })).status === 401);
check("kirish: yo'q email → 401 (bir xil javob)", (await call("POST", "/auth/login", { body: { email: "yoq@t.uz", password: "xato" } })).status === 401);
check("kirish: email massiv bo'lsa → 400 (bazaga yetmaydi)", (await call("POST", "/auth/login", { body: { email: ["a", "b"], password: "x" } })).status === 400);

// --- Token ---
check("auth/me: haqiqiy token", (await call("GET", "/auth/me", { token: aliTok })).data?.userId === aliId);
const ghost = jwt.sign({ sub: 999999, email: "g@t.uz", role: "admin", plan: "free" }, SECRET, { expiresIn: "5m" });
check("soxta token (yo'q foydalanuvchi) → 401", (await call("GET", "/auth/me", { token: ghost })).status === 401);
const fakeAdmin = jwt.sign({ sub: aliId, email: "ali@t.uz", role: "admin", plan: "free" }, SECRET, { expiresIn: "5m" });
check("tokenga 'admin' yozib qo'yish yordam bermaydi (rol bazadan)", (await call("GET", "/admin/stats", { token: fakeAdmin })).status === 403);
check("boshqa kalit bilan imzolangan token → 401", (await call("GET", "/auth/me", { token: jwt.sign({ sub: aliId }, "boshqa-kalit") })).status === 401);
check("'none' algoritmli token → 401", (await call("GET", "/auth/me", { token: `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: aliId })).toString("base64url")}.` })).status === 401);
const adminTok = (await call("POST", "/auth/login", { body: { email: "admin@test.uz", password: "admin123" } })).data.token.access_token;
check("haqiqiy admin kiradi", (await call("GET", "/admin/stats", { token: adminTok })).status === 200);
check("admin manzillari: tokensiz 401, oddiy foydalanuvchi 403", (await call("GET", "/admin/users")).status === 401 && (await call("GET", "/admin/users", { token: aliTok })).status === 403 && (await call("DELETE", `/admin/articles/${pub2.id}`, { token: aliTok })).status === 403 && (await call("POST", "/articles/create", { token: aliTok, body: {} })).status === 403);

// --- Birovning profili (IDOR) ---
check("o'z profilini ko'radi", (await call("GET", `/users/one/${aliId}`, { token: aliTok })).data?.email === "ali@t.uz");
const peek = await call("GET", `/users/one/${valiId}`, { token: aliTok });
check("birovning profilini (emailini) ko'ra olmaydi → 403", peek.status === 403 && !JSON.stringify(peek.data).includes("vali@t.uz"));
check("birovning ismini o'zgartira olmaydi → 403", (await call("PUT", `/users/one/${valiId}`, { token: aliTok, body: { fullName: "Buzildi" } })).status === 403 && (await db.query(`SELECT "fullName" FROM users WHERE id = $1`, [valiId])).rows[0].fullName === "Vali Karimov");
check("birovning parolini terib ko'ra olmaydi → 403", (await call("PUT", `/users/password/${valiId}`, { token: aliTok, body: { currentPassword: "parol123", newPassword: "yangi123" } })).status === 403);
check("o'z ismini o'zgartiradi; rol/plan o'zgarmaydi", (await call("PUT", `/users/one/${aliId}`, { token: aliTok, body: { fullName: "  Ali V.  ", role: "admin", plan: "premium" } })).data?.fullName === "Ali V." && (await db.query(`SELECT role, plan FROM users WHERE id = $1`, [aliId])).rows[0].role === "user");
const pubProfile = await call("GET", `/users/public/${valiId}`);
check("ochiq profilda email yo'q", pubProfile.status === 200 && !JSON.stringify(pubProfile.data).includes("@"));
check("users/public/abc → 400 (500 emas)", (await call("GET", "/users/public/abc")).status === 400);

// --- Parolni o'zgartirish: eski token bekor, yangisi ishlaydi ---
await new Promise((r) => setTimeout(r, 1100));
const ch = await call("PUT", `/users/password/${aliId}`, { token: aliTok, body: { currentPassword: "parol123", newPassword: "yangi-parol" } });
const aliTok2 = ch.data?.token?.access_token;
check("parol o'zgardi va yangi token berildi", ch.status === 200 && !!aliTok2);
check("eski token endi ishlamaydi", (await call("GET", "/auth/me", { token: aliTok })).status === 401);
check("yangi token ishlaydi", (await call("GET", "/auth/me", { token: aliTok2 })).status === 200);
check("eski parol bilan kirib bo'lmaydi, yangisi bilan — ha", (await call("POST", "/auth/login", { body: { email: "ali@t.uz", password: "parol123" } })).status === 401 && (await call("POST", "/auth/login", { body: { email: "ali@t.uz", password: "yangi-parol" } })).status === 201);

// --- Parolni tiklash ---
const f1 = await call("POST", "/auth/forgot-password", { body: { email: "vali@t.uz" } });
const f0 = await call("POST", "/auth/forgot-password", { body: { email: "yoq@t.uz" } });
await new Promise((r) => setTimeout(r, 50));
check("forgot: bor va yo'q email uchun javob bir xil", f1.status === 201 && f0.status === 201 && f1.data.message === f0.data.message);
const token = resetUrl?.match(/token=([a-f0-9]{64})$/)?.[1];
check("tiklash havolasi yuborildi (sayt manzili + 64 belgili kod)", !!token && resetUrl.startsWith("https://bilimmanba.uz/reset-password?token="));
const stored = (await db.query(`SELECT "resetToken" FROM users WHERE id = $1`, [valiId])).rows[0].resetToken;
check("bazada kod ochiq saqlanmaydi (xesh)", stored && stored !== token && stored.length === 64);
check("forgot: email obyekt/massiv → 400", (await call("POST", "/auth/forgot-password", { body: { email: { ne: "" } } })).status === 400 && (await call("POST", "/auth/forgot-password", { body: {} })).status === 400);
check("reset: bo'sh so'rov → 400 (500 emas)", (await call("POST", "/auth/reset-password", { body: {} })).status === 400);
check("reset: token null/massiv → 400", (await call("POST", "/auth/reset-password", { body: { token: null, newPassword: "abcdef1" } })).status === 400 && (await call("POST", "/auth/reset-password", { body: { token: [stored], newPassword: "abcdef1" } })).status === 400);
check("reset: bazadagi xeshni token qilib yuborish ishlamaydi", (await call("POST", "/auth/reset-password", { body: { token: stored, newPassword: "abcdef1" } })).status === 400);
check("reset: qisqa parol → 400", (await call("POST", "/auth/reset-password", { body: { token, newPassword: "123" } })).status === 400);
await new Promise((r) => setTimeout(r, 1100));
check("reset: to'g'ri kod bilan parol yangilanadi", (await call("POST", "/auth/reset-password", { body: { token, newPassword: "tiklangan1" } })).status === 201);
check("reset: kod bir martalik", (await call("POST", "/auth/reset-password", { body: { token, newPassword: "yana-bir1" } })).status === 400);
check("reset'dan keyin eski token bekor", (await call("GET", "/auth/me", { token: valiTok })).status === 401);
const valiLogin = await call("POST", "/auth/login", { body: { email: "vali@t.uz", password: "tiklangan1" } });
const valiTok2 = valiLogin.data?.token?.access_token;
check("yangi parol bilan kiradi va token ishlaydi", valiLogin.status === 201 && (await call("GET", "/auth/me", { token: valiTok2 })).status === 200);
resetUrl = null;
for (let i = 0; i < 4; i++) await call("POST", "/auth/forgot-password", { body: { email: "ali@t.uz" } });
const cnt = (await db.query(`SELECT "resetToken" FROM users WHERE id = $1`, [aliId])).rows[0].resetToken;
resetUrl = null;
await call("POST", "/auth/forgot-password", { body: { email: "ali@t.uz" } });
await new Promise((r) => setTimeout(r, 50));
check("forgot: bitta emailga soatiga 3 tadan ortiq xat ketmaydi", resetUrl === null && (await db.query(`SELECT "resetToken" FROM users WHERE id = $1`, [aliId])).rows[0].resetToken === cnt);

// --- So'rov cheklovi ---
let last = 0;
for (let i = 0; i < 21; i++) last = (await call("POST", "/auth/login", { ip: "7.7.7.7", body: { email: `brute${i}@t.uz`, password: "x" } })).status;
check("login: bitta IP dan 20 tadan keyin 429", last === 429);
check("login: boshqa IP ga ta'sir qilmaydi", (await call("POST", "/auth/login", { ip: "7.7.7.8", body: { email: "yoq2@t.uz", password: "x" } })).status === 401);
for (let i = 0; i < 16; i++) last = (await call("POST", "/auth/login", { body: { email: "Admin@test.uz", password: "x" + i } })).status;
check("login: bitta emailga turli IP lardan 15 tadan keyin 429", last === 429);
resetRateLimits();

// --- Obuna ---
check("obuna: noto'g'ri email / obyekt → 400", (await call("POST", "/subscribers/subscribe", { body: { email: "emas" } })).status === 400 && (await call("POST", "/subscribers/subscribe", { body: { email: { a: 1 } } })).status === 400);
check("obuna bo'ladi", (await call("POST", "/subscribers/subscribe", { body: { email: "sub@t.uz", source: "newsletter_footer", path: "/" } })).status === 201);
check("bekor qilish: imzosiz → 400, obuna joyida", (await call("GET", "/subscribers/unsubscribe?email=sub@t.uz")).status === 400 && (await call("GET", "/subscribers/unsubscribe?email=sub@t.uz&token=xato")).status === 400 && (await call("GET", "/subscribers/unsubscribe")).status === 400 && (await db.query(`SELECT "isActive" FROM subscribers WHERE email = 'sub@t.uz'`)).rows[0].isActive === true);
check("bekor qilish: to'g'ri imzo bilan ishlaydi", (await call("GET", `/subscribers/unsubscribe?email=sub@t.uz&token=${unsubscribeToken("sub@t.uz")}`)).status === 200 && (await db.query(`SELECT "isActive" FROM subscribers WHERE email = 'sub@t.uz'`)).rows[0].isActive === false);
await call("POST", "/subscribers/subscribe", { body: { email: "sub@t.uz" } });
check("bir bosishda bekor qilish (POST) ham imzo bilan", (await call("POST", `/subscribers/unsubscribe?email=sub@t.uz&token=${unsubscribeToken("sub@t.uz")}`)).status === 201 && (await db.query(`SELECT "isActive" FROM subscribers WHERE email = 'sub@t.uz'`)).rows[0].isActive === false);

// --- Maqolalar ---
check("qoralama ochiq emas", (await call("GET", "/articles/byslug/qoralama")).status === 404 && !JSON.stringify((await call("GET", "/articles/all")).data).includes("Qoralama"));
check("qidiruv: ?q=a&q=b → 200 (500 emas)", (await call("GET", "/articles/search?q=a&q=b")).status === 200 && (await call("GET", "/articles/search?q[x]=y")).status === 200);
check("qidiruv: % hamma narsani topib bermaydi, '100%' topadi", (await call("GET", "/articles/search?q=%25%25")).data.length === 0 && (await call("GET", "/articles/search?q=100%25")).data.length === 1 && (await call("GET", "/articles/search?q=foiz_li")).data.length === 1 && (await call("GET", "/articles/search?q=foiz__i")).data.length === 0);
check("ro'yxat: ?category[a]=b → 200", (await call("GET", "/articles/all?category[a]=b")).status === 200);
const views = async (id) => (await db.query(`SELECT "viewCount" FROM articles WHERE id = $1`, [id])).rows[0].viewCount;
for (let i = 0; i < 8; i++) await call("POST", "/articles/view/ochiq", { ip: "9.9.9.9" });
check("ko'rishlar: bitta IP 8 marta bossa ham 3 ta hisoblanadi", (await views(pub.id)) === 3, String(await views(pub.id)));
await call("POST", "/articles/view/ochiq", { ip: "9.9.9.10", token: aliTok2 });
check("ko'rish: boshqa IP hisoblanadi va kirgan foydalanuvchi tarixiga yoziladi", (await views(pub.id)) === 4 && (await db.query(`SELECT COUNT(*)::int AS n FROM article_views WHERE "userId" = $1`, [aliId])).rows[0].n === 1);

// --- Like / saqlash / izoh ---
check("like: tokensiz 401", (await call("POST", `/articles/${pub.id}/like`)).status === 401);
check("like: qoralamaga → 404; id 'abc' → 400", (await call("POST", `/articles/${draft.id}/like`, { token: aliTok2 })).status === 404 && (await call("POST", "/articles/abc/like", { token: aliTok2 })).status === 400 && (await call("POST", `/articles/${draft.id}/bookmark`, { token: aliTok2 })).status === 404);
check("like ishlaydi", (await call("POST", `/articles/${pub.id}/like`, { token: aliTok2 })).data?.isLiked === true);
check("izoh: tokensiz 401; qoralamaga 404; bo'sh matn 400", (await call("POST", `/articles/${pub.id}/comments`, { body: { content: "x" } })).status === 401 && (await call("POST", `/articles/${draft.id}/comments`, { token: aliTok2, body: { content: "salom" } })).status === 404 && (await call("POST", `/articles/${pub.id}/comments`, { token: aliTok2, body: { content: "   " } })).status === 400);
const c1 = await call("POST", `/articles/${pub.id}/comments`, { token: aliTok2, body: { content: "<script>alert(1)</script> salom" } });
check("izoh yoziladi", c1.status === 201 && c1.data.content.includes("salom"));
check("javob: boshqa maqoladagi izohga bog'lab bo'lmaydi", (await call("POST", `/articles/${pub2.id}/comments`, { token: valiTok2, body: { content: "javob", parentId: c1.data.id } })).status === 404);
const r1 = await call("POST", `/articles/${pub.id}/comments`, { token: valiTok2, body: { content: "javob", parentId: c1.data.id } });
const r2 = await call("POST", `/articles/${pub.id}/comments`, { token: aliTok2, body: { content: "javobga javob", parentId: r1.data.id } });
check("javobga javob asosiy izoh ostiga tushadi", r1.status === 201 && r2.data.parentId === c1.data.id);
check("birovning izohini o'chira olmaydi → 403", (await call("DELETE", `/comments/${c1.data.id}`, { token: valiTok2 })).status === 403);
check("o'z izohini o'chira oladi (avval 403 berardi)", (await call("DELETE", `/comments/${r1.data.id}`, { token: valiTok2 })).status === 200);
check("admin istalgan izohni o'chiradi", (await call("DELETE", `/comments/${c1.data.id}`, { token: adminTok })).status === 200 && (await db.query(`SELECT COUNT(*)::int AS n FROM comments`)).rows[0].n === 0);
for (let i = 0; i < 11; i++) last = (await call("POST", `/articles/${pub.id}/comments`, { ip: "5.5.5.5", token: aliTok2, body: { content: `spam ${i}` } })).status;
check("izoh: daqiqasiga 10 tadan keyin 429", last === 429);

// --- Payme ---
const payme = (auth, body) => call("POST", "/payment/payme", { headers: auth ? { authorization: auth } : {}, body });
const basic = (s) => `Basic ${Buffer.from(s).toString("base64")}`;
const errCode = (r) => r.data?.error?.code;
check("payme: avtorizatsiyasiz → -32504", errCode(await payme(null, { id: 1, method: "CheckTransaction", params: { id: "t" } })) === -32504);
check("payme: 'undefined:undefined' → -32504", errCode(await payme(basic("undefined:undefined"), { id: 1, method: "CheckTransaction", params: { id: "t" } })) === -32504);
check("payme: noto'g'ri kalit → -32504", errCode(await payme(basic("merchant-1:xato"), { id: 1, method: "CheckTransaction", params: { id: "t" } })) === -32504);
const good = basic("merchant-1:payme-test-key");
const okAuth = await payme(good, { id: 1, method: "CheckTransaction", params: { id: "yoq" } });
check("payme: to'g'ri kalit o'tadi", errCode(okAuth) === -31003, JSON.stringify(okAuth.data));
check("payme: params'siz so'rov yiqitmaydi", (await payme(good, { id: 1, method: "CreateTransaction" })).status !== 500);
check("payme: yo'q foydalanuvchiga tranzaksiya ochilmaydi", errCode(await payme(good, { id: 1, method: "CreateTransaction", params: { id: "t1", time: 1, amount: 1500000, account: { user_id: 424242 } } })) === -31050);
await payme(good, { id: 1, method: "CreateTransaction", params: { id: "t2", time: 1, amount: 1500000, account: { user_id: valiId } } });
await payme(good, { id: 1, method: "PerformTransaction", params: { id: "t2" } });
check("payme: to'g'ri to'lov premium beradi", (await db.query(`SELECT plan FROM users WHERE id = $1`, [valiId])).rows[0].plan === "premium");

await app.close(); await server.stop(); await db.close();
console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
