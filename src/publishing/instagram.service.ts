import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/sequelize';
import { createHash } from 'crypto';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';

const GRAPH = 'https://graph.instagram.com';
const CAPTION_LIMIT = 2200;
const HASHTAG_LIMIT = 30;
// Uzoq muddatli token 60 kun yashaydi — haftada bir yangilaymiz
const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

export interface InstagramArticle {
  title: string;
  excerpt?: string | null;
  tags?: string | null;
  category?: { name?: string } | null;
}

/**
 * Instagram API (Instagram Login, graph.instagram.com) orqali post va story.
 * Facebook sahifasi kerak emas — Professional (Creator/Business) akkaunt yetadi.
 *
 * Env (Render): INSTAGRAM_ACCESS_TOKEN — Meta dasturchi panelidagi
 * "Generate token" bergan uzoq muddatli token (60 kun).
 * Token haftada bir avtomatik yangilanadi va app_settings jadvalida saqlanadi,
 * shuning uchun env'dagi eski token muddati o'tib ketsa ham ishlayveradi.
 * Env'ga yangi token qo'yilsa — avtomatik o'shanga o'tadi.
 */
@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);
  private userId?: string;

  constructor(
    private readonly config: ConfigService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  private get envToken() {
    return this.config.get<string>('INSTAGRAM_ACCESS_TOKEN') ?? '';
  }

  private get version() {
    return this.config.get<string>('INSTAGRAM_API_VERSION') ?? 'v23.0';
  }

  get configured(): boolean {
    return Boolean(this.envToken);
  }

  private fingerprint(t: string) {
    return createHash('sha256').update(t).digest('hex').slice(0, 16);
  }

  private async getSetting(
    key: string,
  ): Promise<{ value: string; updatedAt: Date } | null> {
    const rows = await this.sequelize.query<{ value: string; updatedAt: Date }>(
      'SELECT value, "updatedAt" FROM app_settings WHERE key = :key',
      { replacements: { key }, type: QueryTypes.SELECT },
    );
    return rows[0] ?? null;
  }

  private async setSetting(key: string, value: string) {
    await this.sequelize.query(
      `INSERT INTO app_settings (key, value, "updatedAt") VALUES (:key, :value, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
      { replacements: { key, value } },
    );
  }

  /** Amaldagi token: bazadagi yangilangani, env o'zgargan bo'lsa — env'dagisi */
  private async token(): Promise<string> {
    const env = this.envToken;
    const stored = await this.getSetting('instagram_token');
    const source = await this.getSetting('instagram_token_env');
    if (!stored || source?.value !== this.fingerprint(env)) {
      await this.setSetting('instagram_token', env);
      await this.setSetting('instagram_token_env', this.fingerprint(env));
      this.userId = undefined;
      return env;
    }
    return stored.value;
  }

  /** Token eskirmasin: haftada bir yangilanadi (tokendan 24 soat o'tgan bo'lishi kerak) */
  async refreshTokenIfNeeded(): Promise<void> {
    if (!this.configured) return;
    try {
      const current = await this.token();
      const row = await this.getSetting('instagram_token');
      if (
        row &&
        Date.now() - new Date(row.updatedAt).getTime() < REFRESH_EVERY_MS
      )
        return;
      const url = `${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(current)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok || !json.access_token) {
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      }
      await this.setSetting('instagram_token', json.access_token);
      this.logger.log(
        `Instagram tokeni yangilandi (${Math.round((json.expires_in ?? 0) / 86400)} kun)`,
      );
    } catch (err: any) {
      this.logger.error(
        `Instagram tokenini yangilab bo'lmadi: ${err?.message}`,
      );
    }
  }

  private async api(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string> = {},
  ) {
    const token = await this.token();
    const qs = new URLSearchParams({ ...params, access_token: token });
    const url = `${GRAPH}/${this.version}/${path}`;
    const res = await fetch(method === 'GET' ? `${url}?${qs}` : url, {
      method,
      ...(method === 'POST' ? { body: qs } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      throw new Error(
        `Instagram ${path}: ${json?.error?.message ?? res.status}`,
      );
    }
    return json;
  }

  private async igUserId(): Promise<string> {
    if (!this.userId) {
      const me = await this.api('GET', 'me', { fields: 'user_id,username' });
      this.userId = String(me.user_id ?? me.id);
    }
    return this.userId;
  }

  buildCaption(a: InstagramArticle): string {
    const clean = (s?: string | null) =>
      String(s ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    const tag = (s: string) =>
      s
        .replace(/['ʻʼ‘’`]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '')
        .toLowerCase();

    const tags = [
      'bilimmanba',
      a.category?.name ? tag(a.category.name) : '',
      ...String(a.tags ?? '')
        .split(',')
        .map((t) => tag(t.trim())),
      'ilm',
      'bilim',
    ].filter((t, i, all) => t.length > 1 && all.indexOf(t) === i);

    const tail = [
      "📖 To'liq maqola — profildagi havolada: bilimmanba.uz",
      tags
        .slice(0, HASHTAG_LIMIT)
        .map((t) => `#${t}`)
        .join(' '),
    ].join('\n\n');

    let body = [clean(a.title), clean(a.excerpt)].filter(Boolean).join('\n\n');
    const room = CAPTION_LIMIT - tail.length - 2;
    if (body.length > room)
      body = body.slice(0, room - 1).replace(/\s+\S*$/, '') + '…';
    return `${body}\n\n${tail}`;
  }

  /** Konteyner tayyor bo'lishini kutadi (rasmni Instagram o'zi yuklab oladi) */
  private async waitReady(containerId: string) {
    for (let i = 0; i < 15; i++) {
      const s = await this.api('GET', containerId, { fields: 'status_code' });
      if (s.status_code === 'FINISHED') return;
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
        throw new Error(`Instagram rasmni qabul qilmadi (${s.status_code})`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('Instagram rasmni tayyorlashga ulgurmadi');
  }

  /** JPEG manzilidan post (caption bilan) yoki story chiqaradi. Media ID qaytaradi. */
  async publishImage(
    imageUrl: string,
    opts: { caption?: string; story?: boolean },
  ) {
    const ig = await this.igUserId();
    const params: Record<string, string> = { image_url: imageUrl };
    if (opts.story) params.media_type = 'STORIES';
    else if (opts.caption) params.caption = opts.caption;

    const container = await this.api('POST', `${ig}/media`, params);
    await this.waitReady(container.id);
    const published = await this.api('POST', `${ig}/media_publish`, {
      creation_id: container.id,
    });
    return String(published.id);
  }
}
