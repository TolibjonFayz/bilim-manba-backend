import { createHash } from 'crypto';

/**
 * Mehmon o'yinchi: ro'yxatdan o'tmagan o'quvchi testlarni yechsa ham bali
 * saqlanadi va reytingda chiqadi. Brauzer bir marta tasodifiy UUID yaratadi
 * (localStorage "bm_qid") va har so'rovda yuboradi. Kirgach/ro'yxatdan
 * o'tgach shu ID bo'yicha ballar akkauntga ko'chiriladi (POST /quiz/merge).
 */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isGuestId = (v: unknown): v is string =>
  typeof v === 'string' && UUID.test(v);

const ADJ = [
  'Zukko',
  'Bilimdon',
  'Chaqqon',
  'Dono',
  'Qiziquvchan',
  'Tirishqoq',
  'Topqir',
  'Ziyrak',
  'Mard',
  'Sabrli',
  'Hushyor',
  'Uddaburon',
];
const ANIMAL = [
  'Burgut',
  'Lochin',
  "Yo'lbars",
  'Qoplon',
  "Bo'ri",
  'Sher',
  'Delfin',
  'Boyqush',
  'Tulki',
  'Kiyik',
  'Ayiq',
  "Qaldirg'och",
  'Laylak',
  'Arslon',
];

/** ID'dan doim bir xil chiqadigan taxallus: "Zukko Burgut 47" */
export function guestName(guestId: string): string {
  const h = createHash('sha256').update(guestId.toLowerCase()).digest();
  return `${ADJ[h[0] % ADJ.length]} ${ANIMAL[h[1] % ANIMAL.length]} ${10 + (h[2] % 90)}`;
}
