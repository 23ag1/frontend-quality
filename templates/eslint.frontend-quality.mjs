/**
 * ESLINT FRAGMENT. The text-level bans of frontend-quality as lint rules, so the
 * editor underlines them while the code is written instead of a gate rejecting
 * them afterwards. Flat config (ESLint 9).
 *
 * Use — copy this file next to eslint.config.mjs, then:
 *
 *   import frontendQuality from "./eslint.frontend-quality.mjs";
 *   export default [
 *     ...yourConfigs,
 *     ...frontendQuality,
 *   ];
 *
 * One catch. ESLint does not merge the options of a rule across config objects:
 * the last `no-restricted-syntax` wins whole. If your config already has one,
 * combine the selector lists instead of spreading the fragment over it:
 *
 *   import { restrictedSyntax } from "./eslint.frontend-quality.mjs";
 *   rules: { "no-restricted-syntax": ["error", ...yourSelectors, ...restrictedSyntax] }
 *
 * Fix the two placeholders below: NETWORK_LAYER (where fetch may be called) and
 * COLOUR_EXCEPTIONS (files that legitimately hold raw colours). The rules that
 * read TypeScript nodes (`as` on res.json()) need the TypeScript parser, which
 * typescript-eslint and eslint-config-next already set up.
 */

/** The one directory allowed to call fetch. */
export const NETWORK_LAYER = ["src/shared/api/**"];

/** Files where a raw colour is the point: theme tokens, brand marks, the
 *  browser theme colour in metadata (a CSS variable does not work there). */
export const COLOUR_EXCEPTIONS = ["src/**/tokens.*", "src/**/theme.*", "src/app/layout.tsx"];

// ---------------------------------------------------------------- colour
// A colour outside the token set does not follow the theme (dark mode, a
// rebrand) and multiplies: one project collected 358 hand-picked colours and
// 341 palette classes in half a year. Colours come from roles.
// HEX: all CSS lengths (#fff, #ffff, #ffffff, #ffffff80). A short form counts
// only as a whole string or after a bracket, colon or comma, so "order #123"
// in a sentence is not a colour.
const HEX = String.raw`/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$|[\[(:,]\s*#[0-9a-fA-F]{3,4}\b|#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/`;
// Tailwind's default palette: bg-blue-500 is a colour picked on the spot, not
// a role (danger, accent, muted).
const PALETTE = String.raw`/\b(?:text|bg|border|from|to|via|ring|placeholder|accent|fill|stroke|outline|divide|shadow|decoration|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/`;
const COLOUR_MSG =
  "A colour comes from a role token (text-danger, bg-surface, var(--color-…)). A raw HEX or a palette class ignores the theme. No role fits — add one to the tokens first.";

export const noRawColour = [
  { selector: `Literal[value=${HEX}]`, message: COLOUR_MSG },
  { selector: `TemplateElement[value.raw=${HEX}]`, message: COLOUR_MSG },
  { selector: `Literal[value=${PALETTE}]`, message: COLOUR_MSG },
  { selector: `TemplateElement[value.raw=${PALETTE}]`, message: COLOUR_MSG },
];

// ------------------------------------------------------- viewport units
// Chrome before 108 and Safari before 15.4 do not know dvh/svh/lvh: a bare
// 100dvh drops the whole declaration (a sheet loses its height), and
// calc(100dvh - var(--x)) is accepted by Chrome 106 at parse time and reset to
// auto later. Allowed: the unit as a var() fallback — var(--app-h, 100dvh) with
// a script that sets --app-h on old engines — and support checks.
// If your browser floor is Chrome 108+ / Safari 15.4+, delete this block.
// If your CSS redefines h-dvh / min-h-dvh inside @supports not (height: 1dvh),
// drop the class alternative (the second part of VIEW_UNIT).
const VIEW_UNIT = String.raw`/(?<![\d.])(?<!var\(\s*--[\w-]+\s*,\s*)\d*\.?\d+[dls]v[hw]\b|(?<![\w-])(?:min-|max-)?(?:h|w|size)-[dls]v[hw](?![\w-])/`;
const VIEW_MSG =
  "dvh/svh/lvh without a fallback: Chrome < 108 and Safari < 15.4 drop the declaration. Write var(--app-h, 100dvh) (a first script sets --app-h on old engines) or a class with an @supports fallback.";

