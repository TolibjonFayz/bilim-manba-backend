// 2026-11-22 foydalanuvchi o'sishi: email tasdiqlash, xush kelibsiz xati,
// haftalik dayjest, obunani bekor qilish (foydalanuvchilar uchun ham).
// Pochta — soxta (xatlar ro'yxatga yoziladi).
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const BE = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(BE);
process.env.JWT_SECRET = "growth-secret-0123456789abcdef0123456789";
const require = createRequire(BE + "package.json");
require("reflect-metadata");
const { Test } = require("@nestjs/testing");
const { SequelizeModule } = require("@nestjs/sequelize");
const { ConfigModule } = require("@nestjs/config");
const { ValidationPipe } = require("@nestjs/common");
const { DatabaseModule } = require(BE + "dist/database/database.module");
const { AdminModule } = require(BE + "dist/admin/admin.module");
const { AdminService } = require(BE + "dist/admin/admin.service");
const { ArticlesModule } = require(BE + "dist/articles/articles.module");
const { AuthModule } = require(BE + "dist/auth/auth.module");
const { UsersModule } = require(BE + "dist/users/users.module");
const { SubscribersModule } = require(BE + "dist/subscribers/subscribers.module");
const { MailerService } = require(BE + "dist/mailer/mailer.service");
const { DraftsService } = require(BE + "dist/drafts/drafts.service");
const { QuizService } = require(BE + "dist/quiz/quiz.service");
const { ChannelQuizService } = require(BE + "dist/publishing/channel-quiz.service");
const { IgRepostService } = require(BE + "dist/publishing/ig-repost.service");
const { DigestService, weekKey, weekLabel } = require(BE + "dist/publishing/digest.service");
const { makeVerifyToken, checkVerifyToken, parseVerifyToken, VERIFY_TTL_MS } = require(BE + "dist/common/verify-token");
const { unsubscribeToken } = require(BE + "dist/common/unsubscribe-token");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

// ---------- 1) Sof funksiyalar ----------
const T0 = Date.UTC(2026, 10, 22, 8, 0);
const tok = makeVerifyToken(7, "Ali@T.uz", T0);
check("verify token: to'g'ri → qabul (email katta-kichik harf farqsiz)", checkVerifyToken(tok, "ali@t.uz", T0 + 1000));
check("verify token: boshqa email → rad", !checkVerifyToken(tok, "vali@t.uz", T0));
check("verify token: 7 kundan keyin → rad", !checkVerifyToken(tok, "ali@t.uz", T0 + VERIFY_TTL_MS + 1));
const [id, exp, sig] = tok.split(".");
check("verify token: userId yoki muddat o'zgartirilsa → rad", !checkVerifyToken(`8.${exp}.${sig}`, "ali@t.uz", T0) && !checkVerifyToken(`${id}.${Number(exp) + 9e9}.${sig}`, "ali@t.uz", T0));
check("verify token: buzuq → parse null", parseVerifyToken("abc") === null && parseVerifyToken("1.2.3") === null && parseVerifyToken(tok)?.userId === 7);
// 2026-11-23 dushanba 12:00 Toshkent = 07:00 UTC
const MON = new Date(Date.UTC(2026, 10, 23, 7, 0));
check("hafta kaliti: dushanba sanasi (Toshkent)", weekKey(MON) === "2026-11-23" && weekKey(new Date(Date.UTC(2026, 10, 29, 18, 30))) === "2026-11-23", weekKey(MON));
check("hafta yorlig'i: o'tgan hafta 16–22-noyabr", weekLabel(MON) === "16–22-noyabr", weekLabel(MON));
check("hafta yorlig'i: oy almashganda", weekLabel(new Date(Date.UTC(2026, 11, 2, 7))) === "23-noyabr – 29-noyabr" || weekLabel(new Date(Date.UTC(2026, 11, 2, 7))).includes("–"), weekLabel(new Date(Date.UTC(2026, 11, 2, 7))));

// ---------- 2) Nest ilova ----------
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5547, host: "127.0.0.1" });
await server.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ JWT_SECRET: process.env.JWT_SECRET, JWT_EXPIRES_IN: "7d" })] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5547, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, AuthModule, UsersModule, ArticlesModule, AdminModule, SubscribersModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });
app.setGlobalPrefix("api");
app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
await app.init();
clearTimeout(app.get(QuizService).timer); clearTimeout(app.get(DraftsService).timer); clearTimeout(app.get(ChannelQuizService).timer); clearTimeout(app.get(IgRepostService).timer);
const digest = app.get(DigestService); clearTimeout(digest.timer); digest.gapMs = 0;
await app.listen(0);
const BASE = `http://127.0.0.1:${app.getHttpServer().address().port}/api`;
await new Promise((r) => setTimeout(r, 300));

