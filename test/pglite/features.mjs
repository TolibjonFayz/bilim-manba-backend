// 2026-11 yangi imkoniyatlar: Google bilan kirish, maqolaga fayl biriktirish,
// email holati va tarqatma natijasi.
// Tashqi xizmatlar (Google, Instagram, Telegram, R2, SMTP) — soxta.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { generateKeyPairSync, createSign } from "crypto";

const BE = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(BE);
const require = createRequire(BE + "package.json");
require("reflect-metadata");
const { Test } = require("@nestjs/testing");
const { SequelizeModule } = require("@nestjs/sequelize");
const { ConfigModule } = require("@nestjs/config");
const { ValidationPipe } = require("@nestjs/common");
const bcrypt = require("bcryptjs");
const { DatabaseModule } = require(BE + "dist/database/database.module");
const { AdminModule } = require(BE + "dist/admin/admin.module");
const { AdminService } = require(BE + "dist/admin/admin.service");
const { ArticlesModule } = require(BE + "dist/articles/articles.module");
const { AuthModule } = require(BE + "dist/auth/auth.module");
const { UsersModule } = require(BE + "dist/users/users.module");
const { CloudflareService } = require(BE + "dist/cloudflare/cloudflare.service");
const { PublishingService, isMailable } = require(BE + "dist/publishing/publishing.service");
const { InstagramService } = require(BE + "dist/publishing/instagram.service");
const { TelegramService } = require(BE + "dist/publishing/telegram.service");
const { MailerService } = require(BE + "dist/mailer/mailer.service");
const { DraftsService } = require(BE + "dist/drafts/drafts.service");
const { QuizService } = require(BE + "dist/quiz/quiz.service");
const { ChannelQuizService } = require(BE + "dist/publishing/channel-quiz.service");
const { verifyGoogleIdToken, resetGoogleKeyCache } = require(BE + "dist/auth/google-token");
const { sanitizeAttachments, looksLike, keySafe, cleanFileName } = require(BE + "dist/common/attachments");
const { resetRateLimits } = require(BE + "dist/common/rate-limit");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

// ---------- 1) Google ID token ----------
const CLIENT = "123-test.apps.googleusercontent.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const sign = (payload, { kid = "k1", key = privateKey, alg = "RS256" } = {}) => {
  const h = b64({ alg, kid, typ: "JWT" }), p = b64(payload);
  const s = createSign("RSA-SHA256").update(`${h}.${p}`).sign(key).toString("base64url");
  return `${h}.${p}.${s}`;
};
const good = (o = {}) => ({ iss: "https://accounts.google.com", aud: CLIENT, sub: "g-1", email: "Ali.Google@Gmail.com", email_verified: true, name: "Ali Google", iat: now, exp: now + 3600, ...o });
let certFetches = 0;
const fetcher = async () => { certFetches++; return { keys: [jwk], maxAge: 3600 }; };
const vt = (t, o) => verifyGoogleIdToken(t, CLIENT, fetcher, o);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e.message; } };

const prof = await vt(sign(good()));
check("google: to'g'ri token → profil (email kichik harf)", prof.email === "ali.google@gmail.com" && prof.name === "Ali Google" && prof.sub === "g-1");
check("google: kalitlar keshlanadi", (await vt(sign(good()))) && certFetches === 1);
check("google: boshqa ilova (aud) → rad", /boshqa ilova/.test(await rejects(vt(sign(good({ aud: "boshqa" }))))));
check("google: muddati o'tgan → rad", /muddati/.test(await rejects(vt(sign(good({ exp: now - 600 }))))));
check("google: noto'g'ri beruvchi → rad", /beruvchi/.test(await rejects(vt(sign(good({ iss: "evil.com" }))))));
check("google: email tasdiqlanmagan → rad", /tasdiqlanmagan/.test(await rejects(vt(sign(good({ email_verified: false }))))));
check("google: boshqa kalit imzolagan → rad", /imzosi/.test(await rejects(vt(sign(good(), { key: other.privateKey })))));
check("google: noma'lum kid → kalitlar yangilanadi, keyin rad", /kaliti topilmadi/.test(await rejects(vt(sign(good(), { kid: "zz" })))) && certFetches === 2);
check("google: alg none / HS256 → rad", /algoritmi/.test(await rejects(vt(`${b64({ alg: "none", kid: "k1" })}.${b64(good())}.`))) && /algoritmi/.test(await rejects(vt(sign(good(), { alg: "HS256" })))));
const parts = sign(good()).split(".");
check("google: payload o'zgartirilsa → rad", /imzosi/.test(await rejects(vt(`${parts[0]}.${b64(good({ email: "admin@bilimmanba.uz" }))}.${parts[2]}`))));
check("google: buzuq token → rad", !!(await rejects(vt("abc"))) && !!(await rejects(vt("a.b.c"))));

