// AI qoralamalar: haqiqiy Wikipedia + soxta (yoki REAL=1 bo'lsa haqiqiy) Groq + PGlite
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import fs from "fs";

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
const { DatabaseModule } = require(BE + "dist/database/database.module");
const { CloudflareService } = require(BE + "dist/cloudflare/cloudflare.service");
const { CloudinaryService } = require(BE + "dist/cloudinary/cloudinary.service");
const { DraftsService, sanitizeHtml, slugify, AI_SOURCE } = require(BE + "dist/drafts/drafts.service");
const { findSource } = require(BE + "dist/drafts/wikipedia");

const REAL = process.env.REAL === "1";
const groqKey = REAL ? fs.readFileSync(BE + ".env", "utf8").match(/^GROQ_API_KEY=(.+)$/m)?.[1]?.trim() : "test-key";

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

// 0) Yordamchilar
const dirty = '<h1>X</h1><p class="a" onclick="evil()">Salom <a href="http://x">havola</a> <strong>qalin</strong></p><script>alert(1)</script><img src=x><p> </p><h2 id="z">Bo‘lim</h2>';
check("sanitize: faqat ruxsat etilgan teglar", sanitizeHtml(dirty) === "X<p>Salom havola <strong>qalin</strong></p><h2>Bo'lim</h2>", sanitizeHtml(dirty));
check("slugify: o'zbekcha sarlavha", slugify("Qora tuynuklar: koinotning eng sirli ob‘ektlari") === "qora-tuynuklar-koinotning-eng-sirli-obektlari", slugify("Qora tuynuklar: koinotning eng sirli ob‘ektlari"));

// 1) Haqiqiy Wikipedia
const s1 = await findSource("Qora tuynuk");
check("uz mavzu → inglizcha Wikipedia", s1.lang === "en" && /black hole/i.test(s1.title), `${s1.lang}: ${s1.title}`);
check("manba matni yetarli va qirqilgan", s1.text.length > 3000 && s1.text.length <= 7000 && !/\nReferences\n/.test(s1.text), String(s1.text.length));
const s2 = await findSource("https://en.wikipedia.org/wiki/Amir_Timur");
check("havola → redirect bilan maqola", /Timur/.test(s2.title) && s2.url.includes("wikipedia.org"), s2.title);

// --- Nest ilova ---
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5497, host: "127.0.0.1" });
await server.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => (REAL ? { GROQ_API_KEY: groqKey } : { GEMINI_API_KEY: "gem-test", GROQ_API_KEY: "groq-test", PEXELS_API_KEY: "px-test" })] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5497, username: "postgres", password: "postgres",
      database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, AdminModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error", "warn"] });
await app.init();
const admin = app.get(AdminService), drafts = app.get(DraftsService);
clearTimeout(drafts.timer); // ishga tushgandagi haqiqiy kunlik ish testga aralashmasin
const uploads = [];
app.get(CloudflareService).uploadJson = async (obj, filename) => { uploads.push({ obj, filename }); return `https://r2.example/articles/${filename}`; };
const coverUploads = [];
app.get(CloudinaryService).uploadBuffer = async (buf, folder, id) => { coverUploads.push({ size: buf.length, folder, id }); return `https://res.cloudinary.com/demo/image/upload/${folder}/${id}.jpg`; };
// Fakt-tekshiruv: alohida soxta model (Gemini fetch-soxtasiga aralashmasin)
const factCalls = [];
drafts.factCheck.llmOverride = { name: "fake", sourceBudget: 30000, json: async (sys, user) => { factCalls.push(user); return JSON.stringify({ issues: [] }); } };

