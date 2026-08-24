/**
 * What the server-rendered pages load — the auth screens, and nothing else.
 *
 * This application has two halves. The auth flows are pages: a form posts, the
 * server redirects, and `errors()` and `old()` need no client state at all. The
 * application behind them is the Vue router, and that boots from `main.ts`.
 *
 * Both halves are built by this one Vite project, because everything the browser
 * runs belongs in the client project. These two imports reach back into the
 * application rather than copying anything: the stylesheet and the passkey script
 * are still where the auth kit put them, and still the only copy.
 */
import '../../resources/css/app.css'
import '../../resources/js/app.ts'
