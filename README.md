# زیرنویس فارسی Coursera

اکستنشن کروم که در لحظه، زیرنویس ویدیوهای Coursera را فارسی می‌کند و
به‌صورت دوزبانه (فارسی بالا، انگلیسی اصلی زیرش) روی خود پلیر نشان می‌دهد.

![زیرنویس دوزبانه روی پلیر Coursera](docs/player.png)

## چطور کار می‌کند

منبع متن، **زیرنویس انگلیسی خود Coursera** است، نه تشخیص گفتار. اکستنشن
تراک زیرنویس را روی عنصر `<video>` پیدا می‌کند (`video.textTracks`)، آن را
در حالت `hidden` می‌گذارد تا کیوها با تایمینگ دقیق لود شوند بدون اینکه
مرورگر رسمشان کند، و بعد خودش روی ویدیو رسم می‌کند.

ترجمه با **Google AI (Gemini)** انجام می‌شود:

- کل زیرنویس در دسته‌های ۴۰ خطی فرستاده می‌شود، نه خط‌به‌خط، تا جمله‌هایی
  که در چند کیو شکسته شده‌اند درست ترجمه شوند.
- سه خط قبل از هر دسته به‌عنوان زمینه فرستاده می‌شود (ترجمه نمی‌شود).
- خروجی با `responseSchema` به‌شکل آرایه‌ی رشته اجبار می‌شود تا تعداد خط‌ها
  با ورودی یکی بماند.
- اول دسته‌ای ترجمه می‌شود که پخش همان‌جاست، بعد جلو می‌رود و آخر به عقب
  برمی‌گردد — پس لازم نیست منتظر ترجمه‌ی کل ویدیو بمانید.
- هر دسته در `chrome.storage.local` کش می‌شود؛ تماشای دوباره‌ی همان ویدیو
  هیچ درخواستی به API نمی‌فرستد.

تا وقتی ترجمه‌ی یک خط نرسیده، همان خط انگلیسی نمایش داده می‌شود تا صفحه
خالی نماند.

## نصب

۱. کروم → `chrome://extensions`
۲. **Developer mode** را روشن کنید.
۳. **Load unpacked** → همین پوشه را انتخاب کنید.

## تنظیم کلید

۱. کلید رایگان را از <https://aistudio.google.com/apikey> بگیرید.
۲. روی آیکن اکستنشن بزنید، کلید را در کادر «کلید Google AI» بگذارید و
   **ذخیره** کنید.
۳. با دکمه‌ی **آزمایش کلید** درستی‌اش را بسنجید؛ با **مدل‌ها** فهرست
   مدل‌های در دسترس کلیدتان را بگیرید.

کلید فقط در همین مرورگر ذخیره می‌شود و تنها service worker آن را می‌خواند؛
content script هرگز کلید را نمی‌بیند.

## تنظیمات popup

![پنل تنظیمات اکستنشن](docs/popup.png)

| گزینه | کار |
|---|---|
| فعال | روشن/خاموش کردن کامل زیرنویس |
| نمایش متن انگلیسی | نشان دادن یا پنهان کردن خط انگلیسی زیر فارسی |
| اندازه‌ی قلم | بزرگی متن فارسی (انگلیسی متناسب با آن) |
| فاصله از پایین | جابه‌جایی عمودی برای اینکه روی نوار کنترل نیفتد |
| مدل | مدل Gemini؛ پیش‌فرض `gemini-2.5-flash` |
| پاک کردن کش | خالی کردن ترجمه‌های ذخیره‌شده |

اندازه‌ی قلم و فاصله با عرض پلیر مقیاس می‌شوند، پس در حالت تمام‌صفحه هم
درست می‌ماند.

## محدودیت‌ها

- ویدیویی که زیرنویس انگلیسی ندارد ترجمه نمی‌شود؛ پیام «این ویدیو زیرنویس
  انگلیسی ندارد» نشان داده می‌شود.
- سهمیه‌ی رایگان Google AI محدودیت نرخ دارد. اگر به آن بخوردید، پیام خطا
  روی ویدیو می‌آید و اکستنشن با تأخیر دوباره تلاش می‌کند.

## فایل‌ها

| فایل | نقش |
|---|---|
| `content.js` | پیدا کردن ویدیو و تراک، برداشت کیوها، ساخت پوشش، هم‌زمانی |
| `background.js` | تماس با Gemini، دسته‌بندی، کش، تلاش دوباره |
| `overlay.css` | ظاهر زیرنویس |
| `popup.html/js` | تنظیمات و مدیریت کلید |

---

## In English

A Chrome extension that adds live Persian subtitles to Coursera videos.

It reads Coursera's own English caption track from the `<video>` element
(`video.textTracks`, kept in `hidden` mode so cues load with exact timings
without the browser rendering them), translates the cues with the Google AI
(Gemini) API, and draws a bilingual overlay on the player — Persian on top,
the original English underneath.

Translation runs in batches of 40 cues with three preceding lines as context,
uses a JSON array `responseSchema` so the line count always matches, starts
from the batch you are currently watching, and caches every batch in
`chrome.storage.local` so re-watching costs nothing.

Bring your own free API key from <https://aistudio.google.com/apikey>. The key
is stored locally and only ever read by the service worker.

MIT licensed.
