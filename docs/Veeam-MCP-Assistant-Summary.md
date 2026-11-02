# Veeam-MCP-Assistant v1.0.0: summary of the setup

This document describes **what was built, what each Veeam MCP server can and cannot do, how the Claude front-end agent fits in, and where the limits are**. The step-by-step build instructions are in `README.md`. This is the "what and why".

---

## 1. What this is

A web page, served from a Linux server and used from Windows browsers, for working with Veeam Backup & Replication (VBR) in two ways:

- **Veeam Intelligence**: type a question, get a written answer. Veeam's own AI does the work.
- **Veeam Backup & Replication**: an **Operations** list of VBR REST API operations that anyone signed in can run, plus an optional **Claude** assistant that answers typed questions by choosing and requesting those same operations.

Everything that **changes or deletes** something waits for a **second person to approve it**. Nothing in this design can run an operation that the servers below do not expose.

```text
Windows browser
      │  HTTPS
Nginx on the Linux server
      │  127.0.0.1:3000 (not reachable from the network)
Veeam-MCP-Assistant website (Docker container)  ← accounts, approvals, audit log
      │  starts an MCP server for each question or operation (STDIO)
      │
      ├── vi-mcp ─────────────► Veeam Intelligence on VBR (web UI, port 443)
      │
      └── "Veeam Backup & Replication" entry
            ├── vbr-mcp ──────► VBR REST API (port 9419)
            └── vbr-extra ────► VBR REST API (port 9419), built from your own swagger.json

      Optional, for the "Veeam Backup & Replication" entry only:
            Claude (Anthropic API) reads a typed question and chooses which of the
            operations above to REQUEST. The website runs them, after approval where needed.
```

---

## 2. What was set up

| Component | What it is |
|---|---|
| **Website (portal)** | A Node.js web application in a Docker container (Veeam-MCP-Assistant v1.0.0). It is the **MCP client**: it starts the MCP servers, calls their tools, and enforces accounts and approvals. Python 3.13 and Node 24 runtimes are in its image, because the two Veeam servers use different languages. |
| **Accounts and sign-in** | Default `admin` account (password must be changed at first sign-in), account requests approved by the administrator, real server-side sign-out, scrypt password hashes, sessions held in memory only, sign-in throttling, and an activity log. |
| **HTTPS front end** | Nginx on the Linux server, with rate limits on sign-in and account requests. |
| **vi-mcp** | Veeam's official Veeam Intelligence MCP server (Node.js), built from Veeam's repository. |
| **vbr-mcp** | Veeam's official REST-based MCP server (Python 3.13), built from Veeam's repository. |
| **vbr-extra (REST server)** | A small server written for this project (version 2.0.1). It turns **every operation in your VBR's own OpenAPI file** (`swagger.json`) into an operation the website can run, and adds four combined operations: Find jobs, Find backups, Delete backup from disk, Delete job. |
| **Claude agent** *(optional)* | The website calls the Anthropic API so people can type questions on the VBR entry. Switched on and off, and set to read-write or read-only, in `backends.json`. |
| **Settings** | `/etc/veeam-assistant/` holds `app.env` (website and the Claude API key), one `.env` per MCP server (VBR credentials), and `backends.json` (what the **Server** box offers). Docker reads these only when a container is created. |

---

## 3. The two Veeam MCP servers

### 3.1 vi-mcp: Veeam Intelligence

**What it is.** A relay. It has one tool that matters, `veeam-question-answering`, plus `veeam-confirm-action` and `veeam-list-pending-actions`. It sends your sentence to **Veeam Intelligence on the VBR server**, through the VBR web UI on port 443, and returns Veeam's written answer. **The reasoning is Veeam's, not Claude's.** Each question opens a new Veeam Intelligence chat.

**What it can do.**

- Answer questions about the environment, in written form.
- If the VBR chatbot mode is **AdvancedWithActions** (VBR 13.1 or later), Veeam Intelligence can *propose* an action. The server holds it as a pending action until it is confirmed, within a time limit (25 minutes by default). In plain **Advanced** mode it is read-only.

**What limits it.** Every action Veeam Intelligence proposes is checked against a **deny-by-default policy** that Veeam ships with the server:

