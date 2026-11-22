// Har bir xizmat ilovada BITTA nusxada bo'lishi kerak. Ikki nusxa bo'lsa,
// taymerli xizmatlar (Kun savoli, dayjest, audio, AI qoralama...) ikki marta
// ishlaydi — masalan kanalga bir post ikki marta ketadi. To'liq AppModule.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const BE = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(BE);
const require = createRequire(BE + "package.json");
require("reflect-metadata");

process.env.GROQ_API_KEY ??= "test-key";
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5561, host: "127.0.0.1" });
await server.start();
const { Test } = require("@nestjs/testing");
const { SequelizeModule } = require("@nestjs/sequelize");
const { ConfigModule } = require("@nestjs/config");
// AppModule'dagi modullar (SSL'li baza ulanishisiz)
const NAMES = ["database/database", "health/health", "auth/auth", "users/users", "categories/categories", "articles/articles", "subscription/subscription", "ai/ai", "cloudinary/cloudinary", "payment/payment", "likes/likes", "article-views/article-views", "admin/admin", "cloudflare/cloudflare", "subscribers/subscribers", "mailer/mailer", "bookmarks/bookmarks", "comments/comments", "notifications/notifications", "analytics/analytics"];
const mods = NAMES.map((n) => Object.values(require(BE + `dist/${n}.module`))[0]);
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) fails++; };

const mod = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ JWT_SECRET: "singleton-test-secret-0123456789abcdef", JWT_EXPIRES_IN: "7d" })] }),
    SequelizeModule.forRoot({ dialect: "postgres", host: "127.0.0.1", port: 5561, username: "postgres", password: "postgres", database: "postgres", autoLoadModels: true, synchronize: true, logging: false, pool: { max: 1 } }),
    ...mods,
  ],
}).compile();
const app = mod.createNestApplication({ logger: ["error"] });

// Har bir provayder → qaysi modullarda va nechta alohida nusxa
const byClass = new Map();
for (const m of app.container.getModules().values()) {
  for (const [token, wrapper] of m.providers) {
    if (typeof token !== "function" || !wrapper.isDependencyTreeStatic?.() && false) continue;
    const name = token.name;
    if (!/Service$/.test(name)) continue;
    const inst = wrapper.instance;
    if (!inst) continue;
    if (!byClass.has(name)) byClass.set(name, { classes: new Set(), instances: new Set(), modules: [] });
    const e = byClass.get(name);
    e.classes.add(token);
    e.instances.add(inst);
    e.modules.push(m.metatype?.name);
  }
}
// JwtService — har modul o'z sozlamasi bilan yaratadi (taymersiz, kutilgan holat)
const EXPECTED = new Set(["JwtService"]);
const dups = [...byClass.entries()].filter(([n, e]) => e.instances.size > 1 && !EXPECTED.has(n));
for (const [name, e] of dups) console.log(`  ${name}: ${e.instances.size} nusxa, ${e.classes.size} xil klass — modullar: ${e.modules.join(", ")}`);
check(`${byClass.size} ta xizmat — hammasi bitta nusxada`, dups.length === 0, dups.map(([n]) => n).join(", "));

await app.close().catch(() => {}); await server.stop(); await db.close();
console.log(fails ? `\n${fails} ta test YIQILDI` : "\nHAMMASI O'TDI");
process.exit(fails ? 1 : 0);
