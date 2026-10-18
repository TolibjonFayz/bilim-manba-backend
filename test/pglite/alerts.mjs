// Adminga shaxsiy Telegram xabarlari + Instant View tugmasi: soxta Telegram API + PGlite
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
const { DatabaseModule } = require(BE + "dist/database/database.module");
const { DraftsService } = require(BE + "dist/drafts/drafts.service");
const { PublishingService } = require(BE + "dist/publishing/publishing.service");
const { TelegramService } = require(BE + "dist/publishing/telegram.service");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

// Soxta Telegram Bot API
const tg = []; let updates = []; let webhookConflict = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/")) return realFetch(url, init);
  const method = u.split("/").pop(); const body = init?.body ? JSON.parse(init.body) : {};
  tg.push({ method, body });
  const ok = (result) => new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
  if (method === "getMe") return ok({ username: "bilim_test_bot" });
  if (method === "getUpdates") {
    if (webhookConflict) return new Response(JSON.stringify({ ok: false, description: "Conflict: can't use getUpdates method while webhook is active" }), { status: 409 });
    return ok(updates.filter((x) => x.update_id >= (body.offset || 0)));
  }
  return ok({ message_id: tg.length });
};

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5498, host: "127.0.0.1" });
await server.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHANNEL_ID: "@bilim_test", TELEGRAM_IV_RHASH: "ab12cd34", GEMINI_API_KEY: "x" })] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5498, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, AdminModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });
await app.init();
const ctrl = app.get(AdminController), admin = app.get(AdminService), drafts = app.get(DraftsService), pub = app.get(PublishingService), tgs = app.get(TelegramService);
clearTimeout(drafts.timer);
await new Promise((r) => setTimeout(r, 500));

// 1) Ulanmagan: xabar jim o'tadi
check("holat: bot bor, ulanmagan", JSON.stringify(await ctrl.alertsStatus()) === '{"botConfigured":true,"linked":false}');
tg.length = 0;
check("ulanmagan — sinov xabari yuborilmaydi", (await ctrl.alertsTest()).sent === false && !tg.some((x) => x.method === "sendMessage"));

// 2) Ulash havolasi
const { url } = await ctrl.alertsLink();
const code = url.split("start=")[1];
check("havola: t.me/<bot>?start=<kod>", /^https:\/\/t\.me\/bilim_test_bot\?start=[\w-]{8,}$/.test(url), url);
check("Start bosilmaguncha — ulanmagan", (await ctrl.alertsCheck()).linked === false);
updates = [
  { update_id: 10, message: { chat: { id: 555, type: "private" }, text: "/start notog'ri-kod" } },
  { update_id: 11, message: { chat: { id: -100, type: "group" }, text: `/start ${code}` } },
  { update_id: 12, message: { chat: { id: 777, type: "private" }, text: `/start ${code}` } },
];
tg.length = 0;
check("Start bosildi → ulandi", (await ctrl.alertsCheck()).linked === true);
const confirm = tg.find((x) => x.method === "sendMessage");
check("tasdiq xabari to'g'ri chatga (guruh va noto'g'ri kod e'tiborsiz)", confirm?.body.chat_id === "777" && /ulandi/.test(confirm.body.text), JSON.stringify(confirm?.body));
const off = (await db.query(`SELECT value FROM app_settings WHERE key='admin_telegram_offset'`)).rows[0]?.value;
check("getUpdates offset saqlandi (eski xabarlar qayta o'qilmaydi)", off === "13", off);
check("havola bir martalik (kod o'chirildi)", (await db.query(`SELECT value FROM app_settings WHERE key='admin_telegram_link'`)).rows[0]?.value === "");
check("holat: ulangan", (await ctrl.alertsStatus()).linked === true);
tg.length = 0;
check("sinov xabari yuborildi", (await ctrl.alertsTest()).sent === true && tg.at(-1).body.chat_id === "777");

// 3) Webhook bo'lsa — tushunarli xato
await ctrl.alertsLink(); webhookConflict = true;
let e = null; try { await ctrl.alertsCheck(); } catch (x) { e = x; }
webhookConflict = false;
check("webhook to'qnashuvi → 503 tushunarli xato", e?.status === 503 && /webhook/.test(e.message), e?.message);

