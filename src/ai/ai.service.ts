import { ConfigService } from '@nestjs/config';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import Groq from 'groq-sdk';

// Mehmon (login qilmagan) uchun kunlik bepul savollar
const GUEST_DAILY_LIMIT = 3;
// Xarajat himoyasi: barcha mehmonlar uchun jami kunlik savollar
const GUEST_GLOBAL_DAILY_LIMIT = 500;

const MAX_TEXT = 6000;
const MAX_QUESTION = 500;
const MAX_HISTORY = 10;

type ChatMessage = { role: 'user' | 'assistant'; content: string };

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private groq: Groq;
  private model: string;

  // Xotirada saqlanadi — server qayta ishga tushsa nollanadi, bu yetarli
  private guestDay = '';
  private guestCounts = new Map<string, number>();
  private guestTotal = 0;

  constructor(private config: ConfigService) {
    this.groq = new Groq({
      apiKey: this.config.get<string>('GROQ_API_KEY'),
    });
    // llama-3.3-70b-versatile Groq'dan olib tashlangan — endi model env
    // orqali almashtiriladi, kod o'zgartirmasdan
    this.model =
      this.config.get<string>('GROQ_MODEL') ?? 'openai/gpt-oss-120b';
  }

  /** Mehmon limitini tekshiradi va hisoblaydi. Qolgan savollar sonini qaytaradi. */
  consumeGuestQuota(ip: string): number {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.guestDay) {
      this.guestDay = today;
      this.guestCounts.clear();
      this.guestTotal = 0;
    }

    const used = this.guestCounts.get(ip) ?? 0;
    if (
      used >= GUEST_DAILY_LIMIT ||
      this.guestTotal >= GUEST_GLOBAL_DAILY_LIMIT
    ) {
      throw new HttpException(
        {
          code: 'GUEST_LIMIT',
          message:
            "Bugungi bepul savollar tugadi. Cheksiz foydalanish uchun ro'yxatdan o'ting.",
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.guestCounts.set(ip, used + 1);
    this.guestTotal++;
    return GUEST_DAILY_LIMIT - used - 1;
  }

  /** AI xato bersa, mehmonning savoli hisobdan qaytariladi */
  refundGuestQuota(ip: string) {
    const used = this.guestCounts.get(ip) ?? 0;
    if (used > 0) this.guestCounts.set(ip, used - 1);
    if (this.guestTotal > 0) this.guestTotal--;
  }

  async explain(text: string, question: string, history: unknown[] = []) {
    // Faqat user/assistant xabarlari — history orqali 'system' ko'rsatma
    // yuborib bo'lmasin
    const safeHistory: ChatMessage[] = (Array.isArray(history) ? history : [])
      .filter(
        (m: any): m is ChatMessage =>
          (m?.role === 'user' || m?.role === 'assistant') &&
          typeof m?.content === 'string',
      )
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

    try {
      const completion = await this.groq.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: `Sen o'zbek tilida javob beradigan aqlli yordamchisan.
Foydalanuvchi maqola matni va savol bilan keladi.
Savolga qisqa, tushunarli va o'zbek tilida javob ber.
Maqola matni: ${String(text ?? '').slice(0, MAX_TEXT)}`,
          },
          ...safeHistory,
          {
            role: 'user',
            content: String(question ?? '').slice(0, MAX_QUESTION),
          },
        ],
        temperature: 0.7,
        max_completion_tokens: 700,
        ...(this.model.startsWith('openai/gpt-oss')
          ? { reasoning_effort: 'low' as const }
          : {}),
      });

      return {
        explanation:
          completion.choices[0]?.message?.content ?? 'Javob olinmadi',
      };
    } catch (err: any) {
      this.logger.error(`Groq xatosi (${this.model}): ${err?.message}`);
      throw new ServiceUnavailableException(
        "AI hozircha javob bera olmayapti. Birozdan so'ng qayta urinib ko'ring.",
      );
    }
  }
}