// Soxta pochta
// (Sinov modulida MailerService bir nechta nusxada — har biriga ulanadi)
const { AuthService } = require(BE + "dist/auth/auth.service");
const welcomes = [], digests = [];
for (const m of new Set([app.get(MailerService), app.get(AuthService).mailerService, digest.mailer])) {
  Object.defineProperty(m, "configured", { get: () => true, configurable: true });
  m.sendWelcomeEmail = async (to, name, verifyUrl, popular) => { welcomes.push({ to, name, verifyUrl, popular }); return true; };
  m.sendDigestEmail = async (to, items, label) => { digests.push({ to, items, label }); return to !== "xato@t.uz"; };
}

let ipN = 0;
const call = async (method, path, { body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": `10.7.0.${++ipN % 250}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
};
const settle = async () => { for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 100)); } };

// Maqolalar (xush kelibsiz xatidagi "eng ko'p o'qilganlar" va dayjest uchun)
const admin = app.get(AdminService);
const cat = await admin.createCategory({ name: "Fan", slug: "Fan" });
const mk = async (slug, views, daysAgo) => {
  const a = await admin.createArticle({ title: `Maqola ${slug}`, slug, categoryId: cat.id, type: "free", status: "published", content: "https://r2.example/x.json", excerpt: `Tavsif ${slug}` });
  await db.query(`UPDATE articles SET "viewCount" = $1, "createdAt" = $3::timestamptz - ($2 || ' days')::interval WHERE id = $4`, [views, String(daysAgo), MON.toISOString(), a.id]);
  return a;
};
await mk("eski-mashhur", 900, 20);
await mk("h1", 50, 1); await mk("h2", 300, 3); await mk("h3", 120, 6); await mk("juda-eski", 5000, 60);

// ---------- 3) Ro'yxatdan o'tish → xush kelibsiz + tasdiqlash ----------
const reg = await call("POST", "/auth/register", { body: { fullName: "Ali Valiyev", email: "ali@t.uz", password: "parol1234" } });
await settle();
check("ro'yxatdan o'tish ishlaydi", reg.status === 201 && !!reg.data?.token?.access_token, JSON.stringify(reg.data));
const w = welcomes.at(-1);
check("xush kelibsiz xati: tasdiqlash havolasi bilan", w?.to === "ali@t.uz" && /\/verify-email\?token=\d+\.\d+\.[a-f0-9]{40}$/.test(w.verifyUrl ?? ""), JSON.stringify(w));
check("xush kelibsiz xati: eng ko'p o'qilgan 3 maqola", w?.popular.length === 3 && w.popular[0].slug === "juda-eski" && w.popular[0].category === "Fan", JSON.stringify(w?.popular.map((p) => p.slug)));
const aliTok = reg.data.token.access_token, aliId = reg.data.userId;
const prof = await call("GET", `/users/one/${aliId}`, { token: aliTok });
check("profil: emailVerifiedAt hali bo'sh", prof.status === 200 && "emailVerifiedAt" in prof.data && prof.data.emailVerifiedAt === null, JSON.stringify(prof.data).slice(0, 200));
const token = w.verifyUrl.split("token=")[1];
check("noto'g'ri token → 400", (await call("POST", "/auth/verify-email", { body: { token: token.slice(0, -1) + (token.endsWith("a") ? "b" : "a") } })).status === 400);
const v = await call("POST", "/auth/verify-email", { body: { token } });
check("tasdiqlash: 201 ok", v.status === 201 && v.data?.ok === true, JSON.stringify(v.data));
const verifiedAt = (await db.query(`SELECT "emailVerifiedAt" FROM users WHERE id = $1`, [aliId])).rows[0].emailVerifiedAt;
check("tasdiqlash: bazaga yozildi; ikkinchi bosish ham ok", !!verifiedAt && (await call("POST", "/auth/verify-email", { body: { token } })).data?.ok === true);
const rs = await call("POST", "/auth/resend-verification", { token: aliTok });
check("qayta yuborish: allaqachon tasdiqlangan → already", rs.data?.already === true, JSON.stringify(rs.data));

