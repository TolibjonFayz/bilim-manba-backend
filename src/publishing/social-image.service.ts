import { Injectable } from '@nestjs/common';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import satori from 'satori';
import sharp from 'sharp';

export interface SocialArticle {
  title: string;
  excerpt?: string | null;
  coverImage?: string | null;
  category?: { name?: string } | null;
}

export type SocialFormat = 'feed' | 'story';

const SIZES: Record<SocialFormat, { width: number; height: number }> = {
  feed: { width: 1080, height: 1350 }, // Instagram post 4:5
  story: { width: 1080, height: 1920 }, // Instagram story 9:16
};

const BRAND = '#5850ec';
const LOGO_URL =
  'https://res.cloudinary.com/dne7ddv2a/image/upload/f_png,c_scale,w_160/v1776068517/Logo_no_text_transparent_uytuse.png';

// Satori'ning vnode ko'rinishi (JSX'siz)
type Node = { type: string; props: Record<string, any> };
const h = (
  type: string,
  style: Record<string, any>,
  children?: any,
  extra: Record<string, any> = {},
): Node => ({ type, props: { style, children, ...extra } });

/**
 * Maqoladan Instagram uchun rasm yasaydi: muqova ustida sarlavha,
 * kategoriya va logo. Matn shrift fayllaridan chiziladi (serverdagi
 * tizim shriftlariga bog'liq emas). Natija — JPEG (Instagram faqat JPEG oladi).
 */
@Injectable()
export class SocialImageService {
  private fonts?: { name: string; data: Buffer; weight: 500 | 700 }[];

  private loadFonts() {
    if (!this.fonts) {
      const dir = join(process.cwd(), 'assets', 'fonts');
      this.fonts = [
        {
          name: 'Space Grotesk',
          weight: 500,
          data: readFileSync(join(dir, 'space-grotesk-latin-500.woff')),
        },
        {
          name: 'Space Grotesk',
          weight: 700,
          data: readFileSync(join(dir, 'space-grotesk-latin-700.woff')),
        },
      ];
    }
    return this.fonts;
  }

  /** Shriftda yo'q belgilar (ʻ ʼ ‘ ’) oddiy apostrofga */
  private clean(s?: string | null) {
    return String(s ?? '')
      .replace(/[ʻʼ‘’`]/g, "'")
      .replace(/[“”«»]/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async dataUri(url: string): Promise<string | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return null;
      const type = res.headers.get('content-type') ?? 'image/jpeg';
      const buf = Buffer.from(await res.arrayBuffer());
      return `data:${type};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  }

  private coverUrl(url: string, w: number, h: number) {
    return url.includes('res.cloudinary.com') && url.includes('/upload/')
      ? url.replace(
          '/upload/',
          `/upload/f_jpg,q_auto,c_fill,g_auto,w_${w},h_${h}/`,
        )
      : url;
  }

  async render(article: SocialArticle, format: SocialFormat): Promise<Buffer> {
    const { width, height } = SIZES[format];
    const story = format === 'story';
    const title = this.clean(article.title);
    const excerpt = this.clean(article.excerpt);
    const category = this.clean(article.category?.name);

    const [cover, logo] = await Promise.all([
      article.coverImage
        ? this.dataUri(this.coverUrl(article.coverImage, width, height))
        : null,
      this.dataUri(LOGO_URL),
    ]);

    // Uzun sarlavha — kichikroq shrift
    const titleSize = story
      ? title.length > 80
        ? 68
        : 80
      : title.length > 80
        ? 56
        : title.length > 50
          ? 64
          : 72;

    const tree = h(
      'div',
      {
        width,
        height,
        display: 'flex',
        position: 'relative',
        fontFamily: 'Space Grotesk',
        color: '#fff',
        background: `linear-gradient(160deg, ${BRAND}, #1a1a2e)`,
      },
      [
        cover
          ? h(
              'img',
              {
                position: 'absolute',
                top: 0,
                left: 0,
                width,
                height,
                objectFit: 'cover',
              },
              undefined,
              { src: cover, width, height },
            )
          : null,
        // Pastki qism matn o'qilishi uchun qorayadi
        h('div', {
          position: 'absolute',
          top: 0,
          left: 0,
          width,
          height,
          display: 'flex',
          backgroundImage: story
            ? 'linear-gradient(180deg, rgba(10,10,30,0.55) 0%, rgba(10,10,30,0) 22%, rgba(10,10,30,0) 38%, rgba(10,10,30,0.85) 62%, rgba(10,10,30,0.97) 100%)'
            : 'linear-gradient(180deg, rgba(10,10,30,0.5) 0%, rgba(10,10,30,0) 20%, rgba(10,10,30,0.1) 40%, rgba(10,10,30,0.88) 70%, rgba(10,10,30,0.97) 100%)',
        }),
        // Logo
        h(
          'div',
          {
            position: 'absolute',
            top: story ? 90 : 56,
            left: 64,
            display: 'flex',
            alignItems: 'center',
            gap: 18,
          },
          [
            logo
              ? h(
                  'img',
                  {
                    width: 72,
                    height: 72,
                    borderRadius: 36,
                    backgroundColor: '#fff',
                    padding: 6,
                  },
                  undefined,
                  { src: logo, width: 72, height: 72 },
                )
              : null,
            h(
              'div',
              { fontSize: 36, fontWeight: 700, display: 'flex' },
              'Bilim Manba',
            ),
          ].filter(Boolean),
        ),
        // Matn bloki
        h(
          'div',
          {
            position: 'absolute',
            left: 64,
            right: 64,
            bottom: story ? 210 : 84,
            display: 'flex',
            flexDirection: 'column',
            gap: 26,
          },
          [
            category
              ? h('div', { display: 'flex' }, [
                  h(
                    'div',
                    {
                      display: 'flex',
                      backgroundColor: BRAND,
                      borderRadius: 999,
                      padding: '10px 26px',
                      fontSize: 30,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: 2,
                    },
                    category,
                  ),
                ])
              : null,
            h(
              'div',
              {
                display: 'block',
                fontSize: titleSize,
                fontWeight: 700,
                lineHeight: 1.12,
                lineClamp: story ? 5 : 4,
              },
              title,
            ),
            excerpt
              ? h(
                  'div',
                  {
                    display: 'block',
                    fontSize: story ? 38 : 32,
                    fontWeight: 500,
                    lineHeight: 1.4,
                    color: 'rgba(255,255,255,0.86)',
                    lineClamp: 3,
                  },
                  excerpt,
                )
              : null,
          ].filter(Boolean),
        ),
        // Pastki yozuv
        h(
          'div',
          {
            position: 'absolute',
            left: 64,
            right: 64,
            bottom: story ? 110 : 34,
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: story ? 34 : 28,
            fontWeight: 500,
            color: 'rgba(255,255,255,0.75)',
          },
          story
            ? [h('div', { display: 'flex' }, "To'liq maqola: bilimmanba.uz")]
            : [
                h('div', { display: 'flex' }, 'bilimmanba.uz'),
                h('div', { display: 'flex' }, "O'zbek tilida bilim"),
              ],
        ),
      ].filter(Boolean),
    );

    const svg = await satori(tree as any, {
      width,
      height,
      fonts: this.loadFonts(),
    });
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: width } })
      .render()
      .asPng();
    return sharp(png).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  }
}
