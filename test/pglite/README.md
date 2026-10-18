# Integratsion testlar (PGlite)

Haqiqiy Postgres o'rniga xotiradagi [PGlite](https://pglite.dev) ishlatiladi,
Nest modullari esa `dist/` dan yuklanadi. AI, Telegram, Google va boshqa
tashqi xizmatlar soxta (fake) javoblar bilan almashtirilgan.

```bash
cd test/pglite && npm install   # bir marta (bu kompyuterda: --legacy-peer-deps)
cd ../.. && npm run test:pglite # build + hamma to'plamlar
node test/pglite/run-all.mjs school quiz   # faqat tanlanganlar (build qilingan bo'lsa)
```

| Fayl | Nimani tekshiradi |
| --- | --- |
| `drafts.mjs` | AI qoralama: mavzu tanlash, qiymatlar qoidasi, muqova, kunlik navbat |
| `alerts.mjs` | Adminga shaxsiy Telegram xabarlari |
| `quiz.mjs` | Maqola testlari va natijalar |
| `quiz-points.mjs` | Test ballari va reyting |
| `fact-check.mjs` | AI qoralamalar fakt-tekshiruvi |
| `series.mjs` | Seriyalar, AI reja, avtomatik seriya |
| `school.mjs` | /maktab bo'limi va admin boshqaruvi |
| `stats.mjs` | Statistika va Search Console |
| `channel-quiz.mjs` | Telegram kanaldagi "Kun savoli" |

`drafts.mjs` ning bir nechta testi arXiv/Wikimedia'dan rasm yuklaydi —
internet sekin bo'lsa ular ba'zan yiqiladi.
