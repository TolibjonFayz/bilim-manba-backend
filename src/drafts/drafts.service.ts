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
import {
  findSource,
  related,
  WikiNotFoundError,
  WikiSource,
} from './wikipedia';
import { ArxivPaper, searchArxiv } from './arxiv';
import { createLlm, Llm } from './llm';
import sharp from 'sharp';
import {
  commonsCandidates,
  downloadImage,
  ImageCandidate,
  nasaCandidates,
  openverseCandidates,
  pexelsCandidates,
} from './images';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { AdminAlertService } from '../publishing/admin-alert.service';
import { SeriesService } from '../series/series.service';
import { SchoolService } from '../school/school.service';
import {
  DemandRow,
  SearchConsoleService,
} from '../search-console/search-console.service';

// AI qoralamalarini shu belgi bilan taniymiz (manbalar maqola oxirida)
export const AI_SOURCE = 'Bilim Manba AI';
// Birinchi versiyadagi belgi — eski qoralamalar ham hisobga olinsin
const LEGACY_AI_SOURCE = 'Wikipedia (Bilim Manba AI)';
// Ko'rib chiqilmagan AI qoralamalari shundan ko'p bo'lsa, kunlik qoralama yozilmaydi
const MAX_PENDING = 3;
// Avtomatik yangi seriya shuncha kunda bir marta (oldingisi navbatda tugagach)
const AUTO_SERIES_EVERY_DAYS = 10;
// Qidiruv so'rovi yangi maqolaga arzishi uchun 90 kunda kamida shuncha ko'rinish
const DEMAND_MIN_IMPRESSIONS = 5;
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
  /** Muqova rasmini qidirish uchun inglizcha so'zlar */
  imageQueries?: string[];
  /** Mavzu umumiy auditoriya uchun mosmi (false — qoralama yozilmaydi) */
  familySafe?: boolean;
}

type Source =
  | ({ kind: 'wikipedia' } & WikiSource)
  | ({ kind: 'arxiv' } & ArxivPaper);

/** Fonda yozilayotgan qoralama (Cloudflare 100 soniyadan uzun so'rovni uzadi) */
export interface DraftJob {
  id: number;
  topic: string;
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  articleId?: number;
  title?: string;
  error?: string;
}

/**
 * Zinapoyaning oxirgi bosqichi: aniq va yaqin rasm topilmasa — kategoriyaga
 * mos, umumiy va xavfsiz (Pexels) fotolar. Kalit — kategoriya nomi kichik harfda.
 */
const CATEGORY_IMAGE_QUERIES: Record<string, string[]> = {
  sport: ['sports stadium lights', 'athlete running track'],
  'kompyuter fanlari': ['computer code on screen', 'circuit board technology'],
  tarix: ['ancient ruins history', 'old historical architecture'],
  "o'yinlar": ['video game controller', 'gaming setup neon'],
  kino: ['cinema theater screen', 'film camera movie set'],
  matematika: ['mathematics chalkboard equations', 'geometry shapes abstract'],
  geografiya: ['mountain landscape aerial', 'world globe map'],
  biologiya: ['green leaves macro nature', 'microscope laboratory biology'],
  fizika: ['galaxy stars night sky', 'physics light experiment'],
  fan: ['science laboratory', 'galaxy stars night sky'],
  "san'at": ['paint brushes palette colors', 'art supplies colorful'],
  umumiy: ['books library reading', 'open book warm light'],
};
const DEFAULT_IMAGE_QUERIES = ['books library reading', 'open book warm light'];

/** Google qidiruvida yangi mavzu topilmadi — kunlik rejim bo'limlar navbatiga o'tadi */
class NoDemandTopicError extends ServiceUnavailableException {}
/** Maktab navbatida mavzu qolmadi (AI ham taklif qila olmadi) */
class NoSchoolTopicError extends ServiceUnavailableException {}

type DraftSource = 'search' | 'school';
/** Maktab maqolasi: fan, sinf va darslikdagi mavzu nomi */
interface SchoolMeta {
  subject: string | null;
  grade: number | null;
  title?: string;
}