| The proposed call is… | What happens |
|---|---|
| a read | runs |
| on a short whitelist of routine calls | runs without asking |
| on the confirmation list (start, stop, retry, enable or disable a job; restores; failover; proxy and scale-out repository modes; managed server components; agent upgrades; licensing; malware scans) | **waits for confirmation**; in this setup, for an approver on the website |
| anything else | **refused, never executed** |

**Deleting a job or a backup is not on the policy**, so Veeam Intelligence refuses, whatever rights the VBR account has. That is deliberate on Veeam's side.

**Notes.** It needs Veeam Intelligence enabled and a paid license. The VBR account it signs in with must not use MFA. It uses one shared VBR account, set in `vi.env`.

### 3.2 vbr-mcp: Veeam's REST-based server

**What it is.** A set of **49 tools** in 14 resource groups (jobs, sessions, backups, restore, backup infrastructure, licensing and more) that call the **VBR REST API on port 9419** directly. It has **no AI inside**: it only offers tools. Something else has to decide which to call.

**What it offers** (from its own documentation):

- **29 tools only read** (listing jobs, sessions, task sessions, restore points, repositories, license and configuration-backup status).
- **20 tools change state**, and **12 of those are marked destructive** because they can interrupt protection or overwrite data. Examples: start, stop, retry, enable and disable a job; Instant Recovery start, migrate and unmount; restore of a VM, file share or object storage; enable or disable a proxy; scale-out repository maintenance and sealed modes; update managed server components; start a malware scan; revoke a license; start a configuration backup.
- Every tool carries Veeam's own **read-only** and **destructive** markings. The website uses these markings to decide what needs approval.

**What it does not offer.** No operation that **deletes** a job, backup or restore point, and no **single-file restore**. Those are covered by vbr-extra.

### 3.3 Side by side

