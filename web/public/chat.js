(function () {
  "use strict";

  var api = VA.api, el = VA.el;
  var thread = document.getElementById("thread");
  var scroller = document.getElementById("scroller");
  var intro = document.getElementById("intro");
  var opsIntro = document.getElementById("opsIntro");
  var input = document.getElementById("question");
  var sendBtn = document.getElementById("sendBtn");
  var clearBtn = document.getElementById("clearBtn");
  var askMsg = document.getElementById("askMsg");

  var STARTERS = [
    ["Which backup jobs failed or finished with warnings in the last 24 hours?", "Job and session history"],
    ["Which repositories are more than 80% full?", "Repository capacity"],
    ["Are there any VMs that are not protected by a backup job?", "Protection coverage"],
    ["When does our license expire and how many instances are in use?", "Licensing"]
  ];

  var backendSel = document.getElementById("backend");
  var backendNote = document.getElementById("backendNote");
  var toolsBtn = document.getElementById("toolsBtn");
  var backends = [];
  var turns = [];
  var rendered = {};        // turn id -> signature of what is on screen
  var pollTimer = null;
  var tickTimer = null;

  /* ---------------- helpers ---------------- */

  function fmtTime(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (e) { return ""; }
  }

  function remaining(iso) {
    var ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return "closing";
    var m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    return m + ":" + (s < 10 ? "0" : "") + s + " left";
  }

  function elapsed(iso) {
    var s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
  }

  function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  }

  function showAskMsg(text) {
    askMsg.textContent = text || "";
    askMsg.className = text ? "msg show err" : "msg";
  }

  /* ---------------- rendering ---------------- */

  function head(cls, label, when) {
    var h = el("div", "a-head");
    h.appendChild(el("span", "dot"));
    h.appendChild(el("span", null, label));
    if (when) { var t = el("time", null, fmtTime(when)); h.appendChild(t); }
    return h;
  }

  function approvalBox(t) {
    var a = t.approval;
    var box = el("div", "approval");
    box.appendChild(el("h3", null, a.title));
    if (a.dynamic_description) box.appendChild(el("p", null, a.dynamic_description));
    else if (a.description) box.appendChild(el("p", null, a.description));
    if (a.method || a.path) box.appendChild(el("span", "req", (a.method || "") + " " + (a.path || "")));

    var row = el("div", "row");
    var who;
    if (a.named_approvers) {
      who = a.approvers.length
        ? "Waiting for approval from " + a.approvers.join(" or ") + " (or the administrator)"
        : "Waiting for the administrator";
    } else {
      who = a.approvers && a.approvers.length
        ? "Waiting for " + a.category_label.toLowerCase() + " approval from " + a.approvers.join(", ")
        : "Waiting for the administrator. Nobody else approves " + a.category_label.toLowerCase() + " yet.";
    }
    row.appendChild(el("span", null, who));
    var left = el("strong", "countdown", remaining(a.expires_at));
    left.dataset.expires = a.expires_at;
    row.appendChild(left);
    var cancel = el("button", "ubtn no", "Cancel request");
    cancel.type = "button";
    cancel.addEventListener("click", function () {
      if (!confirm("Cancel this request? The action will not run.")) return;
      cancel.disabled = true;
      api("/api/approvals/cancel", { id: a.id }).then(function (r) {
        if (!r.ok) { alert(r.data.message || "Could not cancel."); cancel.disabled = false; }
        refresh();
      });
    });
    row.appendChild(cancel);
    box.appendChild(row);
    return box;
  }

  function outcomeList(actions) {
    var ul = el("ul", "outcomes");
    actions.forEach(function (x) {
      var li = el("li");
      var cls = x.executed ? "ok" : (x.decision === "approved" ? "bad" : "warn");
      var label = x.executed ? "Ran" : ({ declined: "Declined", expired: "Expired", rejected: "Blocked by policy", approved: "Failed" }[x.decision] || x.decision);
      li.appendChild(el("span", "tag " + cls, label));
      li.appendChild(el("span", null, x.title || "Action"));
      if (x.method || x.path) li.appendChild(el("code", null, (x.method || "") + " " + (x.path || "")));
      if (x.http_status) li.appendChild(el("span", null, "HTTP " + x.http_status));
      if (x.error) li.appendChild(el("span", null, x.error));
      ul.appendChild(li);
    });
    return ul;
  }

  function sourceName(t) {
    if (t.model) return (t.backend_label || "Veeam") + " (answered by Claude)";
    return t.backend_label || "Veeam Intelligence";
  }

  // The footer under a Claude answer: what it used, and what it had available.
  function agentLine(t) {
    var p = el("p", "decided");
    var bits = [];
    if (t.tools_used && t.tools_used.length) {
      bits.push("Operations used: " + t.tools_used.map(function (u) {
        var s = u.title || u.name;
        if (u.risk !== "read") {
          s += u.ran ? " (approved by " + (u.by || "an approver") + ")"
            : u.decision === "cancelled" ? " (cancelled)" : u.decision === "approved" ? " (approved, failed)" : " (declined by " + (u.by || "an approver") + ")";
        }
        return s;
      }).join(", "));
    }
    if (t.model) {
      var who = "Answered by " + t.model;
      var i = t.agent_info;
      if (i) {
        who += " (" + i.access + "; " + i.tools + " operations available, " +
          (i.can_change ? i.can_change + " of them can change or delete things" : "none can change anything") + ")";
      }
      bits.push(who);
    }
    p.textContent = bits.join(". ") + ".";
    return p;
  }

  function answerCard(t) {
    var card = el("div", "a");
    if (t.status === "working") {
      card.appendChild(head("", sourceName(t)));
      if (t.answer) card.appendChild(window.renderMarkdown(t.answer));
      var w = el("div", "working");
      var p = el("span", "pulse");
      p.innerHTML = "<i></i><i></i><i></i>";
      w.appendChild(p);
      var label = el("span", "elapsed", (t.progress || "Working\u2026") + " " + elapsed(t.created));
      label.dataset.base = t.progress || "Working\u2026";
      label.dataset.since = t.created;
      w.appendChild(label);
      card.appendChild(w);
      return card;
    }
    if (t.status === "awaiting_approval" && t.approval) {
      card.className = "a wait";
      card.appendChild(head("", "Needs approval before it runs", t.updated));
      if (t.answer) card.appendChild(window.renderMarkdown(t.answer));
      card.appendChild(approvalBox(t));
      return card;
    }
    if (t.status === "error" || t.status === "interrupted") {
      card.className = "a err";
      card.appendChild(head("", t.status === "interrupted" ? "Interrupted" : "Not answered", t.updated));
      if (t.answer) card.appendChild(window.renderMarkdown(t.answer));
      card.appendChild(el("p", null, t.error || "Something went wrong."));
      if (t.model || (t.tools_used && t.tools_used.length)) card.appendChild(agentLine(t));
      if (t.error_detail) {
        var dd = el("details", "artifacts");
        dd.appendChild(el("summary", null, "Details (shown to the administrator only)"));
        var dp = el("pre");
        dp.textContent = t.error_detail;
        dd.appendChild(dp);
        card.appendChild(dd);
      }
      if (t.actions && t.actions.length) card.appendChild(outcomeList(t.actions));
      return card;
    }
    card.appendChild(head("", sourceName(t), t.updated));
    card.appendChild(window.renderMarkdown(t.answer));
    if (t.actions && t.actions.length) card.appendChild(outcomeList(t.actions));
    if (t.approval && t.approval.decided_by && t.approval.decided_by !== "system") {
      var verb = { approved: "Approved", declined: "Declined", cancelled: "Cancelled" }[t.approval.status] || "Decided";
      var line = verb + " by " + t.approval.decided_by + (t.approval.decided_at ? " on " + fmtTime(t.approval.decided_at) : "");
      if (t.approval.note && t.approval.status !== "cancelled") line += ". Note: " + t.approval.note;
      card.appendChild(el("p", "decided", line));
    }
    if (t.model || (t.tools_used && t.tools_used.length)) card.appendChild(agentLine(t));
    if (t.warning) card.appendChild(el("div", "warn-line", t.warning));
    if (t.artifacts && t.artifacts.length) {
      var d = el("details", "artifacts");
      d.appendChild(el("summary", null, t.artifacts.length + " supporting item" + (t.artifacts.length === 1 ? "" : "s")));
      var pre = el("pre");
      pre.textContent = JSON.stringify(t.artifacts, null, 2);
      d.appendChild(pre);
      card.appendChild(d);
    }
    return card;
  }

  function turnNode(t) {
    var art = el("article", "turn");
    art.id = "t-" + t.id;
    if (t.backend_label && backends.length > 1) {
      art.appendChild(el("div", "src", (t.kind === "tool" ? "Operation on " : "Asked ") + t.backend_label));
    }
    var q = el("div", "q");
    var b = el("div", "bubble", t.question);
    b.appendChild(el("time", null, fmtTime(t.created)));
    q.appendChild(b);
    art.appendChild(q);
    art.appendChild(answerCard(t));
    return art;
  }

  function signature(t) {
    return [t.status, t.updated, t.approval ? t.approval.status + t.approval.approvers.join(",") : "", (t.actions || []).length, backends.length].join("|");
  }

  function paint() {
    var stick = nearBottom();
    var asking0 = !current() || current().mode !== "tools";
    intro.hidden = turns.length > 0 || !asking0;
    opsIntro.hidden = asking0 || turns.length > 0;
    clearBtn.hidden = !turns.some(function (t) { return t.status !== "working" && t.status !== "awaiting_approval"; });

    var seen = {};
    turns.forEach(function (t) {
      seen[t.id] = true;
      var sig = signature(t);
      var existing = document.getElementById("t-" + t.id);
      if (existing && rendered[t.id] === sig) return;
      var node = turnNode(t);
      if (existing) existing.replaceWith(node);
      else thread.appendChild(node);
      rendered[t.id] = sig;
    });
    Object.keys(rendered).forEach(function (id) {
      if (!seen[id]) {
        var n = document.getElementById("t-" + id);
        if (n) n.remove();
        delete rendered[id];
      }
    });

    var busy = turns.some(function (t) { return t.status === "working"; });
    var asking = !current() || current().mode !== "tools";
    sendBtn.disabled = busy || !asking;
    input.disabled = !asking;
    if (asking) {
      input.placeholder = busy ? "Waiting for the current answer\u2026" : "Ask about jobs, repositories, restore points, licenses\u2026";
    }
    if (stick) scroller.scrollTop = scroller.scrollHeight;
    schedule();
  }

  /* ---------------- polling ---------------- */

  function schedule() {
    clearTimeout(pollTimer);
    var active = turns.some(function (t) { return t.status === "working" || t.status === "awaiting_approval"; });
    pollTimer = setTimeout(refresh, active ? 2500 : 30000);
  }

  function refresh() {
    return api("/api/conversation").then(function (r) {
      if (r.ok) { turns = r.data.turns || []; paint(); }
      else schedule();
    }, schedule);
  }

  // Live counters without re-rendering.
  tickTimer = setInterval(function () {
    document.querySelectorAll(".countdown").forEach(function (n) { n.textContent = remaining(n.dataset.expires); });
    document.querySelectorAll(".elapsed").forEach(function (n) { n.textContent = n.dataset.base + " " + elapsed(n.dataset.since); });
  }, 1000);

  /* ---------------- asking ---------------- */

  function grow() {
    input.style.height = "auto";
    input.style.height = Math.min(200, input.scrollHeight) + "px";
  }

  function ask(text) {
    var q = (text !== undefined ? text : input.value).trim();
    if (!q || sendBtn.disabled) return;
    showAskMsg("");
    sendBtn.disabled = true;
    api("/api/ask", { question: q, backend: current() ? current().id : undefined }).then(function (r) {
      if (!r.ok) { showAskMsg(r.data.message || "The question was not sent."); sendBtn.disabled = false; return; }
      input.value = "";
      grow();
      turns.push(r.data.turn);
      paint();
      scroller.scrollTop = scroller.scrollHeight;
    }, function () { showAskMsg("Could not reach the server."); sendBtn.disabled = false; });
  }

  sendBtn.addEventListener("click", function () { ask(); });
  input.addEventListener("input", grow);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); }
  });
  clearBtn.addEventListener("click", function () {
    if (!confirm("Clear your question history? Questions still running or waiting for approval are kept.")) return;
    api("/api/conversation/clear", {}).then(refresh);
  });

  STARTERS.forEach(function (s) {
    var b = el("button", "starter", s[0]);
    b.type = "button";
    b.appendChild(el("span", null, s[1]));
    b.addEventListener("click", function () { ask(s[0]); });
    document.getElementById("starters").appendChild(b);
  });

  /* ---------------- which server ---------------- */

  function current() {
    var id = backendSel.value;
    for (var i = 0; i < backends.length; i++) if (backends[i].id === id) return backends[i];
    return backends[0] || null;
  }

  function applyBackend() {
    var b = current();
    if (!b) return;
    try { localStorage.setItem("va-backend", b.id); } catch (e) {}
    var asking = b.mode !== "tools";
    toolsBtn.hidden = !(b.mode === "tools" || b.mode === "agent");
    input.disabled = !asking;
    sendBtn.disabled = !asking;
    document.querySelector(".box").style.opacity = asking ? "" : ".55";
    backendNote.textContent = b.description ||
      (asking ? "Answers written questions." : "Offers separate operations rather than a chat.");
    if (b.mode === "agent" && b.model) backendNote.textContent += " Answers by " + b.model + (b.access === "read-only" ? ", read-only" : "") + ".";
    if (!asking) {
      input.placeholder = "This server does not answer written questions — use Operations.";
    } else {
      input.placeholder = "Ask about jobs, repositories, restore points, licenses…";
    }
    opsIntro.hidden = asking || turns.length > 0;
    document.getElementById("opsTitle").textContent = "Operations on " + b.label;
    intro.hidden = turns.length > 0 || !asking;
  }

  function loadBackends() {
    return api("/api/backends").then(function (r) {
      backends = (r.data && r.data.backends) || [];
      var saved = null;
      try { saved = localStorage.getItem("va-backend"); } catch (e) {}
      backendSel.innerHTML = "";
      backends.forEach(function (b) {
        var o = el("option", null, b.label);
        o.value = b.id;
        backendSel.appendChild(o);
      });
      if (saved && backends.some(function (b) { return b.id === saved; })) backendSel.value = saved;
      document.querySelector(".picker").hidden = backends.length < 2 && !backends.some(function (b) { return b.mode === "tools" || b.mode === "agent"; });
      if (!backends.length) {
        showAskMsg(r.data && r.data.problem ? r.data.problem : "No Veeam servers are configured. Ask the administrator.");
        sendBtn.disabled = true;
        input.disabled = true;
        return;
      }
      applyBackend();
    });
  }

  backendSel.addEventListener("change", applyBackend);
  function openOps() {
    var b = current();
    if (b) VAOps.open(b, function (turn) { turns.push(turn); paint(); scroller.scrollTop = scroller.scrollHeight; });
  }
  toolsBtn.addEventListener("click", openOps);
  document.getElementById("opsOpen").addEventListener("click", openOps);

  VA.ready.then(function () {
    loadBackends().then(refresh).then(function () {
      scroller.scrollTop = scroller.scrollHeight;
      if (!input.disabled) input.focus();
    });
  });
})();