// Soxta Gemini: global fetch orqali (Gemini provayderining o'zi ham tekshiriladi)
let demandReqs = [], relatedReqs = [], topicChecks = [], autoReqs = [], badTopicNext = false, groqCalls = [], geminiReqs = [], visionReqs = [], titleReqs = [], wikiDown = false, gem503 = 1, pexelsReqs = [], safetyReqs = [], safetyRejectFirst = false, rankFail = false, adultNext = false, emptyRanks = 0, broaderReqs = [];
const gem = (obj) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
if (!REAL) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://r2.example/articles/")) { const f = String(url).split("/").pop(); const u = uploads.find((x) => x.filename === f); return new Response(JSON.stringify(u?.obj ?? {}), { headers: { "content-type": "application/json" } }); }
    if (String(url) === "https://r2.example/style.json") return new Response(JSON.stringify({ message: "<p>USLUB-NAMUNASI: Bir kuni ertalab olimlar g'alati signal qabul qilishdi.</p>" }), { headers: { "content-type": "application/json" } });
    if (wikiDown && String(url).includes("wikipedia.org")) throw new TypeError("fetch failed (test: tarmoq yo'q)");
    if (String(url).startsWith("https://api.pexels.com/")) {
      pexelsReqs.push({ url: String(url), auth: init?.headers?.Authorization });
      const img = "https://upload.wikimedia.org/wikipedia/commons/thumb/c/cf/Black_hole_-_Messier_87.jpg/1280px-Black_hole_-_Messier_87.jpg";
      return new Response(JSON.stringify({ photos: [1, 2].map((i) => ({ id: i, url: `https://www.pexels.com/photo/${i}/`, photographer: `Fotograf ${i}`, alt: `Pexels qora tuynuk ${i}`, src: { large2x: img + "?p=" + i, medium: img.replace("1280px", "500px") + "?p=" + i } })) }), { headers: { "content-type": "application/json" } });
    }
    if (!String(url).startsWith("https://generativelanguage.googleapis.com/")) return realFetch(url, init);
    if (gem503 > 0) { gem503--; geminiReqs.push({ url: String(url), status: 503 }); return new Response(JSON.stringify({ error: { message: "This model is currently experiencing high demand." } }), { status: 503, headers: { "content-type": "application/json" } }); }
    const body = JSON.parse(init.body);
    geminiReqs.push({ url: String(url), headers: init.headers, body });
    const sys = body.systemInstruction.parts[0].text, user = body.contents[0].parts[0].text;
    const parts = body.contents[0].parts;
    if (parts.some((p) => p.inline_data) && sys.includes("moderatorisan")) { safetyReqs.push(user); const ok = !safetyRejectFirst; safetyRejectFirst = false; return gem({ safe: ok, reason: "test" }); }
    if (parts.some((p) => p.inline_data)) { visionReqs.push({ sys, user, n: parts.length - 1 }); if (rankFail) { rankFail = false; return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400, headers: { "content-type": "application/json" } }); } if (emptyRanks > 0) { emptyRanks--; return gem({ unsafe: [], ranking: [], reason: "mos emas" }); } return gem({ unsafe: [0], ranking: [0, 1, 2], reason: "test" }); }
    if (sys.includes("Google'da odamlar qidirayotgan")) { demandReqs.push({ sys, user }); return gem({ picks: [{ query: "Fotosintez qanday ishlaydi", title: "Photosynthesis", category: "Fan" }, { query: "o'ylab topilgan so'rov", title: "Black hole", category: "Fan" }] }); }
    if (sys.includes("mazmunan eng yaqin 3 tasini")) { relatedReqs.push({ sys, user }); return gem({ numbers: [0, 0, 999] }); }
    if (sys.includes("MAVZUSI sifatida mosmi")) { topicChecks.push(user); const ok = !badTopicNext; badTopicNext = false; return gem({ ok, reason: "test: qadriyatlarga zid" }); }
    if (sys.includes("bo'limi uchun keyingi maqola mavzusini")) { autoReqs.push({ sys, user }); return gem({ titles: ["zzqxqzzq-no-such-topic-xyz", "Photosynthesis", "Black hole"] }); }
    if (sys.includes("KENGROQ")) { broaderReqs.push(user); return gem({ queries: ["egyptian pyramids desert"] }); }
    if (sys.includes("INGLIZCHA Wikipedia maqolalarining")) { titleReqs.push(user); return gem({ titles: user.includes("Userkare") ? ["Userkare"] : [] }); }
    groqCalls.push({ messages: [{ content: sys }, { content: user }] });
    const arx = user.match(/\[(\d+)\] arXiv/);
    const editing = user.includes("QORALAMA (JSON)");
    const html = "<h2>Kirish</h2>" + `<p>${editing ? "TAHRIRLANGAN " : ""}Qora tuynuk — tortishish kuchi shunchalik kuchli bo‘lgan joyki, undan hatto yorug‘lik ham chiqa olmaydi.</p>`.repeat(20) + '<p><a href="x">bad</a></p>';
    const out = { title: "Qora tuynuklar: koinotning eng sirli ob‘ektlari", excerpt: "Yorug‘lik ham qochib qutula olmaydigan joylar qanday paydo bo‘ladi?", category: "fan", tags: ["koinot", "fizika", "Eynshteyn"], sources: arx ? [1, +arx[1]] : [1], imageQueries: ["black hole accretion disk", "Messier 87 black hole"], familySafe: !adultNext, html };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "o'ylayapman", thought: true }, { text: JSON.stringify(out) }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

// Avtomatik seriyalar alohida (series.mjs) tekshiriladi — bu yerda kunlik ishga aralashmasin
await drafts.updateSettings({ autoSeries: false });
await admin.createCategory({ name: "Sport", slug: "Sport" });
const fan = await admin.createCategory({ name: "Fan", slug: "Fan haqida" });
const [u] = await db.query(`INSERT INTO users ("fullName", email, password, role, "createdAt", "updatedAt") VALUES ('Admin','a@b.c','x','admin',now(),now()) RETURNING id`).then((r) => r.rows);
// Uslub namunasi uchun: eng ko'p o'qilgan (AI yozmagan) maqola; source NULL ham bo'lishi mumkin
await admin.createArticle({ title: "Mashhur maqola", slug: "mashhur", categoryId: fan.id, type: "free", status: "published", content: "https://r2.example/style.json", excerpt: "x" });
await db.query(`UPDATE articles SET "viewCount" = 999 WHERE slug = 'mashhur'`);

