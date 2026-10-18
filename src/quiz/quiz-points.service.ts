import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOP = 20;

/** Har to'g'ri javob — 10 ball, hammasi to'g'ri bo'lsa — yana 10 ball */
export const POINTS_PER_CORRECT = 10;
export const PERFECT_BONUS = 10;

export const pointsFor = (correct: number, total: number) =>
  correct * POINTS_PER_CORRECT +
  (total > 0 && correct === total ? PERFECT_BONUS : 0);

export type Period = 'week' | 'month' | 'all';

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

interface Row {
  userId: number;
  fullName: string;
  points: string | number;
  quizzes: string | number;
  correct: string | number;
  total: string | number;
}

/**
 * Test ballari va reyting. Har maqola testi uchun ball faqat birinchi
 * urinishda beriladi (quiz_scores: userId + articleId). Adminlar reytingda
 * ko'rinmaydi (ular testlarni sinab ko'radi).
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

  /** Ball yozadi. Shu test uchun avval ball olingan bo'lsa — awarded: false */
  async award(
    userId: number,
    articleId: number,
    correct: number,
    total: number,
  ) {
    const points = pointsFor(correct, total);
    const rows = await this.q<{ points: number }>(
      `INSERT INTO quiz_scores ("userId", "articleId", correct, total, points, "createdAt")
       VALUES (:userId, :articleId, :correct, :total, :points, now())
       ON CONFLICT ("userId", "articleId") DO NOTHING
       RETURNING points`,
      { userId, articleId, correct, total, points },
    );
    return { awarded: rows.length > 0, points: rows.length ? points : 0 };
  }

  private where(start: Date | null) {
    return start ? 'AND s."createdAt" >= :start' : '';
  }

  /** Reyting: eng ko'p ball to'plaganlar (teng bo'lsa — avval yetganlar yuqorida) */
  async leaderboard(period: Period, meId?: number) {
    const start = periodStart(period);
    const rows = await this.q<Row>(
      `SELECT u.id AS "userId", u."fullName", SUM(s.points) AS points,
              COUNT(*) AS quizzes, SUM(s.correct) AS correct, SUM(s.total) AS total
       FROM quiz_scores s JOIN users u ON u.id = s."userId"
       WHERE u.role <> 'admin' ${this.where(start)}
       GROUP BY u.id, u."fullName"
       HAVING SUM(s.points) > 0
       ORDER BY SUM(s.points) DESC, MAX(s."createdAt") ASC
       LIMIT ${TOP}`,
      { start },
    );
    return {
      period,
      since: start?.toISOString() ?? null,
      top: rows.map((r, i) => ({
        rank: i + 1,
        name: publicName(r.fullName),
        points: Number(r.points),
        quizzes: Number(r.quizzes),
        accuracy: Number(r.total)
          ? Math.round((Number(r.correct) / Number(r.total)) * 100)
          : 0,
        me: meId !== undefined && r.userId === meId,
      })),
      me: meId ? await this.stats(meId, period) : null,
    };
  }

  /** Bitta foydalanuvchi: ball, testlar soni, aniqlik va o'rni (davr bo'yicha) */
  async stats(userId: number, period: Period = 'all') {
    const start = periodStart(period);
    const [mine] = await this.q<Omit<Row, 'userId' | 'fullName'>>(
      `SELECT COALESCE(SUM(points), 0) AS points, COUNT(*) AS quizzes,
              COALESCE(SUM(correct), 0) AS correct, COALESCE(SUM(total), 0) AS total
       FROM quiz_scores s WHERE s."userId" = :userId ${this.where(start)}`,
      { userId, start },
    );
    const points = Number(mine?.points ?? 0);
    let rank: number | null = null;
    if (points > 0) {
      const [r] = await this.q<{ n: string }>(
        `SELECT COUNT(*) AS n FROM (
           SELECT s."userId" FROM quiz_scores s JOIN users u ON u.id = s."userId"
           WHERE u.role <> 'admin' ${this.where(start)}
           GROUP BY s."userId" HAVING SUM(s.points) > :points
         ) t`,
        { start, points },
      );
      rank = Number(r?.n ?? 0) + 1;
    }
    const total = Number(mine?.total ?? 0);
    return {
      period,
      points,
      quizzes: Number(mine?.quizzes ?? 0),
      accuracy: total
        ? Math.round((Number(mine?.correct ?? 0) / total) * 100)
        : 0,
      rank,
    };
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
}
