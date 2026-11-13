// Lokal sinov serveri: haqiqiy backend modullari + xotiradagi PGlite bazasi.
// Frontend'ni (statistika, kuzatuv, kino kartasi) brauzerda sinash uchun.
//   cd backend && npm run build && node test/pglite/dev-server.mjs
// API: http://localhost:3333/api   Admin: admin@test.uz / admin123
// Maqola matnlari: http://localhost:3398/<slug>.json (CORS ochiq)
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import http from "http";

const BE = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(BE);
const require = createRequire(BE + "package.json");
require("reflect-metadata");
const { Test } = require("@nestjs/testing");
const { SequelizeModule } = require("@nestjs/sequelize");
const { ConfigModule } = require("@nestjs/config");
const { ValidationPipe } = require("@nestjs/common");
const express = require("express");
const bcrypt = require("bcryptjs");
const { DatabaseModule } = require(BE + "dist/database/database.module");
const { AdminModule } = require(BE + "dist/admin/admin.module");
const { AdminService } = require(BE + "dist/admin/admin.service");
const { ArticlesModule } = require(BE + "dist/articles/articles.module");
const { CategoriesModule } = require(BE + "dist/categories/categories.module");
const { AnalyticsModule } = require(BE + "dist/analytics/analytics.module");
const { AuthModule } = require(BE + "dist/auth/auth.module");
const { UsersModule } = require(BE + "dist/users/users.module");
const { SubscribersModule } = require(BE + "dist/subscribers/subscribers.module");
const { LikesModule } = require(BE + "dist/likes/likes.module");
const { BookmarksModule } = require(BE + "dist/bookmarks/bookmarks.module");
const { CommentsModule } = require(BE + "dist/comments/comments.module");
const { HealthModule } = require(BE + "dist/health/health.module");

// Obunani bekor qilish imzosi process.env dan o'qiladi
process.env.JWT_SECRET ??= "dev-secret";

const CONTENT_PORT = 3398;
const contents = new Map();
http
  .createServer((req, res) => {
    const slug = decodeURIComponent((req.url || "").slice(1).replace(/\.json$/, ""));
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!contents.has(slug)) return res.writeHead(404).end();
    // Haqiqiy R2 kabi biroz kechikish
    setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ message: contents.get(slug) })), 150);
  })
  .listen(CONTENT_PORT);

const db = await PGlite.create();
const sock = new PGLiteSocketServer({ db, port: 5520, host: "127.0.0.1" });
await sock.start();
const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ JWT_SECRET: "dev-secret", JWT_EXPIRES_IN: "7d" })] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5520, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    DatabaseModule, HealthModule, AuthModule, UsersModule, CategoriesModule, ArticlesModule, AdminModule,
    AnalyticsModule, SubscribersModule, LikesModule, BookmarksModule, CommentsModule,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error", "warn"] });
app.setGlobalPrefix("api");
app.use("/api/t", express.text({ type: "text/plain", limit: "100kb" }));
app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
app.enableCors({ origin: "*", methods: "GET,PUT,PATCH,POST,DELETE", allowedHeaders: "Content-Type, Authorization" });
await app.init();

// --- Namuna ma'lumotlar ---
const admin = app.get(AdminService);
await db.query(`INSERT INTO users ("fullName", email, password, role, plan, "createdAt", "updatedAt") VALUES ('Admin', 'admin@test.uz', $1, 'admin', 'free', now(), now())`, [bcrypt.hashSync("admin123", 10)]);
const cats = {};
for (const name of ["Kino", "Tarix", "Biologiya"]) cats[name] = await admin.createCategory({ name, slug: `${name} bo'limi` });
const para = (n) => Array.from({ length: n }, (_, i) => `<p>${i + 1}-xatboshi. Bu sinov maqolasining matni — o'qish vaqti va qancha qismi o'qilganini o'lchash uchun yetarlicha uzun. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.</p>`).join("\n");
const seed = [
  ["Interstellar: vaqt va muhabbat", "interstellar", "Kino", `<h2>Kirish</h2>${para(12)}<h2>Xulosa</h2>${para(6)}`],
  ["Napoleon: Korsikadan imperatorgacha", "napoleon", "Tarix", `<h2>Bolalik</h2>${para(15)}`],
  ["Hujayra qanday ishlaydi", "hujayra", "Biologiya", `${para(10)}`],
  ["Detektiv qo'ylar: haqiqatni kim yashira oladi?", "detektiv-qoylar", "Kino", `Detektiv qo'ylar: haqiqatni kim yashira oladi?\n\nThe Sheep Detectives — bir qarashda kulgili film.\n\n## Oddiy cho'pon\n\nFilm markazida **George Hardy** turadi.\n\n- Birinchi band\n- Ikkinchi band\n\n## Xulosa\n\n*Detektiv qo'ylar* — g'alati film.`],
];
for (const [title, slug, cat, html] of seed) {
  contents.set(slug, html);
  await admin.createArticle({ title, slug, categoryId: cats[cat].id, type: "free", status: "published", content: `http://localhost:${CONTENT_PORT}/${slug}.json`, excerpt: `${title} — qisqa tavsif.`, coverImage: null });
}
await app.listen(3333);
console.log("DEV API READY http://localhost:3333/api");
