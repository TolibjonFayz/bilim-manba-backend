import { BadRequestException } from '@nestjs/common';

/**
 * Maqolaga biriktiriladigan fayllar (kitob, qo'llanma, jadval...). Fayllar
 * Cloudflare R2'ga yuklanadi va har doim "yuklab olish" sifatida beriladi
 * (Content-Disposition: attachment) — brauzer ularni sahifa sifatida ochmaydi.
 */
export interface Attachment {
  name: string;
  url: string;
  size: number;
  ext: string;
}

export const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

/** Ruxsat etilgan turlar: kengaytma → Content-Type */
export const ATTACHMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  djvu: 'image/vnd.djvu',
  fb2: 'application/x-fictionbook+xml',
  mobi: 'application/x-mobipocket-ebook',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  txt: 'text/plain; charset=utf-8',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  zip: 'application/zip',
};

export function fileExt(name: string): string {
  return (/\.([a-z0-9]{1,5})$/i.exec(name.trim())?.[1] ?? '').toLowerCase();
}

/** Fayl nomi: yo'l qismlari, boshqaruv belgilari va g'alati belgilarsiz */
export function cleanFileName(name: string): string {
  const base = String(name ?? '')
    .replace(/^.*[\\/]/, '')
    .replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return base.slice(-120) || 'fayl';
}

/** R2 kaliti uchun xavfsiz nom (lotin harflar, raqam, - _ .) */
export function keySafe(name: string): string {
  const ext = fileExt(name);
  const stem = name
    .replace(/\.[^.]+$/, '')
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return `${stem || 'fayl'}.${ext}`;
}

/** Fayl mazmuni kengaytmaga mosmi (asosiy turlar uchun "magic" baytlar) */
export function looksLike(ext: string, buf: Buffer): boolean {
  const head = buf.subarray(0, 8);
  const starts = (...b: number[]) => b.every((x, i) => head[i] === x);
  switch (ext) {
    case 'pdf':
      return starts(0x25, 0x50, 0x44, 0x46); // %PDF
    case 'epub':
    case 'docx':
    case 'pptx':
    case 'xlsx':
    case 'odt':
    case 'zip':
      return starts(0x50, 0x4b); // PK (zip)
    case 'doc':
    case 'ppt':
    case 'xls':
      return starts(0xd0, 0xcf, 0x11, 0xe0); // eski Office
    case 'djvu':
      return starts(0x41, 0x54, 0x26, 0x54); // AT&T
    default:
      return true;
  }
}

/**
 * Admin formasidan kelgan ro'yxatni tekshiradi: faqat o'z R2 manzilimizdagi
 * fayllar, ruxsat etilgan turlar, toza nom. Noto'g'ri bo'lsa — 400.
 */
export function sanitizeAttachments(
  raw: unknown,
  publicUrl: string | undefined,
): Attachment[] | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (!Array.isArray(raw)) {
    throw new BadRequestException("Fayllar ro'yxati noto'g'ri");
  }
  if (raw.length > MAX_ATTACHMENTS) {
    throw new BadRequestException(
      `Ko'pi bilan ${MAX_ATTACHMENTS} ta fayl biriktirish mumkin`,
    );
  }
  const base = String(publicUrl ?? '').replace(/\/$/, '');
  const out = raw.map((a: any) => {
    const url = String(a?.url ?? '');
    if (!base || !url.startsWith(`${base}/files/`)) {
      throw new BadRequestException(
        "Fayl saytning o'z omboriga yuklangan bo'lishi kerak",
      );
    }
    const name = cleanFileName(String(a?.name ?? ''));
    const ext = fileExt(url);
    if (!ATTACHMENT_TYPES[ext]) {
      throw new BadRequestException(`Bu turdagi fayl ruxsat etilmagan: .${ext}`);
    }
    const size = Math.max(0, Math.round(Number(a?.size) || 0));
    return { name, url, size, ext };
  });
  return out.length ? out : null;
}
