// Audio maqolalar: matn tayyorlash, Gemini TTS (soxta), MP3, navbat, limitlar (PGlite)
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
const { DatabaseModule } = require(BE + "dist/database/database.module");
const { AdminModule } = require(BE + "dist/admin/admin.module");
const { AdminService } = require(BE + "dist/admin/admin.service");
const { ArticlesModule } = require(BE + "dist/articles/articles.module");
const { ArticlesService } = require(BE + "dist/articles/articles.service");
const { DraftsService } = require(BE + "dist/drafts/drafts.service");
const { QuizService } = require(BE + "dist/quiz/quiz.service");
const { ChannelQuizService } = require(BE + "dist/publishing/channel-quiz.service");
const { DigestService } = require(BE + "dist/publishing/digest.service");
const { AudioService } = require(BE + "dist/audio/audio.service");
const { speechText, chunkText, findAudio, toPcm, joinPcm, toMp3 } = require(BE + "dist/audio/audio-tools");
const { createTts } = require(BE + "dist/audio/gemini-tts");
const { TelegramService } = require(BE + "dist/publishing/telegram.service");
const { AudioController } = require(BE + "dist/audio/audio.controller");

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

// ---------- 1) Sof funksiyalar ----------
const html = `<h2>Kirish 🚀</h2><p>Birinchi &amp; gap. Ikkinchi gap!</p><ul><li>Band bir</li><li>Band ikki</li></ul><figure><img src="x"><figcaption>Rasm izohi</figcaption></figure><h2>Manbalar</h2><ul><li>Wikipedia</li></ul>`;
const st = speechText("Qora tuynuk", html);
check("speechText: sarlavha boshida, h2/li oxirida nuqta", st.startsWith("Qora tuynuk.\nKirish.") && st.includes("Band bir.") && st.includes("Birinchi & gap."), JSON.stringify(st));
check("speechText: Manbalar, rasm izohi va emoji o'qilmaydi", !/Wikipedia|Rasm izohi|🚀/.test(st));
const long = Array.from({ length: 40 }, (_, i) => `${i}-xatboshi. ` + "So'z ".repeat(30)).join("\n");
const ch = chunkText(long, 1000);
check("chunkText: har bo'lak ≤ 1000, matn yo'qolmaydi", ch.every((c) => c.length <= 1000) && ch.join("\n").replace(/\s/g, "") === long.replace(/\s/g, ""), ch.map((c) => c.length).join());
const huge = ("Juda uzun gap bor. ").repeat(300);
check("chunkText: bitta uzun xatboshi gaplarga bo'linadi", chunkText(huge, 800).every((c) => c.length <= 800) && chunkText(huge, 800).length > 5);
check("findAudio: generateContent shakli", findAudio({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: "AAA=" } }] } }] })?.mime.includes("rate=24000"));
check("findAudio: Interactions shakli", findAudio({ outputs: [{ type: "audio", mime_type: "audio/wav", data: "UklG" }] })?.mime === "audio/wav");
check("findAudio: ovoz yo'q → null", findAudio({ candidates: [{ content: { parts: [{ text: "salom" }] } }] }) === null);

const RATE = 24000;
const sine = (sec, freq = 440) => { const n = Math.round(RATE * sec); const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = Math.round(8000 * Math.sin((2 * Math.PI * freq * i) / RATE)); return a; };
const pcmBytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const wav = (a, rate = RATE) => { const d = pcmBytes(a); const h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + d.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(d.length, 40); return Buffer.concat([h, d]); };
const s1 = sine(1);
const fromWav = toPcm(wav(s1, 22050), "audio/wav");
check("toPcm: WAV sarlavhasi o'qiladi (chastota, namunalar)", fromWav.rate === 22050 && fromWav.pcm.length === s1.length && fromWav.pcm[100] === s1[100]);
const fromRaw = toPcm(pcmBytes(s1), "audio/L16;codec=pcm;rate=24000");
check("toPcm: xom L16", fromRaw.rate === 24000 && fromRaw.pcm.length === s1.length && fromRaw.pcm[5] === s1[5]);
const joined = joinPcm([sine(1), sine(1)], RATE);
check("joinPcm: orasida 0.35 s sukut", joined.length === RATE * 2 + Math.round(RATE * 0.35) && joined[RATE + 10] === 0);
const mp3 = await toMp3(sine(3), RATE);
check("toMp3: MP3 kadrlari, 3 s ≈ 18 KB (48 kbit/s)", mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0 && mp3.length > 15000 && mp3.length < 22000, `${mp3.length} bayt`);

