# Running the Aegis agent as a service

Running the agent as a long-lived service (e.g. under systemd) lets it:

- Detect USB drives as soon as you plug them in
- Run auto-backup when a trusted drive is inserted (if enabled)
- Stay available so the UI can connect without you starting the agent manually

## Linux (systemd)

1. Build and install the agent binary, e.g.:

   ```bash
   cargo build -p aegis-agent --release
   sudo cp target/release/aegis-agent /usr/local/bin/
   # or: install to a path of your choice and use that path below
   ```

2. Install the user service (runs for your user, not root):

   ```bash
   mkdir -p ~/.config/systemd/user
   cp contrib/aegis-agent.service ~/.config/systemd/user/
   # Edit ExecStart in the service file if the binary is elsewhere (e.g. /usr/local/bin/aegis-agent).
   ```

3. Enable and start:

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable aegis-agent
   systemctl --user start aegis-agent
   systemctl --user status aegis-agent
   ```

4. To have the agent start at login (even without a session), enable lingering:

   ```bash
   loginctl enable-linger $USER
   ```

Logs: `journalctl --user -u aegis-agent -f`

**Notifications:** When the agent runs as a service, it can show desktop notifications (on Linux, via `notify-send`) for backup started, backup finished, and trusted drive connected. Ensure `notify-send` is available (e.g. `libnotify-bin` on Debian/Ubuntu).

## Without a service

You can still run the agent manually when you need it:

```bash
cargo run -p aegis-agent
```

Then open the Aegis UI. USB detection and backups work only while the agent process is running.
