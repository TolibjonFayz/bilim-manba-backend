import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { Op, QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  Article,
  ArticleStatus,
  ArticleType,
} from '../articles/models/article.model';
import { Category } from '../categories/models/category.model';
import { User } from '../users/models/user.model';
import { CloudflareService } from '../cloudflare/cloudflare.service';
import { featuredToday, findSource, related, WikiSource } from './wikipedia';
import { ArxivPaper, searchArxiv } from './arxiv';
import { createLlm, Llm } from './llm';

// AI qoralamalarini shu belgi bilan taniymiz (manbalar maqola oxirida)
export const AI_SOURCE = 'Bilim Manba AI';
// Birinchi versiyadagi belgi — eski qoralamalar ham hisobga olinsin
const LEGACY_AI_SOURCE = 'Wikipedia (Bilim Manba AI)';
// Ko'rib chiqilmagan AI qoralamalari shundan ko'p bo'lsa, kunlik qoralama yozilmaydi
const MAX_PENDING = 3;
// Kunlik qoralama Toshkent vaqti bilan shu soatdan keyin yoziladi
const DAILY_HOUR = 6;
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;

const ALLOWED_TAGS = new Set([
  'h2',
  'h3',
  'p',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'blockquote',
]);

interface DraftJson {
  title?: string;
  excerpt?: string;
  category?: string;
  tags?: string[];
  html?: string;
  /** AI foydalangan manbalar raqamlari ([1], [2] ...) */
  sources?: number[];
}

type Source =
  | ({ kind: 'wikipedia' } & WikiSource)
  | ({ kind: 'arxiv' } & ArxivPaper);

