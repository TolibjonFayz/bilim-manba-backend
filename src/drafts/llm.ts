import { Logger } from '@nestjs/common';
import Groq from 'groq-sdk';
import Anthropic from '@anthropic-ai/sdk';

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
  /** Asosiy model band bo'lsa (503/429) — vergul bilan ajratilgan zaxira modellar */
  geminiFallbacks?: string;
  groqKey?: string;
  groqModel?: string;
  /**
   * Claude (Anthropic) — faqat AI_WRITER=claude bo'lganda maqola yozuvchisi.
   * Xato bersa (hisobda pul yo'q, limit, rad etish) — Gemini/Groq'ga qaytadi.
   */
  claudeKey?: string;
  claudeModel?: string;
  claudeEffort?: string;
}

export interface Llm {
  name: string;
  /** Manba matnlari uchun belgilar byudjeti (model konteksti/limitlariga qarab) */
  sourceBudget: number;
  json(system: string, user: string): Promise<string>;
  /** Rasmlarni ko'ra oladigan model (faqat Gemini): matn + rasmlar → JSON */
  vision?(
    system: string,
    user: string,
    images: { mime: string; data: string }[],
  ): Promise<string>;
}

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
// Gemini bepul tarifida "high demand" (503) va limit (429) xatolari tez-tez
// vaqtinchalik bo'ladi — kutib qayta uriniladi, keyin zaxira modelga o'tiladi
const RETRY_DELAYS_MS = [0, 5000, 15000];
const RETRYABLE = new Set([429, 500, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Matn yozish uzoq davom etadi; rasm tanlash/tekshiruv qisqa — osilib qolgan
// so'rovni uzoq kutmasdan keyingi modelga o'tamiz
const WRITE_TIMEOUT_MS = 170000;
const VISION_TIMEOUT_MS = 75000;
const logger = new Logger('Gemini');

class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * ListModels javobidan matn yozadigan flash modellar: eng yangi versiya
 * birinchi, barqaror (preview emas) va to'liq (lite emas) modellar oldinda.
 */
export function flashModels(list: any[]): string[] {
  const version = (id: string) =>
    Number(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  return list
    .filter((m) =>
      (m?.supportedGenerationMethods ?? []).includes('generateContent'),
    )
    .map((m) => String(m.name ?? '').replace(/^models\//, ''))
    .filter(
      (id) =>
        /^gemini-\d+(\.\d+)?-flash/.test(id) &&
        !/image|tts|audio|live|thinking|embed|exp/.test(id),
    )
    .sort(
      (a, b) =>
        Number(/preview/.test(a)) - Number(/preview/.test(b)) ||
        version(b) - version(a) ||
        Number(/lite/.test(a)) - Number(/lite/.test(b)) ||
        a.length - b.length,
    );
}

const claudeLogger = new Logger('Claude');

/** Javobdan JSON obyektni ajratib oladi (```json ... ``` o'ramini ham) */
export function extractJson(text: string): string {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fenced ? fenced[1].trim() : t;
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  return a >= 0 && b > a ? body.slice(a, b + 1) : body;
}

const CLAUDE_JSON_RULE =
  "\n\nJavobni FAQAT bitta JSON obyekt ko'rinishida qaytar: undan oldin yoki keyin hech qanday matn, izoh yoki ``` belgisi bo'lmasin.";

export function createClaudeLlm(
  key: string,
  model = 'claude-opus-5-5',
  effort = 'medium',
  client?: Pick<Anthropic, 'messages'>,
): Llm {
  const anthropic = client ?? new Anthropic({ apiKey: key, maxRetries: 2 });
  const run = async (
    system: string,
    content: Anthropic.MessageParam['content'],
    maxTokens: number,
  ) => {
    // Uzun javob — streaming (HTTP timeout bo'lmasin), oxirida to'liq xabar
    const msg = await anthropic.messages
      .stream({
        model,
        max_tokens: maxTokens,
        system: system + CLAUDE_JSON_RULE,
        messages: [{ role: 'user', content }],
        output_config: { effort: effort as any },
      } as any)
      .finalMessage();
    if (msg.stop_reason === 'refusal') {
      throw new Error("Claude so'rovni rad etdi (refusal)");
    }
    if (msg.stop_reason === 'max_tokens') {
      throw new Error('Claude javobi chegaraga yetib kesildi (max_tokens)');
    }
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (!text.trim()) throw new Error("Claude bo'sh javob qaytardi");
    const u: any = msg.usage ?? {};
    claudeLogger.log(
      `${model}: kirish ${u.input_tokens ?? '?'} / chiqish ${u.output_tokens ?? '?'} token`,
    );
    return extractJson(text);
  };
  return {
    name: `claude:${model}`,
    // Katta kontekst — manbalardan ko'proq material beriladi
    sourceBudget: 40000,
    json: (system, user) => run(system, user, 32000),
    vision: (system, user, images) =>
      run(
        system,
        [
          ...images.map((im) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: im.mime as any,
              data: im.data,
            },
          })),
          { type: 'text' as const, text: user },
        ],
        4000,
      ),
  };
}

/** Asosiy model xato bersa — zaxira modelga (o'sha so'rov bilan) o'tadi */
export function withFallback(primary: Llm, backup: Llm | null): Llm {
  if (!backup) return primary;
  const guard =
    <A extends unknown[]>(
      fn: (...a: A) => Promise<string>,
      alt: ((...a: A) => Promise<string>) | undefined,
    ) =>
    async (...a: A) => {
      try {
        return await fn(...a);
      } catch (err: any) {
        if (!alt) throw err;
        claudeLogger.warn(
          `${primary.name} ishlamadi, ${backup.name} ga o'tildi: ${String(err?.message).slice(0, 200)}`,
        );
        return alt(...a);
      }
    };
  return {
    name: `${primary.name} (zaxira: ${backup.name})`,
    // Zaxira modelga ham sig'adigan hajm
    sourceBudget: Math.min(primary.sourceBudget, backup.sourceBudget),
    json: guard(primary.json.bind(primary), backup.json.bind(backup)),
    vision: primary.vision
      ? guard(primary.vision.bind(primary), backup.vision?.bind(backup))
      : backup.vision?.bind(backup),
  };
}

export function createLlm(cfg: LlmConfig): Llm | null {
  if (cfg.claudeKey) {
    const claude = createClaudeLlm(
      cfg.claudeKey,
      cfg.claudeModel || undefined,
      cfg.claudeEffort || undefined,
    );
    return withFallback(claude, createLlm({ ...cfg, claudeKey: undefined }));
  }
  if (cfg.geminiKey) {
    const model = cfg.geminiModel || 'gemini-flash-latest';
    const models = [
      model,
      ...(cfg.geminiFallbacks ?? 'gemini-flash-lite-latest')
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m && m !== model),
    ];
    // Google eski modellarni o'chirib qo'yadi (404) — bunday model jarayon
    // davomida qayta chaqirilmaydi, o'rniga API ro'yxatidan yangi flash topiladi
    const gone = new Set<string>();
    let discovered: string[] | null = null;
    const discover = async (): Promise<string[]> => {
      if (discovered) return discovered;
      try {
        const res = await fetch(`${GEMINI}?pageSize=1000`, {
          headers: { 'x-goog-api-key': cfg.geminiKey! },
          signal: AbortSignal.timeout(15000),
        });
        const j: any = await res.json().catch(() => ({}));
        discovered = flashModels(j?.models ?? []);
      } catch {
        return [];
      }
      return discovered;
    };
    const call = async (
      system: string,
      parts: any[],
      maxOutputTokens: number,
      timeoutMs: number,
    ) => {
      let last: unknown;
      const tryModels = async (list: string[]) => {
        for (const m of list) {
          if (gone.has(m)) continue;
          for (const delay of RETRY_DELAYS_MS) {
            if (delay) await sleep(delay);
            try {
              return {
                text: await callModel(
                  m,
                  system,
                  parts,
                  maxOutputTokens,
                  timeoutMs,
                ),
              };
            } catch (err: any) {
              logger.warn(`${m}: ${String(err?.message).slice(0, 160)}`);
              if (err instanceof GeminiHttpError && err.status === 404) {
                gone.add(m);
                // 404 dan oldingi xato (masalan 503) foydaliroq — uni saqlaymiz
                last ??= err;
                break;
              }
              last = err;
              // Javob bermay qolgan model — qayta kutmasdan keyingisiga
              if (err?.name === 'TimeoutError') break;
              const retryable =
                err instanceof GeminiHttpError
                  ? RETRYABLE.has(err.status)
                  : err?.name === 'TimeoutError' ||
                    /fetch failed/i.test(String(err?.message));
              if (!retryable) throw err;
            }
          }
        }
        return null;
      };
      const extra = async () =>
        (await discover()).filter((m) => !models.includes(m)).slice(0, 2);
      const hit = (await tryModels(models)) ?? (await tryModels(await extra()));
      if (hit) return hit.text;
      throw last;
    };
    const callModel = async (
      model: string,
      system: string,
      parts: any[],
      maxOutputTokens: number,
      timeoutMs: number,
    ) => {
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
            contents: [{ role: 'user', parts }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.7,
              maxOutputTokens,
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new GeminiHttpError(
          res.status,
          `Gemini ${res.status}: ${j?.error?.message ?? ''}`,
        );
      }
      const out = j?.candidates?.[0]?.content?.parts ?? [];
      const text = out
        .filter((p: any) => !p.thought)
        .map((p: any) => p.text ?? '')
        .join('');
      if (!text) {
        throw new Error(
          `Gemini bo'sh javob (${j?.candidates?.[0]?.finishReason ?? j?.promptFeedback?.blockReason ?? '?'})`,
        );
      }
      return text;
    };
    return {
      name: `gemini:${model}`,
      sourceBudget: 30000,
      json: (system, user) =>
        call(system, [{ text: user }], 32000, WRITE_TIMEOUT_MS),
      vision: (system, user, images) =>
        call(
          system,
          [
            { text: user },
            ...images.map((im) => ({
              inline_data: { mime_type: im.mime, data: im.data },
            })),
          ],
          4000,
          VISION_TIMEOUT_MS,
        ),
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
