//! Printable passphrase sheet for one backup: name, a blank to write the passphrase on, and
//! restore steps, in the chosen language. Contains no secrets; the app shows it and prints it
//! itself (opening an .html file depends on whatever app the desktop has for it). Never
//! written to the drive (the backup name may be private).

pub struct SheetInfo<'a> {
    pub instance_id: &'a str,
    pub label: &'a str,
    pub drive_label: Option<&'a str>,
    pub created: &'a str,
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn render(info: &SheetInfo) -> String {
    let label = esc(info.label);
    let drive = esc(info.drive_label.unwrap_or("—"));
    let id = esc(info.instance_id);
    let created = esc(info.created);
    // Translations come from volunteers: escaped like any other untrusted text.
    let t = |key: &str| esc(&crate::i18n::t(key));
    let lang = crate::i18n::language();
    let (title, name, drive_h, id_h, printed) = (
        t("sheet_title"),
        t("name"),
        t("drive"),
        t("sheet_backup_id"),
        t("sheet_printed"),
    );
    let (pass, by_hand, warning) = (
        t("passphrase"),
        t("sheet_write_by_hand"),
        t("sheet_warning"),
    );
    let steps: String = [
        crate::i18n::t("sheet_step_plug_in"),
        crate::i18n::tr(
            "sheet_step_with_aegis",
            &[("restore", &crate::i18n::t("restore"))],
        ),
        crate::i18n::tr(
            "sheet_step_without_aegis",
            &[("readme", &crate::i18n::t("kit_readme"))],
        ),
        crate::i18n::t("sheet_step_passphrase"),
    ]
    .iter()
    .map(|s| format!("<li>{}</li>\n", esc(s)))
    .collect();
    let restore_h = t("sheet_getting_files_back");
    format!(
        r#"<!doctype html>
<html lang="{lang}"><head><meta charset="utf-8"><title>{title} – {label}</title>
<style>
body {{ font: 14px/1.5 system-ui, sans-serif; max-width: 720px; margin: 32px auto; color: #000; }}
h1 {{ font-size: 22px; margin-bottom: 4px; }}
table {{ border-collapse: collapse; margin: 16px 0; }}
td {{ padding: 4px 16px 4px 0; vertical-align: top; }}
.blank {{ border-bottom: 1px solid #000; height: 36px; margin: 8px 0; }}
.box {{ border: 2px solid #000; padding: 12px 16px; margin: 16px 0; }}
ol {{ padding-left: 20px; }}
</style></head><body>
<h1>{title}</h1>
<table>
<tr><td>{name}</td><td><b>{label}</b></td></tr>
<tr><td>{drive_h}</td><td>{drive}</td></tr>
<tr><td>{id_h}</td><td><code>{id}</code></td></tr>
<tr><td>{printed}</td><td>{created}</td></tr>
</table>
<div class="box">
<b>{pass}</b> {by_hand}
<div class="blank"></div><div class="blank"></div>
{warning}
</div>
<h2>{restore_h}</h2>
<ol>
{steps}</ol>
</body></html>
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sheet_escapes_label() {
        let html = render(&SheetInfo {
            instance_id: "ab12",
            label: "<script>x</script> & Co",
            drive_label: None,
            created: "2026-11-20",
        });
        assert!(html.contains("&lt;script&gt;x&lt;/script&gt; &amp; Co"));
        assert!(!html.contains("<script>x"));
    }
}
