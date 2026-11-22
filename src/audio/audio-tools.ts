/**
 * Audio maqolalar uchun sof funksiyalar (tarmoqsiz — testlanadi):
 * HTML → o'qiladigan matn, matnni bo'laklash, Gemini javobidan ovozni
 * ajratib olish (WAV yoki xom PCM), PCM → MP3.
 */

/** Maqola HTML'idan ovoz uchun matn: sarlavhalar alohida gap, "Manbalar"siz */
export function speechText(title: string, html: string): string {
  const cut = html.search(
    /<h[23][^>]*>\s*(Shuningdek o'qing|Manbalar|Foydalanilgan manbalar)\s*<\/h[23]>/i,
  );
  const body = (cut > 0 ? html.slice(0, cut) : html)
    .replace(/<(script|style|figure|figcaption|table)\b[\s\S]*?<\/\1>/gi, ' ')
    // Sarlavha va ro'yxat bandi oxirida to'xtam bo'lsin
    .replace(/<\/(h[1-6]|li)>/gi, '.\n')
    .replace(/<\/(p|blockquote|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // Emoji va bezak belgilar o'qilmasin
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[‘’ʻʼ`]/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([.!?,;:])/g, '$1')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/([.!?:;])\.\n/g, '$1\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  const head = String(title ?? '')
    .trim()
    .replace(/[.!?]?$/, '.');
  return `${head}\n${body}`.trim();
}

/** Matnni ~max belgili bo'laklarga: avval xatboshi, keyin gap chegarasida */
export function chunkText(text: string, max = 3000): string[] {
  const out: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (const para of text.split('\n')) {
    if ((cur + '\n' + para).length <= max) {
      cur = cur ? `${cur}\n${para}` : para;
      continue;
    }
    push();
    if (para.length <= max) {
      cur = para;
      continue;
    }
    // Juda uzun xatboshi — gaplarga bo'linadi
    for (const s of para.match(/[^.!?]+[.!?]*\s*/g) ?? [para]) {
      if ((cur + s).length > max) push();
      cur += s.length > max ? s.slice(0, max) : s;
    }
  }
  push();
  return out;
}

/** Javob JSON ichidan base64 ovozni topadi (generateContent ham, Interactions API ham) */
export function findAudio(
  json: unknown,
): { data: string; mime: string } | null {
  const seen = new Set<unknown>();
  const walk = (v: any): { data: string; mime: string } | null => {
    if (!v || typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    const mime = v.mimeType ?? v.mime_type;
    if (
      typeof v.data === 'string' &&
      typeof mime === 'string' &&
      /audio/i.test(mime)
    )
      return { data: v.data, mime };
    for (const k of Object.keys(v)) {
      const r = walk(v[k]);
      if (r) return r;
    }
    return null;
  };
  return walk(json);
}

/**
 * Ovoz baytlari → 16-bit mono PCM + chastota. WAV (RIFF) bo'lsa sarlavhasi
 * o'qiladi; aks holda xom L16 (Gemini: kichik-endian, mime'da rate=24000).
 */
export function toPcm(
  buf: Buffer,
  mime: string,
): { pcm: Int16Array; rate: number } {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    let rate = 24000;
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (id === 'fmt ') rate = buf.readUInt32LE(pos + 12);
      if (id === 'data') {
        const data = buf.subarray(
          pos + 8,
          Math.min(buf.length, pos + 8 + size),
        );
        return { pcm: bytesToInt16(data), rate };
      }
      pos += 8 + size + (size % 2);
    }
    throw new Error('WAV ichida ovoz topilmadi');
  }
  const rate = Number(/rate=(\d+)/i.exec(mime)?.[1] ?? 24000);
  return { pcm: bytesToInt16(buf), rate };
}

function bytesToInt16(b: Buffer): Int16Array {
  const n = Math.floor(b.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(i * 2);
  return out;
}

/** Bo'laklar orasiga qisqa sukut (0.35 s) — xatboshilar orasidagi tabiiy to'xtam */
export function joinPcm(parts: Int16Array[], rate: number, gapSec = 0.35) {
  const gap = Math.round(rate * gapSec);
  const total =
    parts.reduce((n, p) => n + p.length, 0) +
    gap * Math.max(0, parts.length - 1);
  const out = new Int16Array(total);
  let pos = 0;
  parts.forEach((p, i) => {
    out.set(p, pos);
    pos += p.length + (i < parts.length - 1 ? gap : 0);
  });
  return out;
}

// ES-modul kutubxonani CommonJS'dan yuklash (tsc import()ni require()ga aylantirmasin)
const esmImport = new Function('s', 'return import(s)') as (
  s: string,
) => Promise<any>;

/** PCM → MP3 (mono, 48 kbit/s — nutq uchun yetarli, 1 daqiqa ≈ 360 KB) */
export async function toMp3(
  pcm: Int16Array,
  rate: number,
  kbps = 48,
): Promise<Buffer> {
  const { Mp3Encoder } = await esmImport('@breezystack/lamejs');
  const enc = new Mp3Encoder(1, rate, kbps);
  const chunks: Uint8Array[] = [];
  const BLOCK = 1152 * 20;
  for (let i = 0; i < pcm.length; i += BLOCK) {
    const out = enc.encodeBuffer(pcm.subarray(i, i + BLOCK));
    if (out.length) chunks.push(new Uint8Array(out));
  }
  const end = enc.flush();
  if (end.length) chunks.push(new Uint8Array(end));
  return Buffer.concat(chunks);
}
