/* frontend-quality:compat
 *
 * FIRST SCRIPT. Polyfills for what neither the bundler nor the framework
 * provides, run before the bundle so that the very first request already has
 * them. The marker on the first line tells check-browser-floor.mjs that the
 * APIs below are covered; keep it when you copy the file.
 *
 * Why. The network layer calls AbortSignal.timeout on every request. Without it
 * (Chrome < 103, Safari < 16) every request threw TypeError before it was sent —
 * the app did not work at all. AbortSignal.any (Chrome < 116, Safari < 17.4)
 * broke a screen that combined "the user left" with "the server is silent".
 *
 * Rules for this file:
 *   - ES5 only: it is not transpiled, it runs as written on the oldest engine;
 *   - it touches nothing where the feature exists;
 *   - it never throws: a failure here must not take the page down with it.
 *
 * How to include it — inline, first in <head>, before any bundle script:
 *
 *   Next.js (App Router), app/layout.tsx — a server component, so the file is
 *   read once at build or render time:
 *
 *     import { readFileSync } from "node:fs";
 *     import { join } from "node:path";
 *     const COMPAT = readFileSync(join(process.cwd(), "src/compat-script.js"), "utf8");
 *
 *     <html lang="en">
 *       <head>
 *         <script dangerouslySetInnerHTML={{ __html: COMPAT }} />
 *       </head>
 *       <body>{children}</body>
 *     </html>
 *
 *   (or keep it as a string constant in a .ts file with this marker comment
 *   above it). A plain inline script in <head> is the simplest form that runs
 *   before the bundle without depending on how the framework schedules scripts.
 *
 *   Vite / plain HTML, index.html — paste the file into a classic script above
 *   the module entry (module scripts are deferred, so this runs first):
 *
 *     <head>
 *       <script>/* contents of this file *\/</script>
 *       <script type="module" src="/src/main.tsx"></script>
 *     </head>
 *
 *   With a Content-Security-Policy, allow it by hash ('sha256-…') or nonce.
 *
 * Check: with the floor declared, `node check-browser-floor.mjs src` lists these
 * APIs under "Polyfilled by the first script" instead of blocking on them.
 */
(function () {
  try {
    if (typeof AbortController === 'undefined' || typeof AbortSignal === 'undefined') return;

    // The same error a native timeout produces, so code that tells "the server
    // did not answer" (TimeoutError) from "the user cancelled" (AbortError)
    // keeps working.
    var timeoutError = function () {
      try {
        return new DOMException('signal timed out', 'TimeoutError');
      } catch (e) {
        var err = new Error('signal timed out');
        err.name = 'TimeoutError';
        return err;
      }
    };

    // AbortSignal.timeout: Chrome 103, Safari 16.
    if (typeof AbortSignal.timeout !== 'function') {
      AbortSignal.timeout = function (ms) {
        var controller = new AbortController();
        setTimeout(function () {
          controller.abort(timeoutError());
        }, ms);
        return controller.signal;
      };
    }

    // AbortSignal.any: Chrome 116, Safari 17.4. Aborts as soon as any of the
    // given signals aborts, with that signal's reason; listeners are removed
    // then, so long-lived signals do not collect them.
    if (typeof AbortSignal.any !== 'function') {
      AbortSignal.any = function (signals) {
        var controller = new AbortController();
        var list = typeof Array.from === 'function' ? Array.from(signals) : Array.prototype.slice.call(signals);
        var listeners = [];
        var cleanup = function () {
          for (var k = 0; k < listeners.length; k++) {
            listeners[k][0].removeEventListener('abort', listeners[k][1]);
          }
          listeners = [];
        };
        for (var i = 0; i < list.length; i++) {
          if (list[i].aborted) {
            controller.abort(list[i].reason);
            return controller.signal;
          }
        }
        for (var j = 0; j < list.length; j++) {
          (function (signal) {
            var onAbort = function () {
              cleanup();
              controller.abort(signal.reason);
            };
            signal.addEventListener('abort', onAbort);
            listeners.push([signal, onAbort]);
          })(list[j]);
        }
        return controller.signal;
      };
    }
  } catch (e) {
    /* never break the page from here */
  }
})();
