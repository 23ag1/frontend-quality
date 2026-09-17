# Interface copy

Text is part of the interface, not a caption attached to it. A bad phrase costs
more than a crooked margin: a margin annoys, a phrase leads to a mistake.

## Buttons

**A verb with a noun, not "OK".** The button names the result it produces: "Send
order", "Delete guest", "Save and exit". The person should understand the
consequence without reading the dialog title.

- One primary action. The secondary one is styled weaker: a text button, not a
  second primary.
- "Cancel" cancels; "Close" closes. If a button does both, work out which one it
  actually does.
- A dangerous action is named plainly: not "Continue" but "Delete order". The
  confirmation repeats the consequence instead of asking "are you sure?".

## Errors

An error must answer three questions: **what happened, what it means, what to do
about it.** In that order, in one or two lines.

| Bad | Good |
|---|---|
| "An error occurred" | "The item did not reach the kitchen. Send it again" |
| "Please try again" | "Connection lost. The order is saved and will be sent when you are back online" |
| "Validation error" | "Table number takes digits only" |

An error must not report success: if the system did not confirm the operation, the
interface says so instead of drawing a tick. That is the most expensive class of
interface lying — the person walks away believing the job is done.

## Empty states

An empty screen is not an error, it is a state, and it has text: why it is empty
and what can be done. "No data" is not text. "No orders yet. New ones appear when
guests are seated" is text.

Separate two different cases: **empty because nothing has been created yet**
(teach the first step) and **empty because a filter found nothing** (offer to
change the filter).

## Waiting

- Under 200 ms — show nothing.
- 200 ms to 2 s — a skeleton with the same geometry as the content to come.
- Longer — say what is happening: "Sending to the kitchen…".

The skeleton has to match what appears, otherwise the layout jumps on load and
that reads as a glitch.

## The user's language only

Visible text must never contain:

- internal terms and field names: `SKU`, `product_id`, `payload`, "endpoint",
  "handler", "backend", "the server returned";
- the names of **other** venues, projects or clients;
- explanations of how the engine calculates and over how many days;
- service `notes` and `detail` fields from API responses — those must never be
  rendered at all, only your own human copy.

The reason is threefold: it exposes how the system is built, it hands your work to
competitors, and it announces that the text was not written by a person.

| Instead of | Write |
|---|---|
| "Will appear after the backend update" | "Not available yet" |
| "Error 422 during validation" | "Check the table number" |
| "The backend cannot count several items" | "Only part of your selection was counted — pick one item or try again later" |

This is checked automatically: a vocabulary of banned words in
`check-forbidden.sh`, configurable per project language in `.uiverify.json`
(`lexicon`, `lexiconFields`). A legitimate exception is marked with
`ui-lexicon-ok` in a comment above the line.

## Tone

- Calm and businesslike. No exclamation marks, no cheerfulness, no apologising at
  every step.
- In the user's domain language: "table", "guest", "item" — not "entity",
  "object", "record".
- No slang and no officialese. "Effectuate a dispatch" is officialese; "ping it to
  the kitchen" is slang; "Send to the kitchen" is what you want.
- Consistency beats elegance: one action is named the same way everywhere in the
  product. Synonyms in an interface read as different actions.

## Numbers, dates, units

- Format through `Intl`, not by concatenation: the first change of language or
  currency breaks anything else.
- The unit always sits next to the number, in the same rhythm across the product.
- Zero is not empty: "$0" and "no data" mean different things and must not be
  conflated. A lone dash in place of a value reads as a failure; write "no data".

## Length

Interface text is often twice as long as in the mock: "Send" against "Send the
selected items". Buttons, headings and list rows are checked on the longest real
variant, not on the exemplary one. Otherwise you get wrapping, clipping without an
ellipsis, or a card the name escapes from.
