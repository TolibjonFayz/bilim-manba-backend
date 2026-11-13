import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { clientIp } from './client-ip';

/**
 * Oddiy so'rov cheklovi (xotirada): parol terish, email bombardimon, izoh va
 * statistika spami kabi suiiste'mollarga qarshi. Bitta server nusxasi uchun
 * yetarli; server qayta ishga tushsa hisob nollanadi.
 *
 *   @RateLimit(10, 300)  // shu manzilga bitta IP dan 5 daqiqada 10 ta so'rov
 */
interface Options {
  limit: number;
  windowSec: number;
  message?: string;
}

const KEY = 'rate_limit';
const MAX_KEYS = 100_000;

export const RateLimit = (limit: number, windowSec: number, message?: string) =>
  SetMetadata(KEY, { limit, windowSec, message } satisfies Options);

const buckets = new Map<string, { count: number; reset: number }>();
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < 60_000 && buckets.size < MAX_KEYS) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
  // Hujum paytida xotira to'lib ketmasin
  if (buckets.size >= MAX_KEYS) buckets.clear();
}

/** true — ruxsat (hisobga olindi); false — limit tugagan */
export function takeToken(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  sweep(now);
  const b = buckets.get(key);
  if (!b || b.reset <= now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}

/** Testlar uchun */
export function resetRateLimits() {
  buckets.clear();
}

export function tooMany(message?: string): never {
  throw new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: 'RATE_LIMIT',
      message:
        message ?? "Juda ko'p urinish. Birozdan so'ng qayta urinib ko'ring.",
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const opts = this.reflector.getAllAndOverride<Options | undefined>(KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!opts) return true;
    const req = ctx.switchToHttp().getRequest();
    const key = `${ctx.getClass().name}.${ctx.getHandler().name}:${clientIp(req)}`;
    if (!takeToken(key, opts.limit, opts.windowSec * 1000)) {
      tooMany(opts.message);
    }
    return true;
  }
}
