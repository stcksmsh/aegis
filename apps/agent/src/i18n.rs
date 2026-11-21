//! Translations. One i18next-style JSON file per language in `locales/` (the format Weblate and
//! Crowdin read); English is the source and the fallback for anything missing. Serbian Latin is
//! made from the Cyrillic file letter by letter, so translators keep only one Serbian file.
//! The app's screens get the whole catalog from `GET /v1/i18n`.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

/// Language codes the user can pick, in menu order.
pub const LANGUAGES: [&str; 3] = ["en", "sr", "sr-Latn"];

const EN: &str = include_str!("../../../locales/en.json");
const SR: &str = include_str!("../../../locales/sr.json");

static CURRENT: RwLock<&'static str> = RwLock::new("en");

/// Set the language from the saved choice; `None` or unknown = the computer's language.
pub fn set_language(choice: Option<&str>) {
    let lang = choice
        .and_then(|c| LANGUAGES.iter().find(|l| **l == c).copied())
        .unwrap_or_else(system_language);
    *CURRENT.write().unwrap_or_else(|e| e.into_inner()) = lang;
}

pub fn language() -> &'static str {
    *CURRENT.read().unwrap_or_else(|e| e.into_inner())
}

fn system_language() -> &'static str {
    let lang = from_locale(sys_locale::get_locale().as_deref().unwrap_or("en"));
    // Linux writes Serbian Latin as "sr_RS@latin", and sys-locale drops the "@latin".
    let latin = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .any(|v| std::env::var(v).is_ok_and(|s| s.contains("@latin")));
    if lang == "sr" && latin {
        "sr-Latn"
    } else {
        lang
    }
}

/// Map an OS locale ("sr-RS", "sr_RS@latin", "sr-Latn-RS", "en-US") to one of `LANGUAGES`.
fn from_locale(locale: &str) -> &'static str {
    let l = locale.to_ascii_lowercase();
    if l == "sr" || l.starts_with("sr-") || l.starts_with("sr_") {
        if l.contains("latn") || l.contains("latin") {
            "sr-Latn"
        } else {
            "sr"
        }
    } else {
        "en"
    }
}

/// Flattened catalog for `lang` ("a.b_one" keys), English underneath, cached.
pub fn catalog(lang: &str) -> &'static HashMap<String, String> {
    static CACHE: [OnceLock<HashMap<String, String>>; 3] =
        [OnceLock::new(), OnceLock::new(), OnceLock::new()];
    let i = LANGUAGES.iter().position(|l| *l == lang).unwrap_or(0);
    CACHE[i].get_or_init(|| {
        let mut map = flatten(EN);
        match LANGUAGES[i] {
            "sr" => map.extend(flatten(SR)),
            "sr-Latn" => map.extend(flatten(SR).into_iter().map(|(k, v)| (k, to_latin(&v)))),
            _ => {}
        }
        map
    })
}

pub(crate) fn flatten(json: &str) -> HashMap<String, String> {
    fn walk(prefix: &str, v: &Value, out: &mut HashMap<String, String>) {
        match v {
            Value::Object(m) => {
                for (k, v) in m {
                    let key = if prefix.is_empty() {
                        k.clone()
                    } else {
                        format!("{prefix}.{k}")
                    };
                    walk(&key, v, out);
                }
            }
            // Empty = not translated yet (Weblate writes those): fall back to English.
            Value::String(s) if !s.is_empty() => {
                out.insert(prefix.to_string(), s.clone());
            }
            _ => {}
        }
    }
    let mut out = HashMap::new();
    walk(
        "",
        &serde_json::from_str(json).expect("locale file is valid JSON"),
        &mut out,
    );
    out
}

/// Text for `key` in the current language, with `{{name}}` filled from `args`.
pub fn tr(key: &str, args: &[(&str, &str)]) -> String {
    let mut s = catalog(language())
        .get(key)
        .cloned()
        .unwrap_or_else(|| key.to_string());
    for (name, value) in args {
        s = s.replace(&format!("{{{{{name}}}}}"), value);
    }
    s
}

pub fn t(key: &str) -> String {
    tr(key, &[])
}

/// Text that depends on a number (`key_one`, `key_few`, `key_other`); `{{count}}` is filled in.
pub fn tn(key: &str, count: u64, args: &[(&str, &str)]) -> String {
    let lang = language();
    let cat = catalog(lang);
    let form = plural_form(lang, count);
    let full = [format!("{key}_{form}"), format!("{key}_other")]
        .into_iter()
        .find(|k| cat.contains_key(k))
        .unwrap_or_else(|| key.to_string());
    let n = count.to_string();
    let mut all = vec![("count", n.as_str())];
    all.extend_from_slice(args);
    tr(&full, &all)
}

