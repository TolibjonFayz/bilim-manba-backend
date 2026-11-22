import { findAudio, toPcm } from './audio-tools';

/**
 * Gemini TTS (matn → ovoz). O'zbek tili ("Northern Uzbek") 3.8 Flash TTS
 * modellarida bor, bepul tarifda ham ishlaydi. Google ikki xil so'rov
 * shaklini qo'llaydi: yangi Interactions API (3.8 hujjatlarida) va eski
 * generateContent — avval birinchisi, 400/404 bo'lsa ikkinchisi sinab
 * ko'riladi. Model topilmasa (404) — keyingi model.
 */
export const TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];

export const TTS_STYLE =
  'calm, clear and warm narrator reading an educational article aloud, natural pace';

export class TtsError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
  /** Kunlik/minutlik limit tugadi — bugun boshqa urinmaslik kerak */
  get rateLimited() {
    return this.status === 429;
  }
}

type Fetch = typeof fetch;
const API = 'https://generativelanguage.googleapis.com/v1beta';

async function post(f: Fetch, url: string, key: string, body: unknown) {
  const res = await f(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.message ?? `HTTP ${res.status}`;
    throw new TtsError(String(msg).slice(0, 300), res.status);
  }
  return json;
}

const interactionsBody = (model: string, text: string, voice: string) => ({
  model,
  input: [
    {
      type: 'user_input',
      content: [
        {
          type: 'text',
          text,
          annotations: [{ type: 'speech_metadata', style: TTS_STYLE }],
        },
      ],
    },
  ],
  response_format: { type: 'audio' },
  generation_config: { speech_config: [{ voice }] },
});

const generateBody = (text: string, voice: string) => ({
  contents: [{ parts: [{ text }] }],
  generationConfig: {
    responseModalities: ['AUDIO'],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
    },
  },
});

/** Bitta bo'lak → PCM. Muvaffaqiyatli yo'l (model + API shakli) eslab qolinadi */
export function createTts(opts: {
  key: string;
  models?: string[];
  fetch?: Fetch;
}) {
  const f = opts.fetch ?? fetch;
  const models = opts.models?.length ? opts.models : TTS_MODELS;
  let known: { model: string; api: 'interactions' | 'generate' } | null = null;

  const once = async (
    model: string,
    api: 'interactions' | 'generate',
    text: string,
    voice: string,
  ) => {
    const json =
      api === 'interactions'
        ? await post(
            f,
            `${API}/interactions`,
            opts.key,
            interactionsBody(model, text, voice),
          )
        : await post(
            f,
            `${API}/models/${model}:generateContent`,
            opts.key,
            generateBody(text, voice),
          );
    const audio = findAudio(json);
    if (!audio) throw new TtsError("Javobda ovoz yo'q", 502);
    return toPcm(Buffer.from(audio.data, 'base64'), audio.mime);
  };

  return {
    get route() {
      return known;
    },
    async speak(text: string, voice: string) {
      if (known) return once(known.model, known.api, text, voice);
      let last: TtsError | null = null;
      for (const model of models) {
        for (const api of ['interactions', 'generate'] as const) {
          try {
            const r = await once(model, api, text, voice);
            known = { model, api };
            return r;
          } catch (err: any) {
            const e =
              err instanceof TtsError
                ? err
                : new TtsError(String(err?.message ?? err));
            // Limit yoki kalit xatosi — boshqa shakl/model yordam bermaydi
            if (e.status === 429 || e.status === 401 || e.status === 403)
              throw e;
            last = e;
          }
        }
      }
      throw last ?? new TtsError('TTS ishlamadi');
    },
  };
}
