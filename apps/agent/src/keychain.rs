use anyhow::Context;
use keyring::Entry;

const SERVICE: &str = "Aegis";

pub fn store_passphrase(drive_id: &str, passphrase: &str) -> anyhow::Result<()> {
    let entry = Entry::new(SERVICE, drive_id).context("create keychain entry")?;
    entry.set_password(passphrase).context("store passphrase")?;
    Ok(())
}

pub fn get_passphrase(drive_id: &str) -> anyhow::Result<Option<String>> {
    let entry = Entry::new(SERVICE, drive_id).context("create keychain entry")?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err).context("load passphrase"),
    }
}

pub fn delete_passphrase(drive_id: &str) -> anyhow::Result<()> {
    let entry = Entry::new(SERVICE, drive_id).context("create keychain entry")?;
    match entry.delete_password() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err).context("delete passphrase"),
    }
}