/** Saytdagi matnlar bilan bir xil: o‘ → o', “ ” → " */
const normalize = (s: string) =>
  String(s ?? '')
    .replace(/[‘’ʻʼ`]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/‑/g, '-');

/** AI HTML'idan faqat ruxsat etilgan teglarni qoldiradi, atributlarni olib tashlaydi */
export function sanitizeHtml(html: string): string {
  return normalize(html)
    .replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?([a-z0-9]+)[^>]*>/gi, (tag, name: string) => {
      const n = name.toLowerCase();
      if (!ALLOWED_TAGS.has(n)) return '';
      return tag.startsWith('</') ? `</${n}>` : `<${n}>`;
    })
    .replace(/<p>\s*<\/p>/g, '')
    .trim();
}

export function slugify(title: string): string {
  return (
    normalize(title)
      .toLowerCase()
      .replace(/'/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/, '') || `maqola-${Date.now()}`
  );
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** Toshkent sanasi YYYY-MM-DD */
const tashkentDay = (d = new Date()) =>
  new Date(d.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);

/**
 * AI qoralamalar: bir nechta erkin manbadan (Wikipedia'dagi asosiy va unga
 * yaqin maqolalar — CC BY-SA, arXiv'dagi yangi ilmiy ishlar annotatsiyalari —
 * CC0) faktlarni yig'ib, o'zbekcha original maqola yozadi va QORALAMA
 * sifatida saqlaydi. Admin o'qib, muqova qo'yib, chop etadi
 * yoki rejalashtiradi — keyin Telegram/Instagram avtomatik ketadi.
 *
 * Kunlik rejim: har kuni Toshkent vaqti bilan 06:00 dan keyin bitta qoralama —
 * admin kiritgan mavzular navbatidan, navbat bo'sh bo'lsa Wikipedia'ning
 * bugungi tanlangan maqolasidan.
 */
@Injectable()
export class DraftsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DraftsService.name);
  /** Testlar uchun: soxta model */
  llmOverride?: Llm;
  private timer?: NodeJS.Timeout;
  private dailyRunning = false;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(Article) private readonly articleModel: typeof Article,
    @InjectModel(Category) private readonly categoryModel: typeof Category,
    @InjectModel(User) private readonly userModel: typeof User,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly cloudflare: CloudflareService,
  ) {}

  /** Gemini (kaliti bo'lsa) yoki Groq; kalit yo'q bo'lsa — null, server baribir ishlaydi */
  private getLlm(): Llm | null {
    return (
      this.llmOverride ??
      createLlm({
        geminiKey: this.config.get<string>('GEMINI_API_KEY'),
        geminiModel: this.config.get<string>('GEMINI_MODEL'),
        groqKey: this.config.get<string>('GROQ_API_KEY'),
        groqModel: this.config.get<string>('GROQ_MODEL'),
      })
    );
  }

  onModuleInit() {
    // Deploy/uyg'onishdan keyin bugungi qoralama yozilmagan bo'lsa — yoziladi
    this.schedule(60 * 1000);
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  // ---------- app_settings ----------

  private async getSetting(key: string): Promise<string | null> {
    const rows = await this.sequelize.query<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = :key',
      { replacements: { key }, type: QueryTypes.SELECT },
    );
    return rows[0]?.value ?? null;
  }

  private async setSetting(key: string, value: string) {
    await this.sequelize.query(
      `INSERT INTO app_settings (key, value, "updatedAt") VALUES (:key, :value, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
      { replacements: { key, value } },
    );
  }

  private async getTopics(): Promise<string[]> {
    try {
      const v = JSON.parse((await this.getSetting('ai_topics')) ?? '[]');
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  }

  private pendingCount() {
    return this.articleModel.count({
      where: {
        status: ArticleStatus.DRAFT,
        source: { [Op.in]: [AI_SOURCE, LEGACY_AI_SOURCE] },
        scheduledAt: { [Op.is]: null },
      },
    });
  }

  async getSettings() {
    const [daily, topics, lastRun, lastError, pending] = await Promise.all([
      this.getSetting('ai_daily'),
      this.getTopics(),
      this.getSetting('ai_last_run'),
      this.getSetting('ai_last_error'),
      this.pendingCount(),
    ]);
    return {
      configured: Boolean(this.getLlm()),
      model: this.getLlm()?.name ?? null,
      daily: daily !== 'off',
      dailyHour: DAILY_HOUR,
      maxPending: MAX_PENDING,
      topics,
      lastRun,
      lastError: lastError || null,
      pending,
    };
  }

  async updateSettings(dto: { daily?: boolean; topics?: unknown }) {
    if (typeof dto?.daily === 'boolean') {
      await this.setSetting('ai_daily', dto.daily ? 'on' : 'off');
    }
    if (Array.isArray(dto?.topics)) {
      const topics = dto.topics
        .map((t) => String(t ?? '').trim())
        .filter(Boolean)
        .slice(0, 100)
        .map((t) => t.slice(0, 300));
      await this.setSetting('ai_topics', JSON.stringify(topics));
    }
    return this.getSettings();
  }

  // ---------- Qoralama yozish ----------

  /**
   * Manbalarni yig'adi: asosiy Wikipedia maqolasi, katta modelda yana 1–2 ta
   * yaqin maqola va arXiv'dagi so'nggi ishlar. Mavzusiz — bugungi tanlangan maqola.
   */
  private async gatherSources(topic: string, llm: Llm): Promise<Source[]> {
    const big = llm.sourceBudget >= 20000;
    const mainChars = big ? 14000 : 5500;
    let main: WikiSource;
    try {
      main = topic
        ? await findSource(topic, mainChars)
        : await featuredToday(new Date(), mainChars);
    } catch (err: any) {
      throw new BadRequestException(err?.message ?? 'Manba topilmadi');
    }
    const [rel, papers] = await Promise.all([
      related(main, big ? 2 : 0, 5000).catch(() => []),
      main.lang === 'en'
        ? searchArxiv(main.title, big ? 3 : 1).catch(() => [])
        : Promise.resolve([] as ArxivPaper[]),
    ]);
    return [
      { kind: 'wikipedia' as const, ...main },
      ...rel.map((r) => ({ kind: 'wikipedia' as const, ...r })),
      ...papers.map((p) => ({
        kind: 'arxiv' as const,
        ...p,
        summary: p.summary.slice(0, 2000),
      })),
    ];
  }

  /** Mavzu (yoki Wikipedia havolasi) bo'yicha qoralama; mavzusiz — bugungi tanlangan maqola */
  async generate(opts: {
    topic?: string;
    categoryId?: number;
    authorId?: number;
  }) {
    const llm = this.getLlm();
    if (!llm) {
      throw new ServiceUnavailableException(
        'AI kaliti sozlanmagan (GEMINI_API_KEY yoki GROQ_API_KEY)',
      );
    }
    const topic = String(opts.topic ?? '').trim();
    const sources = await this.gatherSources(topic, llm);

    // raw: Category modelida `name` class field — instance'da undefined bo'ladi
    const categories = (await this.categoryModel.findAll({
      attributes: ['id', 'name'],
      raw: true,
    })) as unknown as { id: number; name: string }[];
    const draft = await this.write(
      llm,
      sources,
      categories.map((c) => c.name),
    );

    const title = normalize(draft.title ?? '').trim() || sources[0].title;
    const category =
      categories.find((c) => c.id === Number(opts.categoryId)) ??
      categories.find(
        (c) =>
          c.name.toLowerCase() === String(draft.category ?? '').toLowerCase(),
      ) ??
      categories[0];
    const html = sanitizeHtml(draft.html ?? '');
    if (html.replace(/<[^>]+>/g, '').length < 1500) {
      throw new ServiceUnavailableException(
        "AI juda qisqa matn qaytardi. Qayta urinib ko'ring.",
      );
    }

    // AI ishlatgan manbalar; asosiy Wikipedia maqolasi doim ko'rsatiladi
    const used = sources.filter(
      (_, i) => i === 0 || (draft.sources ?? []).map(Number).includes(i + 1),
    );
    const items = used.map((src) =>
      src.kind === 'wikipedia'
        ? `<li><a href="${escapeHtml(src.url)}" target="_blank" rel="noopener">Wikipedia: ${escapeHtml(src.title)}</a> (CC BY-SA 4.0)</li>`
        : `<li><a href="${escapeHtml(src.url)}" target="_blank" rel="noopener">${escapeHtml(src.title)}</a> — ${escapeHtml(
            src.authors.slice(0, 3).join(', ') +
              (src.authors.length > 3 ? ' va boshq.' : ''),
          )}, arXiv, ${src.published.slice(0, 4)}</li>`,
    );
    const content = `${html}
<h2>Manbalar</h2>
<ul>${items.join('')}</ul>
<p><em>Maqola yuqoridagi manbalar asosida sun'iy intellekt yordamida tayyorlangan. Matn <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.uz" target="_blank" rel="noopener">CC BY-SA 4.0</a> litsenziyasi ostida tarqatiladi.</em></p>`;

    let slug = slugify(title);
    if (await this.articleModel.findOne({ where: { slug } })) {
      slug = `${slug}-${Date.now()}`;
    }
    const contentUrl = await this.cloudflare.uploadJson(
      { message: content },
      `${slug}-${Date.now()}.json`,
    );

    const authorId = opts.authorId ?? (await this.adminId());
    const article = await this.articleModel.create({
      title,
      slug,
      excerpt: normalize(draft.excerpt ?? '').trim() || null,
      source: AI_SOURCE,
      content: contentUrl,
      coverImage: null,
      type: ArticleType.FREE,
      status: ArticleStatus.DRAFT,
      tags: (draft.tags ?? [])
        .map((t) => normalize(t).trim())
        .filter(Boolean)
        .slice(0, 5)
        .join(', '),
      categoryId: category?.id,
      authorId,
    } as any);
    this.logger.log(
      `AI qoralama yaratildi: ${slug} (${llm.name}; manbalar: ${used.map((u) => u.url).join(', ')})`,
    );
    return article;
  }

  private async adminId(): Promise<number | undefined> {
    const admin = await this.userModel.findOne({
      where: { role: 'admin' } as any,
      order: [['id', 'ASC']],
    });
    return admin?.id;
  }

  private async write(
    llm: Llm,
    sources: Source[],
    categories: string[],
  ): Promise<DraftJson> {
    const system = `Sen Bilim Manba (bilimmanba.uz) — o'zbek tilidagi ilmiy-ommabop jurnalning eng yaxshi muallifisan. Uslubing Quanta Magazine, Kurzgesagt kabi: jonli, aniq, o'quvchini oxirigacha olib boradigan.
Senga bir mavzu bo'yicha bir nechta raqamlangan manba beriladi: Wikipedia maqolalari va (bo'lsa) arXiv'dagi yangi ilmiy ishlarning annotatsiyalari. Ulardagi faktlarni birlashtirib, o'zbek o'quvchisi uchun yangi, o'z so'zlaring bilan yozilgan bitta yaxlit maqola tayyorla.

Uslub va tuzilish:
- Tutuq belgisi uchun oddiy apostrof (o', g', ma'no). Tabiiy, ravon o'zbek adabiy tili; tarjima ohangi, kalka va quruq ensiklopediya uslubidan qoch.
- Qiziqarli "ilgak" bilan boshla: savol, kutilmagan fakt yoki kichik voqea. Keyin mavzu nega muhimligini ayt.
- Murakkab tushunchalarni kundalik hayotdan olingan misol va taqqoslash bilan tushuntir. Atamani birinchi ishlatganda qisqa izohla.
- Manbalarni gapma-gap tarjima qilma va birorta manbaning tuzilishini takrorlama — tuzilishni o'zing qur.
- arXiv ishlari mavzuga aloqador bo'lsa, oxirroqda "So'nggi tadqiqotlar" ruhida qo'sh: nimani o'rganishgan, nima topishgan, nega qiziq — oddiy tilda. Ular hali taqrizdan o'tmagan preprint ekanini bir og'iz eslat. Aloqasiz bo'lsa, umuman ishlatma.
- Kuchli xulosa bilan tugat: o'quvchi o'ylab qoladigan fikr yoki ochiq savol.

Aniqlik:
- Faqat manbalardagi faktlarga tayan. Manbada yo'q raqam, sana, ism yoki iqtibos to'qima. Ishonchsiz bo'lsang, umumiyroq yoz.

Format:
- Hajm: 900–1400 so'z, 4–7 ta <h2> bo'lim (kerak bo'lsa <h3>).
- HTML: faqat <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <blockquote>. <h1>, rasm, havola, markdown va [1] kabi manba belgilarini matnga qo'yma. "Manbalar" bo'limini yozma — uni tizim o'zi qo'shadi.
- title: qiziqarli, 40–90 belgi, aldamchi (clickbait) emas.
- excerpt: 1–2 gap, 130–170 belgi; "Ushbu maqolada" bilan boshlanmasin.
- category: quyidagilardan aynan bittasi: ${categories.join(', ')}.
- tags: 3–5 ta qisqa o'zbekcha teg.
- sources: haqiqatan foydalangan manbalaringning raqamlari.
Javob faqat JSON: {"title": "...", "excerpt": "...", "category": "...", "tags": ["..."], "sources": [1, 2], "html": "..."}`;

    const user = sources
      .map((src, i) =>
        src.kind === 'wikipedia'
          ? `[${i + 1}] Wikipedia (${src.lang}) — "${src.title}"\n${src.text}`
          : `[${i + 1}] arXiv ilmiy ishi (${src.published}; ${src.authors.slice(0, 3).join(', ')}) — "${src.title}"\nAnnotatsiya: ${src.summary}`,
      )
      .join('\n\n---\n\n');

    try {
      const raw = await llm.json(system, user);
      const json = JSON.parse(
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
      );
      if (!json?.html) throw new Error("JSON'da html yo'q");
      return json as DraftJson;
    } catch (err: any) {
      this.logger.error(`AI qoralama xatosi (${llm.name}): ${err?.message}`);
      throw new ServiceUnavailableException(
        `AI maqola yoza olmadi: ${String(err?.message ?? '').slice(0, 200)}`,
      );
    }
  }

  // ---------- Kunlik rejim ----------

  /** Keyingi tekshiruv: Toshkent 06:00 ga yoki ko'pi bilan 6 soatdan keyin */
  private schedule(delay?: number) {
    if (this.timer) clearTimeout(this.timer);
    let wait = delay;
    if (wait === undefined) {
      const now = Date.now();
      const local = new Date(now + TASHKENT_OFFSET_MS);
      local.setUTCHours(DAILY_HOUR, 1, 0, 0);
      let next = local.getTime() - TASHKENT_OFFSET_MS;
      if (next <= now) next += 24 * 60 * 60 * 1000;
      wait = Math.min(next - now, MAX_WAIT_MS);
    }
    this.timer = setTimeout(() => void this.dailyTick(), wait);
    this.timer.unref();
  }

  async dailyTick() {
    try {
      await this.runDailyIfDue();
    } catch (err: any) {
      this.logger.error(`Kunlik qoralama: ${err?.message}`);
    }
    this.schedule();
  }

  /** Bugun hali yozilmagan va soat 06:00 dan o'tgan bo'lsa — bitta qoralama */
  async runDailyIfDue(
    now = new Date(),
  ): Promise<'done' | 'skipped' | 'failed'> {
    if (this.dailyRunning) return 'skipped';
    if (!this.getLlm()) return 'skipped';
    const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
    if (local.getUTCHours() < DAILY_HOUR) return 'skipped';
    const today = tashkentDay(now);

    this.dailyRunning = true;
    try {
      if ((await this.getSetting('ai_daily')) === 'off') return 'skipped';
      if ((await this.getSetting('ai_last_run')) === today) return 'skipped';
      // Bugungi urinish belgilanadi — xato bo'lsa ham kuniga bir marta
      await this.setSetting('ai_last_run', today);
      if ((await this.pendingCount()) >= MAX_PENDING) {
        await this.setSetting(
          'ai_last_error',
          `Ko'rib chiqilmagan ${MAX_PENDING} ta AI qoralama bor — yangisi yozilmadi`,
        );
        return 'skipped';
      }

      const topics = await this.getTopics();
      const topic = topics[0];
      try {
        await this.generate({ topic });
        if (topic)
          await this.setSetting('ai_topics', JSON.stringify(topics.slice(1)));
        await this.setSetting('ai_last_error', '');
        return 'done';
      } catch (err: any) {
        await this.setSetting(
          'ai_last_error',
          `${today}: ${topic ? `"${topic}" — ` : ''}${err?.message ?? 'xato'}`,
        );
        // Topilmagan mavzu navbatni to'sib qo'ymasin
        if (topic && err instanceof BadRequestException) {
          await this.setSetting('ai_topics', JSON.stringify(topics.slice(1)));
        }
        return 'failed';
      }
    } finally {
      this.dailyRunning = false;
    }
  }
}