// ---------- 2) Gemini TTS mijozi (soxta fetch) ----------
const calls = [];
let mode = "interactions-404";
const geminiJson = (sec = 1) => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcmBytes(sine(sec)).toString("base64") } }] } }] });
const fakeFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url: String(url), body, key: init.headers["x-goog-api-key"] });
  const json = (status, j) => new Response(JSON.stringify(j), { status });
  if (mode === "429") return json(429, { error: { message: "Resource has been exhausted (quota)" } });
  if (String(url).endsWith("/interactions")) return mode === "interactions-ok" ? json(200, { outputs: [{ type: "audio", mime_type: "audio/wav", data: wav(sine(1)).toString("base64") }] }) : json(404, { error: { message: "Not found" } });
  if (String(url).includes("gemini-3.8-flash-tts:generateContent") && mode === "only-lite") return json(404, { error: { message: "model not found" } });
  return json(200, geminiJson(1));
};
let tts = createTts({ key: "k1", fetch: fakeFetch });
let r = await tts.speak("Salom dunyo", "Charon");
check("tts: Interactions 404 → generateContent bilan ovoz", r.pcm.length === RATE && tts.route.api === "generate" && tts.route.model === "gemini-3.8-flash-tts", JSON.stringify(tts.route));
check("tts: so'rov — kalit, ovoz nomi, AUDIO", calls.at(-1).key === "k1" && calls.at(-1).body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName === "Charon" && calls.at(-1).body.generationConfig.responseModalities[0] === "AUDIO");
const n0 = calls.length; await tts.speak("Yana", "Charon");
check("tts: ishlagan yo'l eslab qolinadi (1 so'rov)", calls.length === n0 + 1);
mode = "interactions-ok"; calls.length = 0; tts = createTts({ key: "k1", fetch: fakeFetch });
r = await tts.speak("Salom", "Kore");
check("tts: Interactions WAV javobi ham o'qiladi, uslub bilan", r.pcm.length === RATE && tts.route.api === "interactions" && calls[0].body.input[0].content[0].annotations[0].style.includes("narrator") && calls[0].body.generation_config.speech_config[0].voice === "Kore");
mode = "only-lite"; tts = createTts({ key: "k1", fetch: fakeFetch });
await tts.speak("Salom", "Kore");
check("tts: asosiy model yo'q → lite model", tts.route.model === "gemini-3.8-flash-lite-tts");
mode = "429"; tts = createTts({ key: "k1", fetch: fakeFetch });
let e429 = null; try { await tts.speak("x", "Kore"); } catch (e) { e429 = e; }
check("tts: 429 → rateLimited, boshqa model sinalmaydi", e429?.rateLimited === true && calls.at(-1).url.endsWith("/interactions"), e429?.message);

// ---------- 3) Nest: navbat, saqlash, sahifa ----------
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5551, host: "127.0.0.1" });
await server.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ GEMINI_API_KEY: "gem-test", AUDIO_DAILY_MAX: "2", CF_R2_PUBLIC_URL: "https://pub-test.r2.dev", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "@kanal" })] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5551, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, ArticlesModule, AdminModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });
await app.init();
for (const S of [QuizService, DraftsService, ChannelQuizService, DigestService]) clearTimeout(app.get(S).timer);
const audio = app.get(AudioService); clearTimeout(audio.timer);
const instances = new Set([audio, app.get(ArticlesService).audio, app.get(AdminService).audio]);
check("AudioService bitta nusxa (fon jarayoni ikki marta ishlamaydi)", instances.size === 1, String(instances.size));
await new Promise((r) => setTimeout(r, 300));
audio.gapMs = 0;
// Telegram — soxta (hamma nusxalarda bitta TelegramService)
const tgCalls = [];
const tgs = app.get(TelegramService);
check("AudioService o'sha TelegramService'dan foydalanadi", audio.telegram === tgs);
tgs.call = async (method, body) => { tgCalls.push({ method, body }); return { ok: true }; };
mode = "generate"; calls.length = 0;
audio.fetchOverride = fakeFetch;
const uploads = [];
audio.cloudflare.uploadAudio = async (buf, key) => { uploads.push({ key, size: buf.length }); return `https://pub-test.r2.dev/${key}`; };
// Maqola matnlari (R2) — soxta
const realFetch = globalThis.fetch;
const texts = {};
globalThis.fetch = async (url, init) => (String(url).startsWith("https://r2.test/") ? new Response(JSON.stringify({ message: texts[String(url)] })) : realFetch(url, init));

