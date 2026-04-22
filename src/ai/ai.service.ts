import { ExplainDto } from './dto/explain.dto.ts';
import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';
import Groq from 'groq-sdk';

@Injectable()
export class AiService {
  private groq: Groq;

  constructor(private config: ConfigService) {
    this.groq = new Groq({
      apiKey: this.config.get<string>('GROQ_API_KEY'),
    });
  }

  async explain(text: string, question: string, history: any[] = []) {
    const completion = await this.groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Sen o'zbek tilida javob beradigan aqlli yordamchisan. 
Foydalanuvchi maqola matni va savol bilan keladi. 
Savolga qisqa, tushunarli va o'zbek tilida javob ber.
Maqola matni: ${text}`,
        },
        ...history, // 👈 tarix
        {
          role: 'user',
          content: question,
        },
      ],
      temperature: 0.7,
      max_tokens: 500,
    });

    return {
      explanation: completion.choices[0]?.message?.content ?? 'Javob olinmadi',
    };
  }
}