// ---------- 2) Fayllar: sof funksiyalar ----------
const R2 = "https://pub-test.r2.dev";
check("fayl: o'z omborimizdagi pdf qabul", sanitizeAttachments([{ name: "Kitob.pdf", url: `${R2}/files/1-kitob.pdf`, size: 1000 }], R2)[0].ext === "pdf");
check("fayl: begona manzil → 400", !!(await rejects((async () => sanitizeAttachments([{ name: "x.pdf", url: "https://evil.com/files/x.pdf" }], R2))())));
check("fayl: ombor ichida boshqa papka → 400", !!(await rejects((async () => sanitizeAttachments([{ name: "x.json", url: `${R2}/articles/x.json` }], R2))())));
check("fayl: .html/.exe ruxsat yo'q", !!(await rejects((async () => sanitizeAttachments([{ name: "x.html", url: `${R2}/files/x.html` }], R2))())));
check("fayl: bo'sh ro'yxat → null; 11 ta → 400", sanitizeAttachments([], R2) === null && !!(await rejects((async () => sanitizeAttachments(Array(11).fill({ name: "a.pdf", url: `${R2}/files/a.pdf` }), R2))())));
check("fayl nomi: yo'l va xavfli belgilar olib tashlanadi", cleanFileName('C:\\x\\..\\<b>"Kitob".pdf') === 'bKitob/b.pdf'.replace("/", "") || !/[\\/<>"]/.test(cleanFileName('..\\<b>"Kitob".pdf')));
check("R2 kaliti: lotin, kichik harf", /^[a-z0-9-]+\.pdf$/.test(keySafe("O'zbek tili Darslik №1.PDF")), keySafe("O'zbek tili Darslik №1.PDF"));
check("magic: pdf/zip/eski office", looksLike("pdf", Buffer.from("%PDF-1.7")) && !looksLike("pdf", Buffer.from("<html>")) && looksLike("docx", Buffer.from("PK\x03\x04")) && looksLike("txt", Buffer.from("salom")));

// ---------- 3) Nest ilova ----------
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5541, host: "127.0.0.1" });
await server.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ JWT_SECRET: "features-secret-0123456789abcdef0123", JWT_EXPIRES_IN: "7d", GOOGLE_CLIENT_ID: CLIENT, CF_R2_PUBLIC_URL: R2, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "@kanal", INSTAGRAM_ACCESS_TOKEN: "IGtest" })] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5541, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, AuthModule, UsersModule, ArticlesModule, AdminModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });
app.setGlobalPrefix("api");
app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
await app.init();
clearTimeout(app.get(QuizService).timer); clearTimeout(app.get(DraftsService).timer); clearTimeout(app.get(ChannelQuizService).timer);
await app.listen(0);
const BASE = `http://127.0.0.1:${app.getHttpServer().address().port}/api`;

// Google kalitlari va boshqa tashqi so'rovlar — soxta fetch
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://www.googleapis.com/oauth2/v3/certs")) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "cache-control": "max-age=600" } });
  return realFetch(url, opts);
};
resetGoogleKeyCache();

