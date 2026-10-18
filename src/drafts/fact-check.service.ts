import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { quizText } from '../quiz/quiz.service';
import { createLlm, Llm } from './llm';

export interface FactIssue {
  /** Maqoladan aynan ko'chirilgan parcha (admin sahifasida belgilanadi) */
  quote: string;
  /** 'zid' — manbaga zid; 'tasdiqlanmagan' — manbalarda yo'q */
  type: 'zid' | 'tasdiqlanmagan';
  /** Nega shubhali — qisqa izoh */
  note: string;
  /** Manbaga ko'ra to'g'ri varianti (bo'lsa) */
  fix?: string;
}

export type FactState = 'none' | 'running' | 'done' | 'failed';

const MAX_ISSUES = 8;
const ARTICLE_MAX = 16000;
const SOURCES_MAX = 40000;

const clean = (s: unknown, max: number) =>
  String(s ?? '')
    .replace(/[‘’ʻʼ`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** AI javobini tekshiradi: faqat maqolada haqiqatan bor parchalar qoladi */
export function normalizeIssues(
  raw: unknown,
  articleText: string,
): FactIssue[] {
  const list = Array.isArray((raw as any)?.issues) ? (raw as any).issues : [];
  const text = clean(articleText, 1e6).toLowerCase();
  const seen = new Set<string>();
  const out: FactIssue[] = [];
  for (const it of list) {
    const quote = clean(it?.quote, 300).replace(/^["'«]+|["'»]+$/g, '');
    const note = clean(it?.note, 400);
    if (quote.length < 8 || !note) continue;
    const key = quote.toLowerCase();
    // AI parchani "to'qib" yuborgan bo'lsa (maqolada yo'q) — tashlanadi
    if (!text.includes(key) || seen.has(key)) continue;
    seen.add(key);
    const fix = clean(it?.fix, 300);
    out.push({
      quote,
      type: it?.type === 'zid' ? 'zid' : 'tasdiqlanmagan',
      note,
      ...(fix ? { fix } : {}),
    });
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

const SYSTEM = `Sen ilmiy-ommabop jurnalda faktlarni tekshiruvchi muharrirsan. Senga MANBALAR va ular asosida yozilgan o'zbekcha MAQOLA beriladi.
Vazifang: maqoladagi aniq da'volarni — raqamlar, sanalar, ismlar, joy nomlari, iqtiboslar, "birinchi/eng katta" kabi da'volar va ilmiy xulosalarni — manbalar bilan solishtirish.
Faqat quyidagilarni ro'yxatga ol:
- "zid": manbadagi ma'lumotga zid (masalan, boshqa yil, boshqa raqam, boshqa odam);
- "tasdiqlanmagan": aniq fakt, lekin manbalarda umuman yo'q (AI o'zidan qo'shgan bo'lishi mumkin).
Belgilama: umumma'lum va shubhasiz faktlar (masalan, "Yer Quyosh atrofida aylanadi"), fikr va baholar, uslub va til xatolari, manbadagi faktni boshqa so'zlar bilan aytish.
Har biri uchun:
- quote — maqoladan AYNAN, harfma-harf ko'chirilgan qisqa parcha (5–25 so'z), o'zgartirmasdan;
- type — "zid" yoki "tasdiqlanmagan";
- note — nega shubhali, o'zbekcha bitta gap;
- fix — manbaga ko'ra to'g'ri varianti (bo'lsa; bo'lmasa bo'sh qoldir).
Ko'pi bilan ${MAX_ISSUES} ta, eng muhimlari birinchi. Hammasi manbalarga mos bo'lsa — bo'sh ro'yxat qaytar.
Javob faqat JSON: {"issues": [{"quote": "...", "type": "zid", "note": "...", "fix": "..."}]}`;

/**
 * AI qoralamalarni fakt-tekshiruvi: qoralama yozilgach maqola manbalar bilan
 * solishtiriladi, shubhali joylar fact_checks jadvaliga yoziladi. Admin
 * ko'rish sahifasida ular ro'yxat va matnda sariq belgi bo'lib chiqadi.
 * Manbalar matni ham saqlanadi — admin tahrirlagach "Qayta tekshirish" mumkin.
 */
@Injectable()
export class FactCheckService {
  private readonly logger = new Logger(FactCheckService.name);
  /** Testlar uchun: soxta model */
  llmOverride?: Llm;
  private running = new Set<number>();

  constructor(
    private readonly config: ConfigService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

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

  private async save(
    articleId: number,
    state: FactState,
    issues: FactIssue[] | null,
    sources: string | null,
    error: string | null,
  ) {
    await this.sequelize.query(
      `INSERT INTO fact_checks ("articleId", state, issues, sources, error, "checkedAt")
       VALUES (:id, :state, :issues, :sources, :error, now())
       ON CONFLICT ("articleId") DO UPDATE SET state = EXCLUDED.state,
         issues = EXCLUDED.issues, error = EXCLUDED.error, "checkedAt" = now(),
         sources = COALESCE(EXCLUDED.sources, fact_checks.sources)`,
      {
        replacements: {
          id: articleId,
          state,
          issues: issues ? JSON.stringify(issues) : null,
          sources,
          error,
        },
      },
    );
  }

  /**
   * Maqolani manbalar bilan solishtiradi va natijani saqlaydi.
   * Xato bo'lsa — null (qoralama baribir tayyor, admin o'zi o'qiydi).
   */
  async check(
    articleId: number,
    html: string,
    sources: string,
  ): Promise<FactIssue[] | null> {
    const llm = this.getLlm();
    if (!llm || !sources.trim()) return null;
    const text = quizText(html, ARTICLE_MAX);
    const src = sources.slice(0, SOURCES_MAX);
    this.running.add(articleId);
    try {
      const raw = await llm.json(
        SYSTEM,
        `MANBALAR:\n\n${src}\n\n=====\n\nMAQOLA:\n\n${text}`,
      );
      const json = JSON.parse(
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
      );
      const issues = normalizeIssues(json, text);
      await this.save(articleId, 'done', issues, src, null);
      this.logger.log(
        `Fakt-tekshiruv (${articleId}): ${issues.length} ta shubhali joy`,
      );
      return issues;
    } catch (err: any) {
      const msg = String(err?.message ?? err).slice(0, 300);
      this.logger.warn(`Fakt-tekshiruv bo'lmadi (${articleId}): ${msg}`);
      await this.save(articleId, 'failed', null, src, msg).catch(() => {});
      return null;
    } finally {
      this.running.delete(articleId);
    }
  }

  /** Admin: holat va shubhali joylar */
  async get(articleId: number) {
    if (this.running.has(articleId))
      return { state: 'running' as FactState, issues: [], canRecheck: false };
    const [row] = await this.sequelize.query<{
      state: FactState;
      issues: FactIssue[] | string | null;
      error: string | null;
      checkedAt: string;
      hasSources: boolean;
    }>(
      `SELECT state, issues, error, "checkedAt", (sources IS NOT NULL AND sources <> '') AS "hasSources"
       FROM fact_checks WHERE "articleId" = :id`,
      { replacements: { id: articleId }, type: QueryTypes.SELECT },
    );
    if (!row)
      return { state: 'none' as FactState, issues: [], canRecheck: false };
    const issues =
      typeof row.issues === 'string' ? JSON.parse(row.issues) : row.issues;
    return {
      state: row.state,
      issues: Array.isArray(issues) ? issues : [],
      error: row.error,
      checkedAt: row.checkedAt,
      canRecheck: Boolean(row.hasSources),
    };
  }

  /** Telegram xabari uchun: shubhali joylar soni (tekshirilmagan bo'lsa — null) */
  async count(articleId: number): Promise<number | null> {
    const r = await this.get(articleId).catch(() => null);
    return r?.state === 'done' ? r.issues.length : null;
  }

  /**
   * Admin tahrirlagach qayta tekshirish: joriy matn (R2'dan) + saqlangan
   * manbalar. Fonda ishlaydi — natija get() orqali olinadi.
   */
  async recheck(articleId: number, contentUrl: string | null | undefined) {
    if (this.running.has(articleId)) return this.get(articleId);
    const [row] = await this.sequelize.query<{ sources: string | null }>(
      'SELECT sources FROM fact_checks WHERE "articleId" = :id',
      { replacements: { id: articleId }, type: QueryTypes.SELECT },
    );
    if (!row?.sources)
      throw new NotFoundException(
        "Bu maqola uchun manbalar saqlanmagan — faqat AI qoralamalarini tekshirsa bo'ladi",
      );
    if (!contentUrl) throw new NotFoundException('Maqola matni topilmadi');
    const res = await fetch(contentUrl, { signal: AbortSignal.timeout(20000) });
    const html = String(((await res.json()) as any)?.message ?? '');
    this.running.add(articleId);
    void this.check(articleId, html, row.sources);
    return { state: 'running' as FactState, issues: [], canRecheck: false };
  }
}
