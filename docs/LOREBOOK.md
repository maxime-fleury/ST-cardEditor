# Lorebook activation semantics

`js/cardHealth.js` answers "which lorebook entries would actually fire?" so the
preview can say how many entries a card triggers on its own, and so a future
simulator can show the exact prompt text. This file records *what is modelled*
and *what is deliberately approximated*, because the two rules below are the
ones people get wrong when a card "does nothing" in chat.

Rule of thumb: an entry that never fires is silent. There is no error, no log —
the text simply never reaches the model.

## What IS modelled

For each entry, in this order:

1. `disable: true` → never fires. Checked first, before anything else.
2. `constant: true` → always fires, regardless of `key`. This is how "always in
   context" entries (the character's core facts) are written.
3. Otherwise at least one **primary key** must match the scanned text. `key` is
   either an array or a comma-separated string; a comma inside a key is
   therefore a separator, not part of the key.
4. `selective: true` → a **secondary key** (`keysecondary`) must match too.
5. Matching is case-insensitive by default, honours `caseSensitive`, and honours
   `matchWholeWords` (word boundaries) when set.

Insertion order is `order` ascending, tie-broken by declaration order. Entries
are grouped by `position`:

- `before_char` (or `0`) → goes before the character definition
- anything else, including the common `after_char` (`1`), → after it
- a numeric position `>= 3` ("at depth") → reported separately, since where it
  lands depends on the prompt builder, not on the card

## What is NOT modelled

- **Recursion.** SillyTavern can rescan inserted content so one entry's text
  triggers another (`recursive` / `preventRecursion` / the scan depth of the
  insertion). This module makes exactly one pass.
- **Scan depth and the token budget.** Which slice of the chat is scanned, and
  what happens when matched content exceeds the entry's token budget, is a
  prompt-builder policy that lives in the app, not in the card.
- **`selectiveLogic`.** The four modes (AND_ANY, NOT_ALL, NOT_ANY, NOT_ALL_NOT)
  are collapsed to "at least one secondary key matches". A card relying on
  NOT_* logic will be reported as firing when it would not, or the reverse.
- **Variable macros** (`{{getvar}}`, `{{setvar}}`) and `bias`/`group` scoping.

## The scan text

`simulate(card, haystack)` takes the text to match against:

- `haystack == null` → `CardHealth.cardText(card)`: name, description,
  personality, scenario, `first_mes`, every `alternate_greetings` entry,
  `mes_example`, `system_prompt` and `post_history_instructions` — i.e. the text
  the model can see with no chat at all. This is what the preview's "N entries
  trigger on this card alone" figure means. Lorebook `content`/`comment` are
  **not** part of it: an entry is never matched against another entry's text, so
  a book keyed only on its own wording reports zero.
- a string → the recent chat, which is what a live simulator should pass.
- `''` → matches nothing (an explicit empty haystack is not the same as `null`).