export const noBareViewportUnits = [
  {
    // CSS.supports("height", "1dvh") is a check, not a height.
    selector: `Literal[value=${VIEW_UNIT}]:not(CallExpression[callee.object.name='CSS'][callee.property.name='supports'] > Literal)`,
    message: VIEW_MSG,
  },
  { selector: `TemplateElement[value.raw=${VIEW_UNIT}]`, message: VIEW_MSG },
];

// ------------------------------------------- network answers are not checked
// `await res.json() as Order[]` tells the compiler a story nobody verified: a
// server that returns {error} or null reaches .map() and the screen crashes far
// from the cause. Parse at the boundary (zod, valibot, a hand-written guard) and
// let the type come from the parser. `as unknown` is allowed: it is honest.
const CAST_MSG =
  "A cast is not validation: parse the response at the boundary (a schema or a type guard) and take the type from the parser.";
const JSON_CALL = "CallExpression[callee.property.name='json']";

export const noCastOnJson = [
  { selector: `TSAsExpression[typeAnnotation.type!='TSUnknownKeyword'] > AwaitExpression > ${JSON_CALL}`, message: CAST_MSG },
  { selector: `TSAsExpression[typeAnnotation.type!='TSUnknownKeyword'] > ${JSON_CALL}`, message: CAST_MSG },
  { selector: `TSTypeAssertion[typeAnnotation.type!='TSUnknownKeyword'] > AwaitExpression > ${JSON_CALL}`, message: CAST_MSG },
];

/** Everything this fragment puts into no-restricted-syntax. */
export const restrictedSyntax = [...noRawColour, ...noBareViewportUnits, ...noCastOnJson];
const restrictedSyntaxWithoutColour = [...noBareViewportUnits, ...noCastOnJson];

// ------------------------------------------------------- one network layer
// Every screen that calls fetch itself re-invents the timeout, the cancellation,
// the error model and the error text, and each copy drifts. A request without a
// timeout once hung a loading skeleton forever when a proxy cut the response.
// fetch lives in the network layer; screens call its client.
const FETCH_MSG = "Call the shared network client: it owns the timeout, cancellation and error model.";

export default [
  {
    files: ["**/*.{js,jsx,ts,tsx,mjs}"],
    rules: {
      "no-restricted-syntax": ["error", ...restrictedSyntax],
      "no-restricted-globals": ["error", { name: "fetch", message: FETCH_MSG }],
      "no-restricted-properties": [
        "error",
        { object: "window", property: "fetch", message: FETCH_MSG },
        { object: "globalThis", property: "fetch", message: FETCH_MSG },
        { object: "self", property: "fetch", message: FETCH_MSG },
      ],
    },
  },
  {
    // The network layer is where fetch belongs.
    files: NETWORK_LAYER,
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-properties": "off",
    },
  },
  {
    // Raw colours where they are the definition, not a use.
    files: COLOUR_EXCEPTIONS,
    rules: { "no-restricted-syntax": ["error", ...restrictedSyntaxWithoutColour] },
  },

  // ------------------------------------------------- APIs above the floor
  // eslint-plugin-compat reads browserslist from package.json and reports
  // Web APIs the oldest browser lacks (AbortSignal.any, structuredClone …).
  // Set the browserslist from real traffic, not from the bundler default:
  //   "browserslist": ["chrome >= 106", "safari >= 15"]
  // and declare what the first script polyfills, so it is not reported.
  // CSS is not covered by it: check-browser-floor.mjs scans that.
  //
  //   npm i -D eslint-plugin-compat
  //
  //   import compat from "eslint-plugin-compat";
  //   ...
  //   compat.configs["flat/recommended"],
  //   { settings: { polyfills: ["AbortSignal.timeout", "AbortSignal.any"] } },
];
