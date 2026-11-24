import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { guestName, isGuestId } from './quiz-guests';

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOP = 50;

/** Har to'g'ri javob — 10 ball, hammasi to'g'ri bo'lsa — yana 10 ball */
export const POINTS_PER_CORRECT = 10;
export const PERFECT_BONUS = 10;

export const pointsFor = (correct: number, total: number) =>
  correct * POINTS_PER_CORRECT +
  (total > 0 && correct === total ? PERFECT_BONUS : 0);

export type Period = 'week' | 'month' | 'all';

/** Test yechayotgan kishi: kirgan foydalanuvchi yoki mehmon (brauzer ID) */
export interface Player {
  userId?: number;
  guestId?: string;
}

/** Davr boshi (Toshkent vaqti): hafta — dushanba 00:00, oy — 1-kun 00:00 */
export function periodStart(period: Period, now = new Date()): Date | null {
  if (period === 'all') return null;
  const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  if (period === 'week') {
    const dow = (local.getUTCDay() + 6) % 7; // dushanba = 0
    local.setTime(local.getTime() - dow * DAY_MS);
  } else {
    local.setUTCDate(1);
  }
  return new Date(local.getTime() - TASHKENT_OFFSET_MS);
}

/** "Tolibjon Fayzullayev" → "Tolibjon F." (reytingda to'liq familiya ko'rinmasin) */
export function publicName(fullName: string | null | undefined) {
  const parts = String(fullName ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return 'Foydalanuvchi';
  return parts.length > 1
    ? `${parts[0]} ${parts[1].charAt(0).toUpperCase()}.`
    : parts[0];
}

/** O'yinchi kaliti (reytingda): "u12" yoki "g<uuid>" */
const pidOf = (p: Player) =>
  p.userId ? `u${p.userId}` : p.guestId ? `g${p.guestId.toLowerCase()}` : null;

/**
 * Hamma o'yinchilarning ballari bitta jadvaldek: foydalanuvchilar (adminsiz)
 * va hali akkauntga ko'chirilmagan mehmonlar. :start — davr boshi (yoki null).
 */
const SCORES = `
  SELECT 'u' || s."userId" AS pid, u."fullName" AS name, false AS guest,
         s.points, s.correct, s.total, s."createdAt"
  FROM quiz_scores s JOIN users u ON u.id = s."userId"
  WHERE u.role <> 'admin'
  UNION ALL
  SELECT 'g' || lower(g."guestId"), g.name, true,
         s.points, s.correct, s.total, s."createdAt"
  FROM quiz_guest_scores s JOIN quiz_guests g ON g."guestId" = s."guestId"
  WHERE g."userId" IS NULL`;

interface Row {
  pid: string;
  name: string;
  guest: boolean;
  points: string | number;
  quizzes: string | number;
  correct: string | number;
  total: string | number;
}

/**
 * Test ballari va reyting. Har maqola testi uchun ball faqat birinchi
 * urinishda beriladi (foydalanuvchi: quiz_scores, mehmon: quiz_guest_scores).
 * Mehmon kirsa/ro'yxatdan o'tsa — merge() ballarini akkauntga ko'chiradi.
 * Adminlar reytingda ko'rinmaydi (ular testlarni sinab ko'radi).
 */
@Injectable()
export class QuizPointsService {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private q<T extends object>(
    sql: string,
    replacements: Record<string, unknown>,
  ) {
    return this.sequelize.query<T>(sql, {
      replacements,
      type: QueryTypes.SELECT,
    });
  }

  /** Mehmon yozuvi (taxallusi bilan) — birinchi marta ko'ringanda yaratiladi */
  async ensureGuest(guestId: string) {
    if (!isGuestId(guestId)) return;
    await this.sequelize.query(
      `INSERT INTO quiz_guests ("guestId", name, "createdAt") VALUES (:id, :name, now())
       ON CONFLICT ("guestId") DO NOTHING`,
      { replacements: { id: guestId.toLowerCase(), name: guestName(guestId) } },
    );
  }

  /** Ball yozadi. Shu test uchun avval ball olingan bo'lsa — awarded: false */
  async award(
    player: Player | number,
    articleId: number,
    correct: number,
    total: number,
  ) {
    const p: Player = typeof player === 'number' ? { userId: player } : player;
    const points = pointsFor(correct, total);
    let rows: { points: number }[] = [];
    if (p.userId) {
      rows = await this.q<{ points: number }>(
        `INSERT INTO quiz_scores ("userId", "articleId", correct, total, points, "createdAt")
         VALUES (:id, :articleId, :correct, :total, :points, now())
         ON CONFLICT ("userId", "articleId") DO NOTHING
         RETURNING points`,
        { id: p.userId, articleId, correct, total, points },
      );
    } else if (p.guestId && isGuestId(p.guestId)) {
      await this.ensureGuest(p.guestId);
      rows = await this.q<{ points: number }>(
        `INSERT INTO quiz_guest_scores ("guestId", "articleId", correct, total, points, "createdAt")
         VALUES (:id, :articleId, :correct, :total, :points, now())
         ON CONFLICT ("guestId", "articleId") DO NOTHING
         RETURNING points`,
        { id: p.guestId.toLowerCase(), articleId, correct, total, points },
      );
    }
    return { awarded: rows.length > 0, points: rows.length ? points : 0 };
  }

  private where(start: Date | null) {
    return start ? 'WHERE "createdAt" >= :start' : '';
  }

  /** Reyting: eng ko'p ball to'plaganlar (teng bo'lsa — avval yetganlar yuqorida) */
  async leaderboard(period: Period, me: Player = {}) {
    const start = periodStart(period);
    const mePid = pidOf(me);
    const [rows, [count]] = await Promise.all([
      this.q<Row>(
        `SELECT pid, MAX(name) AS name, bool_or(guest) AS guest, SUM(points) AS points,
                COUNT(*) AS quizzes, SUM(correct) AS correct, SUM(total) AS total
         FROM (${SCORES}) s ${this.where(start)}
         GROUP BY pid
         HAVING SUM(points) > 0
         ORDER BY SUM(points) DESC, MAX("createdAt") ASC
         LIMIT ${TOP}`,
        { start },
      ),
      this.q<{ n: string }>(
        `SELECT COUNT(*) AS n FROM (
           SELECT pid FROM (${SCORES}) s ${this.where(start)}
           GROUP BY pid HAVING SUM(points) > 0
         ) t`,
        { start },
      ),
    ]);
    return {
      period,
      since: start?.toISOString() ?? null,
      participants: Number(count?.n ?? 0),
      top: rows.map((r, i) => ({
        rank: i + 1,
        name: r.guest ? r.name : publicName(r.name),
        guest: Boolean(r.guest),
        points: Number(r.points),
        quizzes: Number(r.quizzes),
        accuracy: Number(r.total)
          ? Math.round((Number(r.correct) / Number(r.total)) * 100)
          : 0,
        me: mePid !== null && r.pid === mePid,
      })),
      me: mePid ? await this.statsFor(me, period) : null,
    };
  }

  /** Bitta o'yinchi: ball, testlar soni, aniqlik va o'rni (davr bo'yicha) */
  async statsFor(player: Player, period: Period = 'all') {
    const pid = pidOf(player);
    const start = periodStart(period);
    const [mine] = pid
      ? await this.q<Omit<Row, 'pid' | 'name' | 'guest'>>(
          `SELECT COALESCE(SUM(points), 0) AS points, COUNT(*) AS quizzes,
                  COALESCE(SUM(correct), 0) AS correct, COALESCE(SUM(total), 0) AS total
           FROM (${SCORES}) s WHERE pid = :pid ${start ? 'AND "createdAt" >= :start' : ''}`,
          { pid, start },
        )
      : [];
    const points = Number(mine?.points ?? 0);
    let rank: number | null = null;
    if (points > 0) {
      const [r] = await this.q<{ n: string }>(
        `SELECT COUNT(*) AS n FROM (
           SELECT pid FROM (${SCORES}) s ${this.where(start)}
           GROUP BY pid HAVING SUM(points) > :points
         ) t`,
        { start, points },
      );
      rank = Number(r?.n ?? 0) + 1;
    }
    const total = Number(mine?.total ?? 0);
    const name =
      player.guestId && !player.userId ? guestName(player.guestId) : null;
    return {
      period,
      points,
      quizzes: Number(mine?.quizzes ?? 0),
      accuracy: total
        ? Math.round((Number(mine?.correct ?? 0) / total) * 100)
        : 0,
      rank,
      ...(name ? { name, guest: true } : {}),
    };
  }

  /** Foydalanuvchi uchun (eski chaqiruvlar) */
  stats(userId: number, period: Period = 'all') {
    return this.statsFor({ userId }, period);
  }

  /** Profil uchun: umumiy, haftalik va oylik ko'rsatkichlar bir yo'la */
  async summary(userId: number) {
    const [all, week, month] = await Promise.all([
      this.stats(userId, 'all'),
      this.stats(userId, 'week'),
      this.stats(userId, 'month'),
    ]);
    return { all, week, month };
  }

  /**
   * Mehmon kirdi/ro'yxatdan o'tdi: uning ballari va tanlovlari akkauntga
   * ko'chiriladi (akkauntda shu test uchun ball bo'lsa — akkauntniki qoladi).
   * Boshqa akkauntga ko'chirilgan mehmon ID qayta ishlatilmaydi.
   */
  async merge(userId: number, guestId: string) {
    if (!isGuestId(guestId)) return { merged: 0, points: 0 };
    const id = guestId.toLowerCase();
    return this.sequelize.transaction(async (transaction) => {
      const opts = { transaction, type: QueryTypes.SELECT as const };
      const [g] = await this.sequelize.query<{ userId: number | null }>(
        'SELECT "userId" FROM quiz_guests WHERE "guestId" = :id FOR UPDATE',
        { ...opts, replacements: { id } },
      );
      if (!g || (g.userId && Number(g.userId) !== userId))
        return { merged: 0, points: 0 };
      const moved = await this.sequelize.query<{ points: number }>(
        `INSERT INTO quiz_scores ("userId", "articleId", correct, total, points, "createdAt")
         SELECT :userId, "articleId", correct, total, points, "createdAt"
         FROM quiz_guest_scores WHERE "guestId" = :id
         ON CONFLICT ("userId", "articleId") DO NOTHING
         RETURNING points`,
        { ...opts, replacements: { id, userId } },
      );
      await this.sequelize.query(
        `INSERT INTO quiz_picks ("userId", "articleId", idx, choice, "createdAt")
         SELECT :userId, "articleId", idx, choice, "createdAt"
         FROM quiz_guest_picks WHERE "guestId" = :id
         ON CONFLICT ("userId", "articleId", idx) DO NOTHING`,
        { transaction, replacements: { id, userId } },
      );
      await this.sequelize.query(
        'UPDATE quiz_guests SET "userId" = :userId, "mergedAt" = now() WHERE "guestId" = :id',
        { transaction, replacements: { id, userId } },
      );
      await this.sequelize.query(
        'DELETE FROM quiz_guest_scores WHERE "guestId" = :id',
        { transaction, replacements: { id } },
      );
      await this.sequelize.query(
        'DELETE FROM quiz_guest_picks WHERE "guestId" = :id',
        { transaction, replacements: { id } },
      );
      return {
        merged: moved.length,
        points: moved.reduce((n, r) => n + Number(r.points), 0),
      };
    });
  }
}