let ipN = 0;
const call = async (method, path, { body, token, form } = {}) => {
  const res = await realFetch(BASE + path, {
    method,
    headers: { ...(form ? {} : { "content-type": "application/json" }), "cf-connecting-ip": `10.9.0.${++ipN % 250}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
};

check("google/config: yoqilgan, client id ochiq", (await call("GET", "/auth/google/config")).data?.clientId === CLIENT);
const g1 = await call("POST", "/auth/google", { body: { credential: sign(good()) } });
check("google: yangi foydalanuvchi ochiladi va token beriladi", g1.status === 201 && g1.data.isNew === true && !!g1.data.token?.access_token);
check("google: token bilan /auth/me ishlaydi", (await call("GET", "/auth/me", { token: g1.data.token.access_token })).data?.email === "ali.google@gmail.com");
const g2 = await call("POST", "/auth/google", { body: { credential: sign(good()) } });
check("google: ikkinchi marta — o'sha akkaunt", g2.data.userId === g1.data.userId && g2.data.isNew === false);
await db.query(`INSERT INTO users ("fullName", email, password, role, plan, "createdAt", "updatedAt") VALUES ('Vali', 'Vali@Test.uz', $1, 'user', 'free', now(), now())`, [bcrypt.hashSync("parol123", 4)]);
const g3 = await call("POST", "/auth/google", { body: { credential: sign(good({ sub: "g-2", email: "vali@test.uz", name: "Vali G" })) } });
check("google: parol bilan ochilgan akkauntga ulanadi (email bir xil)", g3.status === 201 && g3.data.isNew === false && (await db.query(`SELECT COUNT(*)::int n FROM users WHERE lower(email)='vali@test.uz'`)).rows[0].n === 1);
check("google: parol bilan kirish ham ishlayveradi", (await call("POST", "/auth/login", { body: { email: "Vali@Test.uz", password: "parol123" } })).status === 201);
check("google: soxta token → 401", (await call("POST", "/auth/google", { body: { credential: sign(good(), { key: other.privateKey }) } })).status === 401);
check("google: credential'siz → 400", (await call("POST", "/auth/google", { body: {} })).status === 400);
check("google: yangi akkaunt — admin emas", (await db.query(`SELECT role FROM users WHERE id=$1`, [g1.data.userId])).rows[0].role === "user");
resetRateLimits();

// --- Fayl yuklash va maqolaga biriktirish ---
await db.query(`INSERT INTO users ("fullName", email, password, role, plan, "createdAt", "updatedAt") VALUES ('Admin', 'admin@test.uz', $1, 'admin', 'free', now(), now())`, [bcrypt.hashSync("admin123", 4)]);
const adminTok = (await call("POST", "/auth/login", { body: { email: "admin@test.uz", password: "admin123" } })).data.token.access_token;
const userTok = g1.data.token.access_token;
const uploads = [];
const cf = app.get(CloudflareService);
cf.publicUrl = R2;
cf.uploadFile = async (body, key, type, name) => { uploads.push({ key, type, name, size: body.length }); return `${R2}/${key}`; };
const fileForm = (name, content, type = "application/octet-stream") => { const f = new FormData(); f.append("file", new Blob([content], { type }), name); return f; };
const up = await call("POST", "/admin/upload/file", { token: adminTok, form: fileForm("O'zbek tili darsligi.pdf", "%PDF-1.7 test") });
check("yuklash: pdf → R2 files/, asl nom saqlanadi", up.status === 201 && up.data.url.startsWith(`${R2}/files/`) && up.data.name === "O'zbek tili darsligi.pdf" && uploads[0].type === "application/pdf", JSON.stringify(up.data));
check("yuklash: oddiy foydalanuvchi → 403", (await call("POST", "/admin/upload/file", { token: userTok, form: fileForm("a.pdf", "%PDF") })).status === 403);
check("yuklash: .html → 400", (await call("POST", "/admin/upload/file", { token: adminTok, form: fileForm("x.html", "<script>") })).status === 400);
check("yuklash: .pdf deb atalgan html → 400", (await call("POST", "/admin/upload/file", { token: adminTok, form: fileForm("x.pdf", "<html>") })).status === 400);
check("yuklash: faylsiz → 400", (await call("POST", "/admin/upload/file", { token: adminTok, form: new FormData() })).status === 400);
const admin = app.get(AdminService);
const cat = await admin.createCategory({ name: "Fan", slug: "Fan" });
const art = await call("POST", "/admin/articles", { token: adminTok, body: { title: "Kitobli maqola", slug: "kitobli", categoryId: cat.id, type: "free", status: "published", content: "http://x/k.json", excerpt: "e", attachments: [up.data] } });
check("maqola fayl bilan yaratiladi", art.status === 201, JSON.stringify(art.data).slice(0, 200));
const bys = await call("GET", "/articles/byslug/kitobli");
check("byslug: attachments qaytadi", bys.data?.attachments?.[0]?.name === "O'zbek tili darsligi.pdf");
check("ro'yxat (/articles/all): attachments yuborilmaydi", !("attachments" in ((await call("GET", "/articles/all")).data[0] ?? {})));
check("tahrir: begona havola → 400", (await call("PUT", `/admin/articles/${art.data.id}`, { token: adminTok, body: { attachments: [{ name: "x.pdf", url: "https://evil.com/files/x.pdf" }] } })).status === 400);
check("tahrir: fayllarni olib tashlash", (await call("PUT", `/admin/articles/${art.data.id}`, { token: adminTok, body: { attachments: [] } })).status === 200 && (await call("GET", "/articles/byslug/kitobli")).data.attachments === null);

// --- Email holati va tarqatma ---
const mail = await call("GET", "/admin/mail", { token: adminTok });
check("email holati: sozlanmagan deb aniq ko'rsatadi", mail.status === 200 && mail.data.configured === false && /MAIL_HOST/.test(mail.data.error));
check("sinov xati: sozlanmagan → 400 va sababi", /sozlanmagan/.test((await call("POST", "/admin/mail/test", { token: adminTok })).data?.message ?? ""));
await db.query(`INSERT INTO subscribers (email, "isActive", "createdAt", "updatedAt") VALUES ('s1@t.uz', true, now(), now()), ('s2@t.uz', true, now(), now())`);
const pub = app.get(PublishingService);
const r0 = await pub.sendNewsletter({ title: "T", slug: "t", excerpt: "e", coverImage: null });
check("tarqatma: pochta yo'q — 0 ta ketdi, sababi yoziladi", r0.total === 2 && r0.sent === 0 && /sozlanmagan/.test(r0.error));
const mailer = app.get(MailerService);
const realCfg = Object.getOwnPropertyDescriptor(MailerService.prototype, "configured");
Object.defineProperty(mailer, "configured", { get: () => true });
let n = 0;
mailer.sendNewArticleEmail = async (to) => { n++; if (to === "s2@t.uz") { mailer.lastError = "535 auth failed"; return false; } return true; };
const r1 = await pub.sendNewsletter({ title: "T2", slug: "t2", excerpt: "e", coverImage: null });
check("tarqatma: ketma-ket, natija hisoblanadi", r1.sent === 1 && r1.failed === 1 && r1.error === "535 auth failed" && n === 2);
const mail2 = await call("GET", "/admin/mail", { token: adminTok });
check("admin: oxirgi tarqatma natijasi ko'rinadi", mail2.data.lastNewsletter?.title === "T2" && mail2.data.lastNewsletter.sent === 1 && mail2.data.subscribers === 2);

// --- Resend HTTP API (Render SMTP portlarini yopadi) ---
const resendCalls = [];
let resendReply = { status: 200, body: { id: "e1" } };
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://api.resend.com/")) {
    resendCalls.push({ u, method: opts?.method ?? "GET", auth: opts?.headers?.Authorization, body: opts?.body ? JSON.parse(opts.body) : null });
    return new Response(JSON.stringify(resendReply.body), { status: resendReply.status });
  }
  return realFetch(url, opts);
};
const mk = (cfg) => new MailerService({ get: (k) => cfg[k] });
const rm = mk({ MAIL_HOST: "smtp.resend.com", MAIL_PORT: "465", MAIL_USER: "resend", MAIL_PASS: "re_test123", MAIL_FROM: "noreply@bilimmanba.uz" });
check("resend: sozlangan deb hisoblanadi", rm.configured === true);
const okSend = await rm.sendNewArticleEmail("o@t.uz", "Sarlavha <b>", "slug-1", "Tavsif", "https://res.cloudinary.com/x.jpg");
const rc = resendCalls.at(-1);
check("resend: SMTP emas, HTTPS API orqali yuboradi", okSend === true && rc.u === "https://api.resend.com/emails" && rc.method === "POST" && rc.auth === "Bearer re_test123");
check("resend: jo'natuvchi, oluvchi, mavzu, html, unsubscribe sarlavhasi", rc.body.from === '"Bilim Manba" <noreply@bilimmanba.uz>' && rc.body.to[0] === "o@t.uz" && rc.body.subject.includes("Sarlavha") && rc.body.html.includes("Sarlavha &lt;b&gt;") && /unsubscribe/.test(rc.body.headers["List-Unsubscribe"]));
resendReply = { status: 403, body: { name: "validation_error", message: "The bilimmanba.uz domain is not verified" } };
const bad = await rm.sendNewArticleEmail("o@t.uz", "S", "s", "", "");
check("resend: xato bo'lsa false va sababi saqlanadi", bad === false && /not verified/.test(rm.lastError));
resendReply = { status: 401, body: { name: "restricted_api_key", message: "This API key is restricted to only send emails" } };
const rs = await rm.status();
check("resend holati: faqat-yuborish kaliti — ishlayapti", rs.ok === true && rs.host === "Resend API" && resendCalls.at(-1).u.endsWith("/domains"));
resendReply = { status: 400, body: { name: "validation_error", message: "API key is invalid" } };
const rs2 = await rm.status();
check("resend holati: noto'g'ri kalit — xato matni bilan", rs2.ok === false && /invalid/.test(rs2.error));
resendReply = { status: 200, body: { id: "e2" } };
await rm.sendTest("admin@test.uz");
check("sinov xati ham API orqali", resendCalls.at(-1).body.to[0] === "admin@test.uz");
await rm.sendResetPasswordEmail("v@t.uz", "Vali", "https://bilimmanba.uz/reset-password?token=abc");
check("parol tiklash xati ham API orqali", resendCalls.at(-1).body.to[0] === "v@t.uz" && resendCalls.at(-1).body.html.includes("reset-password"));
check("RESEND_API_KEY alohida ham ishlaydi", mk({ RESEND_API_KEY: "re_x", MAIL_FROM: "a@b.uz" }).configured === true);
check("oddiy SMTP (resend emas) — transporter bilan", mk({ MAIL_HOST: "smtp.gmail.com", MAIL_PORT: "465", MAIL_USER: "u", MAIL_PASS: "p" }).configured === true && mk({}).configured === false);

// Oxirgi maqolani qayta yuborish (admin)
Object.defineProperty(MailerService.prototype, "configured", { configurable: true, get() { return true; } });
const sentTo = [];
mailer.sendNewArticleEmail = async (to) => { sentTo.push(to); return true; };
const rl = await call("POST", "/admin/mail/resend-latest", { token: adminTok });
check("qayta yuborish: so'nggi maqola, hamma obunachiga", rl.status === 201 && rl.data.title === "Kitobli maqola" && rl.data.sent === 2 && rl.data.slug === "kitobli" && sentTo.length >= 2, JSON.stringify(rl.data));
check("isMailable: to'g'ri va buzuq manzillar", isMailable("ali@gmail.com") && isMailable("a.b+c@sub.domain.uz") && !isMailable("aligmail.com") && !isMailable("ali@gmail") && !isMailable("ali @gmail.com") && !isMailable("ali@@gmail.com") && !isMailable("") && !isMailable("a@b.c"));
await db.query(`INSERT INTO subscribers (email, "isActive", "createdAt", "updatedAt") VALUES ('buzuq-manzil', true, now(), now()), (' bosh@joy.uz ', true, now(), now())`);
sentTo.length = 0;
const rl2 = await call("POST", "/admin/mail/resend-latest", { token: adminTok });
check("buzuq manzil o'tkazib yuboriladi, xato emas; bo'sh joy kesiladi", rl2.data.invalid === 1 && rl2.data.failed === 0 && rl2.data.sent === 3 && !sentTo.includes("buzuq-manzil") && sentTo.includes("bosh@joy.uz"), JSON.stringify(rl2.data));
check("qayta yuborish: oddiy foydalanuvchiga yopiq", (await call("POST", "/admin/mail/resend-latest", { token: userTok })).status === 403);

await app.close(); await server.stop(); await db.close();
console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