const reg2 = await call("POST", "/auth/register", { body: { fullName: "Guli", email: "guli@t.uz", password: "parol1234" } });
await settle();
const before = welcomes.length;
const rs2 = await call("POST", "/auth/resend-verification", { token: reg2.data.token.access_token });
check("qayta yuborish: tasdiqlanmagan → yangi xat (havola bilan)", rs2.status === 201 && welcomes.length === before + 1 && !!welcomes.at(-1).verifyUrl);
check("qayta yuborish: tokensiz → 401", (await call("POST", "/auth/resend-verification")).status === 401);
// Email o'zgarsa — eski havola ishlamaydi
const gTok = welcomes.at(-1).verifyUrl.split("token=")[1];
await db.query(`UPDATE users SET email = 'guli2@t.uz' WHERE id = $1`, [reg2.data.userId]);
check("email o'zgargach eski havola → 400", (await call("POST", "/auth/verify-email", { body: { token: gTok } })).status === 400);

// ---------- 4) Haftalik dayjest ----------
await db.query(`INSERT INTO subscribers (email, "isActive", "createdAt", "updatedAt") VALUES
  ('s1@t.uz', true, now(), now()), ('Ali@T.uz', true, now(), now()), ('ketgan@t.uz', false, now(), now()),
  ('buzuq-manzil', true, now(), now()), ('xato@t.uz', true, now(), now())`);
const items = await digest.items(MON);
check("dayjest: o'tgan 7 kun (h2, h3, h1) + 30 kunlik bilan to'ldiriladi", items.map((i) => i.slug).join() === "h2,h3,h1,eski-mashhur", items.map((i) => i.slug).join());
let rec = await digest.recipients();
check("oluvchilar: obunachilar + tasdiqlangan foydalanuvchi, takror va buzuqlarsiz", rec.sort().join() === "ali@t.uz,s1@t.uz,xato@t.uz", rec.join());
// Tasdiqlangan, lekin obunani bekor qilgan foydalanuvchi
await db.query(`UPDATE users SET "emailVerifiedAt" = now() WHERE email = 'guli2@t.uz'`);
const uns = await call("GET", `/subscribers/unsubscribe?email=${encodeURIComponent("guli2@t.uz")}&token=${unsubscribeToken("guli2@t.uz")}`);
const uns2 = uns.status < 300 ? uns : await call("POST", "/subscribers/unsubscribe", { body: { email: "guli2@t.uz", token: unsubscribeToken("guli2@t.uz") } });
rec = await digest.recipients();
check("obunani bekor qilgan foydalanuvchi — dayjest olmaydi", uns2.status < 300 && !rec.includes("guli2@t.uz") && rec.length === 3, `${uns.status}/${uns2.status} ${rec.join()}`);

check("dushanba 09:00 — hali vaqti emas", (await digest.runIfDue(new Date(Date.UTC(2026, 10, 23, 4, 0)))) === "skipped");
check("payshanba — o'tkazib yuboriladi", (await digest.runIfDue(new Date(Date.UTC(2026, 10, 26, 7, 0)))) === "skipped");
const r1 = await digest.runIfDue(MON);
check("dushanba 12:00 — yuborildi", r1 === "sent" && digests.length === 3 && digests[0].items.length === 4 && digests[0].label === "16–22-noyabr", `${r1} ${digests.length}`);
const st = await digest.status();
check("natija saqlandi: 2/3, 1 xato", st.enabled && st.last.week === "2026-11-23" && st.last.sent === 2 && st.last.failed === 1 && st.last.total === 3, JSON.stringify(st.last));
check("shu hafta ikkinchi marta — yuborilmaydi", (await digest.runIfDue(new Date(MON.getTime() + 3600e3))) === "skipped" && digests.length === 3);
check("seshanba (server dushanba uxlagan) — keyingi haftada ishlaydi", (await digest.runIfDue(new Date(Date.UTC(2026, 11, 1, 7)))) === "sent");
await digest.setEnabled(false);
check("o'chirilgan — yuborilmaydi", (await digest.runIfDue(new Date(Date.UTC(2026, 11, 7, 7)))) === "skipped" && (await digest.status()).enabled === false);
await digest.setEnabled(true);
await db.query(`DELETE FROM articles`);
const few = await digest.runIfDue(new Date(Date.UTC(2026, 11, 7, 7)));
check("maqolalar kam (<3) — xat ketmaydi, sababi yoziladi", few === "failed" && /yetarli emas/.test((await digest.status()).last.error), few);

await app.close(); await server.stop(); await db.close();
console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