const categoryQueries = (name?: string | null) =>
  CATEGORY_IMAGE_QUERIES[
    String(name ?? '')
      .toLowerCase()
      .replace(/[‘’ʻʼ`]/g, "'")
      .trim()
  ] ?? DEFAULT_IMAGE_QUERIES;

/** "Manbalar" ro'yxatidagi muqova muallifi qatori */
const coverCredit = (c: ImageCandidate) =>
  `<li>Muqova rasmi: <a href="${escapeHtml(c.pageUrl)}" target="_blank" rel="noopener">${escapeHtml(c.title)}</a> — ${escapeHtml(c.artist)}, ${escapeHtml(c.license)}, ${escapeHtml(c.provider)}</li>`;

const plainLength = (html?: string) =>
  String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;

// Ikkala bosqich (muallif va muharrir) uchun umumiy til qoidalari
const UZ_RULES = `O'zbek tili qoidalari:
- Lotin yozuvi; tutuq belgisi va o', g' uchun oddiy apostrof (o', g', ma'no, ta'sir).
- Tabiiy o'zbek gap qurilishi: kesim gap oxirida. 25 so'zdan uzun gapni bo'l; ergash gaplar zanjiridan qoch.
- Rus va ingliz kalkalaridan qoch: "muhim rol o'ynaydi" o'rniga "muhim o'rin tutadi", "amalga oshirildi", "hisoblanadi", "mavjud" kabi qoliplarni keragidan ortiq ishlatma.
- Ilmiy atamalarni o'zbek ilmiy adabiyotidagi shaklda yoz (qora tuynuk, tortishish kuchi, yorug'lik yili, hujayra, fotosintez). O'zbekcha muqobili bo'lmasa xalqaro atamani qoldir va birinchi marta qisqa izohla.
- Sonlar: o'nli kasr vergul bilan (1,5); katta sonlar so'z bilan (4 million, 13,8 milliard); yillar "1915-yilda", asrlar "XX asr".
- Xorijiy ismlarni o'zbekcha talaffuzda yoz (Albert Eynshteyn, Isaak Nyuton, Stiven Hoking) va birinchi tilga olinganda kimligini qisqa ayt.
- O'quvchiga "siz" deb murojaat qil; jargon va haddan tashqari ko'tarinki, reklama ohangidagi iboralardan qoch.
- Maqola oilaviy auditoriyaga (bolalar va o'smirlar ham) mos bo'lsin: jinsiy, shahvoniy yoki shok (qon, qiynoq) tafsilotlarni yozma; zarur bo'lsa, umumiy va ehtiyotkor tilda ayt.`;

// Sayt qadriyatlari: o'quvchilar asosan musulmon oilalar, bolalar ham o'qiydi
const VALUES_RULES = `Sayt qadriyatlari (qat'iy):
- O'quvchilar asosan musulmon oilalar. Islom aqidasi va axloqiga zid narsalarni targ'ib qilma, ijobiy yoki havas qilinadigan qilib ko'rsatma: spirtli ichimlik, giyohvandlik, qimor va tikish, nikohsiz munosabatlar, sehr-jodu, folbinlik va munajjimlik (bashorat sifatida), butparastlik va shirk, LGBT targ'iboti.
- Islom, Qur'on, Payg'ambarimiz (s.a.v.), sahobalar va diniy qadriyatlarni tanqid qilma, masxara qilma, ular haqida shubha uyg'otma. Diniy bahs-munozaralarga kirma; boshqa dinlarni ham haqorat qilma.
- Ilmiy nazariyalarni (masalan, evolyutsiya yoki koinot kelib chiqishi) "olimlar fikricha" tarzida xolis bayon qil; din haqida xulosa chiqarma va ateizmni targ'ib qilma.
- Mavzu bunday narsaga beixtiyor tegsa (masalan, film qahramoni ichadi yoki qimor o'ynaydi) — tafsilotga kirmasdan, qisqa va betaraf o'tib ket.
- 18+ mazmun yo'q: jinsiy, shahvoniy, ochiq sahnalar va shok tafsilotlar yozilmaydi.`;

const FORMAT_RULES = (categories: string[]) => `Format:
- Hajm: 900–1400 so'z, 4–7 ta <h2> bo'lim (kerak bo'lsa <h3>).
- HTML: faqat <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <blockquote>. <h1>, rasm, havola, markdown va [1] kabi manba belgilarini matnga qo'yma. "Manbalar" bo'limini yozma — uni tizim o'zi qo'shadi.
- title: qiziqarli, 40–90 belgi, aldamchi (clickbait) emas.
- excerpt: 1–2 gap, 130–170 belgi; "Ushbu maqolada" bilan boshlanmasin.
- category: quyidagilardan aynan bittasi: ${categories.join(', ')}.
- tags: 3–5 ta qisqa o'zbekcha teg.
- sources: haqiqatan foydalangan manbalaringning raqamlari.
- familySafe: maqola mavzusi va mazmuni musulmon oila (bolalar va o'smirlar ham) uchun mos bo'lsa true; mavzuning o'zi 18+ (jinsiy, erotik, o'ta shafqatsiz) yoki Islom qadriyatlariga zid narsa (spirtli ichimlik, qimor, okkultizm, LGBT, dinni masxara qilish) atrofida qurilgan bo'lsa false.
- imageQueries: muqova rasmini topish uchun 2–3 ta INGLIZCHA qidiruv so'zi — aniq, ko'rinadigan obyekt (masalan "Messier 87 black hole", "Registan Samarkand", "Lionel Messi World Cup"), mavhum so'zlar emas.
Javob faqat JSON: {"title": "...", "excerpt": "...", "category": "...", "tags": ["..."], "sources": [1, 2], "familySafe": true, "imageQueries": ["..."], "html": "..."}`;

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
 * admin kiritgan mavzular navbatidan, navbat bo'sh bo'lsa bo'limlar navbatidan
 * (har bo'lim bittadan, Kino ikki marta) AI o'zi mavzu tanlaydi.
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
    private readonly cloudinary: CloudinaryService,
    private readonly alerts: AdminAlertService,
    private readonly searchConsole: SearchConsoleService,
    private readonly series: SeriesService,
    private readonly school: SchoolService,
  ) {}

  private job: DraftJob | null = null;
  private jobSeq = 0;
  private styleCache?: { at: number; text: string };

  getJob(): DraftJob | null {
    return this.job;
  }

  /**
   * Qoralamani fonda yozishni boshlaydi va darhol javob qaytaradi —
   * admin panel GET drafts/job orqali holatini kuzatadi.
   */
  startGenerate(opts: {
    topic?: string;
    categoryId?: number;
    authorId?: number;
    source?: DraftSource;
  }): DraftJob {
    if (this.job?.state === 'running') {
      throw new BadRequestException(
        'Hozir boshqa qoralama yozilmoqda — u tugashini kuting',
      );
    }
    if (!this.getLlm()) {
      throw new ServiceUnavailableException(
        'AI kaliti sozlanmagan (GEMINI_API_KEY yoki GROQ_API_KEY)',
      );
    }
    const job: DraftJob = {
      id: ++this.jobSeq,
      topic: String(opts.topic ?? '').trim(),
      state: 'running',
      startedAt: new Date().toISOString(),
    };
    this.job = job;
    this.generate(opts)
      .then((a) => {
        Object.assign(job, {
          state: 'done',
          articleId: a.id,
          title: a.title,
          finishedAt: new Date().toISOString(),
        });
        // Yozish 5–10 daqiqa oladi — admin oynani yopgan bo'lishi mumkin
        void this.alerts.draftReady(a, false);
      })
      .catch((err: any) => {
        Object.assign(job, {
          state: 'failed',
          error: String(err?.message ?? 'Xato'),
          finishedAt: new Date().toISOString(),
        });
        void this.alerts.draftFailed(job.error!, job.topic);
      });
    return job;
  }

  /** Gemini (kaliti bo'lsa) yoki Groq; kalit yo'q bo'lsa — null, server baribir ishlaydi */
  private getLlm(): Llm | null {
    return (
      this.llmOverride ??
      createLlm({
        geminiKey: this.config.get<string>('GEMINI_API_KEY'),
        geminiModel: this.config.get<string>('GEMINI_MODEL'),
        geminiFallbacks: this.config.get<string>('GEMINI_FALLBACK_MODELS'),
        groqKey: this.config.get<string>('GROQ_API_KEY'),
        groqModel: this.config.get<string>('GROQ_MODEL'),
      })
    );
  }

  onModuleInit() {
    // Deploy/uyg'onishdan keyin bugungi qoralama yozilmagan bo'lsa — yoziladi
    this.schedule(60 * 1000);
    // 2026-10-14: 92-qoralamaga 18+ muqova tushgan edi (xavfsizlik filtrlaridan
    // oldin) — deploy'dan keyin bir marta olib tashlanib, yangisi tanlanadi
    setTimeout(() => void this.replaceCoverOnce(92), 90 * 1000).unref();
    // 2026-10-18: birinchi seriyalar — mavjud maqolalardan va yangi AI seriya
    setTimeout(() => void this.seriesKickoffOnce(), 3 * 60 * 1000).unref();
    // 2026-10-18: /maktab — mavjud maqolalardan belgilash + mavzular navbati
    setTimeout(() => void this.schoolKickoffOnce(), 6 * 60 * 1000).unref();
  }

  /** Bir marta: maktabga mos mavjud maqolalarni belgilash va mavzular navbati */
  async schoolKickoffOnce() {
    const key = 'once_school_kickoff_v1';
    try {
      if (await this.getSetting(key)) return;
      await this.setSetting(key, new Date().toISOString());
      const marked = await this.school.classifyExisting();
      if (!(await this.school.queue()).length) await this.school.refill();
      if (marked.length) {
        await this.alerts.send(
          `🎒 <b>/maktab sahifasi ishga tushdi</b>\n\nAI saytdagi ${marked.length} ta maqolani maktab o'quvchilari uchun belgiladi. Endi kunlik AI qoralama navbat bilan maktab mavzularini ham yozadi.`,
          { text: "🎒 Ko'rish", path: '/maktab' },
        );
      }
    } catch (err: any) {
      this.logger.error(`Maktab bo'limini boshlashda xato: ${err?.message}`);
    }
  }

  /**
   * Maktab navbatidan mavzu: Wikipedia'da topilmasa yoki qoidaga mos kelmasa —
   * keyingisi (ko'pi bilan 3 ta urinish).
   */
  private async schoolTopic(mainChars: number, llm: Llm) {
    const categories = (await this.categoryModel.findAll({
      attributes: ['id', 'name'],
      raw: true,
    })) as unknown as { id: number; name: string }[];
    for (let i = 0; i < 3; i++) {
      const t = await this.school.nextTopic();
      if (!t) break;
      let main: WikiSource;
      try {
        main = await findSource(t.topic, mainChars);
      } catch {
        continue;
      }
      const verdict = await this.checkTopic(main, llm);
      if (!verdict.ok) continue;
      const cat = categories.find(
        (c) => c.name.toLowerCase() === t.subject.toLowerCase(),
      );
      this.logger.log(`Maktab mavzusi: ${t.title} (${t.grade ?? '?'}-sinf)`);
      return {
        main,
        categoryId: cat?.id,
        school: { subject: t.subject, grade: t.grade, title: t.title },
      };
    }
    throw new NoSchoolTopicError(
      "Maktab navbatida mos mavzu topilmadi. Birozdan keyin qayta urinib ko'ring.",
    );
  }

  /** Bir marta: mavjud maqolalardan seriya yig'ish + birinchi avtomatik seriya */
  async seriesKickoffOnce() {
    const key = 'once_series_kickoff_v1';
    try {
      if (await this.getSetting(key)) return;
      await this.setSetting(key, new Date().toISOString());
      await this.seriesFromExisting();
      await this.maybeAutoSeries(true);
    } catch (err: any) {
      this.logger.error(`Seriyalarni boshlashda xato: ${err?.message}`);
    }
  }

  /** AI mavjud maqolalardan seriya yig'adi (admin tugmasi ham shuni chaqiradi) */
  async seriesFromExisting() {
    const created = await this.series.groupExisting();
    for (const s of created) {
      await this.alerts.send(
        `📚 <b>Yangi seriya</b>: «${s.title.replace(/[<>&]/g, '')}»\n\nAI saytdagi ${s.parts} ta maqolani bitta seriyaga yig'di — o'quvchilar ularni qism-qism o'qiydi.`,
        { text: "📚 Seriyani ko'rish", path: `/series/${s.slug}` },
      );
    }
    return created;
  }

  /**
   * Avtomatik yangi seriya: o'chirilmagan bo'lsa, oldingi seriya qismlari
   * navbatda tugagan va oxirgisidan beri AUTO_SERIES_EVERY_DAYS kun o'tgan
   * bo'lsa — AI yangi seriya o'ylab topib, qismlarini navbatga qo'yadi.
   * force — kunni kutmaydi (admin tugmasi, birinchi ishga tushirish).
   */
  async maybeAutoSeries(force = false) {
    if ((await this.getSetting('ai_auto_series')) === 'off' && !force)
      return null;
    if (await this.series.hasQueued()) return null;
    const last = await this.getSetting('series_last_auto');
    if (
      !force &&
      last &&
      Date.now() - new Date(last).getTime() <
        AUTO_SERIES_EVERY_DAYS * 24 * 60 * 60 * 1000
    )
      return null;
    const created = await this.series.autoNew();
    if (!created) return null;
    await this.setSetting('series_last_auto', new Date().toISOString());
    await this.alerts.send(
      `📚 <b>Yangi seriya rejalashtirildi</b>: «${created.title.replace(/[<>&]/g, '')}»\n\n${created.parts.length} qism kunlik AI navbatiga qo'yildi — har kuni bittadan qoralama yoziladi:\n${created.parts.map((p, i) => `${i + 1}. ${p.title.replace(/[<>&]/g, '')}`).join('\n')}`,
      { text: '📚 Seriyalar', path: '/admin/series' },
    );
    return created;
  }

  /** Bir marta bajariladi (app_settings belgisi) — qayta ishga tushganda takrorlanmaydi */
  async replaceCoverOnce(articleId: number) {
    // v2: zinapoyali qidiruv bilan qayta (v1 xavfsiz rasm topa olmagan edi)
    const key = `once_cover_v2_${articleId}`;
    try {
      if (await this.getSetting(key)) return;
      await this.setSetting(key, new Date().toISOString());
      const res = await this.regenerateCover(articleId);
      this.logger.log(
        `${articleId}-maqola muqovasi almashtirildi: ${res.coverImage ?? 'muqovasiz qoldi'}`,
      );
    } catch (err: any) {
      this.logger.error(
        `${articleId}-maqola muqovasi almashtirilmadi: ${err?.message}`,
      );
    }
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

  /**
   * Navbatdan bitta mavzuni olib tashlaydi — ro'yxat qaytadan o'qiladi, shuning
   * uchun yozish davomida qo'shilgan mavzular (masalan, yangi seriya) yo'qolmaydi.
   */
  private async removeTopic(topic: string) {
    const list = await this.getTopics();
    const i = list.findIndex((t) => t === topic);
    if (i >= 0) list.splice(i, 1);
    await this.setSetting('ai_topics', JSON.stringify(list));
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
    const [daily, topics, lastRun, lastError, pending, autoSeries] =
      await Promise.all([
        this.getSetting('ai_daily'),
        this.getTopics(),
        this.getSetting('ai_last_run'),
        this.getSetting('ai_last_error'),
        this.pendingCount(),
        this.getSetting('ai_auto_series'),
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
      autoSeries: autoSeries !== 'off',
      autoSeriesEveryDays: AUTO_SERIES_EVERY_DAYS,
    };
  }

  async updateSettings(dto: {
    daily?: boolean;
    topics?: unknown;
    autoSeries?: boolean;
  }) {
    if (typeof dto?.daily === 'boolean') {
      await this.setSetting('ai_daily', dto.daily ? 'on' : 'off');
    }
    if (typeof dto?.autoSeries === 'boolean') {
      await this.setSetting('ai_auto_series', dto.autoSeries ? 'on' : 'off');
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
   * Asosiy Wikipedia maqolasi: berilgan mavzu bo'yicha yoki (mavzusiz) bo'lim
   * uchun AI tanlagan mavzu. Ikkala holda ham sayt qoidalariga mosligi
   * yozishdan oldin tekshiriladi.
   */
  private async mainSource(
    topic: string,
    categoryId: number | undefined,
    llm: Llm,
    source?: DraftSource,
  ): Promise<{
    main: WikiSource;
    categoryId?: number;
    query?: string;
    school?: SchoolMeta;
  }> {
    const mainChars = llm.sourceBudget >= 20000 ? 14000 : 5500;
    if (!topic && source === 'school') return this.schoolTopic(mainChars, llm);
    if (!topic && source === 'search') {
      const found = await this.demandTopic(mainChars, llm);
      if (found) return found;
      throw new NoDemandTopicError(
        "Google qidiruvida hali maqolasi yo'q yangi so'rov topilmadi. Boshqa usulni tanlang yoki birozdan keyin urinib ko'ring.",
      );
    }
    if (!topic) return this.autoTopic(categoryId, mainChars, llm);
    let main: WikiSource;
    try {
      main = await this.findTopic(topic, mainChars, llm);
    } catch (err: any) {
      if (err instanceof WikiNotFoundError) {
        throw new BadRequestException(err.message);
      }
      // Tarmoq/Wikipedia xatosi — mavzu aybdor emas (kunlik navbatda qoladi)
      throw new ServiceUnavailableException(
        `Wikipedia bilan aloqa bo'lmadi: ${err?.message ?? 'xato'}. Birozdan keyin qayta urinib ko'ring.`,
      );
    }
    const verdict = await this.checkTopic(main, llm);
    if (!verdict.ok) {
      throw new BadRequestException(
        `Mavzu sayt qoidalariga mos emas (18+ yoki Islom qadriyatlariga zid): ${verdict.reason}`,
      );
    }
    return { main, categoryId };
  }

  /** Yozishdan oldin arzon tekshiruv: mavzu musulmon oila o'quvchisiga mosmi */
  private async checkTopic(
    main: WikiSource,
    llm: Llm,
  ): Promise<{ ok: boolean; reason: string }> {
    try {
      const raw = await llm.json(
        `Sen o'zbek ta'lim saytining muharririsan. O'quvchilar asosan musulmon oilalar, bolalar va o'smirlar ham bor. Berilgan Wikipedia maqolasi shu sayt uchun maqola MAVZUSI sifatida mosmi?
Mos EMAS, agar mavzuning o'zi: 18+ (jinsiy, erotik, pornografik; ochiq sahnalari bilan tanilgan yoki 18+ / NC-17 reytingli film), o'ta shafqatsiz yoki dahshat (gore, qiynoq, seriyali qotillar), spirtli ichimlik, giyohvandlik, qimor yoki kazino, sehr-jodu, okkultizm, satanizm, LGBT, Islomni yoki boshqa dinni tanqid qilish va masxara qilish atrofida qurilgan bo'lsa.
Oddiy ilmiy, tarixiy, sport, san'at, texnologiya va oilaviy kino mavzulari — mos. Mavzu bunday narsalarga faqat yo'l-yo'lakay tegsa — baribir mos.
Javob faqat JSON: {"ok": true yoki false, "reason": "qisqa izoh"}`,
        `"${main.title}"\n${main.text.slice(0, 3000)}`,
      );
      const j = JSON.parse(
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
      );
      return {
        ok: j?.ok !== false,
        reason: String(j?.reason ?? '').slice(0, 200),
      };
    } catch (err: any) {
      // Tekshiruv ishlamasa — muallif bosqichidagi familySafe baribir to'xtatadi
      this.logger.warn(`Mavzu tekshiruvi bajarilmadi: ${err?.message}`);
      return { ok: true, reason: '' };
    }
  }

  /**
   * Bo'limlar navbati: har bir bo'lim bittadan, Kino — ikki marta (navbat
   * boshida va o'rtasida). Ko'rsatkich app_settings ai_rotation'da.
   */
  static rotation<T extends { name: string }>(categories: T[]): T[] {
    const isKino = (c: T) => c.name.trim().toLowerCase() === 'kino';
    const kino = categories.find(isKino);
    const rest = categories.filter((c) => !isKino(c));
    if (!kino) return rest;
    const half = Math.ceil(rest.length / 2);
    return [kino, ...rest.slice(0, half), kino, ...rest.slice(half)];
  }

  private async nextRotationCategory() {
    const categories = (await this.categoryModel.findAll({
      attributes: ['id', 'name'],
      order: [['id', 'ASC']],
      raw: true,
    })) as unknown as { id: number; name: string }[];
    const cycle = DraftsService.rotation(categories);
    if (!cycle.length) return undefined;
    const i = Number(await this.getSetting('ai_rotation')) || 0;
    await this.setSetting('ai_rotation', String((i + 1) % cycle.length));
    return cycle[i % cycle.length];
  }

  /**
   * Mavzu berilmagan: bo'lim (tanlangan yoki navbatdagi) uchun AI bir nechta
   * aniq Wikipedia mavzusini taklif qiladi — saytda borlarini takrorlamasdan;
   * birinchi topilgan va qoidalarga mos kelgani olinadi.
   */
  private async autoTopic(
    categoryId: number | undefined,
    mainChars: number,
    llm: Llm,
  ): Promise<{ main: WikiSource; categoryId?: number }> {
    const category = categoryId
      ? ((await this.categoryModel.findByPk(categoryId, {
          attributes: ['id', 'name'],
          raw: true,
        })) as unknown as { id: number; name: string } | null)
      : await this.nextRotationCategory();
    const name = category?.name ?? 'Umumiy';
    const existing = category
      ? ((await this.articleModel.findAll({
          where: { categoryId: category.id },
          attributes: ['title'],
          order: [['createdAt', 'DESC']],
          limit: 80,
          raw: true,
        })) as unknown as { title: string }[])
      : [];
    const kino = name.trim().toLowerCase() === 'kino';
    const kinoRules = kino
      ? "Kino bo'limi uchun: butun oila bilan ko'rsa bo'ladigan mashhur, yuqori baholangan filmlar, multfilmlar, rejissyorlar yoki kino tarixi va texnologiyasi. 18+ / R / NC-17 reytingli, ochiq sahnali, dahshat, okkult yoki zo'ravonlikka urg'u bergan filmlarni tanlama.\n"
      : '';
    let titles: string[] = [];
    try {
      const raw = await llm.json(
        `Sen Bilim Manba (o'zbek tilidagi ilmiy-ommabop sayt) bosh muharririsan. "${name}" bo'limi uchun keyingi maqola mavzusini tanlaysan.
6 ta turli, aniq va qiziqarli mavzu taklif qil. Har biri INGLIZCHA Wikipedia maqolasining aynan nomi bo'lsin (masalan, aniq film, shaxs, kashfiyot, voqea yoki hodisa) — umumiy so'z emas.
${kinoRules}Mavzular musulmon oila o'quvchisiga mos bo'lsin: 18+, spirtli ichimlik, qimor, okkultizm, LGBT, dinni tanqid qilish mavzulari bo'lmasin.
Saytda shu bo'limda allaqachon bor maqolalar (bularni va ularga juda yaqin mavzularni takrorlama):
${existing.map((a) => `- ${a.title}`).join('\n') || "- (hali yo'q)"}
Javob faqat JSON: {"titles": ["..."]}`,
        name,
      );
      const j = JSON.parse(
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
      );
      titles = (Array.isArray(j?.titles) ? j.titles : [])
        .map((t: unknown) => String(t ?? '').trim())
        .filter(Boolean)
        .slice(0, 6);
    } catch (err: any) {
      throw new ServiceUnavailableException(
        `AI "${name}" bo'limi uchun mavzu tanlay olmadi: ${String(err?.message ?? '').slice(0, 200)}`,
      );
    }
    for (const t of titles) {
      let main: WikiSource;
      try {
        main = await findSource(t, mainChars);
      } catch {
        continue;
      }
      const verdict = await this.checkTopic(main, llm);
      if (verdict.ok) {
        this.logger.log(`Avto mavzu (${name}): ${main.title}`);
        return { main, categoryId: category?.id };
      }
      this.logger.warn(
        `Avto mavzu rad etildi: ${main.title} — ${verdict.reason}`,
      );
    }
    throw new ServiceUnavailableException(
      `"${name}" bo'limi uchun mos mavzu topilmadi. Qayta urinib ko'ring yoki mavzuni o'zingiz yozing.`,
    );
  }

  /**
   * Google qidiruv talabi: Search Console'da ko'rinayotgan, lekin saytda
   * yaxshi javobi yo'q so'rovlar (2-sahifa va undan pastda yoki maqola emas,
   * bosh/kategoriya sahifasi chiqayotgan). AI ulardan saytda hali yo'q
   * mavzularni tanlaydi. Ishlatilgan so'rovlar qayta olinmaydi.
   */
  private async demandTopic(
    mainChars: number,
    llm: Llm,
  ): Promise<{ main: WikiSource; categoryId?: number; query: string } | null> {
    let rows: DemandRow[] = [];
    try {
      rows = await this.searchConsole.demand(90);
    } catch (err: any) {
      this.logger.warn(`Search Console talabi olinmadi: ${err?.message}`);
      return null;
    }
    const used = new Set(await this.usedQueries());
    const candidates = rows
      .filter(
        (r) =>
          r.impressions >= DEMAND_MIN_IMPRESSIONS &&
          !used.has(r.query.toLowerCase()) &&
          (r.position > 8 || !r.page.startsWith('/articles/')),
      )
      .slice(0, 40);
    if (!candidates.length) return null;
    const allowed = new Set(candidates.map((c) => c.query.toLowerCase()));

    const [categories, existing] = await Promise.all([
      this.categoryModel.findAll({ attributes: ['id', 'name'], raw: true }),
      this.articleModel.findAll({
        attributes: ['title'],
        order: [['createdAt', 'DESC']],
        limit: 200,
        raw: true,
      }),
    ]);
    const cats = categories as unknown as { id: number; name: string }[];
    const titles = existing as unknown as { title: string }[];
    let picks: { query: string; title: string; category?: string }[] = [];
    try {
      const raw = await llm.json(
        `Sen Bilim Manba (o'zbek tilidagi ilmiy-ommabop sayt) bosh muharririsan. Senga Google'da odamlar qidirayotgan va saytimiz ko'rinayotgan, lekin yaxshi javob bera olmayotgan so'rovlar beriladi (ko'rinishlar soni va o'rni bilan).
Vazifa: saytda hali alohida maqolasi YO'Q va yangi maqolaga arziydigan eng yaxshi 3 ta so'rovni tanla (ko'p qidirilgani birinchi). Har biri uchun shu mavzuni yorituvchi INGLIZCHA Wikipedia maqolasining aynan nomini va bo'limni ber.
Tashlab ket: saytdagi mavjud maqola allaqachon javob beradigan so'rovlar; navigatsion so'rovlar (sayt nomi, "bilim manba"); juda umumiy yoki ma'nosiz so'rovlar; 18+, spirtli ichimlik, qimor, okkultizm, LGBT yoki dinni tanqid qilish mavzulari.
Bo'limlar: ${cats.map((c) => c.name).join(', ')}.
Saytdagi mavjud maqolalar:
${titles.map((a) => `- ${a.title}`).join('\n')}
Javob faqat JSON: {"picks": [{"query": "so'rov aynan", "title": "English Wikipedia title", "category": "bo'lim"}]}`,
        candidates
          .map(
            (c) =>
              `"${c.query}" — ${c.impressions} ko'rinish, o'rin ${c.position}, chiqayotgan sahifa ${c.page}`,
          )
          .join('\n'),
      );
      const j = JSON.parse(
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
      );
      picks = (Array.isArray(j?.picks) ? j.picks : [])
        .map((p: any) => ({
          query: String(p?.query ?? '').trim(),
          title: String(p?.title ?? '').trim(),
          category: p?.category ? String(p.category) : undefined,
        }))
        // Faqat haqiqatan berilgan so'rovlar — AI o'zidan so'rov o'ylab topmasin
        .filter(
          (p: { query: string; title: string }) =>
            p.title && allowed.has(p.query.toLowerCase()),
        )
        .slice(0, 3);
    } catch (err: any) {
      this.logger.warn(`Qidiruv mavzusi tanlanmadi: ${err?.message}`);
      return null;
    }
    for (const p of picks) {
      // Tanlangan so'rov qayta olinmasin (topilmasa ham — navbatni to'smasin)
      await this.markQueryUsed(p.query);
      let main: WikiSource;
      try {
        main = await findSource(p.title, mainChars);
      } catch {
        continue;
      }
      const verdict = await this.checkTopic(main, llm);
      if (!verdict.ok) {
        this.logger.warn(
          `Qidiruv mavzusi rad etildi: ${main.title} — ${verdict.reason}`,
        );
        continue;
      }
      const cat = cats.find(
        (c) => c.name.toLowerCase() === String(p.category ?? '').toLowerCase(),
      );
      this.logger.log(`Qidiruv mavzusi: "${p.query}" → ${main.title}`);
      return { main, categoryId: cat?.id, query: p.query };
    }
    return null;
  }

  private async usedQueries(): Promise<string[]> {
    try {
      const v = JSON.parse((await this.getSetting('gsc_used_queries')) ?? '[]');
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  }

  private async markQueryUsed(query: string) {
    const list = await this.usedQueries();
    list.push(query.toLowerCase());
    await this.setSetting('gsc_used_queries', JSON.stringify(list.slice(-500)));
  }

  /**
   * Ichki havolalar: saytdagi chop etilgan maqolalardan AI 3 ta eng yaqinini
   * tanlaydi — "Shuningdek o'qing" ro'yxati (o'quvchi saytda qoladi, Google
   * sahifalar bog'lanishini ko'radi). AI ishlamasa — o'sha bo'limning so'nggilari.
   */
  private async relatedLinks(
    llm: Llm,
    title: string,
    excerpt: string,
    categoryId?: number,
  ): Promise<{ title: string; slug: string }[]> {
    const pool = (await this.articleModel.findAll({
      where: { status: ArticleStatus.PUBLISHED },
      attributes: ['title', 'slug', 'categoryId'],
      order: [['createdAt', 'DESC']],
      limit: 150,
      raw: true,
    })) as unknown as { title: string; slug: string; categoryId: number }[];
    if (!pool.length) return [];
    try {
      const raw = await llm.json(
        `Yangi maqola uchun saytdagi mavjud maqolalardan mazmunan eng yaqin 3 tasini tanla (o'quvchi keyin o'qishi uchun). Faqat haqiqatan bog'liqlarini ol; bog'liq yo'q bo'lsa — kamroq.
Javob faqat JSON: {"numbers": [n, ...]}`,
        `Yangi maqola: ${title}\n${excerpt}\n\nMavjud maqolalar:\n${pool.map((a, i) => `${i}) ${a.title}`).join('\n')}`,
      );
      const j = JSON.parse(
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
      );
      const picked = [
        ...new Set<number>(
          (Array.isArray(j?.numbers) ? j.numbers : []).map(Number),
        ),
      ]
        .filter((n) => Number.isInteger(n) && pool[n])
        .slice(0, 3)
        .map((n) => pool[n]);
      if (picked.length) return picked;
    } catch (err: any) {
      this.logger.warn(`Ichki havolalar AI bilan tanlanmadi: ${err?.message}`);
    }
    return pool.filter((a) => a.categoryId === categoryId).slice(0, 3);
  }

  /** Asosiy maqolaga yaqin Wikipedia maqolalari va arXiv'dagi so'nggi ishlar */
  private async gatherSources(main: WikiSource, llm: Llm): Promise<Source[]> {
    const big = llm.sourceBudget >= 20000;
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

  /**
   * Mavzuni Wikipedia'dan topadi. Topilmasa (masalan, uzun o'zbekcha sarlavha
   * yozilgan bo'lsa) — AI mos inglizcha Wikipedia maqola nomlarini taklif qiladi.
   */
  private async findTopic(
    topic: string,
    maxChars: number,
    llm: Llm,
  ): Promise<WikiSource> {
    try {
      return await findSource(topic, maxChars);
    } catch (first) {
      let titles: string[] = [];
      try {
        const raw = await llm.json(
          `Foydalanuvchi maqola mavzusini yozdi (o'zbekcha yoki boshqa tilda, sarlavha ko'rinishida bo'lishi mumkin). Shu mavzu bo'yicha ma'lumot beradigan eng mos INGLIZCHA Wikipedia maqolalarining aniq nomlarini top (1–3 ta, eng mosi birinchi). Javob faqat JSON: {"titles": ["..."]}`,
          topic,
        );
        const j = JSON.parse(
          raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
        );
        titles = (Array.isArray(j?.titles) ? j.titles : [])
          .map((t: unknown) => String(t ?? '').trim())
          .filter(Boolean)
          .slice(0, 3);
      } catch {
        // AI yordam bera olmadi — asl xatoni qaytaramiz
      }
      for (const t of titles) {
        try {
          return await findSource(t, maxChars);
        } catch {
          // keyingi nomni sinaymiz
        }
      }
      throw first;
    }
  }

  /** Mavzu (yoki Wikipedia havolasi) bo'yicha qoralama; mavzusiz — bo'lim navbatidan AI tanlaydi */
  async generate(opts: {
    topic?: string;
    categoryId?: number;
    authorId?: number;
    /**
     * 'search' — Google qidiruv talabidan (mavzusiz); 'school' — maktab o'quvchilari
     * uchun (mavzusiz bo'lsa maktab navbatidan); aks holda bo'limlar navbatidan
     */
    source?: DraftSource;
  }) {
    const llm = this.getLlm();
    if (!llm) {
      throw new ServiceUnavailableException(
        'AI kaliti sozlanmagan (GEMINI_API_KEY yoki GROQ_API_KEY)',
      );
    }
    const topic = String(opts.topic ?? '').trim();
    const picked = await this.mainSource(
      topic,
      opts.categoryId,
      llm,
      opts.source,
    );
    const sources = await this.gatherSources(picked.main, llm);
    // Mavzu berilgan, lekin "maktab uchun" tanlangan — fan keyin bo'limdan olinadi
    const school: SchoolMeta | undefined =
      picked.school ??
      (opts.source === 'school' ? { subject: null, grade: null } : undefined);

    // raw: Category modelida `name` class field — instance'da undefined bo'ladi
    const categories = (await this.categoryModel.findAll({
      attributes: ['id', 'name'],
      raw: true,
    })) as unknown as { id: number; name: string }[];
    const draft = await this.write(
      llm,
      sources,
      categories.map((c) => c.name),
      picked.query,
      school,
    );

    const title = normalize(draft.title ?? '').trim() || sources[0].title;
    const category =
      categories.find((c) => c.id === Number(picked.categoryId)) ??
      categories.find(
        (c) =>
          c.name.toLowerCase() === String(draft.category ?? '').toLowerCase(),
      ) ??
      categories[0];
    // Mavzu 18+ yoki qadriyatlarga zid bo'lsa (tekshiruvdan o'tib ketgan bo'lsa ham) — to'xtaymiz
    if (draft.familySafe === false) {
      throw new BadRequestException(
        'Mavzu sayt qoidalariga mos emas (18+ yoki Islom qadriyatlariga zid) — qoralama yozilmadi',
      );
    }
    const html = sanitizeHtml(draft.html ?? '');
    if (html.replace(/<[^>]+>/g, '').length < 1500) {
      throw new ServiceUnavailableException(
        "AI juda qisqa matn qaytardi. Qayta urinib ko'ring.",
      );
    }

    let slug = slugify(title);
    if (await this.articleModel.findOne({ where: { slug } })) {
      slug = `${slug}-${Date.now()}`;
    }
    // Muqova: erkin rasmlar orasidan AI tanlaydi (topilmasa — admin o'zi qo'yadi)
    const cover = await this.coverFor(
      llm,
      sources,
      draft,
      title,
      slug,
      category?.name,
    );

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
    if (cover) {
      const c = cover.cover;
      items.push(coverCredit(c));
    }
    // Ichki havolalar — Manbalar'dan oldin
    const related = await this.relatedLinks(
      llm,
      title,
      normalize(draft.excerpt ?? ''),
      category?.id,
    );
    const relatedHtml = related.length
      ? `\n<h2>Shuningdek o'qing</h2>\n<ul>${related
          .map(
            (r) =>
              `<li><a href="/articles/${encodeURIComponent(r.slug)}">${escapeHtml(r.title)}</a></li>`,
          )
          .join('')}</ul>`
      : '';
    const content = `${html}${relatedHtml}
<h2>Manbalar</h2>
<ul>${items.join('')}</ul>
<p><em>Maqola yuqoridagi manbalar asosida sun'iy intellekt yordamida tayyorlangan. Matn <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.uz" target="_blank" rel="noopener">CC BY-SA 4.0</a> litsenziyasi ostida tarqatiladi.</em></p>`;

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
      coverImage: cover?.url ?? null,
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
    // Seriya rejasidan navbatga qo'yilgan mavzu bo'lsa — o'z qismiga biriktiriladi
    await this.series.attachQueued(topic, article.id);
    if (school) {
      await this.school.mark(
        article.id,
        school.subject ?? category?.name ?? 'Umumiy',
        school.grade,
      );
    }
    this.logger.log(
      `AI qoralama yaratildi: ${slug} (${llm.name}; muqova: ${cover ? 'bor' : "yo'q"}; manbalar: ${used.map((u) => u.url).join(', ')})`,
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

  /**
   * Muqova: bir nechta erkin rasm bazasidan nomzodlar yig'iladi, Gemini ularni
   * ko'rib eng mos va chiroylisini tanlaydi. Tanlangan rasm 1600px gacha
   * kichraytirilib Cloudinary'ga yuklanadi.
   */
  /**
   * Mavjud maqolaning muqovasini xavfsiz tizim bilan qayta tanlaydi: eski rasm
   * darhol olib tashlanadi, yangisi topilsa qo'yiladi (Cloudinary'da o'sha
   * nom bilan — eski fayl ustidan yoziladi), "Manbalar"dagi muallif qatori
   * yangilanadi.
   */
  async regenerateCover(articleId: number) {
    const llm = this.getLlm();
    if (!llm) {
      throw new ServiceUnavailableException(
        'AI kaliti sozlanmagan (GEMINI_API_KEY yoki GROQ_API_KEY)',
      );
    }
    const article = (await this.articleModel.findByPk(articleId, {
      raw: true,
    })) as any;
    if (!article) throw new BadRequestException('Maqola topilmadi');

    // Avval eski rasmni olib qo'yamiz — yangisi topilmasa ham eskisi qolmasin
    await this.articleModel.update(
      { coverImage: null },
      { where: { id: articleId } },
    );

    // Rasm qidirish uchun inglizcha so'zlar va (topilsa) Wikipedia manbasi
    let imageQueries: string[] = [];
    try {
      const raw = await llm.json(
        `Maqola uchun muqova rasmi qidiramiz. Sarlavha va tavsifga qarab 2–3 ta INGLIZCHA qidiruv so'zi ber — aniq, ko'rinadigan obyekt, mavhum so'zlar emas. Javob faqat JSON: {"imageQueries": ["..."]}`,
        `Sarlavha: ${article.title}\nTavsif: ${article.excerpt ?? ''}\nTeglar: ${article.tags ?? ''}`,
      );
      const j = JSON.parse(
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
      );
      imageQueries = (Array.isArray(j?.imageQueries) ? j.imageQueries : [])
        .map((q: unknown) => String(q ?? '').trim())
        .filter(Boolean)
        .slice(0, 3);
    } catch {
      // so'zlarsiz ham Wikipedia manbasi orqali qidiriladi
    }
    const sources: Source[] = [];
    try {
      const w = await this.findTopic(article.title, 500, llm);
      sources.push({ kind: 'wikipedia', ...w });
    } catch {
      // Wikipedia'da topilmasa — faqat qidiruv so'zlari bilan
    }
    const category = article.categoryId
      ? ((await this.categoryModel.findByPk(article.categoryId, {
          attributes: ['name'],
          raw: true,
        })) as unknown as { name: string } | null)
      : null;

    const cover = await this.coverFor(
      llm,
      sources,
      { excerpt: article.excerpt, imageQueries },
      article.title,
      article.slug,
      category?.name,
    );
    await this.articleModel.update(
      { coverImage: cover?.url ?? null },
      { where: { id: articleId } },
    );

    // "Manbalar"dagi muqova qatorini yangilaymiz (eski muallif/havola qolmasin)
    if (article.content) {
      try {
        const res = await fetch(article.content, {
          signal: AbortSignal.timeout(15000),
        });
        const html = String(((await res.json()) as any)?.message ?? '');
        const withoutOld = html.replace(/<li>Muqova rasmi:[\s\S]*?<\/li>/g, '');
        const updated = cover
          ? withoutOld.includes('<h2>Manbalar</h2>')
            ? withoutOld.replace(
                /(<h2>Manbalar<\/h2>\s*<ul>[\s\S]*?)(<\/ul>)/,
                `$1${coverCredit(cover.cover)}$2`,
              )
            : withoutOld
          : withoutOld;
        if (updated !== html) {
          const url = await this.cloudflare.uploadJson(
            { message: updated },
            `${article.slug}-${Date.now()}.json`,
          );
          await this.articleModel.update(
            { content: url },
            { where: { id: articleId } },
          );
        }
      } catch (err: any) {
        this.logger.warn(
          `Manbalar yangilanmadi (${article.slug}): ${err?.message}`,
        );
      }
    }
    return {
      coverImage: cover?.url ?? null,
      cover: cover
        ? { title: cover.cover.title, provider: cover.cover.provider }
        : null,
    };
  }

  /**
   * Muqova — zinapoya bo'yicha, har bosqichda xavfsizlik tekshiruvi bilan:
   *  1) aniq rasm: maqola mavzusi (manba maqolalar rasmlari + qidiruv so'zlari);
   *  2) yaqin rasm: AI bergan kengroq mavzular (masalan, fir'avn → piramidalar);
   *  3) kategoriya rasmi: kategoriyaga mos umumiy fotolar (Tarix → xarobalar).
   * Shunda deyarli har doim xavfsiz va mavzuga yaqin rasm bo'ladi.
   */
  private async coverFor(
    llm: Llm,
    sources: Source[],
    draft: DraftJson,
    title: string,
    slug: string,
    categoryName?: string | null,
  ): Promise<{ url: string; cover: ImageCandidate } | null> {
    const tried = new Set<string>();
    const stages: {
      name: string;
      candidates: () => Promise<ImageCandidate[]>;
    }[] = [
      { name: 'aniq', candidates: () => this.imageCandidates(sources, draft) },
      {
        name: 'yaqin',
        candidates: async () =>
          this.queryCandidates(
            await this.broaderQueries(llm, title, draft.excerpt, categoryName),
          ),
      },
      {
        name: 'kategoriya',
        candidates: () => this.queryCandidates(categoryQueries(categoryName)),
      },
    ];
    for (const stage of stages) {
      try {
        const candidates = (await stage.candidates()).filter(
          (c) => !tried.has(c.imageUrl),
        );
        candidates.forEach((c) => tried.add(c.imageUrl));
        if (!candidates.length) continue;
        const cover = await this.tryCandidates(
          llm,
          candidates,
          title,
          draft,
          slug,
        );
        if (cover) {
          this.logger.log(
            `Muqova (${stage.name} bosqich): ${cover.cover.title}`,
          );
          return cover;
        }
      } catch (err: any) {
        this.logger.warn(
          `Muqova ${stage.name} bosqichida topilmadi (${slug}): ${err?.message}`,
        );
      }
    }
    return null;
  }

  /** Nomzodlarni AI bilan tartiblab, birinchi xavfsiz va yuklanadiganini qo'yadi */
  private async tryCandidates(
    llm: Llm,
    candidates: ImageCandidate[],
    title: string,
    draft: DraftJson,
    slug: string,
  ): Promise<{ url: string; cover: ImageCandidate } | null> {
    const order = await this.rankImages(llm, candidates, title, draft);
    for (const c of order) {
      try {
        let raw: Buffer | null = null;
        for (const u of [c.imageUrl, ...(c.altUrls ?? [])]) {
          raw = await downloadImage(u).catch(() => null);
          if (raw) break;
        }
        if (!raw) throw new Error('hech bir nusxa yuklanmadi');
        const img = sharp(raw, { failOn: 'none' }).rotate();
        const meta = await img.metadata();
        if ((meta.width ?? 0) < 900) continue;
        const jpeg = await img
          .resize({ width: 1600, withoutEnlargement: true })
          .jpeg({ quality: 85, mozjpeg: true })
          .toBuffer();
        // Yakuniy qavat: aynan yuklanadigan rasm yana bir bor tekshiriladi
        if (!(await this.imageIsSafe(llm, jpeg, c))) {
          this.logger.warn(
            `Muqova xavfsizlik tekshiruvidan o'tmadi: ${c.title}`,
          );
          continue;
        }
        const url = await this.cloudinary.uploadBuffer(
          jpeg,
          'bilim-manba/covers',
          slug.slice(0, 120),
        );
        return { url, cover: c };
      } catch (err: any) {
        this.logger.warn(`Muqova yuklanmadi (${c.imageUrl}): ${err?.message}`);
      }
    }
    return null;
  }

  /** Aniq rasm topilmasa: mavzuga yaqin, kengroq va ko'rinadigan narsalar */
  private async broaderQueries(
    llm: Llm,
    title: string,
    excerpt?: string | null,
    categoryName?: string | null,
  ): Promise<string[]> {
    try {
      const raw = await llm.json(
        `Maqola uchun muqova rasmi qidiryapmiz, lekin aniq mavzuga oid rasm topilmadi. KENGROQ, mavzuga yaqin va fotoda ko'rinadigan 3 ta INGLIZCHA qidiruv so'zi ber: davr, joy, muhit, kayfiyat yoki tegishli obyektlar (masalan, qadimgi Misr fir'avni → "egyptian pyramids desert", "hieroglyphs carved stone"; futbolchi → "football stadium night"). Odamlarning tanasiga urg'u beradigan so'zlar bo'lmasin. Javob faqat JSON: {"queries": ["..."]}`,
        `Sarlavha: ${title}\nTavsif: ${excerpt ?? ''}\nKategoriya: ${categoryName ?? ''}`,
      );
      const j = JSON.parse(
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
      );
      return (Array.isArray(j?.queries) ? j.queries : [])
        .map((q: unknown) => String(q ?? '').trim())
        .filter(Boolean)
        .slice(0, 3);
    } catch {
      return [];
    }
  }

  /**
   * Rasm hamma uchun (o'smirlar ham) mos ekanini Gemini qat'iy tekshiradi.
   * Javob bo'lmasa yoki xato bo'lsa — rasm ishlatilmaydi (shubhada — rasmsiz).
   * Rasmni ko'ra olmaydigan model bilan faqat Pexels/NASA rasmlariga ruxsat.
   */
  private async imageIsSafe(
    llm: Llm,
    jpeg: Buffer,
    c: ImageCandidate,
  ): Promise<boolean> {
    if (!llm.vision) return Boolean(c.trusted);
    try {
      const small = await sharp(jpeg)
        .resize({ width: 512, withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();
      const raw = await llm.vision(
        `Sen ta'lim saytining kontent xavfsizligi bo'yicha qat'iy moderatorisan. Sayt o'quvchilari orasida bolalar va o'smirlar ham bor. Rasmda quyidagilardan BIRORTASI bo'lsa — xavfli:
- har qanday yalang'ochlik, shu jumladan san'at asari, haykal, tarixiy yoki tibbiy rasm;
- ichki kiyim, cho'milish kiyimi yoki tanaga urg'u berilgan, shahvoniy ohangdagi suratlar;
- jinsiy mazmun yoki ishora;
- qon, jarohat, murda, zo'ravonlik, qiynoq, qatl;
- giyohvand moddalar, o'z-o'ziga zarar;
- spirtli ichimliklar (shisha, qadah, bar), qimor va kazino;
- sehr-jodu va okkult belgilari (shayton, pentagramma).
Shubha bo'lsa ham — xavfli deb belgila.
Javob faqat JSON: {"safe": true yoki false, "reason": "qisqa izoh"}`,
        `Rasm: ${c.title} — ${c.provider}`,
        [{ mime: 'image/jpeg', data: small.toString('base64') }],
      );
      const j = JSON.parse(
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
      );
      if (j?.safe !== true) {
        this.logger.warn(
          `Xavfli deb topildi: ${c.title} (${String(j?.reason ?? '').slice(0, 120)})`,
        );
      }
      return j?.safe === true;
    } catch (err: any) {
      this.logger.warn(
        `Xavfsizlik tekshiruvi bajarilmadi (${c.title}): ${err?.message}`,
      );
      return false;
    }
  }

  /** 1-bosqich: manba maqolalarining rasmlari + mavzu bo'yicha qidiruv */
  private async imageCandidates(
    sources: Source[],
    draft: DraftJson,
  ): Promise<ImageCandidate[]> {
    const wiki = sources.filter(
      (x): x is Extract<Source, { kind: 'wikipedia' }> =>
        x.kind === 'wikipedia',
    );
    const queries = [
      ...(draft.imageQueries ?? []).map((q) => String(q ?? '').trim()),
      wiki[0]?.title.replace(/\s*\(.*?\)\s*/g, ' ').trim() ?? '',
    ];
    const [byQuery, fromPages] = await Promise.all([
      this.queryCandidates(queries),
      wiki.length
        ? commonsCandidates(
            wiki[0].lang,
            wiki.map((w) => w.title),
          ).catch(() => [])
        : Promise.resolve([] as ImageCandidate[]),
    ]);
    // Pexels birinchi (queryCandidates tartibi), keyin manba maqolalarining rasmlari
    const pexels = byQuery.filter((c) => c.provider === 'Pexels');
    const rest = byQuery.filter((c) => c.provider !== 'Pexels');
    return this.dedupe([...pexels, ...fromPages, ...rest]).slice(0, 16);
  }

  /** Qidiruv so'zlari bo'yicha: Pexels (kaliti bo'lsa) → Openverse → NASA */
  private async queryCandidates(
    rawQueries: string[],
  ): Promise<ImageCandidate[]> {
    const queries = rawQueries
      .map((q) => String(q ?? '').trim())
      .filter(Boolean)
      .filter(
        (q, i, all) =>
          all.findIndex((x) => x.toLowerCase() === q.toLowerCase()) === i,
      )
      .slice(0, 3);
    if (!queries.length) return [];
    const pexelsKey = this.config.get<string>('PEXELS_API_KEY');
    const settled = await Promise.allSettled([
      ...(pexelsKey
        ? queries
            .slice(0, 2)
            .map((q, i) => pexelsCandidates(q, pexelsKey, i ? 3 : 6))
        : []),
      ...queries.map((q) => openverseCandidates(q, 3)),
      nasaCandidates(queries[0], 2),
    ]);
    return this.dedupe(
      settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
    ).slice(0, 16);
  }

  private dedupe(list: ImageCandidate[]) {
    const seen = new Set<string>();
    return list.filter((c) => {
      const key = c.imageUrl.split('?')[0];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Gemini nomzodlarning kichik nusxalarini ko'rib, eng mosini tanlaydi va
   * 18+/shok rasmlarni alohida belgilaydi (ular hech qachon tanlanmaydi).
   * Ko'ra olmaydigan model yoki xato bo'lsa — faqat ishonchli bazalar
   * (Pexels, NASA) qoladi: Commons/Openverse rasmlari tekshiruvsiz ishlatilmaydi.
   */
  private async rankImages(
    llm: Llm,
    candidates: ImageCandidate[],
    title: string,
    draft: DraftJson,
  ): Promise<ImageCandidate[]> {
    const trustedOnly = () => candidates.filter((c) => c.trusted);
    if (!llm.vision) return trustedOnly();
    try {
      const thumbs = await Promise.all(
        candidates.map(async (c) => {
          try {
            // Kichik nusxa bo'lmasa — kattasini olib o'zimiz kichraytiramiz
            const buf = await downloadImage(c.thumbUrl, 5_000_000).catch(() =>
              downloadImage(c.imageUrl, 15_000_000),
            );
            const small = await sharp(buf, { failOn: 'none' })
              .resize({ width: 384, withoutEnlargement: true })
              .jpeg({ quality: 70 })
              .toBuffer();
            return { c, data: small.toString('base64') };
          } catch {
            return null;
          }
        }),
      );
      const ok = thumbs.filter((t): t is { c: ImageCandidate; data: string } =>
        Boolean(t),
      );
      if (!ok.length) return [];
      const raw = await llm.vision(
        `Sen ilmiy-ommabop jurnalning foto-muharririsan. Maqola uchun muqova rasmini tanlaysan. Rasmlar tartib bilan berilgan (birinchisi 0-raqam).
AVVAL XAVFSIZLIK: sayt o'quvchilari orasida bolalar va o'smirlar bor. Quyidagilardan birortasi bo'lgan rasmlarni "unsafe" ro'yxatiga yoz va hech qachon tanlama: har qanday yalang'ochlik (san'at asari, haykal, tarixiy yoki tibbiy rasm bo'lsa ham); ichki kiyim, cho'milish kiyimi yoki tanaga urg'u berilgan, shahvoniy ohangdagi suratlar; jinsiy mazmun yoki ishora; qon, jarohat, murda, zo'ravonlik, qatl; giyohvand moddalar; spirtli ichimliklar (shisha, qadah, bar), qimor va kazino; sehr-jodu va okkult belgilari (shayton, pentagramma). Shubha bo'lsa ham — unsafe.
Keyin qolganlaridan tanla. Talablar: maqola mavzusiga aniq aloqador; sifatli, chiroyli, ko'zni tortadigan; gorizontal kompozitsiya; ustida matn, vatermark, logotip, ramka bo'lmasin; kolaj, jadval, sxema yoki xarita bo'lmasin (agar mavzu aynan shuni talab qilmasa).
Pexels rasmlari professional fotograflarning ishlari — mavzuga mos bo'lsa, ularni birinchi navbatda tanla; Pexels'da mosi bo'lmasa, boshqalaridan tanla.
Eng yaxshisidan boshlab eng ko'pi 4 ta rasm raqamini qaytar. Aniq mos rasm bo'lmasa ham, mavzuga eng yaqin yoki uning kayfiyatini beradigan xavfsiz rasmlarni tartib bilan ber. Faqat hammasi xavfli yoki mavzuga mutlaqo aloqasiz bo'lsa — bo'sh ro'yxat.
Javob faqat JSON: {"unsafe": [n, ...], "ranking": [n, ...], "reason": "qisqa izoh"}`,
        `Maqola sarlavhasi: ${title}\nTavsif: ${draft.excerpt ?? ''}\n\nRasmlar: ${ok
          .map((t, i) => `${i}) ${t.c.title} — ${t.c.provider}`)
          .join('; ')}`,
        ok.map((t) => ({ mime: 'image/jpeg', data: t.data })),
      );
      const j = JSON.parse(
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
      );
      const unsafe = new Set<number>(
        (Array.isArray(j?.unsafe) ? j.unsafe : []).map(Number),
      );
      const picked: ImageCandidate[] = (
        Array.isArray(j?.ranking) ? j.ranking : []
      )
        .map(Number)
        .filter((n: number) => !unsafe.has(n))
        .map((n: number) => ok[n]?.c)
        .filter((c: ImageCandidate | undefined): c is ImageCandidate =>
          Boolean(c),
        );
      this.logger.log(
        `Muqova tanlandi: ${picked[0]?.title ?? "yo'q"} (${ok.length} ta nomzoddan, ${unsafe.size} tasi xavfli; ${String(j?.reason ?? '').slice(0, 120)})`,
      );
      // AI hech birini mos topmadi — muqovasiz qoldiramiz (admin o'zi qo'yadi)
      return picked;
    } catch (err: any) {
      this.logger.warn(`Rasmni AI tanlay olmadi: ${err?.message}`);
      return trustedOnly();
    }
  }

  /**
   * Saytdagi eng ko'p o'qilgan (AI yozmagan) maqoladan 2500 belgilik parcha —
   * AI ohang va uslubni shundan oladi. 12 soat keshda turadi.
   */
  private async styleSample(): Promise<string> {
    if (this.styleCache && Date.now() - this.styleCache.at < 12 * 3600 * 1000) {
      return this.styleCache.text;
    }
    let text = '';
    try {
      const top = (await this.articleModel.findOne({
        where: {
          status: ArticleStatus.PUBLISHED,
          content: { [Op.ne]: null },
          [Op.or]: [
            { source: { [Op.is]: null } },
            { source: { [Op.notIn]: [AI_SOURCE, LEGACY_AI_SOURCE] } },
          ],
        },
        order: [['viewCount', 'DESC']],
        attributes: ['content'],
        raw: true,
      })) as unknown as { content: string } | null;
      if (top?.content) {
        const res = await fetch(top.content, {
          signal: AbortSignal.timeout(15000),
        });
        const j: any = await res.json();
        text = String(j?.message ?? '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 2500);
      }
    } catch (err: any) {
      this.logger.warn(`Uslub namunasi olinmadi: ${err?.message}`);
    }
    this.styleCache = { at: Date.now(), text };
    return text;
  }

  private async callJson(
    llm: Llm,
    system: string,
    user: string,
    stage: string,
  ): Promise<DraftJson> {
    try {
      const raw = await llm.json(system, user);
      const json = JSON.parse(
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
      );
      if (!json?.html) throw new Error("JSON'da html yo'q");
      return json as DraftJson;
    } catch (err: any) {
      this.logger.error(`AI ${stage} xatosi (${llm.name}): ${err?.message}`);
      throw new ServiceUnavailableException(
        `AI maqola yoza olmadi: ${String(err?.message ?? '').slice(0, 200)}`,
      );
    }
  }

  /**
   * 1-bosqich: muallif manbalardan maqola yozadi.
   * 2-bosqich (katta modelda): bosh muharrir faktlarni manbalarga solishtiradi,
   * tilni silliqlaydi va o'qishlilikni oshiradi. Muharrir xato bersa —
   * muallif varianti qoladi.
   */
  private async write(
    llm: Llm,
    sources: Source[],
    categories: string[],
    /** Google'dagi qidiruv so'rovi — maqola aynan shunga javob bersin */
    query?: string,
    /** Maktab o'quvchilari uchun (fan, sinf, darslikdagi mavzu nomi) */
    school?: SchoolMeta,
  ): Promise<DraftJson> {
    const big = llm.sourceBudget >= 20000;
    const style = big ? await this.styleSample() : '';
    const seo = query
      ? `
Qidiruv maqsadi: odamlar Google'da "${query}" deb qidirmoqda — maqola shu so'rovga eng yaxshi javob bo'lsin. So'rovga aniq javobni dastlabki 2 paragrafda ber; so'rovni (yoki uning tabiiy o'zbekcha shaklini) sarlavhada, kirishda va kamida bitta <h2> da tabiiy ishlat. So'zni sun'iy takrorlama.
`
      : '';
    const student = school
      ? `
O'quvchilar uchun: bu maqola maktab o'quvchilari${school.grade ? ` (taxminan ${school.grade}-sinf)` : ''} uchun${school.title ? ` — darslikdagi "${school.title}" mavzusini tushunishga yordam bersin` : ''}.
- Sodda va aniq til; har bir atamani birinchi ishlatganda izohla; uzun murakkab gaplardan qoch.
- Darslikdagi asosiy tushunchalar, ta'riflar va muhim sanalar/qonunlarni qamrab ol; misollar o'quvchi hayotidan bo'lsin.
- Sarlavhada mavzu nomini${school.title ? ` ("${school.title}")` : ''} tabiiy ishlat — o'quvchi Google'dan shu nom bilan qidiradi.
- Xulosadan keyin <h2>Asosiy fikrlar</h2> va <ul> ichida 4–6 ta qisqa punkt: o'quvchi esda saqlashi kerak bo'lgan eng muhim faktlar.
`
      : '';

    const writer = `Sen Bilim Manba (bilimmanba.uz) — o'zbek tilidagi ilmiy-ommabop jurnalning eng yaxshi muallifisan. Uslubing Quanta Magazine, Kurzgesagt kabi: jonli, aniq, o'quvchini oxirigacha olib boradigan.
Senga bir mavzu bo'yicha bir nechta raqamlangan manba beriladi: Wikipedia maqolalari va (bo'lsa) arXiv'dagi yangi ilmiy ishlarning annotatsiyalari. Ulardagi faktlarni birlashtirib, o'zbek o'quvchisi uchun yangi, o'z so'zlaring bilan yozilgan bitta yaxlit maqola tayyorla.

Uslub va tuzilish:
- Qiziqarli "ilgak" bilan boshla: savol, kutilmagan fakt yoki kichik voqea. Keyin mavzu nega muhimligini ayt.
- Murakkab tushunchalarni kundalik hayotdan olingan misol va taqqoslash bilan tushuntir (imkon bo'lsa, o'zbek o'quvchisiga tanish misollar). Atamani birinchi ishlatganda qisqa izohla.
- Manbalarni gapma-gap tarjima qilma va birorta manbaning tuzilishini takrorlama — tuzilishni o'zing qur.
- Har bir bo'lim yangi narsa bersin; suv, takror va bo'sh umumiy gaplar bo'lmasin.
- arXiv ishlari mavzuga aloqador bo'lsa, oxirroqda "So'nggi tadqiqotlar" ruhida qo'sh: nimani o'rganishgan, nima topishgan, nega qiziq — oddiy tilda. Ular hali taqrizdan o'tmagan preprint ekanini bir og'iz eslat. Aloqasiz bo'lsa, umuman ishlatma.
- Kuchli xulosa bilan tugat: o'quvchi o'ylab qoladigan fikr yoki ochiq savol.

Aniqlik:
- Faqat manbalardagi faktlarga tayan. Manbada yo'q raqam, sana, ism yoki iqtibos to'qima. Ishonchsiz bo'lsang, umumiyroq yoz.

${UZ_RULES}

${VALUES_RULES}
${
  style
    ? `
Saytimizdagi o'quvchilar yoqtirgan maqoladan parcha — undan faqat ohang va uslubni ol, mazmunini ishlatma:
"""${style}"""
`
    : ''
}${seo}${student}
${FORMAT_RULES(categories)}`;

    const user = sources
      .map((src, i) =>
        src.kind === 'wikipedia'
          ? `[${i + 1}] Wikipedia (${src.lang}) — "${src.title}"\n${src.text}`
          : `[${i + 1}] arXiv ilmiy ishi (${src.published}; ${src.authors.slice(0, 3).join(', ')}) — "${src.title}"\nAnnotatsiya: ${src.summary}`,
      )
      .join('\n\n---\n\n');

    const draft = await this.callJson(llm, writer, user, 'yozish');
    if (!big) return draft;

    const editor = `Sen Bilim Manba jurnalining bosh muharririsan va o'zbek tili bo'yicha mutaxassissan. Senga manbalar va muallif yozgan qoralama (JSON) beriladi. Vazifang — uni nashrga tayyor, eng yuqori sifatli holga keltirish:
1. Faktlarni tekshir: manbalarda tasdiqlanmagan yoki noto'g'ri raqam, sana, ism va da'volarni tuzat yoki olib tashla.
2. Tilni silliqla: har bir gapni quyidagi qoidalar bo'yicha ko'rib chiq; g'aliz va tarjima ohangidagi jumlalarni tabiiy o'zbekchaga o'gir; imlo va tinish belgilari xatolarini tuzat.
3. O'qishlilik: ilgakni kuchaytir; takror, suv va bo'sh umumiy gaplarni olib tashla; misollar aniq va esda qoladigan bo'lsin; bo'limlar mantiqan ulansin; xulosa kuchli bo'lsin.
4. Sarlavha va tavsifni yanada qiziqarli, lekin halol qil.
5. Hajm va tuzilishni saqla (900–1400 so'z); maqolani qisqartirib yuborma.

${UZ_RULES}

${VALUES_RULES}
6. Sayt qadriyatlariga zid jumla yoki tafsilot bo'lsa — olib tashla yoki betaraf qilib qayta yoz.
${seo}${student}
${FORMAT_RULES(categories)}
To'liq yaxshilangan versiyani qaytar (faqat o'zgargan joylarni emas).`;

    try {
      const revised = await this.callJson(
        llm,
        editor,
        `MANBALAR:\n\n${user}\n\n=====\n\nQORALAMA (JSON):\n${JSON.stringify(draft)}`,
        'tahrir',
      );
      // Muharrir maqolani keskin qisqartirib yuborgan bo'lsa — muallif varianti
      if (plainLength(revised.html) < plainLength(draft.html) * 0.7) {
        this.logger.warn(
          'Muharrir matnni juda qisqartirdi — muallif varianti olindi',
        );
        return draft;
      }
      return {
        ...draft,
        ...revised,
        sources: revised.sources ?? draft.sources,
      };
    } catch {
      return draft;
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
        const msg = `Ko'rib chiqilmagan ${MAX_PENDING} ta AI qoralama bor — yangisi yozilmadi`;
        await this.setSetting('ai_last_error', msg);
        await this.alerts.draftSkipped(
          `${msg}. Ulardan birini chop eting yoki o'chiring — ertaga yana yoziladi.`,
        );
        return 'skipped';
      }

      // Oldingi seriya tugagan bo'lsa — vaqti kelganda yangisi navbatga qo'yiladi
      try {
        await this.maybeAutoSeries();
      } catch (err: any) {
        this.logger.warn(`Avtomatik seriya: ${err?.message}`);
      }
      const topics = await this.getTopics();
      const topic = topics[0];
      // Navbat bo'sh: kunma-kun navbat bilan — Google qidiruv talabi → maktab
      // mavzusi → bo'limlar navbati
      let source: DraftSource | undefined;
      if (!topic) {
        const cur = await this.getSetting('ai_next_source');
        const now: 'search' | 'school' | 'rotation' =
          cur === 'school' || cur === 'rotation' ? cur : 'search';
        source = now === 'rotation' ? undefined : now;
        await this.setSetting(
          'ai_next_source',
          now === 'search'
            ? 'school'
            : now === 'school'
              ? 'rotation'
              : 'search',
        );
      }
      try {
        let article: Article;
        try {
          article = await this.generate({ topic, source });
        } catch (err) {
          // Qidiruvda yoki maktab navbatida mavzu bo'lmasa — bugun bo'limlar navbatidan
          if (
            !(err instanceof NoDemandTopicError) &&
            !(err instanceof NoSchoolTopicError)
          )
            throw err;
          article = await this.generate({});
        }
        await this.alerts.draftReady(article, true);
        if (topic) await this.removeTopic(topic);
        await this.setSetting('ai_last_error', '');
        return 'done';
      } catch (err: any) {
        await this.setSetting(
          'ai_last_error',
          `${today}: ${topic ? `"${topic}" — ` : ''}${err?.message ?? 'xato'}`,
        );
        await this.alerts.draftFailed(
          String(err?.message ?? 'xato'),
          topic,
          true,
        );
        // Topilmagan mavzu navbatni to'sib qo'ymasin
        if (topic && err instanceof BadRequestException) {
          await this.removeTopic(topic);
        }
        return 'failed';
      }
    } finally {
      this.dailyRunning = false;
    }
  }
}
