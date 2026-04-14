import { Injectable, ForbiddenException } from '@nestjs/common';
import { ExplainDto } from './dto/explain.dto.ts';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

@Injectable()
export class AiService {
  private client: Anthropic;

  constructor(private config: ConfigService) {
    this.client = new Anthropic({
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
    });
  }

  async explain(dto: ExplainDto, userPlan: string) {
    // Bu premium feature — free user ishlatsa blokladik
    if (userPlan !== 'premium') {
      throw new ForbiddenException(
        'Bu funksiya faqat premium foydalanuvchilar uchun',
      );
    }

    const message = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001', // Tez va arzon — bizga shu yetadi
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `
Sen "Bilim Manba" platformasining AI yordamchisisisan.
Foydalanuvchi quyidagi matnni o'zbek tilida tushuntirishingni so'rayapti.

Matn:
"""
${dto.text}
"""

Foydalanuvchi savoli: ${dto.question}

Qoidalar:
- Faqat o'zbek tilida (lotin) javob ber
- Oddiy va tushunarli tilda tushuntir
- Kerak bo'lsa misollar keltir
- Javob 3-5 paragrafdan oshmasin
          `.trim(),
        },
      ],
    });

    // Anthropic response ichidan faqat text olamiz
    const content = message.content[0];
    if (content.type !== 'text') {
      throw new Error('Kutilmagan javob formati');
    }

    return {
      explanation: content.text,
      // Token statistikasi — monitoring uchun
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
    };
  }
}