// 4) Qoralama xabarlari
tg.length = 0;
await drafts.alerts.draftReady({ id: 42, title: "Qora <tuynuk> & yulduz" }, true);
const ready = tg.at(-1)?.body;
check("qoralama tayyor: sarlavha HTML-escaped, ko'rib chiqish tugmasi", /Kunlik AI qoralama tayyor/.test(ready?.text) && ready.text.includes("Qora &lt;tuynuk&gt; &amp; yulduz") && ready.reply_markup.inline_keyboard[0][0].url === "https://bilimmanba.uz/admin/articles/42/preview", JSON.stringify(ready));
await drafts.alerts.draftFailed("Gemini 503: band", "Fotosintez", true);
check("qoralama xatosi: mavzu va xato matni", /yozilmadi/.test(tg.at(-1).body.text) && /Fotosintez/.test(tg.at(-1).body.text) && /Gemini 503/.test(tg.at(-1).body.text));

// Kunlik: 3 ta kutilayotgan qoralama → "yozilmadi" xabari
const cat = await admin.createCategory({ name: "Fan", slug: "Fan" });
for (let i = 0; i < 3; i++) await admin.createArticle({ title: `AI ${i}`, slug: `ai-${i}`, categoryId: cat.id, type: "free", status: "draft", content: "https://r2.example/x.json", excerpt: "x", source: "Bilim Manba AI" });
tg.length = 0;
const r = await drafts.runDailyIfDue(new Date("2026-10-20T03:00:00Z"));
check("kunlik: 3 ta kutilmoqda → skipped + adminga xabar", r === "skipped" && tg.some((x) => x.method === "sendMessage" && /Kunlik AI qoralama yozilmadi/.test(x.body.text)), r);

// 5) Rejali nashr → kanal posti (Instant View tugmasi) + adminga natija
const sch = await admin.createArticle({ title: "Rejali maqola", slug: "rejali-maqola", categoryId: cat.id, type: "free", status: "draft", content: "https://r2.example/x.json", excerpt: "Qisqa tavsif" });
await db.query(`UPDATE articles SET "scheduledAt" = now() - interval '1 minute' WHERE id = $1`, [sch.id]);
tg.length = 0;
const n = await pub.publishDue();
const chan = tg.find((x) => x.body.chat_id === "@bilim_test");
const btn = chan?.body.reply_markup.inline_keyboard[0][0].url ?? "";
check("rejali maqola chop etildi", n === 1);
check("kanal tugmasi Instant View (t.me/iv + rhash, utm saqlangan)", btn.startsWith("https://t.me/iv?url=") && btn.endsWith("&rhash=ab12cd34") && decodeURIComponent(btn.split("url=")[1].split("&rhash")[0]) === "https://bilimmanba.uz/articles/rejali-maqola?utm_source=telegram&utm_medium=channel", btn);
const pubMsg = tg.find((x) => x.body.chat_id === "777" && /chop etildi/.test(x.body.text));
check("adminga: chop etildi, Telegram ✅, Instagram ulanmagan", pubMsg && /Telegram kanal: ✅/.test(pubMsg.body.text) && /Instagram: — ulanmagan/.test(pubMsg.body.text), pubMsg?.body.text);
check("readUrl: rhash bo'lmasa oddiy havola", (() => { const c = tgs.config; const orig = c.get.bind(c); c.get = (k) => (k === "TELEGRAM_IV_RHASH" ? undefined : orig(k)); const u = tgs.readUrl("x"); c.get = orig; return u === "https://bilimmanba.uz/articles/x?utm_source=telegram&utm_medium=channel"; })());

// 6) Telegram ishlamasa ham nashr to'xtamaydi
globalThis.fetch = async (url, init) => (String(url).startsWith("https://api.telegram.org/") ? Promise.reject(new TypeError("fetch failed")) : realFetch(url, init));
check("Telegram ishlamasa — send() false, xato otmaydi", (await drafts.alerts.send("x")) === false);

// 7) Uzish
check("uzish → ulanmagan", (await ctrl.alertsUnlink()).linked === false);

await app.close(); await server.stop(); await db.close();
console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
