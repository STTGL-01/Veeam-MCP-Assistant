# Veeam Assistant v1.0.0

**A web front end for Veeam's MCP servers.** Sign in from a browser, ask Veeam Intelligence questions, run Veeam Backup & Replication operations, and make sure a second person approves anything that changes or deletes something.

> **Not an official or supported Veeam product.** Veeam Assistant is a community project, provided as-is, with no warranty and no support from Veeam. **Try it in a lab first**, and read *What it can and cannot do* below before you point it at a production backup server.

## What it does

It adds one web page, with a **Server** box that offers two choices:

| Server | What it does |
|---|---|
| **Veeam Intelligence** | Type a question, get a written answer. Veeam's own AI on your VBR server does the work. |
| **Veeam Backup & Replication** | An **Operations…** list with **every VBR REST API operation**, generated from your own VBR's API definition, plus Veeam's vbr-mcp operations and four combined ones (find jobs, find backups, delete backup, delete job). Optionally, Claude can answer typed questions here too (Part J). |

- **Accounts.** People request an account, and an administrator approves it. Everything is recorded in an activity log.
- **Approvals.** Read operations run straight away. **Anything that changes or deletes something waits for a second person to approve it**, who sees exactly what will run. Nobody approves their own request.
- **Claude (optional).** With your own Claude API key, people can type a question in plain English and Claude chooses which operations to *request*. Claude never talks to VBR directly and cannot approve anything.

## Built on Veeam's MCP servers

This project builds on the open-source MCP servers that Veeam publishes at **https://github.com/veeam-ai/veeam-mcp-server**: `vi-mcp` (Veeam Intelligence) and `vbr-mcp` (a set of tools for the VBR REST API). Setup downloads them from Veeam's repository (step 8). They are not copied into this repository. The web front end, accounts, approvals and the generated REST operations list are what this repository adds.

