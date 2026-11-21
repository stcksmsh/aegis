# Translating Aegis

Every text Aegis shows lives in `locales/`: one JSON file per language, in the i18next format
that Weblate and Crowdin read.

- `locales/en.json` is the source. New texts are added here first; anything missing from
  another language shows in English.
- `locales/sr.json` is Serbian in Cyrillic. Serbian Latin (`sr-Latn`) is made from it letter by
  letter, so there is no separate Latin file to keep up to date.
- `{{name}}` is filled in by Aegis: keep it as is, wherever it fits in your sentence.
- Keys ending in `_one`, `_few`, `_other` are plural forms ("1 копија / 2 копије / 5 копија").
  Weblate shows the forms your language needs.
- `kit_readme` is the name of the restore instructions file on the drive for that language
  (`README.txt`, `PROCITAJ.txt`).
- `erase_word` is the word people type to confirm erasing a drive. The English `ERASE` always
  works as well.
- Plain text only: no HTML. Aegis shows every translation as text.

`cargo test` checks that `sr.json` has every key of `en.json` and the same `{{…}}` values.

## Adding a language

1. Copy `locales/en.json` to `locales/<code>.json` and translate it (or add the language in
   Weblate).
2. In `apps/agent/src/i18n.rs`: add the code to `LANGUAGES`, an `include_str!` for the file, a
   branch in `catalog()` and, if needed, its plural rule in `plural_form()` and its OS locale
   names in `from_locale()`.
3. Add an `<option>` with the language's own name to the Language box in
   `apps/ui/frontend/index.html`.

## Weblate (volunteer translators)

Aegis is open source, so hosted Weblate is free (https://hosted.weblate.org, "Libre" plan).

1. Sign in with GitHub and create a project "Aegis".
2. Add a component: source code repository `https://github.com/stcksmsh/aegis`, branch
   `master`, file format "i18next JSON file v4", file mask `locales/*.json`, monolingual base
   language file `locales/en.json`.
3. Give Weblate push access the way it suggests (a pull request per batch is the safest), and
   add its webhook to the GitHub repository so it sees new English texts.
4. Do not add `sr_Latn` in Weblate: Serbian Latin is generated from Cyrillic.