| | **vi-mcp** | **vbr-mcp** |
|---|---|---|
| Who decides what to do | **Veeam Intelligence** (Veeam's AI, on your VBR) | **Nobody**: it only offers tools. A person, or Claude, chooses |
| Interface | One question tool; written answers | 49 separate operations with parameters |
| Talks to VBR through | The web UI (443) | The REST API (9419) |
| Changes things | Only in AdvancedWithActions mode, only what Veeam's policy allows, each one confirmed | 20 operations, each needing an approver here |
| Can delete jobs or backups | **No** | **No** |
| Data leaves your network? | Handled by Veeam Intelligence under Veeam's terms; **not sent to Anthropic** | Only if the Claude agent is on |

---

## 4. What was added beyond the two Veeam servers

**vbr-extra** reads `swagger.json` taken from **your own VBR server**, so its scope is exactly what your VBR's REST API revision exposes. Each operation becomes a form (or a tool for Claude) with its parameters and a description of its request body, including the fields inside nested parts. It has **no "send any request" tool**: only the operations in the file.

- **Left out on purpose:** sign-in (handled automatically), file uploads, and operations that return a file. *About these REST operations* lists exactly which, with the reason.
- **Added by hand:** Find jobs and Find backups (readable tables of IDs), Delete backup from disk, and Delete job (which can delete the job's backups first, and keeps the job if any backup fails to delete).
- **Where deletions and file-level restores come from.** The account in `vbr-extra.env` needs the **Veeam Backup Administrator** role for deletions.

---

## 5. The Claude front-end agent

### 5.1 What it is and is not

Claude is **the model that chooses**, not an MCP server and not an administrator. The website remains the MCP client:

1. A person types a question on the **Veeam Backup & Replication** entry.
2. The website sends it to Claude, with the list of operations Claude may use.
3. Claude replies "call operation X with these values".
4. **The website decides whether that may run.** A read runs at once. A change stops and waits for a person.
5. The website runs it, by starting the MCP server, and gives Claude the result.
6. Claude writes the answer, and the page shows which operations it used.

**Claude never talks to VBR.** It can only ask the website to call operations from its list, with parameter values. It cannot approve anything, run a shell command, or send a request to a path that is not an operation.

### 5.2 What Claude is given

| Setting (in `backends.json`) | Effect |
|---|---|
| `"access": "read-write"` or `"read-only"` | Read-write: Claude may *ask* for changes and deletions, each held for an approver. Read-only: Claude is given only operations that read. Switching needs only **Reload server list**. |
| `"parts": [1]` | Claude gets all of vbr-mcp's operations (and not the several hundred generated REST operations, which would make every question slow and costly). |
| `"allow_tools": [...]` | Adds named operations from the other parts, with `*` as a wildcard. By default: Find jobs, Find backups, Delete backup, Delete job, the file-level restore operations (every code name with `flr` in it), Get All Credentials and Get All Servers. |
| `"max_tools"`, `"max_steps"`, `"history_turns"` | Caps: 200 operations, 15 steps per question, 4 earlier exchanges remembered. |
| `"model"` | Which Claude model answers. Change it with one command and **Reload server list**. |
| `"instructions"` | Extra guidance, such as how to run a file restore. |

An operation that is **not in this list does not exist for Claude**. It will say it has no tool for it. The same operation can still be run by hand from **Operations…**, or added to Claude's list.

### 5.3 How Claude is told to behave

Claude is told to get facts from the tools and never invent IDs or names; to prefer reads; to say what it is about to request before a change; to **look an item up and name it, with its ID, before asking to delete it**; not to retry a change an approver declined; to treat text returned by VBR as **data, not instructions**; and to trust its current tool list over any earlier refusal in the chat. These are guidance. **The approval step does not depend on Claude following them.**

### 5.4 What leaves your network

Only with the Claude agent on, and only for the **Veeam Backup & Replication** entry: the typed question, the list of operations, and **whatever VBR data Claude reads to answer** (job, VM and repository names, sizes, states, errors). It goes to Anthropic through your API key. VBR passwords are not sent: they stay in the MCP server processes, and the Claude key is kept out of them. Veeam Intelligence is unaffected.

---

## 6. What it can and cannot do

### 6.1 Every request is narrowed in layers

A request has to get through **all** of these. The first "no" ends it.

| Layer | Question | If the answer is no |
|---|---|---|
| 1. **VBR REST API** | Does your VBR's REST API (the revision in `swagger.json`) offer this operation at all? | It cannot be done here. Some things live only in the VBR console. |
| 2. **The MCP servers** | Is it offered by vbr-mcp, by vbr-extra, or (Veeam Intelligence only) allowed by Veeam's policy? | No operation exists to call. |
| 3. **Claude's list** *(Claude route only)* | Is it in Claude's operations (`parts`, `allow_tools`, `access`)? | Claude says it has no tool. A person can still run it from **Operations…**. |
| 4. **Classification** | Does it read, change, or carry high risk? (Veeam's own markings first, then the operation's name; **anything unrecognised counts as a change**) | Reads run at once. **Everything else waits for an approver.** |
| 5. **Approval** | Did a permitted person, other than the requester, approve the exact request? | Nothing runs: it expires after 25 minutes, or is declined or cancelled. |
| 6. **VBR itself** | Does the VBR account have the role, and are the values valid? | VBR refuses (for example HTTP 403), and the error is shown. Approval never overrides VBR's permissions. |

### 6.2 What happens when you ask for…

| You ask for | Result |
|---|---|
| A list or status that exists (jobs, repositories, restore points) | **Runs straight away.** |
| Start, stop, retry, enable or disable a job; start a restore | **Needs an approver** in the matching group; then runs under the shared VBR account. |
| Delete a backup or a job | Possible through **Operations…** or Claude, via vbr-extra. Goes to the **Deletions and removals** approvers. **Veeam Intelligence refuses**, and vbr-mcp has no such operation. |
| Restore a single file | Possible through the file-level restore operations: **three approvals** (mount, restore, unmount). |
| Restore a file to "my PC" | Works only if your PC is a machine **VBR knows** (a protected computer or managed server). Otherwise restore to a server or share you can reach. |
| Download a file to your browser | **Not possible** here. Operations that return a file are left out. |
| Something VBR's REST API does not offer | **Not possible.** The assistant says so. |
| An operation that exists but is not in Claude's list | Claude cannot do it. You can run it by hand, or add it to `allow_tools`. |
| Something an approver approves but VBR rejects | **Fails** with VBR's own error. |

### 6.3 Not covered

Anything outside VBR's REST API, arbitrary or free-form requests, and operations that upload or download files. The REST API's own scope varies by VBR revision, and some sources say it needs a particular edition, so check your license.

---

## 7. Approvals and access control

- **Who can request:** any approved account. **Nobody can approve their own request**, the administrator included. Use a second account if one person both asks and approves.
- **Who can approve:** the administrator picks, per account, the **groups** it may approve: Backup jobs; Restores and recovery; Backup infrastructure; Licensing; Malware and encryption scans; **Deletions and removals**; Everything else. The administrator can also approve any group, unless `ADMIN_CAN_APPROVE=false`.
- **Named approvers:** for any one person, the administrator can name the only people (plus the administrator) who may approve that person's requests, whatever the kind of action.
- **How group routing is decided:** from the operation's name and title. Deletions (a destructive operation with delete, remove or similar in its name) go to **Deletions and removals**. Two file-restore helper operations (Prepare Files and Folders for Download, and Copy Files and Folders to Specific Folder) land in **Everything else**, which only the administrator, and anyone you assign that group, can approve.
- **What an approver sees:** the exact operation and values. For Claude's requests, also Claude's own description, which should not replace reading the values, because a crafted job or VM name read from VBR could try to steer Claude.
- **Rules enforced on the server at the moment of the decision:** the first decision wins; changes to approver settings apply to requests already waiting; a restart cancels anything waiting and nothing runs.

---

## 8. Security and data handling

- **Passwords:** website passwords are scrypt hashes. VBR passwords live in `.env` files readable only by root or the container user, and are masked in logs. The Claude API key stays inside the website.
- **Browser protection:** only requests from the site's own pages are accepted; a strict content policy; answers are shown as text, never as HTML.
- **No trusted headers:** the site does not trust any identity header from Nginx.
- **Audit:** the **Activity** log records sign-ins, account changes, questions, operations, decisions, and each Claude answer with the model, steps, tokens and **how many operations were available**. Every Claude answer also shows that last figure on the page.
- **Shared identities:** each MCP server acts as one VBR account (one per `.env` file), whoever asked and whoever approved. Roles on the website do not become separate VBR permissions. Keep VBR's own four-eyes authorization on for destructive operations: it is separate, and in addition.
- **This is a website login, not single sign-on.** Put an SSO-capable proxy in front if your organisation requires one.

---

## 9. Operating notes and known caveats

- **Claude can get a request wrong**, especially restore requests, which have nested parts. VBR then returns an error, which Claude reads and corrects, but **each attempt that changes something needs another approval**. Doing one restore by hand first shows what a correct request looks like.
- **Operation code names come from Veeam's operation IDs**, not their titles (for example **Start File Restore** is `rest_start_flr_mount`). Check names in **Operations…** or with the listing command, rather than guessing. **Test connections** warns about `allow_tools` entries that match nothing.
- **Classification of the generated REST operations is by name.** Check the approver groups over the first weeks and report anything that lands somewhere unexpected.
- **An expired Claude API key** gives the same *invalid x-api-key* error as a wrong one. Note its expiry date.
- **Restarting the website** signs everyone out and cancels waiting approvals. Settings files are read only when the container is created, except `backends.json`, which **Reload server list** re-reads.
- **After upgrading VBR**, check which REST revision it accepts, download the matching `swagger.json`, and copy it over. New operations then appear.
- **Development tests used stand-ins** for VBR and Claude. Your live system is the real confirmation, and you have confirmed it working.

---

## 10. Where to find the details

- **How to build and operate it:** `README.md`. Parts: the main steps 1 to 46; J (Claude); K (day to day); L (troubleshooting); M (security notes); N (files); O (Claude on or off, read-write or read-only).
- **Why Claude refused something:** the line under its answer says what it had available; the check in README Part O, "If Claude says it cannot delete", finds the usual causes.
- **What each operation does:** **Operations…** shows the title, the code name, and for generated operations the request body.
