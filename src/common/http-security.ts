import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Brauzerdan API'ga murojaat qila oladigan saytlar. Origin'siz so'rovlar
 * (server-server: Vercel SSR, UptimeRobot, Payme) cheklanmaydi.
 * Qo'shimcha manzillar: env CORS_ORIGINS (vergul bilan).
 */
const ALLOWED_ORIGINS = [
  /^https:\/\/(www\.)?bilimmanba\.uz$/,
  /^https:\/\/bilim-manba[a-z0-9-]*\.vercel\.app$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.some((re) => re.test(origin))) return true;
  return (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(origin);
}

/** CORS + xavfsizlik sarlavhalari (main.ts va testlar bir xil sozlamani ishlatadi) */
export function applyHttpSecurity(app: INestApplication) {
  // Qaysi texnologiyada yozilganini oshkor qilmaymiz
  app.getHttpAdapter().getInstance().disable?.('x-powered-by');

  // API faqat JSON beradi
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
    next();
  });

  app.enableCors({
    origin: (origin, cb) => cb(null, originAllowed(origin)),
    methods: 'GET,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type, Authorization',
    optionsSuccessStatus: 200,
    maxAge: 86400,
  });
}
