/** Foydalanuvchi kiritgan matnni HTML ichiga (email, sahifa) xavfsiz qo'yish */
export const escHtml = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Faqat http(s) havolalar — javascript: va boshqalar o'tmaydi */
export const safeUrl = (s: unknown) => {
  const v = String(s ?? '').trim();
  return /^https?:\/\//i.test(v) ? escHtml(v) : '';
};
