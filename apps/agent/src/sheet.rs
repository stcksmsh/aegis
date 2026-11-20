//! Printable passphrase sheet for one backup: name, a blank to write the passphrase on, and
//! restore steps (English + Serbian). Contains no secrets; written to the temp folder and opened
//! in the browser for printing. Never written to the drive (the backup name may be private).

use anyhow::Context;
use std::path::PathBuf;

pub struct SheetInfo<'a> {
    pub instance_id: &'a str,
    pub label: &'a str,
    pub drive_label: Option<&'a str>,
    pub created: &'a str,
}

pub fn write_sheet(info: &SheetInfo) -> anyhow::Result<PathBuf> {
    let short: String = info.instance_id.chars().take(8).collect();
    let path = std::env::temp_dir().join(format!("aegis-passphrase-sheet-{short}.html"));
    std::fs::write(&path, render(info)).context("write passphrase sheet")?;
    Ok(path)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn render(info: &SheetInfo) -> String {
    let label = esc(info.label);
    let drive = esc(info.drive_label.unwrap_or("—"));
    let id = esc(info.instance_id);
    let created = esc(info.created);
    format!(
        r#"<!doctype html>
<html><head><meta charset="utf-8"><title>Aegis passphrase sheet – {label}</title>
<style>
body {{ font: 14px/1.5 system-ui, sans-serif; max-width: 720px; margin: 32px auto; color: #000; }}
h1 {{ font-size: 22px; margin-bottom: 4px; }}
table {{ border-collapse: collapse; margin: 16px 0; }}
td {{ padding: 4px 16px 4px 0; vertical-align: top; }}
.blank {{ border-bottom: 1px solid #000; height: 36px; margin: 8px 0; }}
.box {{ border: 2px solid #000; padding: 12px 16px; margin: 16px 0; }}
ol {{ padding-left: 20px; }}
.cols {{ display: flex; gap: 32px; }} .cols > div {{ flex: 1; }}
@media print {{ button {{ display: none; }} }}
</style></head><body>
<button onclick="window.print()">Print</button>
<h1>Aegis backup – passphrase sheet</h1>
<table>
<tr><td>Name / Naziv</td><td><b>{label}</b></td></tr>
<tr><td>Drive / Disk</td><td>{drive}</td></tr>
<tr><td>Backup ID</td><td><code>{id}</code></td></tr>
<tr><td>Printed / Odštampano</td><td>{created}</td></tr>
</table>
<div class="box">
<b>Passphrase / Lozinka</b> (write it by hand / upišite rukom):
<div class="blank"></div><div class="blank"></div>
Without the passphrase nobody can open the backup, not even the person who set it up.
Keep this sheet in a safe place, <b>never together with the drive</b>.<br>
Bez lozinke niko ne može da otvori bekap. Čuvajte ovaj list na sigurnom mestu,
<b>nikada zajedno sa diskom</b>.
</div>
<div class="cols">
<div><h2>Getting files back</h2><ol>
<li>Plug in the drive.</li>
<li>With Aegis: open Aegis → Restore.</li>
<li>Without Aegis: open the <b>AEGIS-RESTORE</b> folder on the drive and follow <b>README.txt</b>
(Windows: restore-windows.bat, Mac: restore-mac.command).</li>
<li>Type the passphrase. Files go into a new folder on the Desktop; nothing is overwritten.</li>
</ol></div>
<div><h2>Vraćanje fajlova</h2><ol>
<li>Uključite disk.</li>
<li>Sa Aegis-om: otvorite Aegis → Restore.</li>
<li>Bez Aegis-a: otvorite folder <b>AEGIS-RESTORE</b> na disku i pratite <b>PROCITAJ.txt</b>
(Windows: restore-windows.bat, Mac: restore-mac.command).</li>
<li>Upišite lozinku. Fajlovi idu u novi folder na radnoj površini; ništa se ne prepisuje.</li>
</ol></div>
</div>
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
