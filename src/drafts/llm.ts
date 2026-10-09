import Groq from 'groq-sdk';

/**
 * Qoralama yozadigan model. GEMINI_API_KEY bo'lsa — Google Gemini (o'zbek
 * tilini ancha yaxshi biladi, bepul tarifda katta kontekst), bo'lmasa — Groq.
 *
 * Env: GEMINI_API_KEY, GEMINI_MODEL (standart: gemini-flash-latest),
 *      GROQ_API_KEY, GROQ_MODEL.
 */
export interface LlmConfig {
  geminiKey?: string;
  geminiModel?: string;
  groqKey?: string;
  groqModel?: string;
}

export interface Llm {
  name: string;
  /** Manba matnlari uchun belgilar byudjeti (model konteksti/limitlariga qarab) */
  sourceBudget: number;
  json(system: string, user: string): Promise<string>;
}

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';

export function createLlm(cfg: LlmConfig): Llm | null {
  if (cfg.geminiKey) {
    const model = cfg.geminiModel || 'gemini-flash-latest';
    return {
      name: `gemini:${model}`,
      sourceBudget: 30000,
      async json(system, user) {
        const res = await fetch(
          `${GEMINI}/${encodeURIComponent(model)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': cfg.geminiKey!,
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: 'user', parts: [{ text: user }] }],
              generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.7,
                maxOutputTokens: 32000,
              },
            }),
            signal: AbortSignal.timeout(170000),
          },
        );
        const j: any = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(`Gemini ${res.status}: ${j?.error?.message ?? ''}`);
        }
        const parts = j?.candidates?.[0]?.content?.parts ?? [];
        const text = parts
          .filter((p: any) => !p.thought)
          .map((p: any) => p.text ?? '')
          .join('');
        if (!text) {
          throw new Error(
            `Gemini bo'sh javob (${j?.candidates?.[0]?.finishReason ?? j?.promptFeedback?.blockReason ?? '?'})`,
          );
        }
        return text;
      },
    };
  }

  if (cfg.groqKey) {
    const model = cfg.groqModel || 'openai/gpt-oss-120b';
    const groq = new Groq({ apiKey: cfg.groqKey });
    return {
      name: `groq:${model}`,
      // Groq bepul tarifi: so'rov (kirish + max javob) daqiqasiga ~8000 token
      sourceBudget: 7000,
      async json(system, user) {
        const completion = await groq.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.6,
          max_completion_tokens: 5000,
          ...(model.startsWith('openai/gpt-oss')
            ? { reasoning_effort: 'low' as const }
            : {}),
        });
        return completion.choices[0]?.message?.content ?? '';
      },
    };
  }

  return null;
}
