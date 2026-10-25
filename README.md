# AutoRia Tracker

Щодня збирає оголошення з auto.ria.com за збереженими пошуками і повідомляє в Telegram,
що з'явилося нового, що продано і що подешевшало. Дашборд публікується на GitHub Pages.

Специфікація: [SPEC.md](SPEC.md) · дизайн: [docs/design.md](docs/design.md) ·
структура сайту: [docs/recon.md](docs/recon.md).

## Налаштування (один раз)

1. **Пошуки.** Налаштуйте фільтри на auto.ria.com, натисніть «Пошук» і скопіюйте URL виду
   `https://auto.ria.com/uk/search/?...` у [`searches.yaml`](searches.yaml).
   Сторінки категорій (`/uk/legkovie/toyota/...`) не підходять.
2. **Telegram-бот.** Створіть бота в [@BotFather](https://t.me/BotFather) і отримайте токен.
   Напишіть боту будь-що, потім відкрийте
   `https://api.telegram.org/bot<TOKEN>/getUpdates` і візьміть `message.chat.id`.
3. **Секрети репозиторію** (Settings → Secrets and variables → Actions):
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
4. **GitHub Pages:** Settings → Pages → Source: **GitHub Actions**.
5. **Перевірка доступу з GitHub:** Actions → `daily` → Run workflow → увімкнути `probe`.
   Якщо в лозі `probe ok: ... total=N parsed=N`, сайт віддає дані на IP GitHub.
6. Перший повний запуск (`daily` без `probe`) лише фіксує поточний стан, без «нових».
   Далі все працює саме щодня о 09:00 UTC (12:00 Київ улітку / 11:00 взимку).

## Локально

```sh
npm ci
npm test                 # офлайн-тести на фікстурах
npm run probe            # перший пошук із searches.yaml, без запису в БД
npm run track            # повний запуск; без TELEGRAM_* повідомлення друкуються в консоль
npm run dashboard        # data/autoria.db -> site/
```

Змінні: `DB_PATH` (типово `data/autoria.db`), `SEARCHES_PATH` (`searches.yaml`),
`DASHBOARD_URL` (типово `https://<owner>.github.io/<repo>/`).

## Як це працює

- Звичайні HTTP-запити з паузами 1–3 с, дані з вбудованого JSON сторінок (`window.__PINIA__`).
  Платний API і браузер не потрібні. При 403/429/капчі запуск переривається, і в БД нічого
  не пишеться.
- Ціни порівнюються у валюті продавця. USD-ціна гривневих оголошень «плаває» з курсом,
  тож порівнювати її не можна.
- Зникле оголошення перевіряється на його сторінці: неактивне → «продано»
  (сайт не розрізняє продаж і видалення), активне → «вийшло з фільтра».
- Перевиставлене авто (той самий VIN або номер) не рахується новим, історія спільна.
- База `data/autoria.db` (SQLite) комітиться в репозиторій після кожного запуску.

## Обмеження

- GitHub вимикає розклад у репозиторіях без активності 60 днів. Щоденні коміти бази
  мають це покривати, але якщо розклад вимкнеться, увімкніть його в Actions.
- Якщо auto.ria.com змінить верстку, парсер упаде голосно (повідомлення в Telegram),
  а не збере порожні дані.