// 2) Qo'lda qoralama
const t0 = Date.now();
const a = await drafts.generate({ topic: "Qora tuynuk" });
console.log(`    (yozish: ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
check("qoralama yaratildi", a.status === "draft" && a.source === AI_SOURCE && a.type === "free");
check("kategoriya AI tanlovidan (katta-kichik harf farqsiz)", a.categoryId === fan.id, String(a.categoryId));
check("muallif — admin (cron uchun)", a.authorId === u.id);
const html = uploads.at(-1).obj.message;
check("kontent R2'ga, Manbalar + litsenziya", a.content.startsWith("https://r2.example/") && html.includes("<h2>Manbalar</h2>") && html.includes("CC BY-SA 4.0") && html.includes("en.wikipedia.org/wiki/Black_hole"));
if (!REAL) {
  check("AI'ning <a> havolasi olib tashlandi", !html.slice(0, html.search(/<h2>(Shuningdek o'qing|Manbalar)/)).includes("<a "));
  check("apostroflar normallashdi", a.title === "Qora tuynuklar: koinotning eng sirli ob'ektlari" && !/[‘’]/.test(html.slice(0, 500)));
  check("slug + teglar", a.slug === "qora-tuynuklar-koinotning-eng-sirli-obektlari" && a.tags === "koinot, fizika, Eynshteyn", `${a.slug} | ${a.tags}`);
  check("prompt: kategoriyalar + manba matni", groqCalls[0].messages[0].content.includes("Sport, Fan") && groqCalls[0].messages[1].content.includes("Black hole"));
  const up = groqCalls[0].messages[1].content;
  const nWiki = (up.match(/\] Wikipedia \(/g) || []).length, nArx = (up.match(/\] arXiv ilmiy ishi/g) || []).length;
  check("ko'p manba: 1+(1..2) Wikipedia, arXiv ishlari", nWiki >= 2 && nArx >= 1, `wiki=${nWiki} arxiv=${nArx} | ${[...up.matchAll(/\[\d+\] [^\n]+/g)].map((m) => m[0].slice(0, 70)).join(" ; ")}`);
  check("Gemini 503 → kutib qayta urindi va yozdi", geminiReqs[0].status === 503 && geminiReqs[1].url.includes("gemini-flash-latest") && !geminiReqs[1].status);
  check("Pexels: kalit bilan so'raldi, nomzodlar boshida", pexelsReqs.length >= 1 && pexelsReqs[0].auth === "px-test" && /Rasmlar: 0\) Pexels qora tuynuk 1 — Pexels/.test(visionReqs[0]?.user ?? ""), visionReqs[0]?.user.slice(0, 200));
  check("vision promptda Pexels ustuvorligi", /Pexels rasmlari professional/.test(visionReqs[0]?.sys ?? ""));
  check("Gemini: kalit header'da, JSON rejimi, fikrlash qismi tashlandi", geminiReqs[1].headers["x-goog-api-key"] === "gem-test" && geminiReqs[1].body.generationConfig.responseMimeType === "application/json" && geminiReqs[1].url.includes("gemini-flash-latest:generateContent") && a.title.startsWith("Qora"));
  check("Manbalar: AI ishlatgan arXiv ishi ham bor", nArx === 0 || /arxiv\.org\/abs\/[^"]+".*?, arXiv, 20\d\d/.test(html), html.slice(html.indexOf("<h2>Manbalar")).slice(0, 400));
  check("Manbalar: ishlatilmagan yaqin Wikipedia maqolalari yo'q", (html.match(/Wikipedia: /g) || []).length === 1);
  check("sozlamalar: model nomi", (await drafts.getSettings()).model === "gemini:gemini-flash-latest");
  // Sifat: ikki bosqich + uslub namunasi
  check("2 bosqich: muallif + muharrir", groqCalls.length === 2 && groqCalls[1].messages[0].content.includes("bosh muharriri") && groqCalls[1].messages[1].content.includes("QORALAMA (JSON)"));
  check("muharrir varianti saqlandi", html.includes("TAHRIRLANGAN"));
  check("uslub namunasi promptda (source NULL maqoladan)", groqCalls[0].messages[0].content.includes("USLUB-NAMUNASI"));
  check("o'zbek tili qoidalari promptda", groqCalls[0].messages[0].content.includes("Eynshteyn") && groqCalls[1].messages[0].content.includes("kalkalaridan"));
  // Muqova
  const coverLi = (html.match(/<li>Muqova rasmi:.*?<\/li>/) || [""])[0];
  check("rasm nomzodlari ko'p bazadan, Gemini ko'rib tanladi", visionReqs.length === 1 && visionReqs[0].n >= 5 && /Openverse/.test(visionReqs[0].user) && /NASA/.test(visionReqs[0].user), `${visionReqs[0]?.n} ta: ${visionReqs[0]?.user.slice(0, 300)}`);
  const pickedName = visionReqs[0]?.user.match(/ 1\) (.*?) — /)?.[1] ?? "";
  check("Gemini tanlovi (1-raqam) muqova bo'ldi", coverLi.includes(pickedName.slice(0, 20)), `${pickedName} | ${coverLi}`);
  check("muqova 1600px JPEG, Cloudinary'ga yuklandi", a.coverImage?.includes("bilim-manba/covers/") && coverUploads[0]?.size > 20000, `${a.coverImage} ${coverUploads[0]?.size}`);
  check("muqova muallifi, litsenziyasi va bazasi Manbalarda", /Muqova rasmi: <a href="https:[^"]+"[^>]*>[^<]+<\/a> — [^,]+, (CC|Public|Pexels)[^,]*, (Wikimedia Commons|Openverse|NASA|Pexels)/.test(coverLi), coverLi);
  // Xavfsizlik: unsafe ro'yxatidagi rasm tanlanmaydi, yakuniy tekshiruv o'tkaziladi
  const name0 = visionReqs[0]?.user.match(/ 0\) (.*?) — /)?.[1] ?? "@@";
  check("Gemini 'unsafe' degan 0-rasm reytingda 1-o'rinda bo'lsa ham tanlanmadi", !coverLi.includes(name0.slice(0, 20)), name0);
  check("yuklashdan oldin yakuniy xavfsizlik tekshiruvi", safetyReqs.length === 1 && safetyReqs[0].includes(pickedName.slice(0, 20)) && /moderatorisan/.test(geminiReqs.find((g) => g.body?.systemInstruction?.parts[0].text.includes("moderatorisan"))?.body.systemInstruction.parts[0].text ?? ""));
  check("vision prompt avval xavfsizlikni so'raydi", /AVVAL XAVFSIZLIK/.test(visionReqs[0].sys) && /"unsafe"/.test(visionReqs[0].sys));
  // Yakuniy tekshiruv rad etsa — keyingi rasm
  safetyRejectFirst = true;
  const before = visionReqs.length;
  const s2 = await drafts.generate({ topic: "Qora tuynuk" });
  const html2 = uploads.at(-1).obj.message, cover2 = (html2.match(/<li>Muqova rasmi:.*?<\/li>/) || [""])[0];
  const name2 = visionReqs[before]?.user.match(/ 2\) (.*?) — /)?.[1] ?? "@@";
  check("yakuniy tekshiruv rad etdi → keyingi (2-) rasm olindi", cover2.includes(name2.slice(0, 20)), `${name2} | ${cover2.slice(0, 160)}`);
  // AI rasmlarni ko'ra olmasa — faqat Pexels/NASA (ishonchli bazalar)
  rankFail = true;
  const s3 = await drafts.generate({ topic: "Qora tuynuk" });
  const cover3 = (uploads.at(-1).obj.message.match(/<li>Muqova rasmi:.*?<\/li>/) || [""])[0];
  check("AI tanlay olmadi → faqat ishonchli baza (Pexels/NASA)", /, (Pexels|NASA Image Library)<\/li>/.test(cover3), cover3.slice(0, 200));
  await db.query(`UPDATE articles SET status='published' WHERE id IN ($1, $2)`, [s2.id, s3.id]);
  // 18+ mavzu → qoralama yozilmaydi
  adultNext = true;
  let adultErr = null; try { await drafts.generate({ topic: "Qora tuynuk" }); } catch (e) { adultErr = e; }
  adultNext = false;
  check("18+ mavzu → 400, qoralama yozilmadi", adultErr?.status === 400 && /18\+/.test(adultErr.message), adultErr?.message);
  check("yozish qoidalarida oilaviy auditoriya talabi", /oilaviy auditoriyaga/.test(groqCalls[0].messages[0].content) && /familySafe/.test(groqCalls[0].messages[0].content));
  // Islom qadriyatlari: muallif va muharrir promptida, rasm filtrlarida
  check("qadriyatlar: muallif va muharrir promptida", /Islom aqidasi/.test(groqCalls[0].messages[0].content) && /Islom aqidasi/.test(groqCalls[1].messages[0].content) && /musulmon oila/.test(groqCalls[0].messages[0].content));
  check("qadriyatlar: rasm tanlash va yakuniy tekshiruvda alkogol/okkult", /spirtli ichimliklar/.test(visionReqs[0].sys) && /spirtli ichimliklar/.test(geminiReqs.find((g) => g.body?.systemInstruction?.parts[0].text.includes("moderatorisan"))?.body.systemInstruction.parts[0].text ?? ""));
  const { unsafeText } = require(BE + "dist/drafts/images");
  check("qadriyatlar: rasm nomida vino/kazino → filtrlanadi", unsafeText("Glass of red wine") && unsafeText("Las Vegas casino") && !unsafeText("Registan Samarkand"));
  check("mavzu tekshiruvi yozishdan oldin bajarildi", topicChecks.length >= 1 && topicChecks[0].includes("Black hole"), topicChecks[0]?.slice(0, 60));
  badTopicNext = true;
  const nW = groqCalls.length;
  let valErr = null; try { await drafts.generate({ topic: "Qora tuynuk" }); } catch (e) { valErr = e; }
  check("qadriyatlarga zid mavzu → 400, AI yozishga ham o'tmadi", valErr?.status === 400 && /Islom qadriyatlariga zid/.test(valErr.message) && groqCalls.length === nW, valErr?.message);
  // Uzun o'zbekcha sarlavha → AI inglizcha Wikipedia nomini topadi
  const ua = await drafts.generate({ topic: "Tarixdan o'chirilgan fir'avn: Userkarening sirli hukmronligi" });
  const lastWriter = groqCalls.filter((c) => !c.messages[1].content.includes("QORALAMA (JSON)")).at(-1).messages[1].content;
  check("o'zbekcha sarlavha → AI → 'Userkare' Wikipedia'dan topildi", titleReqs.some((t) => t.includes("Userkare")) && lastWriter.includes('"Userkare"'), lastWriter.slice(0, 80));
  await db.query(`UPDATE articles SET status='published' WHERE id = $1`, [ua.id]);
} else {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  console.log("\n--- REAL natija ---\nSarlavha:", a.title, "\nTavsif:", a.excerpt, "\nTeglar:", a.tags, "\nSo'zlar:", text.split(" ").length, "\n", html.slice(0, 1500), "\n...\n");
  fs.writeFileSync(process.env.OUT || require("path").join(require("os").tmpdir(), "ai-draft-sample.html"), `<meta charset=utf-8><h1>${a.title}</h1><p><i>${a.excerpt}</i></p>${html}`);
}
// Fondagi ish: darhol javob, ikkinchisi rad etiladi, keyin 'done'
const job = drafts.startGenerate({ topic: "Fotosintez" });
check("fon: darhol 'running' qaytadi", job.state === "running" && job.topic === "Fotosintez");
let busy = null; try { drafts.startGenerate({ topic: "X" }); } catch (e) { busy = e; }
check("fon: band paytda ikkinchisi 400", busy?.status === 400, busy?.message);
for (let i = 0; i < 600 && drafts.getJob().state === "running"; i++) await new Promise((r) => setTimeout(r, 500));
const jd = drafts.getJob();
check("fon: tugadi, maqola ID bilan", jd.state === "done" && jd.articleId > 0 && jd.title, JSON.stringify(jd));
await db.query(`UPDATE articles SET status='published' WHERE id = $1`, [jd.articleId]); // ko'rib chiqildi
const badJob = drafts.startGenerate({ topic: "zzqxqzzq-no-such-topic-xyz" });
for (let i = 0; i < 60 && drafts.getJob().state === "running"; i++) await new Promise((r) => setTimeout(r, 250));
check("fon: xato 'failed' bo'lib saqlanadi", drafts.getJob().state === "failed" && drafts.getJob().error.includes("topilmadi"), drafts.getJob().error);

const again = await drafts.generate({ topic: "Qora tuynuk" });
check("bir xil sarlavha → slug takrorlanmaydi", again.slug !== a.slug, again.slug);
let err = null; try { await drafts.generate({ topic: "zzqxqzzq-no-such-topic-xyz" }); } catch (e) { err = e; }
check("topilmagan mavzu → 400", err?.status === 400, err?.message);

if (!REAL) {
  // 3) Sozlamalar
  let st = await drafts.updateSettings({ topics: [" Amir Temur ", "", "zzqxqzzq-no-such-topic-xyz", "Fotosintez"], daily: true });
  check("sozlamalar: bo'sh mavzular tashlanadi", JSON.stringify(st.topics) === JSON.stringify(["Amir Temur", "zzqxqzzq-no-such-topic-xyz", "Fotosintez"]) && st.daily);

  // 4) Kunlik rejim (Toshkent vaqti)
  const at = (iso) => new Date(iso);
  await db.query(`UPDATE articles SET status='published' WHERE source = $1`, [AI_SOURCE]); // ko'rib chiqildi
  check("05:30 Toshkent — hali erta", (await drafts.runDailyIfDue(at("2026-10-10T00:30:00Z"))) === "skipped");
  { const rr = await drafts.runDailyIfDue(at("2026-10-10T01:30:00Z")); check("06:30 Toshkent — yozildi", rr === "done", rr + " " + (await drafts.getSettings()).lastError); }
  st = await drafts.getSettings();
  check("navbatdan birinchi mavzu olindi", JSON.stringify(st.topics) === JSON.stringify(["zzqxqzzq-no-such-topic-xyz", "Fotosintez"]) && st.lastRun === "2026-10-10" && !st.lastError);
  const latest = (await admin.getArticles())[0];
  check("kunlik qoralama 'Amir Temur' bo'yicha", groqCalls.at(-1).messages[1].content.includes("Timur"), latest.slug);
  check("o'sha kuni ikkinchi marta yozmaydi", (await drafts.runDailyIfDue(at("2026-10-10T10:00:00Z"))) === "skipped");
  check("ertasi: topilmagan mavzu → failed, navbatdan chiqdi", (await drafts.runDailyIfDue(at("2026-10-11T02:00:00Z"))) === "failed");
  st = await drafts.getSettings();
  check("xato saqlandi, navbat: Fotosintez", st.lastError?.includes("zzqxqzzq") && JSON.stringify(st.topics) === '["Fotosintez"]', st.lastError);
  // 3 ta ko'rib chiqilmagan qoralama → to'xtaydi
  await drafts.generate({ topic: "Fotosintez" }); await drafts.generate({ topic: "Fotosintez" });
  check("3 ta kutilayotgan qoralama → yozilmaydi", (await drafts.runDailyIfDue(at("2026-10-12T02:00:00Z"))) === "skipped" && (await drafts.getSettings()).lastError.includes("3 ta"));
  await drafts.updateSettings({ daily: false });
  check("o'chirilgan → skip", (await drafts.runDailyIfDue(at("2026-10-13T02:00:00Z"))) === "skipped" && (await drafts.getSettings()).lastRun === "2026-10-12");
  // Navbat bo'sh → bo'limlar navbatidan AI mavzu tanlaydi
  await drafts.updateSettings({ daily: true, topics: [] });
  await db.query(`UPDATE articles SET status='published' WHERE source = $1`, [AI_SOURCE]);
  const r = await drafts.runDailyIfDue(at("2026-10-14T02:00:00Z"));
  // Tarmoq uzilsa — mavzu navbatda qoladi (faqat haqiqatan topilmagan mavzu chiqariladi)
  await drafts.updateSettings({ topics: ["Fotosintez"] });
  await db.query(`UPDATE articles SET status='published' WHERE source = $1`, [AI_SOURCE]);
  wikiDown = true;
  const rd = await drafts.runDailyIfDue(at("2026-10-15T02:00:00Z"));
  wikiDown = false;
  const sd = await drafts.getSettings();
  check("tarmoq xatosi → failed, mavzu navbatda qoldi", rd === "failed" && JSON.stringify(sd.topics) === '["Fotosintez"]' && /aloqa/.test(sd.lastError), `${rd} ${JSON.stringify(sd.topics)} ${sd.lastError}`);
  check("navbat bo'sh → bo'lim navbatidan avto mavzu", r === "done" && autoReqs.length >= 1, (await drafts.getSettings()).lastError ?? "");
  check("avto mavzu: topilmagan nom tashlandi, keyingisi (Photosynthesis) olindi", /Photosynthesis/.test(groqCalls.at(-1).messages[1].content), groqCalls.at(-1).messages[1].content.slice(0, 80));
  check("avto mavzu: navbat ko'rsatkichi oshdi", Number((await db.query(`SELECT value FROM app_settings WHERE key='ai_rotation'`)).rows[0]?.value) === 1);
  check("navbat: har bo'lim bittadan, Kino ikki marta", JSON.stringify(DraftsService.rotation([{ name: "Sport" }, { name: "Kino" }, { name: "Fan" }, { name: "Tarix" }, { name: "San'at" }]).map((c) => c.name)) === JSON.stringify(["Kino", "Sport", "Fan", "Kino", "Tarix", "San'at"]));
  check("navbat: Kino bo'lmasa — oddiy", JSON.stringify(DraftsService.rotation([{ name: "Sport" }, { name: "Fan" }]).map((c) => c.name)) === '["Sport","Fan"]');
  // Qo'lda: mavzusiz + Kino tanlangan → kino qoidalari va mavjud maqolalar promptda
  const kinoCat = await admin.createCategory({ name: "Kino", slug: "Kino" });
  await admin.createArticle({ title: "Shoh sher: savannadagi afsona", slug: "shoh-sher", categoryId: kinoCat.id, type: "free", status: "published", content: "https://r2.example/style.json", excerpt: "x" });
  await db.query(`UPDATE articles SET status='published' WHERE source = $1`, [AI_SOURCE]);
  const nAuto = autoReqs.length;
  const km = await drafts.generate({ categoryId: kinoCat.id });
  const kr = autoReqs[nAuto];
  check("Kino tanlangan, mavzusiz → kino qoidalari + takrorlamaslik ro'yxati", kr && /oilaviy|butun oila/.test(kr.sys) && /R \/ NC-17/.test(kr.sys) && kr.sys.includes("Shoh sher: savannadagi afsona") && km.categoryId === kinoCat.id, kr?.sys.slice(0, 120));
  await db.query(`DELETE FROM articles WHERE id = $1 OR slug = 'shoh-sher'`, [km.id]); // keyingi muqova testlariga aralashmasin

  // Google qidiruv talabi
  let demandCalls = 0;
  drafts.searchConsole.demand = async () => { demandCalls++; return [
    { query: "Fotosintez qanday ishlaydi", impressions: 120, clicks: 2, position: 14.5, page: "/" },
    { query: "bilim manba", impressions: 300, clicks: 90, position: 1.2, page: "/" },
    { query: "qora tuynuk", impressions: 80, clicks: 30, position: 2.1, page: "/articles/qora-tuynuk" },
    { query: "kam qidirilgan", impressions: 2, clicks: 0, position: 30, page: "/" },
  ]; };
  await db.query(`UPDATE articles SET status='published' WHERE source = $1`, [AI_SOURCE]);
  const nW0 = groqCalls.length;
  const sa = await drafts.generate({ source: "search" });
  const dq = demandReqs.at(-1)?.user ?? "";
  check("qidiruv: nomzodlar — kam ko'rinishli va yaxshi o'rindagi maqola so'rovi chiqarildi", dq.includes("Fotosintez qanday ishlaydi") && dq.includes("bilim manba") && !dq.includes("kam qidirilgan") && !dq.includes("qora tuynuk"), dq);
  check("qidiruv: mavjud maqolalar va qoidalar promptda", /Saytdagi mavjud maqolalar/.test(demandReqs.at(-1).sys) && /LGBT/.test(demandReqs.at(-1).sys));
  const sw = groqCalls.slice(nW0).find((c) => c.messages[0].content.includes("eng yaxshi muallifisan"));
  check("qidiruv: muallif so'rovga javob berishga yo'naltirildi", sw && sw.messages[0].content.includes('"Fotosintez qanday ishlaydi"') && /dastlabki 2 paragrafda/.test(sw.messages[0].content) && /Photosynthesis/.test(sw.messages[1].content));
  check("qidiruv: bo'lim AI tanlovidan (Fan)", sa.categoryId === fan.id, String(sa.categoryId));
  const usedQ = (await db.query(`SELECT value FROM app_settings WHERE key='gsc_used_queries'`)).rows[0]?.value ?? "";
  check("qidiruv: so'rov ishlatilganlar ro'yxatida, o'ylab topilgan so'rov e'tiborsiz", usedQ.includes("fotosintez qanday ishlaydi") && !usedQ.includes("o'ylab topilgan"), usedQ);
  // Ichki havolalar
  const sHtml = uploads.at(-1).obj.message;
  const relBlock = sHtml.slice(sHtml.indexOf("<h2>Shuningdek o'qing</h2>"), sHtml.indexOf("<h2>Manbalar</h2>"));
  check("ichki havolalar: Manbalar'dan oldin, 1 ta (takror va noto'g'ri raqam tashlandi)", sHtml.includes("<h2>Shuningdek o'qing</h2>") && (relBlock.match(/<li><a href="\/articles\/[^"]+">/g) || []).length === 1 && relBlock.indexOf("<h2>Shuningdek") < sHtml.indexOf("<h2>Manbalar"), relBlock.slice(0, 300));
  check("ichki havolalar: faqat chop etilgan maqolalardan", relatedReqs.length >= 1 && !relatedReqs.at(-1).user.includes("Hell Creek qatlami") , "");
  // Ikkinchi marta — yangi so'rov yo'q → tushunarli 503
  let nd = null; try { await drafts.generate({ source: "search" }); } catch (x) { nd = x; }
  check("qidiruv: yangi so'rov qolmasa → 503 tushunarli xabar", nd?.status === 503 && /Google qidiruvida/.test(nd.message), nd?.message);
  // Kunlik: navbat bo'sh → bir kun qidiruv (bo'lmasa bo'limlar), keyingi kun bo'limlar
  await db.query(`UPDATE articles SET status='published' WHERE source = $1`, [AI_SOURCE]);
  await drafts.updateSettings({ daily: true, topics: [] });
  await db.query(`DELETE FROM app_settings WHERE key='ai_next_source'`);
  const dc0 = demandCalls;
  const d1 = await drafts.runDailyIfDue(new Date("2026-11-01T03:00:00Z"));
  check("kunlik 1-kun: qidiruv sinaldi, yangi so'rov yo'q → bo'limlar navbatidan yozildi", d1 === "done" && demandCalls === dc0 + 1, `${d1} ${(await drafts.getSettings()).lastError}`);
  await db.query(`UPDATE articles SET status='published' WHERE source = $1`, [AI_SOURCE]);
  const d2 = await drafts.runDailyIfDue(new Date("2026-11-02T03:00:00Z"));
  check("kunlik 2-kun: bo'limlar navbati (qidiruv chaqirilmadi)", d2 === "done" && demandCalls === dc0 + 1, d2);
  // Maktab o'quvchilari uchun: navbatdan mavzu, o'quvchi uslubi, belgilash
  await db.query(`UPDATE articles SET status='published' WHERE source = $1`, [AI_SOURCE]);
  drafts.school.llmOverride = { name: "fake", sourceBudget: 30000, json: async () => JSON.stringify({ topics: [{ title: "Fotosintez", topic: "Photosynthesis", subject: "Fan", grade: 6 }] }) };
  const nS = groqCalls.length;
  const sch = await drafts.generate({ source: "school" });
  const sWriter = groqCalls.slice(nS).find((c) => c.messages[0].content.includes("eng yaxshi muallifisan"));
  check("maktab: muallif o'quvchi uslubida (6-sinf, darslik mavzusi, Asosiy fikrlar)", sWriter && /O'quvchilar uchun/.test(sWriter.messages[0].content) && /6-sinf/.test(sWriter.messages[0].content) && sWriter.messages[0].content.includes('"Fotosintez"') && /<h2>Asosiy fikrlar<\/h2>/.test(sWriter.messages[0].content));
  const sEditor = groqCalls.slice(nS).find((c) => c.messages[0].content.includes("bosh muharriri"));
  check("maktab: muharrir ham o'quvchi qoidalarini biladi", sEditor && /O'quvchilar uchun/.test(sEditor.messages[0].content));
  const sRow = (await db.query(`SELECT subject, grade FROM school_articles WHERE "articleId" = $1`, [sch.id])).rows[0];
  check("maktab: qoralama fan va sinf bilan belgilandi, bo'lim Fan", sRow?.subject === "Fan" && sRow.grade === 6 && sch.categoryId === fan.id, JSON.stringify(sRow));
  // Mavzu berilgan + "maktab uchun" → o'quvchi uslubi, fan bo'limdan
  const nS2 = groqCalls.length;
  const sch2 = await drafts.generate({ topic: "Qora tuynuk", source: "school" });
  check("maktab (mavzu bilan): o'quvchi uslubi va belgilash (sinfsiz)", groqCalls.slice(nS2).some((c) => /O'quvchilar uchun/.test(c.messages[0].content)) && (await db.query(`SELECT grade FROM school_articles WHERE "articleId" = $1`, [sch2.id])).rows[0]?.grade === null);
  check("oddiy qoralama — o'quvchi bloki yo'q, belgilanmaydi", !groqCalls.slice(0, nS).some((c) => /O'quvchilar uchun/.test(c.messages[0].content)) && (await db.query(`SELECT count(*)::int n FROM school_articles WHERE "articleId" = $1`, [a.id])).rows[0].n === 0);
  // Kunlik aylanish: qidiruv → maktab → bo'limlar
  await db.query(`UPDATE articles SET status='published' WHERE source = $1`, [AI_SOURCE]);
  await db.query(`DELETE FROM app_settings WHERE key='ai_next_source'`);
  const order = [];
  for (const [k, day] of [["s1", "2026-11-05"], ["s2", "2026-11-06"], ["s3", "2026-11-07"], ["s4", "2026-11-08"]]) {
    const before = (await db.query(`SELECT value FROM app_settings WHERE key='ai_next_source'`)).rows[0]?.value ?? "search";
    order.push(before);
    await drafts.runDailyIfDue(new Date(`${day}T03:00:00Z`));
    await db.query(`UPDATE articles SET status='published' WHERE source = $1`, [AI_SOURCE]);
  }
  check("kunlik aylanish: qidiruv → maktab → bo'limlar → qidiruv", order.join(",") === "search,school,rotation,search", order.join(","));
  await db.query(`UPDATE articles SET status='published' WHERE source = $1`, [AI_SOURCE]);

}

if (!REAL) {
  // Mavjud maqola muqovasini qayta tanlash (92-qoralama holati)
  const art = (await admin.getArticles()).find((x) => x.coverImage && x.source === AI_SOURCE);
  const oldContent = art.content, nVision = visionReqs.length, nUp = coverUploads.length;
  const r = await drafts.regenerateCover(art.id);
  const fresh = (await admin.getArticles()).find((x) => x.id === art.id);
  const newHtml = uploads.at(-1).obj.message;
  check("qayta tanlash: yangi muqova xavfsiz tizimdan (ranking + yakuniy tekshiruv)", r.coverImage && fresh.coverImage === r.coverImage && visionReqs.length === nVision + 1 && coverUploads.length === nUp + 1, JSON.stringify(r));
  check("qayta tanlash: Cloudinary'da o'sha nom (eski fayl ustidan yoziladi)", coverUploads.at(-1).id === art.slug.slice(0, 120));
  check("qayta tanlash: Manbalarda bitta, yangi muqova qatori", (newHtml.match(/<li>Muqova rasmi:/g) || []).length === 1 && newHtml.includes(r.cover.title.slice(0, 15)), (newHtml.match(/<li>Muqova rasmi:.*?<\/li>/) || [""])[0].slice(0, 150));
  // Hech narsa topilmasa — eski rasm baribir olib tashlanadi
  safetyRejectFirst = false; rankFail = false;
  const origVision = drafts.llmOverride;
  const r2 = await (async () => { const real = globalThis.fetch; globalThis.fetch = async (u, i) => (/api\.pexels|openverse|images-api\.nasa|wikipedia\.org|commons\.wikimedia/.test(String(u)) ? new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }) : real(u, i)); try { return await drafts.regenerateCover(art.id); } finally { globalThis.fetch = real; } })();
  const fresh2 = (await admin.getArticles()).find((x) => x.id === art.id);
  check("rasm topilmasa — eski muqova olib tashlanadi, Manbalardan ham", r2.coverImage === null && fresh2.coverImage === null && !(uploads.at(-1).obj.message.includes("Muqova rasmi")), JSON.stringify(r2));
  // Zinapoya: aniq rasm yo'q → yaqin (kengroq) → kategoriya
  emptyRanks = 1;
  let pi = pexelsReqs.length;
  const z1 = await drafts.regenerateCover(art.id);
  check("1-bosqich bo'sh → 2-bosqich: AI kengroq mavzu berdi, rasm topildi", z1.coverImage && broaderReqs.length >= 1 && pexelsReqs.slice(pi).some((r) => r.url.includes("egyptian+pyramids")), JSON.stringify(z1));
  emptyRanks = 2;
  pi = pexelsReqs.length;
  const z2 = await drafts.regenerateCover(art.id);
  const catQ = pexelsReqs.slice(pi).map((r) => decodeURIComponent(new URL(r.url).searchParams.get("query")));
  check("1 va 2-bosqich bo'sh → 3-bosqich: bo'lim rasmi qidirildi", z2.coverImage && catQ.some((q) => ["science laboratory", "sports stadium lights", "cinema theater screen"].includes(q)), catQ.join(", "));
  // Bir martalik vazifa takrorlanmaydi
  const nv = visionReqs.length;
  await drafts.replaceCoverOnce(art.id);
  const afterFirst = visionReqs.length;
  await drafts.replaceCoverOnce(art.id);
  check("bir martalik vazifa: bir marta ishlaydi", afterFirst === nv + 1 && visionReqs.length === afterFirst);
}

check("har qoralamadan keyin fakt-tekshiruv (manbalar + maqola matni)", factCalls.length > 0 && factCalls[0].includes("MANBALAR:") && factCalls[0].includes("MAQOLA:"), String(factCalls.length));
const fcRow = (await db.query(`SELECT state FROM fact_checks LIMIT 1`)).rows[0];
check("fakt-tekshiruv natijasi saqlandi", fcRow?.state === "done", JSON.stringify(fcRow));
await app.close(); await server.stop();
console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
