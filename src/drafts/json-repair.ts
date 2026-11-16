/**
 * AI javobidagi JSON'ni o'qish. Modellar ba'zan matn ichidagi qo'shtirnoqni
 * ekranlamaydi: "title": "Spider-Man: "Brand New Day"" — JSON.parse yiqiladi
 * ("Expected ',' or '}' after property value"). Avval oddiy o'qiladi, bo'lmasa
 * qatorlar ichidagi "adashgan" qo'shtirnoqlar, xom qator ko'chirishlar va
 * oxirgi vergullar tuzatiladi.
 */

/** Matndan birinchi '{' dan oxirgi '}' gacha (```json o'rami bo'lsa ham) */
export function jsonSlice(raw: string): string {
  const s = String(raw ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  return a >= 0 && b > a ? s.slice(a, b + 1) : s.trim();
}

/**
 * Qator ichidagi qo'shtirnoq: undan keyin (bo'shliqlarni o'tkazib) JSON
 * tuzilish belgisi kelmasa — u qator oxiri emas, matnning bir qismi.
 */
export function repairJson(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      out += ch + (text[i + 1] ?? '');
      i++;
      continue;
    }
    // Qator ichidagi xom qator ko'chirish/tab — JSON'da ekranlanishi shart
    if (ch === '\n') {
      out += '\\n';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\t') {
      out += '\\t';
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const next = text[j];
      if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
        inStr = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  // Oxirgi element ortidagi vergul: {"a":1,} / [1,2,]
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parseLlmJson<T = any>(raw: string): T {
  const text = jsonSlice(raw);
  try {
    return JSON.parse(text) as T;
  } catch (first) {
    try {
      return JSON.parse(repairJson(text)) as T;
    } catch {
      throw first;
    }
  }
}