Before you rely on `vbr-mcp`, read the safety section in [its own README](https://github.com/veeam-ai/veeam-mcp-server/tree/main/servers/vbr-mcp): some of its tools change state or can overwrite data.

## How it works

```text
Browser ──HTTPS──► Nginx ──► Veeam Assistant website (Docker)
                               accounts · approvals · activity log
                                   │
                                   ├── vi-mcp ─────► Veeam Intelligence on VBR (web UI, port 443)
                                   │
                                   └── "Veeam Backup & Replication"
                                         ├── vbr-mcp ───► VBR REST API (port 9419)
                                         └── vbr-extra ─► VBR REST API (port 9419)

      Optional: Claude (Anthropic API) chooses which operations to request.
                The website runs them, after approval where needed.
```

## What it can and cannot do

- **It is limited to what Veeam's servers and your VBR's REST API expose.** There is no "send any request" tool: only listed operations can be requested.
- **Reads run straight away. Changes and deletions wait for a person other than the requester.**
- **Deleting jobs and backups** is possible through the REST operations (Delete job, Delete backup from disk), each needing approval. Veeam Intelligence never deletes.
- **Restoring files** is possible through the file-level restore operations. A file cannot be downloaded to your browser.
- **With Claude on, the setup in this guide is read-write by default**: Claude can *ask* for changes and deletions, and each one still waits for an approver. Part O shows how to make it read-only.
- **Everything runs as the VBR accounts you configure.** Roles on the website do not become separate VBR permissions. Keep VBR's own four-eyes authorization on for destructive operations.

A fuller summary, with the limits explained, is in `docs/Veeam-Assistant-Summary.docx` (also as Markdown).

## Before you start

| You need | Details |
|---|---|
| **A Linux server** | Ubuntu, with `sudo`. **Tested on Ubuntu Server 26.04.1 LTS only.** Other distributions and versions are untested. |
| **Veeam Backup & Replication** | Reachable from that server on ports **443** and **9419**. **Tested with Veeam Backup & Replication 13.1.2.57 and REST API revision 1.3-rev2.** You do not need to know your REST API revision in advance: step 9 finds the one your VBR accepts, and step 10 downloads the matching definition. The Veeam Intelligence actions mode needs VBR 13.1 or later. |
| **A Veeam license** | An **active, non-Community license**, which Veeam's own MCP servers require. Check that your edition offers the REST API. |
| **Veeam Intelligence** | Enabled on VBR, for the Veeam Intelligence server. |
| **A VBR account** | A service account for the website to use, **without MFA**. It needs the **Veeam Backup Administrator** role to delete things. |
| **Network** | The server needs the internet for Docker, GitHub and Veeam's repository, and, only for Part J, `api.anthropic.com`. |
| **A site name and certificate** | The name people type to reach the site (step 27 creates the certificate). |
| **A Windows PC** | With PowerShell for `scp`, and a browser. Any computer with `scp` and a browser works. |
| **A Claude API key** *(optional)* | Your own, from the Claude Console, only for Part J. **None is included.** |

## How this guide is organised

| Part | What it covers | Steps |
|---|---|---|
| **Part A** | Start clean *(optional)* | 1–5 |
| **Part B** | Install the tools | 6–7 |
| **Part C** | Get the code and Veeam's API definition | 8–12 |
| **Part D** | Build | 13–18 |
| **Part E** | Settings files | 19–25 |
| **Part F** | Check the connections to VBR | 26 |
| **Part G** | Start it | 27–31 |
| **Part H** | First use | 32–36 |
| **Part I** | People and approvals | 37–42 |
| **Part J** | *(optional)* Let Claude answer questions on Veeam Backup & Replication | 43–46 |
| **Part K** | Day-to-day | — |
| **Part L** | If something fails | — |
| **Part M** | Security notes | — |
| **Part N** | Files | — |
| **Part O** | Turn Claude on or off, and choose read-write or read-only | O1–O9 |

## License and support

- **License:** MIT, see [LICENSE](LICENSE). Veeam's MCP servers are MIT-licensed by Veeam and are not part of this repository.
- **Support:** none. This is provided as-is.

---

## Installation guide (Veeam Assistant v1.0.0)

## What is in this repository

Everything this guide needs is here. Nothing else has to be downloaded except Veeam's own MCP servers (step 8) and one file from **your own VBR** (step 10).

| Folder | What it holds |
|---|---|
| `web/` | The website (Node.js) and its Dockerfile |
| `deploy/` | The build and run scripts, a sample Nginx configuration, and **example settings files** for every step in Part E |
| `mcp-extra/vbr-extra/` | The REST API server (version 2.0.1), which turns your VBR's own `swagger.json` into operations |
| `docs/` | A summary of what this is and where its limits are, as Word and Markdown |
| `README.md` | This guide |
| `LICENSE` | The MIT license for this project |

**Not in this repository, on purpose:** Veeam's own MCP servers (`vi-mcp` and `vbr-mcp`), which step 8 downloads from Veeam's repository; your VBR's `swagger.json` (step 10); and any password or API key. **This repository contains no credentials of any kind.**

## Your own Claude API key

Part J is optional. It lets Claude answer typed questions, and it needs **your own Claude API key**, from the Claude Console. This repository contains none. You enter yours on the Linux server in step 44. It is stored only in `/etc/veeam-assistant/app.env`, and it is never passed to the MCP servers. If you skip Part J, nothing is ever sent to Anthropic.

## How to use this file

- Run every step in order. Each grey block is **one** copy-paste.
- A block that starts with `sudo tee` and ends with `EOF` is pasted as one command, including the last `EOF` line. Do not remove the quotes in `<<'EOF'`.
- Anything written `REPLACE-SOMETHING` must be replaced with your real value. Step 25 checks none are left.
- Where a step says what you **must see**, stop if you do not see it, and note the step number and what was printed when you ask for help.

---

## Part A — Start clean (optional)

**On a brand-new server, skip this part and begin at Part B.** Use it only to remove an earlier install of this project before installing again.

### Step 1 — See what is there now

```bash
sudo docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

Just look. Nothing to change.

### Step 2 — Back up your website accounts (recommended)

This keeps your users, approvers and history. If it says the volume does not exist, skip to step 3.

```bash
sudo mkdir -p /root/veeam-assistant-backups
sudo docker run --rm --user root --entrypoint tar \
  -v veeam-assistant-data:/data:ro -v /root/veeam-assistant-backups:/backup \
  alpine czf /backup/accounts-$(date +%F).tgz -C /data .
sudo ls -l /root/veeam-assistant-backups
```

### Step 3 — Remove the old container, images and built servers

```bash
sudo docker rm -f veeam-assistant 2>/dev/null
sudo docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '^veeam-assistant:' | xargs -r sudo docker image rm -f
sudo rm -rf /opt/veeam-mcp
sudo docker image prune -f
```

The data volume `veeam-assistant-data` is kept. Step 29 decides what to do with it.

### Step 4 — Move old project folders out of the way

```bash
cd ~
for d in veeam-assistant veeam-mcp-server; do [ -d "$d" ] && mv "$d" "$d-old-$(date +%F)"; done
ls -d ~/veeam* 2>/dev/null
```

You should only see folders ending in `-old-` and today's date.

### Step 5 — Check port 3000 is free

```bash
sudo ss -ltnp | grep ':3000 ' || echo "Port 3000 is free"
```

You must see `Port 3000 is free`.

---

## Part B — Install the tools

### Step 6 — Docker, Nginx and helpers

If `sudo docker version` already shows a **Server** section, skip to step 7.

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git nginx unzip openssl python3
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
sudo systemctl enable --now docker
```

### Step 7 — Check Python is there

```bash
python3 --version
```

Any version is fine. It is only used to check files on this server.

---

## Part C — Get the code and Veeam's API definition

### Step 8 — Download Veeam's MCP servers

```bash
cd ~
git clone https://github.com/veeam-ai/veeam-mcp-server.git
ls ~/veeam-mcp-server/servers
```

You must see `vbr-mcp  vi-mcp`.

> **Optional: only if you do not see both names.** Veeam updates this repository, and has changed its layout once already (the Veeam Intelligence server moved into `servers/vi-mcp`). If the line above shows different names, the layout has changed again since this guide was written. Read the repository's own README for the new layout, or go back to an earlier version: on GitHub, open the repository's **Commits** list, copy the ID of a commit from before the change, and run this with that ID in place of `REPLACE-COMMIT-ID`:
>
> ```bash
> git -C ~/veeam-mcp-server checkout REPLACE-COMMIT-ID
> ls ~/veeam-mcp-server/servers
> ```
>
> You must then see `vbr-mcp  vi-mcp`.

### Step 9 — Find which REST API revision your VBR accepts

Replace `REPLACE-VBR-NAME` with your VBR server's name, then run:

```bash
VBR=REPLACE-VBR-NAME
for v in 1.3-rev2 1.3-rev1 1.3-rev0 1.2-rev1; do
  printf '%-9s ' "$v"; curl -sk -o /dev/null -w '%{http_code}\n' -H "x-api-version: $v" "https://$VBR:9419/api/v1/serverTime"
done
```

`curl -k` skips the certificate check. It is used here for this connectivity test only.

**Write down the first revision that shows `200` or `401`.** Both mean VBR accepts that revision (401 only means you have not signed in). `400` means it does not.

If every line shows `000`, this server cannot reach VBR on port 9419. Fix that first (firewall, or the REST service on VBR).

### Step 10 — Get the API definition from your VBR server

`swagger.json` is Veeam's description of the REST API. This project's REST API server builds its operations from it, so take it from **your own VBR**, to match your version. Use the first option that works.

**Option A — The Swagger UI that VBR serves itself**

On Windows, open this in a browser, with your VBR server's name in place of `REPLACE-VBR-NAME` (accept the certificate warning if one appears):

`https://REPLACE-VBR-NAME:9419/swagger/ui/index.html`

If the page is not found, try `https://REPLACE-VBR-NAME:9419/api/swagger/ui/index.html`.

1. In the **Select a definition** list, choose the revision you wrote down in step 9.
2. Under the page title, click the link to the definition (it ends in `.json`).
3. The browser shows the file as text. Save it with **Ctrl+S** as `swagger.json`, in a working folder on your Windows PC. You will copy it to the server in step 11. Choose **All files** or **JSON** as the type, not "Web page".

**Option B — From VBR's installation folder (VBR installed on Windows)**

Veeam's documentation puts the file in the VBR installation folder. On a default install:

`%ProgramFiles%\Veeam\Backup and Replication\Backup\RestApiService\specs\latest\swagger.json`

Copy it to your working folder. This finds it if the folder differs:

```powershell
Get-ChildItem "$env:ProgramFiles\Veeam" -Recurse -Filter swagger.json -ErrorAction SilentlyContinue | Select-Object FullName
```

**Check the file before copying it.** In PowerShell, in the folder holding it:

```powershell
(Get-Content .\swagger.json -Raw | ConvertFrom-Json).info.version
```

It must show the revision from step 9, for example `1.3-rev2`. An error means the file was saved as a web page rather than JSON: save it again as in Option A, step 3. A definition **newer** than your VBR accepts gives *Unsupported x-api-version* errors later.

### Step 11 — Copy swagger.json to the server

**On Windows**, in PowerShell, in the folder holding it. Replace `you@linux-server`:

```powershell
scp .\swagger.json you@linux-server:~/
```

### Step 12 — Get the project

**On the Linux server:**

```bash
cd ~
git clone https://github.com/STTGL-01/Veeam-MCP-Assistant.git veeam-assistant
ls ~/veeam-assistant
```

You must see at least these five names: `README.md`, `deploy`, `docs`, `mcp-extra` and `web`. The folder is called `veeam-assistant` with no version number.

---

## Part D — Build

### Step 13 — Check the project version

```bash
grep '"version"' ~/veeam-assistant/web/package.json
```

You must see `"version": "1.0.0"`.

### Step 14 — Build the website image

Build it now: Veeam's servers are built using this image, so it has to exist first.

```bash
cd ~/veeam-assistant/web
sudo docker build -t veeam-assistant:1.0.0 .
```

### Step 15 — Check the image

```bash
sudo docker run --rm veeam-assistant:1.0.0 python3 --version
sudo docker run --rm veeam-assistant:1.0.0 node --version
```

Python **must** say `3.13.` something. Node should say `v24.` something.

### Step 16 — Build both Veeam MCP servers

Pass the path and the image name exactly as shown. Under `sudo`, the script cannot work out either by itself.

```bash
sudo env VA_PORTAL_IMAGE=veeam-assistant:1.0.0 sh ~/veeam-assistant/deploy/build-mcp-servers.sh ~/veeam-mcp-server
```

This takes a few minutes. At the end it prints one line for each of Veeam's two servers:

```text
Built servers in /opt/veeam-mcp:
  vbr-mcp  OK  Python  /servers/vbr-mcp/.venv/bin/vbr-mcp
  vi-mcp  OK  Node    /servers/vi-mcp/build/index.js

All servers are in place. Next: README step 18.
```

You must see `OK` on both lines. If either says `PROBLEM`, the lines under it say what is missing: share them when you ask for help.

### Step 17 — Install the REST API server

```bash
sudo mkdir -p /opt/veeam-mcp/vbr-extra
sudo cp ~/veeam-assistant/mcp-extra/vbr-extra/server.mjs /opt/veeam-mcp/vbr-extra/server.mjs
sudo cp ~/swagger.json /opt/veeam-mcp/vbr-extra/swagger.json
sudo chmod -R a+rX /opt/veeam-mcp/vbr-extra
python3 -c "import json; d=json.load(open('/opt/veeam-mcp/vbr-extra/swagger.json', encoding='utf-8-sig')); print('Revision:', d['info']['version'], '| API paths:', len(d['paths']))"
```

You must see the revision from step 9 and a few hundred API paths.

That file is version 2.0.1 of the REST server. Besides every operation in `swagger.json`, it shows the fields **inside** the nested parts of a request, for example the `target` of a file restore. Without that, a restore or an edit would have to be filled in by guessing.

### Step 18 — Check everything is in place

```bash
ls -l /opt/veeam-mcp/vi-mcp/build/index.js
ls -l /opt/veeam-mcp/vbr-mcp/.venv/bin/vbr-mcp /opt/veeam-mcp/vbr-mcp/.venv/bin/python3
ls -l /opt/veeam-mcp/vbr-extra/server.mjs /opt/veeam-mcp/vbr-extra/swagger.json
```

All five must show a file. If one says *No such file*, stop and send the output of step 16.

---

## Part E — Settings files

### Step 19 — Create the settings folder

```bash
sudo mkdir -p /etc/veeam-assistant
```

### Step 20 — app.env (the website's own settings)

No changes needed. Leave `PUBLIC_ORIGIN` empty: the website then accepts whatever address people use, short name or full name.

> **Leave it empty unless you have a reason to set it.** `PUBLIC_ORIGIN` pins the one address the site accepts, which is extra protection if the site is reachable beyond a small network. If you set it, it must match the address in the browser **exactly**, including `https://` and any port. A wrong value blocks sign-in with *This request did not come from the assistant site*.

```bash
sudo tee /etc/veeam-assistant/app.env > /dev/null <<'EOF'
SITE_TITLE=Veeam Assistant
SITE_SUBTITLE=Veeam Intelligence
COOKIE_SECURE=true
SESSION_IDLE_MINUTES=60
SESSION_MAX_HOURS=12
MAX_CONCURRENT_QUESTIONS=4
ADMIN_CAN_APPROVE=true
TOOL_APPROVAL_TIMEOUT_SEC=1500
CHAT_TURN_TIMEOUT_SEC=3600
PUBLIC_ORIGIN=
LOG_MCP=false
EOF
```

### Step 21 — vi.env (Veeam Intelligence, port 443)

Create the file and open it:

```bash
sudo tee /etc/veeam-assistant/vi.env > /dev/null <<'EOF'
PRODUCT_NAME=vbr
WEB_URL=https://REPLACE-VBR-NAME/
ADMIN_USERNAME=REPLACE-DOMAIN\REPLACE-USER
ADMIN_PASSWORD=REPLACE-PASSWORD
ACCEPT_SELF_SIGNED_CERT=true
ACTION_CONFIRMATION_TIMEOUT_SEC=1500
EOF
sudo nano /etc/veeam-assistant/vi.env
```

In `nano`, change three lines, then save with **Ctrl+O**, **Enter**, **Ctrl+X**:

| Line | Change it to | Example |
|---|---|---|
| `WEB_URL=https://REPLACE-VBR-NAME/` | your VBR name, keep `https://` and the `/` at the end | `WEB_URL=https://vbr01.corp.local/` |
| `ADMIN_USERNAME=REPLACE-DOMAIN\REPLACE-USER` | the VBR account, one backslash | `ADMIN_USERNAME=CORP\svc-veeam-ai` |
| `ADMIN_PASSWORD=REPLACE-PASSWORD` | its password | `ADMIN_PASSWORD=your-password-here` |

Use a name that resolves from this server. `ACCEPT_SELF_SIGNED_CERT=true` is needed when VBR's certificate is self-signed, or does not contain the name you use (for example when DNS adds a domain suffix the certificate does not carry). No quotes around values. The account must not use MFA.

### Step 22 — vbr.env (Veeam's vbr-mcp, port 9419)

```bash
sudo tee /etc/veeam-assistant/vbr.env > /dev/null <<'EOF'
VBR_BASE_URL=https://REPLACE-VBR-NAME:9419
VBR_USERNAME=REPLACE-DOMAIN\REPLACE-USER
VBR_PASSWORD=REPLACE-PASSWORD
VBR_VERIFY_TLS=false
EOF
sudo nano /etc/veeam-assistant/vbr.env
```

Change the three `REPLACE` values as in step 21. **Keep `:9419`** and put no `/` at the end of the address.

These are the names vbr-mcp reads. `VBR_BASE_URL` matters most: if it is misspelt, vbr-mcp quietly uses `https://localhost:9419`. To check your file against what vbr-mcp actually reads:

```bash
echo "vbr-mcp reads:"; grep -rhoE '\bVBR_[A-Z0-9_]+' ~/veeam-mcp-server/servers/vbr-mcp/src ~/veeam-mcp-server/servers/vbr-mcp/README.md | sort -u
echo "Your file sets:"; sudo grep -oE '^[A-Z0-9_]+' /etc/veeam-assistant/vbr.env
```

Every name your file sets must appear in the first list.

### Step 23 — vbr-extra.env (the REST API server, port 9419)

```bash
sudo tee /etc/veeam-assistant/vbr-extra.env > /dev/null <<'EOF'
VBR_URL=https://REPLACE-VBR-NAME:9419
VBR_USERNAME=REPLACE-DOMAIN\REPLACE-USER
VBR_PASSWORD=REPLACE-PASSWORD
VBR_ACCEPT_SELF_SIGNED_CERT=true
VBR_WAIT_SEC=900
EOF
sudo nano /etc/veeam-assistant/vbr-extra.env
```

Change the three `REPLACE` values. **Keep `:9419`**, no `/` at the end.

The names differ from step 22 (`VBR_URL`, `VBR_ACCEPT_SELF_SIGNED_CERT`). That is correct: this is a different server.

The account needs the **Veeam Backup Administrator** role for deletions; with a lesser role they fail with *HTTP 403*. The API revision is taken from `swagger.json`, so it is not set here.

### Step 24 — backends.json (what the Server box offers)

No changes needed.

```bash
sudo tee /etc/veeam-assistant/backends.json > /dev/null <<'EOF'
{
  "servers": [
    {
      "id": "vi",
      "label": "Veeam Intelligence",
      "description": "Ask questions about your backup environment.",
      "command": "node",
      "args": ["/servers/vi-mcp/build/index.js"],
      "cwd": "/servers/vi-mcp",
      "env_file": "/etc/veeam-assistant/vi.env",
      "mode": "question",
      "enabled": true
    },
    {
      "id": "vbr",
      "label": "Veeam Backup & Replication",
      "description": "Run any VBR operation, including deleting jobs and backups.",
      "mode": "tools",
      "enabled": true,
      "parts": [
        {
          "command": "/servers/vbr-mcp/.venv/bin/python3",
          "args": ["/servers/vbr-mcp/.venv/bin/vbr-mcp"],
          "cwd": "/servers/vbr-mcp",
          "env_file": "/etc/veeam-assistant/vbr.env"
        },
        {
          "command": "node",
          "args": ["/servers/vbr-extra/server.mjs"],
          "cwd": "/servers/vbr-extra",
          "env_file": "/etc/veeam-assistant/vbr-extra.env",
          "hide_tools": []
        }
      ]
    }
  ]
}
EOF
```

What the settings mean:

- `"mode": "question"` shows the message box; `"mode": "tools"` shows the **Operations…** button.
- The VBR entry has two **parts**, shown as one list: Veeam's vbr-mcp, and the REST API server.
- vbr-mcp is started through its own Python (`.venv/bin/python3`). Starting `.venv/bin/vbr-mcp` directly fails with `spawn … ENOENT`.

### Step 25 — Lock down and check the settings

`app.env` is read by Docker on the host, so it belongs to root. The other three are read inside the container, so they belong to the container's user. All stay private.

```bash
PUID=$(sudo docker run --rm --entrypoint id veeam-assistant:1.0.0 -u portal)
PGID=$(sudo docker run --rm --entrypoint id veeam-assistant:1.0.0 -g portal)
sudo chown root:root /etc/veeam-assistant/app.env /etc/veeam-assistant/backends.json
sudo chown "$PUID:$PGID" /etc/veeam-assistant/vi.env /etc/veeam-assistant/vbr.env /etc/veeam-assistant/vbr-extra.env
sudo chmod 600 /etc/veeam-assistant/app.env /etc/veeam-assistant/vi.env /etc/veeam-assistant/vbr.env /etc/veeam-assistant/vbr-extra.env
sudo chmod 644 /etc/veeam-assistant/backends.json
ls -ln /etc/veeam-assistant/
python3 -m json.tool /etc/veeam-assistant/backends.json > /dev/null && echo "backends.json OK"
echo "Placeholders left:"; sudo grep -c REPLACE /etc/veeam-assistant/vi.env /etc/veeam-assistant/vbr.env /etc/veeam-assistant/vbr-extra.env
```

You must see:

- the four `.env` files as `-rw-------`; `app.env` owned by `0`, the other three by the container user's number
- `backends.json OK`
- `0` placeholders left in each file

Editing these files later with `sudo nano` keeps the owner. Only recreating a file from scratch needs the `chown` line again.

---

## Part F — Check the connections to VBR

### Step 26 — Both ports

```bash
VBR=REPLACE-VBR-NAME
curl -sk -o /dev/null -w 'Port 443:  %{http_code}\n' "https://$VBR/"
curl -sk -o /dev/null -w 'Port 9419: %{http_code}\n' "https://$VBR:9419/api/v1/serverTime"
```

Each must show a number other than `000`. As in step 9, `curl -k` skips the certificate check, for this test only.

| You see | Meaning |
|---|---|
| `000` on 9419 | The REST port is blocked or the REST service is not running. Veeam Intelligence can still work; operations cannot. |
| `Could not resolve host` | No DNS record for that name. Use a name that resolves, or the IP address. |

---

## Part G — Start it

### Step 27 — HTTPS certificate for the website

**If your site already worked over `https://` before, skip to step 29.**

Replace `REPLACE-SITE-NAME` (twice) with the name people type in the browser:

```bash
sudo mkdir -p /etc/ssl/veeam-assistant
sudo chmod 700 /etc/ssl/veeam-assistant
sudo openssl req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes \
  -keyout /etc/ssl/veeam-assistant/privkey.pem \
  -out /etc/ssl/veeam-assistant/fullchain.pem \
  -subj "/CN=REPLACE-SITE-NAME" \
  -addext "subjectAltName=DNS:REPLACE-SITE-NAME" \
  -addext "extendedKeyUsage=serverAuth"
sudo chmod 600 /etc/ssl/veeam-assistant/privkey.pem
sudo cp /etc/ssl/veeam-assistant/fullchain.pem ~/veeam-assistant.crt
sudo chown "$USER" ~/veeam-assistant.crt
```

### Step 28 — Trust the certificate on Windows

**Skip if you skipped step 27.** In PowerShell, replace `you@linux-server`:

```powershell
scp you@linux-server:~/veeam-assistant.crt .
```

Then in an **administrator** PowerShell:

```powershell
Import-Certificate -FilePath .\veeam-assistant.crt -CertStoreLocation Cert:\LocalMachine\Root
```

### Step 29 — Prepare the data volume

The data volume holds website accounts, approvers and history. Its files must belong to the container's user **before** the container first starts, or it fails with `EACCES: permission denied`. Pick **one** option.

**Option 1 — Keep the accounts already in the volume:**

```bash
PUID=$(sudo docker run --rm --entrypoint id veeam-assistant:1.0.0 -u portal)
PGID=$(sudo docker run --rm --entrypoint id veeam-assistant:1.0.0 -g portal)
sudo docker run --rm -v veeam-assistant-data:/data alpine chown -R "$PUID:$PGID" /data
sudo docker run --rm -v veeam-assistant-data:/data alpine sh -c 'rm -f /data/*.corrupt-*; ls -ln /data'
```

**Option 2 — Restore the backup from step 2.** Replace `YYYY-MM-DD` with the date in its file name:

```bash
sudo docker run --rm --user root --entrypoint sh \
  -v veeam-assistant-data:/data -v /root/veeam-assistant-backups:/backup \
  alpine -c 'rm -rf /data/* && tar xzf /backup/accounts-YYYY-MM-DD.tgz -C /data'
PUID=$(sudo docker run --rm --entrypoint id veeam-assistant:1.0.0 -u portal)
PGID=$(sudo docker run --rm --entrypoint id veeam-assistant:1.0.0 -g portal)
sudo docker run --rm -v veeam-assistant-data:/data alpine chown -R "$PUID:$PGID" /data
```

**Option 3 — Start fresh** with `admin` / `admin` (change that password straight away, step 32). This deletes all website accounts:

```bash
sudo docker volume rm veeam-assistant-data 2>/dev/null
sudo docker volume create veeam-assistant-data
PUID=$(sudo docker run --rm --entrypoint id veeam-assistant:1.0.0 -u portal)
PGID=$(sudo docker run --rm --entrypoint id veeam-assistant:1.0.0 -g portal)
sudo docker run --rm -v veeam-assistant-data:/data alpine chown -R "$PUID:$PGID" /data
```

### Step 30 — Start the website container

```bash
sudo sh ~/veeam-assistant/deploy/run-container.sh veeam-assistant:1.0.0
sleep 3
sudo docker logs --since 1m veeam-assistant
```

A correct start looks like this, with **no** lines containing `EACCES` or `does not exist`:

```text
[backends] 2 MCP server(s) configured: vi, vbr (2 parts)
[startup] Veeam Assistant portal 1.0.0 listening on 0.0.0.0:3000
[startup] Data directory: /data. Secure cookies: true.
```

| Log line contains | Fix |
|---|---|
| `could not read /etc/veeam-assistant/...env: EACCES` | Run step 25 again, then `sudo docker restart veeam-assistant` |
| `EACCES: permission denied, open '/data/...` | Run Option 1 of step 29, then `sudo docker restart veeam-assistant` |
| `does not exist` | Check step 18, then read the log again |

### Step 31 — Nginx

**If your site already worked before, skip to step 32.** Nginx has not changed.

```bash
sudo cp ~/veeam-assistant/deploy/nginx-veeam-assistant.conf /etc/nginx/sites-available/veeam-assistant
sudo nano /etc/nginx/sites-available/veeam-assistant
```

Replace both places that say `assistant.corp.example.com` with your site name. Save with **Ctrl+O**, **Enter**, **Ctrl+X**. Then:

```bash
sudo ln -sf /etc/nginx/sites-available/veeam-assistant /etc/nginx/sites-enabled/veeam-assistant
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

`nginx -t` must say *syntax is ok* and *test is successful*. Do not change the line `proxy_set_header Host $http_host;`.

> **Do step 32 now, before you give anyone the address.** A new install starts with the administrator account `admin` and the password `admin`.

---

## Part H — First use

### Step 32 — Sign in

> **Change the administrator password first, before you give anyone the address.** A new install starts with `admin` / `admin`. The site makes you choose a new password at the first sign-in, so sign in yourself before anyone else can.

On Windows, go to `https://` followed by your site name. There should be no certificate warning.

- Kept or restored accounts in step 29: sign in with your **existing** admin password.
- Started fresh: sign in as **admin** / **admin**, then choose a new password of at least 12 characters.

### Step 33 — Test both servers

Menu (three lines, top left) → **User accounts** → **MCP servers** → **Test connections**.

| Server | Expected |
|---|---|
| Veeam Intelligence | started, 3 tools, *answers questions* |
| Veeam Backup & Replication | started *(2 parts)*, *offers operations*. Part 1: vbr-mcp, about 49 tools. Part 2: vbr-extra 2.0.1, several hundred tools. |

If a part fails, its line says which, with the error underneath. See Part L.

### Step 34 — Try Veeam Intelligence

1. **Back to the assistant**.
2. **Server** box: **Veeam Intelligence**.
3. Type `Which backup jobs failed in the last 24 hours?` and press **Enter**. The first answer can take a minute.

### Step 35 — Try the REST operations

1. **Server** box: **Veeam Backup & Replication**.
2. Click **Operations…**, on the right **above the message box** (it is not in the main menu).
3. Type `about` in the search box, pick **About these REST operations**, and click **Run**.

   The answer shows the API file, the revision being sent, how many operations are offered, and the few Veeam operations left out, with the reason for each: sign-in is handled automatically, and file uploads and downloads cannot be done from a form.

4. Search `get all jobs`, pick **Get All Jobs** under **Jobs**, and click **Run**. You get a table of your jobs. This is the first real sign-in to VBR through the REST server.

### Step 36 — Filling in operation forms

The list is grouped by area (Jobs, Backups, Repositories…). Search with a few words, for example `delete backup` or `repositories state`.

| Field shows | What to type | Example |
|---|---|---|
| plain text box | the value | `Daily VMs` |
| number box | a number | `50` |
| tick box | tick for yes | |
| **(JSON)** list | a JSON list: square brackets, double quotes, commas | `["a623b664-df5d-486e-9ece-ce9f7ffb16ec", "18b95123-ca41-42a9-9531-189f3155474f"]` |
| **Request body (JSON)** | a JSON object; the text under the box lists its fields and which are required | `{"performActiveFull": false}` |

- Leave optional fields **empty** to leave them out.
- **List operations** show the first 50 rows. Use `skip` and `limit` to page through the rest.
- **IDs** are shown in the tables; copy them from there.
- Operations that start a VBR session have a **Return immediately** tick box. Leave it unticked to wait for VBR to finish and see the result.

**Restoring files and folders.** A file restore is **three operations, run in this order**. Each one that changes something needs an approver, so expect three approvals, all in **Restores and recovery**:

| Order | Operation | What it does |
|---|---|---|
| 1 | **Start File Restore** | Mounts the backup's file system. The answer shows a **session ID**: copy it. |
| 2 | **Restore Files and Folders to Another Location** (or **to Original Location**) | Copies the files out. |
| 3 | **Unmount File System** | Unmounts the backup. **Do not skip it**, or the mount stays open. |

Before step 1, find the **restore point ID** (**List restore points**) and, to restore to another machine, the ID of that machine (**Get All Servers**) and of the **credentials** VBR should use there (**Get All Credentials**). Between steps 1 and 2, **Browse File System** or **Search for Files and Folders** (both read-only, with the mount ID) finds the exact path, and **Validate Target Machine Credentials** and **Validate FLR Restore Item Target Path** (also read-only) check the target before anything is written. **Get All File Restore Mount Points** lists any mount left open, and **Unmount File System** closes it.

These operations sit under **Restore** and **Backup Browser** in the list. Their code names come from Veeam's operation IDs, which are not the same as the titles: **Start File Restore** is `rest_start_flr_mount`, and **Restore Files and Folders to Another Location** is `rest_flr_mount_restore_to`. "FLR" is Veeam's name for file-level restore, so every operation in this group has `flr` in its code name.

For the restore itself, write the **Request body (JSON)** from the description under the box. It lists every field, including the fields inside nested parts such as the target, and which are required. A list of objects is written `[{"path": "..."}]`.

**Where the files can go.** VBR restores files to the **original location**, or to **another machine that VBR knows about**, including Linux machines that have the Veeam Agent. It can also prepare a ZIP download, but **this website cannot pass a file to your browser**, so operations that return a file are left out of the list (**About these REST operations** shows them, with the reason). So "restore it to my local system" works only if **your computer is a machine VBR knows**, for example a protected computer or a managed server, and you name it **as VBR names it**. If it is not, restore the file to a server or share you can reach and copy it from there, or use the VBR console's own file-level restore.

If you turned Claude on (Part J), it can run these three steps for you. Name the machine as VBR names it, and the folder, for example: `Restore C:\Data\report.xlsx from the latest backup of SERVER01 to D:\Restore on SERVER01.` Claude waits for each approval in turn, and Claude may need a second try at a restore request, which means another approval. Doing one restore by hand first is the quickest way to learn what a correct request looks like.

---

## Part I — People and approvals

### Step 37 — A second account for yourself

**Nobody can approve their own request, administrator included.** If you will both request and approve changes, keep `admin` for approving and make an ordinary account for requesting:

1. Open a **private window** (Ctrl+Shift+N) and go to the site.
2. Click **Request one**, and pick a username and a password of at least 12 characters.
3. In your **normal** window, as admin: menu → **User accounts** → **Awaiting approval** → **Approve**.
4. Use the private window (new account) to request changes, and the normal window (admin) to approve them under **Approvals**.

### Step 38 — Approve other people

They request accounts themselves from the sign-in page. Approve them under **User accounts** → **Awaiting approval**.

### Step 39 — Choose who approves what

**All accounts** → **Approver for…** on a person → tick the groups → **Save**.

| Group | Covers |
|---|---|
| Backup jobs | Start, stop, retry, enable, disable and edit jobs |
| Restores and recovery | Instant Recovery, VM and file restores, failover, migrate, unmount |
| Backup infrastructure | Proxies, repositories, managed servers, agents, credentials, upgrades |
| Licensing | Install, update and revoke licenses |
| Malware and encryption scans | Malware and encryption scans |
| **Deletions and removals** | **Anything that permanently deletes or removes something.** Give it to as few people as possible. |
| Everything else | Anything not covered above, such as general options |

Each operation is marked **Read** (runs straight away), **Changes** or **High risk** (both need approval). Anything the website cannot classify counts as a change, never as a read.

### Step 40 — (Optional) Named approvers for one person

**Approved by…** on a person → tick who may approve their requests → **Save**. Their requests then go only to those people and the administrator, whatever the kind of action.

### Step 41 — How an approval looks

1. The requester clicks **Send for approval**. Their chat shows **Needs approval before it runs**, who it waits for, and a countdown (25 minutes).
2. The approver opens **Approvals**, sees the exact operation and values, and clicks **Approve and run** or **Decline**.
3. The requester's chat shows the result and who approved it.

Nothing runs if nobody decides before the countdown ends, or if the container restarts.

### Step 42 — (Optional) Veeam Intelligence actions

This affects **Veeam Intelligence only**. With VBR's Veeam Intelligence chatbot mode set to **Advanced**, it only answers. Setting it to **AdvancedWithActions** (VBR 13.1 or later) lets it propose some changes, which then go to approvers too. Veeam Intelligence never deletes anything, whatever the account's rights; use **Operations…** for that.

---

## Part J — (Optional) Let Claude answer questions on Veeam Backup & Replication

With this, you can type a question with **Veeam Backup & Replication** selected. Claude runs read operations to find the answer, and, because it is set up **read-write**, it can also ask for changes and deletions. **Every change it asks for waits for a human approver**, exactly like a hand-picked operation, and nobody approves their own request. Part O explains how to switch Claude to read-only, and how to turn it off.

**Questions, and the VBR data Claude reads to answer them, are sent to Anthropic.** Check this is acceptable before turning it on.

### Step 43 — Check the server can reach the Claude API

```bash
sudo docker exec veeam-assistant node -e "fetch('https://api.anthropic.com/v1/models').then(r=>console.log('Reachable, HTTP',r.status)).catch(e=>console.log('FAILED:',e.cause?e.cause.code||e.cause.message:e.message))"
```

You must see `Reachable, HTTP 401`. If you see `FAILED`, ask your network team to allow outbound HTTPS to `api.anthropic.com`.

### Step 44 — Check your API key and save it

Get a normal API key from the Claude Console; it starts with `sk-ant-api`. **Note its expiry date**, and put a reminder in your calendar a week before it. An expired key gives the same *invalid x-api-key* error as a wrong one.

Paste this whole block. It asks for the key without showing it, tests it, and saves it only if it works:

```bash
read -rsp 'Paste the Claude API key, then press Enter: ' KEY; echo
KEY=$(printf '%s' "$KEY" | tr -d '\r"'"'"' ')
echo "Starts with: ${KEY:0:12}   Length: ${#KEY}"
CODE=$(curl -s -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/models -H "x-api-key: $KEY" -H 'anthropic-version: 2023-06-01')
echo "Anthropic answered: HTTP $CODE"
if [ "$CODE" = "200" ]; then
  sudo sed -i '/^ANTHROPIC_API_KEY=/d' /etc/veeam-assistant/app.env
  sudo sed -i -e '$a\' /etc/veeam-assistant/app.env
  printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" | sudo tee -a /etc/veeam-assistant/app.env > /dev/null
  echo "Saved."
else
  echo "Not saved. A 401 means the key is wrong, expired or revoked: check it in the Claude Console."
fi
unset KEY
```

You must see `HTTP 200` and `Saved.`

### Step 45 — Turn it on in backends.json

> **This sets Claude up read-write by default.** Claude can *ask* for changes and deletions, and each one still waits for a human approver. To make Claude read-only instead, go to **Part O**, *Switch between read-write and read-only*, after this step.

This adds an `agent` section to the Veeam Backup & Replication entry, **read-write**. The settings, and how to change them later, are explained in Part O step O2; this is the same block.

```bash
sudo python3 - <<'PYEOF'
import json
p = '/etc/veeam-assistant/backends.json'
d = json.load(open(p))
for s in d['servers']:
    if s['id'] == 'vbr':
        s['agent'] = {
            "model": "claude-sonnet-5-5",
            "access": "read-write",
            "max_steps": 15,
            "max_tokens": 4096,
            "history_turns": 4,
            "parts": [1],
            "allow_tools": [
                "find_jobs", "find_backups", "delete_backup", "delete_job",
                "rest_*flr*", "rest_get_all_creds", "rest_get_all_managed_servers"
            ],
            "instructions": ("File restores: if the person has not said which machine to restore to, as VBR names it, and which folder, ask them. "
                             "Steps: find the restore point, start a file restore, browse to confirm the path, restore the items, and always unmount the file system afterwards. "
                             "A file restore cannot be downloaded to the person's own computer.")
        }
        s['description'] = "Ask questions or run any VBR operation, including deleting jobs and backups."
json.dump(d, open(p, 'w'), indent=2)
print("Claude section added (read-write)")
PYEOF
python3 -m json.tool /etc/veeam-assistant/backends.json > /dev/null && echo "backends.json OK"
```

`"parts": [1]` gives Claude all of vbr-mcp's operations. `"allow_tools"` adds Find jobs, Find backups, Delete backup from disk and Delete job, and, by name pattern, the file restore operations (every code name containing `flr`: mount, browse, search, validate, restore, unmount), plus **Get All Credentials** and **Get All Servers** so it can find the target machine. `"instructions"` tells Claude how to run a file restore. The full REST list is several hundred operations, which would make every question slow and expensive; those stay available through **Operations…**, and Part O shows how to add specific ones for Claude.

**Model names change over time.** Check Anthropic's current model list before you choose, and use the name exactly as shown there.

| Model name | When to use it |
|---|---|
| `claude-sonnet-5-5` | **Recommended.** Reliable across several steps. $2 per million input tokens, $10 per million output. |
| `claude-haiku-5-5` | Cheapest (from $0.10 / $0.50 per million). Fine for simple lookups. |
| `claude-opus-5-5` | Most capable, costs more. |

To change the model later, put the new name in this command, run it, then use **Reload server list** on the User accounts page:

```bash
sudo sed -i 's/"model": "[^"]*"/"model": "claude-haiku-5-5"/' /etc/veeam-assistant/backends.json
```

### Step 46 — Apply it

The key is in `app.env`, which Docker only reads when the container is created:

```bash
sudo sh ~/veeam-assistant/deploy/run-container.sh veeam-assistant:1.0.0
sleep 3
sudo docker logs --since 1m veeam-assistant
```

You must see `answers questions with claude-sonnet-5-5` and `Claude API key found`. **Test connections** must then show *Written questions: Claude model claude-sonnet-5-5 is available.*

Ask a question with **Veeam Backup & Replication** selected. The answer ends with *Operations used: … Answered by claude-sonnet-5-5.* Each answer is recorded in the **Activity** log with the model, steps and tokens used.

To restore a file through Claude, name the machine as VBR names it and the folder. Step 36 explains the three approvals involved, and where a restored file can and cannot go.

---

## Part K — Day-to-day

**After editing any file in `/etc/veeam-assistant`**, recreate the container, or the change has no effect:

```bash
sudo sh ~/veeam-assistant/deploy/run-container.sh veeam-assistant:1.0.0
```

A change to `backends.json` alone only needs **Reload server list** on the User accounts page.

**Update Veeam's MCP servers:**

```bash
cd ~/veeam-mcp-server && git pull
sudo env VA_PORTAL_IMAGE=veeam-assistant:1.0.0 sh ~/veeam-assistant/deploy/build-mcp-servers.sh ~/veeam-mcp-server
sudo docker restart veeam-assistant
```

This leaves `/opt/veeam-mcp/vbr-extra` alone.

**Update the REST server itself.** When a newer version of this repository is published, pull it and copy the REST server over:

```bash
git -C ~/veeam-assistant pull
sudo cp ~/veeam-assistant/mcp-extra/vbr-extra/server.mjs /opt/veeam-mcp/vbr-extra/server.mjs
sudo chmod a+r /opt/veeam-mcp/vbr-extra/server.mjs
```

and use **Reload server list**. **Test connections** shows its version on part 2. No restart or rebuild is needed for the REST server. A newer version may also change the website: its README says when, and then you rebuild the image (step 14) and recreate the container (step 30).

**After upgrading VBR**, repeat step 9. If a newer revision is now accepted, download its `swagger.json` (step 10), copy it to the server (copy it to the server as in step 11), then:

```bash
sudo cp ~/swagger.json /opt/veeam-mcp/vbr-extra/swagger.json
sudo chmod a+r /opt/veeam-mcp/vbr-extra/swagger.json
```

and use **Reload server list**. New operations appear straight away.

**Replace an expired Claude API key:** run step 44 again, then step 46.

**Back up the website data:**

```bash
sudo mkdir -p /root/veeam-assistant-backups
sudo docker run --rm --user root --entrypoint tar \
  -v veeam-assistant-data:/data:ro -v /root/veeam-assistant-backups:/backup \
  alpine czf /backup/data-$(date +%F).tgz -C /data .
sudo chmod 600 /root/veeam-assistant-backups/*
```

**Restore a backup:** `sudo docker stop veeam-assistant`, run Option 2 of step 29, then `sudo docker start veeam-assistant`.

**Forgotten administrator password:**

```bash
sudo docker stop veeam-assistant
sudo docker run --rm -it -v veeam-assistant-data:/data veeam-assistant:1.0.0 node /portal/server.mjs reset-admin
sudo docker start veeam-assistant
```

**Sign everyone out at once:** `sudo docker restart veeam-assistant`.

---

## Part L — If something fails

Every failed answer has a **Details** section, shown to the administrator only, with the server's own error. Match it below.

| You see | Cause and fix |
|---|---|
| `EACCES: permission denied, open '/data/...` | Data volume owned by another user. Option 1 of step 29, then restart. |
| `could not read /etc/veeam-assistant/...env: EACCES` | Settings file owned by the wrong user. Step 25, then restart. |
| `spawn /servers/vbr-mcp/.venv/bin/vbr-mcp ENOENT` | vbr-mcp started directly. Its `command` must be `.venv/bin/python3` (step 24). |
| `Could not reach the VBR server at https://localhost:9419` | `vbr.env` uses the wrong name for the address. It must be `VBR_BASE_URL` (step 22). |
| `Could not verify the TLS certificate of the VBR server` | `vbr.env` needs `VBR_VERIFY_TLS=false` (step 22). |
| `self-signed certificate` from Veeam Intelligence | `vi.env` needs `ACCEPT_SELF_SIGNED_CERT=true` (step 21). |
| `Unsupported x-api-version` | `swagger.json` is newer than your VBR accepts. Steps 9 and 10, then Part K's "After upgrading VBR". |
| `HTTP 403` on a deletion | The account in `vbr-extra.env` needs the Veeam Backup Administrator role. |
| `… must be valid JSON` | A list or body field. See the table in step 36. |
| *This request did not come from the assistant site* | `PUBLIC_ORIGIN` in `app.env` is set but does not match the browser's address. Leave it empty (step 20) and recreate the container. |
| Sign-in returns to the sign-in page | The site was opened over `http://`. Use `https://`. |
| *Needs approval*, waiting for the administrator, but you are the administrator | Nobody approves their own request. Step 37. |
| Operations button missing | `backends.json` needs `"mode": "tools"` for `vbr` (step 24). Reload server list, then F5. |
| *does not answer written questions* | That server offers operations, not chat. Use **Operations…**, or Part J. |
| Claude says it cannot delete or edit something, or an answer shows *There is no tool called …* | Run the check in Part O, **If Claude says it cannot delete**. It finds the usual causes: a website that was rebuilt but not restarted, a missing `allow_tools` line, or a deletion server that is not working. |
| Claude says it cannot restore a single file, or asks which machine you mean | The file restore operations are in Claude's list from step 45 or O2. If Claude says it has none, run the check in Part O, **If Claude says it cannot delete**. A restore also needs the machine **as VBR names it**, and a file cannot be downloaded to your own computer through this website. Step 36 explains both. |
| Claude says it is read-only | `"access"` is `"read-only"` in `backends.json`. Part O, **Make Claude read-write again**, then **Reload server list**. |
| *The Claude API key was refused* | Wrong, revoked or **expired** key. Step 44, then step 46. |
| *The model "…" was not found* | Model name typo in `backends.json` (step 45). |
| *Could not reach the Claude API* | Step 43. |
| `502 Bad Gateway` | The container is not running. Check `sudo docker ps -a --filter name=veeam-assistant` and the log. |
| Certificate warning in the browser | Steps 27 and 28. |

To see more detail, set `LOG_MCP=true` in `app.env`, recreate the container, repeat the problem, and check `sudo docker logs veeam-assistant`. Passwords are masked. Set it back to `false` afterwards.

When asking for help, send the step number, what was printed, and:

```bash
sudo docker logs --tail 50 veeam-assistant
cat /etc/veeam-assistant/backends.json
```

**Never send** the contents of `app.env`, `vi.env`, `vbr.env` or `vbr-extra.env`: they hold passwords and your Claude API key. Leave key files out of any zip you share.

---

## Part M — Security notes

- Website passwords are stored as scrypt hashes. Sessions live only in memory and end after 60 minutes idle or 12 hours.
- Every change, whether hand-picked or chosen by Claude, waits for a human approver who sees exactly what will run. Nobody approves their own request.
- The website only accepts changes sent from its own pages, and shows answers from Veeam and Claude as text, never as HTML.
- The Claude API key stays inside the website. It is not passed to any of the MCP servers.
- Everyone acts through the VBR accounts in the `.env` files. Give them only the role you are comfortable sharing, and keep VBR's own four-eyes authorization on for destructive operations.

---

## Part N — Files

| Path | Purpose |
|---|---|
| `/etc/veeam-assistant/app.env` | Website settings and the Claude API key |
| `/etc/veeam-assistant/vi.env` | Veeam Intelligence connection |
| `/etc/veeam-assistant/vbr.env` | vbr-mcp connection |
| `/etc/veeam-assistant/vbr-extra.env` | REST API server connection |
| `/etc/veeam-assistant/backends.json` | What the Server box offers |
| `/opt/veeam-mcp/vi-mcp`, `/opt/veeam-mcp/vbr-mcp` | Veeam's MCP servers, built in step 16 |
| `/opt/veeam-mcp/vbr-extra/server.mjs` | The REST API server |
| `/opt/veeam-mcp/vbr-extra/swagger.json` | Veeam's REST API definition |
| `~/veeam-assistant/web` | The website source (Veeam Assistant v1.0.0) |
| `~/veeam-assistant/mcp-extra/vbr-extra/` | The REST API server |
| `~/veeam-assistant/deploy/*.example` | Example settings files, one per step in Part E |
| `~/veeam-assistant/docs/` | A summary of what this is and its limits |
| `~/veeam-assistant/deploy/run-container.sh` | Creates or replaces the container |
| `~/veeam-assistant/deploy/build-mcp-servers.sh` | Builds Veeam's MCP servers |
| Docker volume `veeam-assistant-data` | Accounts, history, approvals, activity log |

---

## Part O — Turn Claude on or off, and choose read-write or read-only

Use these steps to switch Claude's answers for **Veeam Backup & Replication** on or off, and to choose what Claude may do. Nothing else changes: Veeam Intelligence, the **Operations…** list, accounts and approvals keep working either way.

| Access | What Claude is given |
|---|---|
| **read-write** (what these steps set up) | Everything it can read, plus operations that **change or delete** things: the 20 change operations in vbr-mcp, the four combined operations (Find jobs, Find backups, **Delete backup from disk**, **Delete job**), and the file restore operations (start, browse, restore, unmount). |
| **read-only** | Only operations that read. Claude cannot ask for any change. |

**Read-write does not let Claude change anything by itself.** Every change it asks for stops and waits for a human approver, who sees the exact operation and values. Nobody approves their own request. Claude is also told not to guess IDs: it looks the item up first and names it before asking. Approvers should read the exact values on the Approvals page rather than rely on Claude's description of them.

### See whether Claude is on now

```bash
echo "API key in app.env: $(sudo grep -c '^ANTHROPIC_API_KEY=' /etc/veeam-assistant/app.env)"
python3 -c "
import json
d = json.load(open('/etc/veeam-assistant/backends.json'))
v = [s for s in d['servers'] if s['id'] == 'vbr'][0]
a = v.get('agent')
if not a:
    print('Claude section in backends.json: no')
else:
    print('Claude section in backends.json: yes, model', a['model'])
    print('Access:', a.get('access', 'read-write (default)'))
    print('Parts given:', a.get('parts', 'all'), '| extra operations allowed:', a.get('allow_tools', []))
"
sudo docker logs veeam-assistant 2>&1 | grep -E 'MCP server\(s\) configured|Claude API key' | tail -2
```

Claude is **on** only when the key count is `1`, backends.json says `yes`, and the log shows `answers questions with …` and `Claude API key found`.

### Turn Claude on

**Step O1 — Make sure the API key is saved.** If the check above showed `API key in app.env: 1` and the key has not expired, skip to step O2. Otherwise run step 44, and check it says `Saved.`

**Step O2 — Add the Claude section to backends.json, read-write.** To use a model other than `claude-sonnet-5-5`, change it in this block first (see the table in step 45).

```bash
sudo python3 - <<'PYEOF'
import json
p = '/etc/veeam-assistant/backends.json'
d = json.load(open(p))
for s in d['servers']:
    if s['id'] == 'vbr':
        s['agent'] = {
            "model": "claude-sonnet-5-5",
            "access": "read-write",
            "max_steps": 15,
            "max_tokens": 4096,
            "history_turns": 4,
            "parts": [1],
            "allow_tools": [
                "find_jobs", "find_backups", "delete_backup", "delete_job",
                "rest_*flr*", "rest_get_all_creds", "rest_get_all_managed_servers"
            ],
            "instructions": ("File restores: if the person has not said which machine to restore to, as VBR names it, and which folder, ask them. "
                             "Steps: find the restore point, start a file restore, browse to confirm the path, restore the items, and always unmount the file system afterwards. "
                             "A file restore cannot be downloaded to the person's own computer.")
        }
        s['description'] = "Ask questions or run any VBR operation, including deleting jobs and backups."
json.dump(d, open(p, 'w'), indent=2)
print("Claude section added (read-write)")
PYEOF
sudo chown root:root /etc/veeam-assistant/backends.json
sudo chmod 644 /etc/veeam-assistant/backends.json
python3 -m json.tool /etc/veeam-assistant/backends.json > /dev/null && echo "backends.json OK"
```

You must see `Claude section added (read-write)` and `backends.json OK`.

What the settings mean:

| Setting | What it does |
|---|---|
| `"access": "read-write"` | Claude may ask for changes and deletions, each held for an approver. `"read-only"` gives it only operations that read. |
| `"parts": [1]` | Claude is given all of vbr-mcp's operations (29 that read, 20 that can change things). It is **not** given the several hundred generated REST operations, which would make every question slow and expensive. Those stay available through **Operations…**. |
| `"allow_tools": [...]` | Adds these operations from the other parts: **Find jobs** and **Find backups** (to look up IDs), **Delete backup from disk** and **Delete job** (this is what lets Claude delete), and, by name pattern with `*` as a wildcard, the file restore operations (`rest_*flr*`), plus **Get All Credentials** and **Get All Servers** for finding the target machine. |
| `"instructions": "..."` | A short note to Claude on how to run a file restore: ask which machine and folder, and always stop the mount afterwards. |

**Step O3 — Restart so it takes effect:**

```bash
sudo sh ~/veeam-assistant/deploy/run-container.sh veeam-assistant:1.0.0
sleep 3
sudo docker logs --since 1m veeam-assistant
```

You must see:

```text
[backends] 2 MCP server(s) configured: vi, vbr (2 parts, answers questions with claude-sonnet-5-5)
[startup] Claude API key found; written questions are on for agent servers.
[startup] Veeam Assistant portal 1.0.0 listening on 0.0.0.0:3000
```

If it says `ANTHROPIC_API_KEY is not set`, go back to step O1.

**Step O4 — Check in the browser.** Press **F5**. Menu → **User accounts** → **MCP servers** → **Test connections**. Veeam Backup & Replication must show a green line like this:

```text
Written questions: Claude model claude-sonnet-5-5 is available. Access: read-write.
Claude can use 60 operations, 25 of which can change or delete things (each waits for an approver).
```

If an entry in `allow_tools` matches no operation (a typo, or the part that offers it is not working), a second line names it.

Your numbers will differ, because the file restore operations depend on your VBR version. The first number should be at least 53 (vbr-mcp's 49 and the four combined operations), and the second at least 22. If it says **read-only** or **none of which can change anything**, see "Switch between read-write and read-only" below.

**Step O5 — Try a deletion safely.** Use your **second (non-admin) account** (step 37), because nobody can approve their own request:

1. Choose **Veeam Backup & Replication** in the **Server** box, and type: `Delete the backup called TEST` (use a real test backup).
2. Claude looks the backup up, names it and its ID, and asks for the deletion. Your chat shows **Needs approval before it runs**, waiting on the **Deletions and removals** approvers.
3. As admin (or another approver of that group), open **Approvals**, check the exact backup ID, and choose **Approve and run**.
4. Your chat shows the result and who approved it.

Under every Claude answer, a line says what it had available, for example *Answered by claude-sonnet-5-5 (read-write; 60 operations available, 25 of them can change or delete things)*. If Claude ever says it cannot do something, check that line first.

### If Claude says it cannot delete (or edit) something

If Claude answers that none of its tools can delete, or that it is read-only, it was not given the deletion operations for that answer. Offering to *disable* a job but not delete it is the usual sign: disabling is in vbr-mcp, deleting is in the deletion server. Run this check. It changes nothing.

```bash
echo "=== 1. The website code running right now"
sudo docker exec veeam-assistant grep '"version"' /portal/package.json
if [ "$(sudo docker exec veeam-assistant grep -c allowTools /portal/lib/backends.mjs)" = "0" ]; then
  echo "PROBLEM: the running website is too old to give Claude extra operations. It ignores allow_tools."
  echo "         Rebuild the image (README step 14), then run step O3."
else
  echo "OK: the running website understands allow_tools."
fi
echo
echo "=== 2. Was the container started from the newest image?"
if [ "$(sudo docker inspect veeam-assistant --format '{{.Image}}')" = "$(sudo docker image inspect veeam-assistant:1.0.0 --format '{{.Id}}')" ]; then
  echo "OK: yes."
else
  echo "PROBLEM: no. The container was started from an older build. Do step O3."
fi
echo
echo "=== 3. Claude's settings in backends.json"
python3 -c "
import json
d = json.load(open('/etc/veeam-assistant/backends.json'))
v = [s for s in d['servers'] if s['id'] == 'vbr'][0]
a = v.get('agent')
if not a:
    print('No Claude section: Claude is off.')
else:
    print('Access:', a.get('access', 'read-write (default)'))
    print('Parts given:', a.get('parts', 'all'))
    print('Extra operations allowed:', a.get('allow_tools', 'NONE - the allow_tools line is missing'))
"
echo
echo "=== 4. Does the deletion server offer Delete job and Delete backup?"
printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | sudo timeout 60 docker exec -i --env-file /etc/veeam-assistant/vbr-extra.env veeam-assistant node /servers/vbr-extra/server.mjs 2>/dev/null \
  | grep -o '"name":"delete_[a-z_]*"' | sort -u
```

What each part should show, and what to do if it does not:

| Part | You must see | If not |
|---|---|---|
| 1 | `OK: the running website understands allow_tools.` | Rebuild the image (step 14), then do step O3. A rebuilt image changes nothing until the container is recreated. |
| 2 | `OK: yes.` | Do step O3. |
| 3 | `Access: read-write`, `Parts given: [1]`, and the four names (`find_jobs`, `find_backups`, `delete_backup`, `delete_job`) | Run the block in step O2. For `read-only`, use **Make Claude read-write again**. |
| 4 | the two lines `"name":"delete_backup"` and `"name":"delete_job"` | The deletion server is not working. Check **Test connections** for its part line, and steps 17 and 23. |

If all four are right and Claude still refuses:

1. Press **Clear history** under the message box, then ask again. Claude sees your last few questions and answers, and may repeat an earlier refusal that was true when it was written.
2. Look at the line under its answer, for example *Answered by claude-sonnet-5-5 (read-write; 60 operations available, 25 of them can change or delete things)*. The first number should be at least 53 (vbr-mcp's 49 and the four combined operations). A lower number means the deletion operations were not in its list; **Test connections** then names any `allow_tools` entry that matched nothing.
3. A line saying `read-only` there means `"access"` is `"read-only"` (part 3 above).

The line under every Claude answer, and the *Access* and *unmatched* lines in **Test connections**, need Veeam Assistant **v1.0.0**. If they are missing, the running website was built from an older copy: rebuild the image (step 14) and recreate the container (step O3).

### Switch between read-write and read-only

Switching is a change to `backends.json` only, so **no restart is needed**: use **Reload server list** on the User accounts page afterwards.

**Make Claude read-only.** Claude then keeps answering questions, but is given only operations that read:

```bash
sudo python3 - <<'PYEOF'
import json
p = '/etc/veeam-assistant/backends.json'
d = json.load(open(p))
v = [s for s in d['servers'] if s['id'] == 'vbr'][0]
if 'agent' not in v:
    raise SystemExit('Claude is not turned on: there is no Claude section to change.')
v['agent']['access'] = 'read-only'
json.dump(d, open(p, 'w'), indent=2)
print('Claude is now read-only')
PYEOF
python3 -m json.tool /etc/veeam-assistant/backends.json > /dev/null && echo "backends.json OK"
```

**Make Claude read-write again:**

```bash
sudo python3 - <<'PYEOF'
import json
p = '/etc/veeam-assistant/backends.json'
d = json.load(open(p))
v = [s for s in d['servers'] if s['id'] == 'vbr'][0]
if 'agent' not in v:
    raise SystemExit('Claude is not turned on: there is no Claude section to change.')
v['agent']['access'] = 'read-write'
json.dump(d, open(p, 'w'), indent=2)
print('Claude is now read-write')
PYEOF
python3 -m json.tool /etc/veeam-assistant/backends.json > /dev/null && echo "backends.json OK"
```

Then **Reload server list**, and run **Test connections** to see the new access and counts. While Claude is read-only, the chat page also says so beside the **Server** box.

### Give Claude more operations

Out of the box, Claude can delete backups and jobs and restore files and folders, but cannot, for example, edit a job. To add operations:

1. Find the operation's code name. **Do not guess it from the title:** code names are made from Veeam's operation IDs, so **Start File Restore** is `rest_start_flr_mount`. In **Operations…**, search for the operation: the name in grey under its title, such as `rest_start_job`, is the code name. Or list the operations whose name contains a word, straight from the server: put your words in the `FILTER` line (separate several with `|`) and run. For example, `FILTER='flr'` lists every file restore operation:

```bash
FILTER='job'
printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | sudo timeout 60 docker exec -i --env-file /etc/veeam-assistant/vbr-extra.env veeam-assistant node /servers/vbr-extra/server.mjs 2>/dev/null \
  | FILTER="$FILTER" python3 -c "
import json, os, re, sys
pattern = re.compile(os.environ['FILTER'], re.I)
for line in sys.stdin:
    try:
        m = json.loads(line)
    except ValueError:
        continue
    for t in (m.get('result') or {}).get('tools', []):
        if pattern.search(t['name'] + ' ' + t.get('title', '')):
            a = t.get('annotations', {})
            kind = 'reads' if a.get('readOnlyHint') else ('HIGH RISK' if a.get('destructiveHint') else 'changes')
            print('%-62s %-10s %s' % (t['name'], kind, t.get('title', '')))
"
```

2. Put the code name in the `ADD` line of this block. `*` is a wildcard, so `"rest_*_job"` matches `rest_start_job`, `rest_delete_job` and so on. Use `REMOVE` to take names back out.

```bash
sudo python3 - <<'PYEOF'
import json
ADD = ["rest_start_job"]
REMOVE = []
p = '/etc/veeam-assistant/backends.json'
d = json.load(open(p))
v = [s for s in d['servers'] if s['id'] == 'vbr'][0]
if 'agent' not in v:
    raise SystemExit('Claude is not turned on: there is no Claude section to change.')
a = v['agent']
a['allow_tools'] = sorted((set(a.get('allow_tools', [])) | set(ADD)) - set(REMOVE))
json.dump(d, open(p, 'w'), indent=2)
print('Allowed extra operations:', a['allow_tools'])
PYEOF
python3 -m json.tool /etc/veeam-assistant/backends.json > /dev/null && echo "backends.json OK"
```

Then **Reload server list** and run **Test connections**: the count of operations Claude can use goes up.

The file restore operations are already in Claude's list (step O2). To take them away, put their patterns in `REMOVE`: `["rest_*flr*", "rest_get_all_creds", "rest_get_all_managed_servers"]`.

Keep the list short. Every operation Claude can use is described to it with every question, which costs time and money, and a broad wildcard such as `"rest_*"` would send hundreds. Claude is given at most 200 operations (`max_tools`), and the ones you name always come first. Read operations such as `"rest_get_*"` are the safest to add widely; add changes and deletions one at a time.

### Turn Claude off

**Step O6 — Remove the Claude section from backends.json:**

```bash
sudo python3 -c "
import json
p = '/etc/veeam-assistant/backends.json'
d = json.load(open(p))
for s in d['servers']:
    if s['id'] == 'vbr':
        s.pop('agent', None)
        s['description'] = 'Run any VBR operation, including deleting jobs and backups.'
json.dump(d, open(p, 'w'), indent=2)
print('Claude section removed')
"
sudo chown root:root /etc/veeam-assistant/backends.json
sudo chmod 644 /etc/veeam-assistant/backends.json
python3 -m json.tool /etc/veeam-assistant/backends.json > /dev/null && echo "backends.json OK"
```

You must see `Claude section removed` and `backends.json OK`.

**Step O7 — (Optional) Remove the API key as well.** Do this if nothing on this server should be able to reach Claude at all, or if the key is being retired. Leave the key in place if you expect to turn Claude back on soon.

```bash
sudo sed -i '/^ANTHROPIC_API_KEY=/d' /etc/veeam-assistant/app.env
echo "API key lines left: $(sudo grep -c '^ANTHROPIC_API_KEY=' /etc/veeam-assistant/app.env)"
```

You must see `API key lines left: 0`. To turn Claude on again later, start at step O1 and run step 44.

**Step O8 — Restart so it takes effect:**

```bash
sudo sh ~/veeam-assistant/deploy/run-container.sh veeam-assistant:1.0.0
sleep 3
sudo docker logs --since 1m veeam-assistant
```

You must see this line, with no mention of Claude:

```text
[backends] 2 MCP server(s) configured: vi, vbr (2 parts)
```

**Step O9 — Check in the browser.** Press **F5**. With **Veeam Backup & Replication** selected, the message box is greyed out and only **Operations…** is offered. **Test connections** no longer shows a *Written questions* line.

Answers Claude already gave stay in people's chat history. Anything Claude asked for that was still waiting for approval is cancelled by the restart, and nothing from it runs.