/// CLDR plural category for whole numbers.
fn plural_form(lang: &str, n: u64) -> &'static str {
    if lang.starts_with("sr") {
        match (n % 10, n % 100) {
            (1, m) if m != 11 => "one",
            (2..=4, m) if !(12..=14).contains(&m) => "few",
            _ => "other",
        }
    } else if n == 1 {
        "one"
    } else {
        "other"
    }
}

/// Serbian Cyrillic to Latin (exact in this direction).
pub fn to_latin(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, c) in chars.iter().enumerate() {
        let next_upper = chars.get(i + 1).is_some_and(|n| n.is_uppercase());
        let pair = |cap: &str, lower: &str| {
            if next_upper {
                cap.to_string()
            } else {
                lower.to_string()
            }
        };
        let mapped = match c {
            'Љ' => pair("LJ", "Lj"),
            'Њ' => pair("NJ", "Nj"),
            'Џ' => pair("DŽ", "Dž"),
            'љ' => "lj".into(),
            'њ' => "nj".into(),
            'џ' => "dž".into(),
            _ => {
                let lower = c.to_lowercase().next().unwrap_or(*c);
                let l = match lower {
                    'а' => 'a',
                    'б' => 'b',
                    'в' => 'v',
                    'г' => 'g',
                    'д' => 'd',
                    'ђ' => 'đ',
                    'е' => 'e',
                    'ж' => 'ž',
                    'з' => 'z',
                    'и' => 'i',
                    'ј' => 'j',
                    'к' => 'k',
                    'л' => 'l',
                    'м' => 'm',
                    'н' => 'n',
                    'о' => 'o',
                    'п' => 'p',
                    'р' => 'r',
                    'с' => 's',
                    'т' => 't',
                    'ћ' => 'ć',
                    'у' => 'u',
                    'ф' => 'f',
                    'х' => 'h',
                    'ц' => 'c',
                    'ч' => 'č',
                    'ш' => 'š',
                    _ => {
                        out.push(*c);
                        continue;
                    }
                };
                if c.is_uppercase() {
                    l.to_uppercase().collect()
                } else {
                    l.to_string()
                }
            }
        };
        out.push_str(&mapped);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn placeholders(s: &str) -> BTreeSet<String> {
        s.split("{{")
            .skip(1)
            .filter_map(|p| p.split_once("}}").map(|(n, _)| n.trim().to_string()))
            .collect()
    }

    fn base(key: &str) -> &str {
        for suffix in ["_zero", "_one", "_two", "_few", "_many", "_other"] {
            if let Some(b) = key.strip_suffix(suffix) {
                return b;
            }
        }
        key
    }

    #[test]
    fn serbian_matches_english() {
        let en = flatten(EN);
        let sr = flatten(SR);
        let en_bases: BTreeSet<&str> = en.keys().map(|k| base(k)).collect();
        let sr_bases: BTreeSet<&str> = sr.keys().map(|k| base(k)).collect();
        let missing: Vec<_> = en_bases.difference(&sr_bases).collect();
        let unknown: Vec<_> = sr_bases.difference(&en_bases).collect();
        assert!(missing.is_empty(), "missing in sr.json: {missing:?}");
        assert!(unknown.is_empty(), "not in en.json: {unknown:?}");
        for (k, v) in &sr {
            let en_v = en
                .get(k)
                .or_else(|| en.get(&format!("{}_other", base(k))))
                .unwrap_or_else(|| panic!("no English for {k}"));
            let mut want = placeholders(en_v);
            want.remove("count");
            let mut got = placeholders(v);
            got.remove("count");
            assert_eq!(got, want, "placeholders differ for {k}");
        }
    }

    #[test]
    fn latin_and_plurals() {
        assert_eq!(
            to_latin("Љиљана ЏЕП Ђорђе {{name}}"),
            "Ljiljana DŽEP Đorđe {{name}}"
        );
        assert_eq!(plural_form("sr", 1), "one");
        assert_eq!(plural_form("sr", 3), "few");
        assert_eq!(plural_form("sr", 12), "other");
        assert_eq!(plural_form("sr", 21), "one");
        assert_eq!(from_locale("sr_RS@latin"), "sr-Latn");
        assert_eq!(from_locale("sr-RS"), "sr");
        assert_eq!(from_locale("en-US"), "en");
    }
}