const admin = app.get(AdminService), articles = app.get(ArticlesService);
const cat = await admin.createCategory({ name: "Fan", slug: "Fan" });
const para = (n) => Array.from({ length: n }, (_, i) => `<p>${i + 1}-xatboshi. ${"Bu maqola matnining bir qismi. ".repeat(12)}</p>`).join("");
const mk = async (slug, views, paras = 4) => {
  const url = `https://r2.test/${slug}.json`;
  texts[url] = `<h2>Kirish</h2>${para(paras)}<h2>Manbalar</h2><p>x</p>`;
  const a = await admin.createArticle({ title: `Maqola ${slug}`, slug, categoryId: cat.id, type: "free", status: "published", content: url, excerpt: "t" });
  await db.query(`UPDATE articles SET "viewCount" = $1, "createdAt" = now() - interval '10 days' WHERE id = $2`, [views, a.id]);
  return a;
};
const A = await mk("mashhur", 500, 12), B = await mk("oddiy", 10), C = await mk("yangi", 1);
await db.query(`UPDATE articles SET "createdAt" = now() - interval '1 day' WHERE id = $1`, [C.id]);

check("o'chirilgan holatda — ishlamaydi", (await audio.tick()) === "skipped" && calls.length === 0);
let s = await audio.settings({ voice: "Kore" });
check("ovoz tanlandi, hali o'chiq", s.voice === "Kore" && s.enabled === false && s.done === 0 && s.total === 3);
let bad = ""; try { await audio.settings({ voice: "Hacker" }); } catch (e) { bad = e.constructor.name; }
check("noma'lum ovoz → BadRequest", bad === "BadRequestException");
await audio.settings({ enabled: true }); clearTimeout(audio.timer);
check("navbat: avval yangi (1 kunlik) maqola", (await audio.nextArticleId()) === C.id);
const t1 = await audio.tick();
const row = (await db.query(`SELECT * FROM article_audio WHERE "articleId" = $1`, [C.id])).rows[0];
check("tick: yangi maqola ovozlashtirildi va saqlandi", t1 === "done" && row?.url.startsWith("https://pub-test.r2.dev/audio/") && row.voice === "Kore" && row.seconds >= 1 && uploads.at(-1).size > 1000, JSON.stringify(row));
const audioPosts = () => tgCalls.filter((c) => c.method === "sendAudio");
const ap = audioPosts();
check("yangi maqola audiosi kanalga: sendAudio, sarlavha, davomiylik, 2 tugma", ap.length === 1 && ap[0].body.chat_id === "@kanal" && ap[0].body.audio === row.url && ap[0].body.performer === "Bilim Manba" && ap[0].body.title === "Maqola yangi" && ap[0].body.duration === row.seconds && ap[0].body.reply_markup.inline_keyboard[0].length >= 1 && /Audio versiya/.test(ap[0].body.caption), JSON.stringify(ap[0]?.body).slice(0, 300));
check("bytes saqlandi (podkast uchun)", Number(row.bytes) === uploads.at(-1).size, `${row.bytes} vs ${uploads.at(-1).size}`);
check("kanalga ikkinchi marta yuborilmaydi", (await audio.postToTelegram(C.id)) === false && audioPosts().length === 1);
check("TTS'ga ketgan matn: sarlavha bor, Manbalar yo'q", calls.some((c) => c.body.contents?.[0].parts[0].text.startsWith("Maqola yangi.")) && !calls.some((c) => /Manbalar/.test(JSON.stringify(c.body))));
const bySlug = await articles.findBySlug("yangi");
check("maqola sahifasida audio {url, seconds}", bySlug.audio?.url === row.url && bySlug.audio.seconds === row.seconds, JSON.stringify(bySlug?.audio));
check("audiosiz maqolada audio: null", (await articles.findBySlug("oddiy")).audio === null);
calls.length = 0;
await audio.tick();
const aRow = (await db.query(`SELECT seconds FROM article_audio WHERE "articleId" = $1`, [A.id])).rows[0];
check("keyingisi — eng ko'p o'qilgan; uzun matn bir necha bo'lakda", !!aRow && calls.length >= 2, `${calls.length} so'rov`);
check("eski (10 kunlik) maqola audiosi kanalga chiqmaydi", audioPosts().length === 1);
check("kunlik limit (2) — uchinchisi bugun yo'q", (await audio.tick()) === "skipped" && (await audio.status()).today === 2);
// Ertaga
check("ertaga — davom etadi", (await audio.tick(new Date(Date.now() + 86400e3))) === "done");
check("hammasi tayyor — idle", (await audio.tick(new Date(Date.now() + 2 * 86400e3))) === "idle");
const stDone = await audio.status();
check("holat: 3/3 tayyor, xato yo'q", stDone.done === 3 && stDone.total === 3 && stDone.lastError === null && stDone.configured, JSON.stringify(stDone).slice(0, 200));

