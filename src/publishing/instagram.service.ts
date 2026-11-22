import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/sequelize';
import { createHash } from 'crypto';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';

const GRAPH_IG = 'https://graph.instagram.com';
const GRAPH_FB = 'https://graph.facebook.com';
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
 * Instagram API orqali post va story. Ikki xil ulanishni qo'llaydi —
 * qaysi biri ekanini token o'zi aytadi:
 *
 *  - Instagram Login (token "IG..." bilan boshlanadi), graph.instagram.com.
 *    Facebook sahifa kerak emas. Token 60 kun yashaydi — haftada bir
 *    avtomatik yangilanadi.
 *  - Facebook Login (token "EAA..." bilan boshlanadi), graph.facebook.com.
 *    Instagram Professional akkaunt Facebook sahifaga ulangan bo'lishi kerak.
 *    Env'ga uzoq muddatli foydalanuvchi tokeni qo'yiladi; undan sahifa tokeni
 *    olinadi (u muddatsiz) va Instagram akkaunt IDsi topiladi.
 *
 * Env (Render): INSTAGRAM_ACCESS_TOKEN. Amaldagi token app_settings jadvalida
 * saqlanadi; env'ga yangi token qo'yilsa — avtomatik o'shanga o'tadi.
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
    return (this.config.get<string>('INSTAGRAM_ACCESS_TOKEN') ?? '').trim();
  }

  private get version() {
    return this.config.get<string>('INSTAGRAM_API_VERSION') ?? 'v23.0';
  }

  get configured(): boolean {
    return Boolean(this.envToken);
  }

  /** Facebook Login tokenlari "EAA" bilan boshlanadi */
  private get viaFacebook(): boolean {
    return this.envToken.startsWith('EAA');
  }

  private get graph() {
    return this.viaFacebook ? GRAPH_FB : GRAPH_IG;
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

  private async getJson(url: string) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
    }
    return json;
  }

  /**
   * Facebook Login: env tokenidan Instagram akkaunt ulangan sahifani topadi.
   * Foydalanuvchi tokeni bo'lsa — sahifa tokeni olinadi (uzoq muddatli
   * foydalanuvchi tokenidan olingan sahifa tokeni muddatsiz bo'ladi).
   * Env'da sahifa tokeni bo'lsa — o'zi ishlatiladi.
   */
  private async resolveFacebook(
    env: string,
  ): Promise<{ token: string; igId: string }> {
    const base = `${GRAPH_FB}/${this.version}`;
    const t = encodeURIComponent(env);
    try {
      const pages = await this.getJson(
        `${base}/me/accounts?fields=name,access_token,instagram_business_account&limit=100&access_token=${t}`,
      );
      const page = (pages.data ?? []).find(
        (p: any) => p.instagram_business_account?.id,
      );
      if (page) {
        this.logger.log(
          `Instagram Facebook sahifa orqali ulandi: ${page.name}`,
        );
        return {
          token: page.access_token ?? env,
          igId: String(page.instagram_business_account.id),
        };
      }
    } catch {
      // Sahifa tokenida /me/accounts ishlamaydi — pastda sahifaning o'zini so'raymiz
    }
    const me = await this.getJson(
      `${base}/me?fields=name,instagram_business_account&access_token=${t}`,
    );
    if (me.instagram_business_account?.id) {
      return { token: env, igId: String(me.instagram_business_account.id) };
    }
    throw new Error(
      'Facebook sahifaga ulangan Instagram Professional akkaunt topilmadi (token ruxsatlari: instagram_basic, instagram_content_publish, pages_show_list, pages_read_engagement, business_management)',
    );
  }

  /** Amaldagi token: bazadagi yangilangani, env o'zgargan bo'lsa — env'dagisi */
  private async token(): Promise<string> {
    const env = this.envToken;
    const stored = await this.getSetting('instagram_token');
    const source = await this.getSetting('instagram_token_env');
    if (stored && source?.value === this.fingerprint(env)) return stored.value;

    this.userId = undefined;
    let token = env;
    if (this.viaFacebook) {
      const r = await this.resolveFacebook(env);
      token = r.token;
      await this.setSetting('instagram_user_id', r.igId);
    }
    await this.setSetting('instagram_token', token);
    await this.setSetting('instagram_token_env', this.fingerprint(env));
    return token;
  }

  /** Token eskirmasin: haftada bir yangilanadi (tokendan 24 soat o'tgan bo'lishi kerak) */
  async refreshTokenIfNeeded(): Promise<void> {
    if (!this.configured) return;
    try {
      const current = await this.token();
      // Facebook sahifa tokeni muddatsiz — yangilash shart emas
      if (this.viaFacebook) return;
      const row = await this.getSetting('instagram_token');
      if (
        row &&
        Date.now() - new Date(row.updatedAt).getTime() < REFRESH_EVERY_MS
      )
        return;
      const json = await this.getJson(
        `${GRAPH_IG}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(current)}`,
      );
      if (!json.access_token) throw new Error("access_token yo'q");
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
    const url = `${this.graph}/${this.version}/${path}`;
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
      if (this.viaFacebook) {
        await this.token();
        const row = await this.getSetting('instagram_user_id');
        if (!row?.value) throw new Error('Instagram akkaunt IDsi topilmadi');
        this.userId = row.value;
      } else {
        const me = await this.api('GET', 'me', { fields: 'user_id,username' });
        this.userId = String(me.user_id ?? me.id);
      }
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
