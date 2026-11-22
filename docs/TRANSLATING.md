# Translating Aegis

## Translate on Weblate

Translators work on [Weblate](https://hosted.weblate.org/projects/aegis/app/), in a web browser. Nothing to install.

1. Open the [Aegis translation page](https://hosted.weblate.org/engage/aegis/) and sign in with GitHub or an email address.
2. Pick a language to improve, or add a new one.
3. Translate. Weblate sends your changes to Aegis as a pull request.

Please follow the rules below.

## Rules for translations

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

Do not add `sr_Latn` in Weblate: Serbian Latin is generated from Cyrillic.

## Adding a language to the app

A language added on Weblate does not show up in Aegis until these code steps are done.

1. Copy `locales/en.json` to `locales/<code>.json` and translate it (or add the language in
   Weblate and take its file).
2. In `apps/agent/src/i18n.rs`: add the code to `LANGUAGES`, an `include_str!` for the file, a
   branch in `catalog()` and, if needed, its plural rule in `plural_form()` and its OS locale
   names in `from_locale()`.
3. Add an `<option>` with the language's own name to the Language box in
   `apps/ui/frontend/index.html`.

## Maintainers

Weblate component settings (project `aegis`, component `app`): file format "i18next JSON file v4", file mask `locales/*.json`, monolingual base file `locales/en.json`. Weblate pushes changes as pull requests. The GitHub webhook `https://hosted.weblate.org/hooks/github/` is installed, so Weblate sees new English texts.