// Podkast lentasi
await db.query(`UPDATE article_audio SET bytes = NULL WHERE "articleId" = $1`, [A.id]);
const feedFetch = audio.fetchOverride;
audio.fetchOverride = async (url, init) => (init?.method === "HEAD" ? new Response(null, { headers: { "content-length": "123456" } }) : feedFetch(url, init));
audio.feedCache = undefined;
const feed = await app.get(AudioController).feed();
check("lenta: 3 ta, eng yangisi birinchi, maydonlar to'liq", feed.length === 3 && feed[0].slug === "yangi" && feed.every((f) => f.url && f.seconds >= 1 && f.title && f.published) && feed[0].category === "Fan", JSON.stringify(feed[0]).slice(0, 200));
check("lenta: noma'lum hajm R2'dan olinadi va saqlanadi", feed.find((f) => f.slug === "mashhur").bytes === 123456 && Number((await db.query(`SELECT bytes FROM article_audio WHERE "articleId" = $1`, [A.id])).rows[0].bytes) === 123456);
audio.fetchOverride = feedFetch;
// Kanalga yuborishni o'chirish
await audio.settings({ telegram: false });
await db.query(`UPDATE article_audio SET "tgPostedAt" = NULL WHERE "articleId" = $1`, [C.id]);
check("sozlama: kanalga yuborish o'chirilsa — yuborilmaydi", (await audio.postToTelegram(C.id)) === false && (await audio.status()).telegram === false);
await audio.settings({ telegram: true });
check("qayta yoqilsa — yuboriladi", (await audio.postToTelegram(C.id)) === true);

// Matn o'zgardi → audio o'chadi va qayta navbatga tushadi
texts["https://r2.test/oddiy-v2.json"] = texts["https://r2.test/oddiy.json"];
app.get(QuizService).generateFor = async () => false;
await admin.updateArticle(B.id, { content: "https://r2.test/oddiy-v2.json" });
await new Promise((r) => setTimeout(r, 400));
check("admin matnni o'zgartirsa — eski audio o'chiriladi", (await db.query(`SELECT 1 FROM article_audio WHERE "articleId" = $1`, [B.id])).rows.length === 0);
check("...va u yana navbatga tushadi", (await audio.nextArticleId()) === B.id);

// 429 → 6 soat pauza
mode = "429";
const t429 = await audio.tick(new Date(Date.now() + 3 * 86400e3));
const stt = await audio.status();
check("429 → pauza va xato matni saqlanadi", t429 === "failed" && !!stt.pausedUntil && /exhausted/.test(stt.lastError.message), JSON.stringify(stt.lastError));
check("pauza davomida — urinmaydi", (await audio.tick(new Date(Date.now() + 3 * 86400e3 + 3600e3))) === "skipped");

// Ovoz namunasi
mode = "generate";
const smp = await audio.sample("Sulafat");
check("namuna: data:audio/mpeg, ovoz Sulafat", smp.audio.startsWith("data:audio/mpeg;base64,") && smp.voice === "Sulafat" && smp.seconds >= 1);
mode = "429"; let se = ""; try { await audio.sample("Kore"); } catch (e) { se = e.message; }
check("namuna: xato tushunarli matn bilan", /Ovoz yaratilmadi/.test(se), se);

globalThis.fetch = realFetch;
await app.close(); await server.stop(); await db.close();
console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
