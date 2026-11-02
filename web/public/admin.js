(function () {
  "use strict";

  var api = VA.api, el = VA.el;
  var state = { users: [], categories: [], coverage: {}, admin_can_approve: true };
  var openPanel = null;   // "username:kind" of the panel left open across repaints

  function fmt(iso) {
    if (!iso) return "never";
    try { return new Date(iso).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return iso; }
  }

  function flash(cls, text) {
    var m = document.getElementById("msg");
    m.className = "msg show " + cls;
    m.textContent = text;
    clearTimeout(flash.t);
    flash.t = setTimeout(function () { m.className = "msg"; }, 6000);
  }

  function op(payload, btn) {
    if (btn) btn.disabled = true;
    return api("/api/admin/user", payload).then(function (r) {
      flash(r.ok ? "ok" : "err", r.data.message || (r.ok ? "Done." : "That did not work."));
      return load().then(function () { return r.ok; });
    }, function () { flash("err", "Could not reach the server."); if (btn) btn.disabled = false; return false; });
  }

  function catLabel(id) {
    var c = state.categories.filter(function (x) { return x.id === id; })[0];
    return c ? c.label : id;
  }

  /* ---------------- rows ---------------- */

  function pendingRow(u) {
    var li = el("li", "urow");
    var nm = el("div", "uname");
    nm.appendChild(el("strong", null, u.username));
    nm.appendChild(el("span", null, "Requested " + fmt(u.created)));
    li.appendChild(nm);
    li.appendChild(el("span", "tag pending", "Pending"));
    var acts = el("div", "uacts");
    var ok = el("button", "ubtn ok", "Approve");
    var no = el("button", "ubtn no", "Reject");
    ok.type = no.type = "button";
    ok.addEventListener("click", function () { op({ username: u.username, op: "approve" }, ok); });
    no.addEventListener("click", function () {
      if (confirm("Reject and delete the request for \u201c" + u.username + "\u201d?")) op({ username: u.username, op: "reject" }, no);
    });
    acts.appendChild(ok); acts.appendChild(no);
    li.appendChild(acts);
    return li;
  }

  function approverPanel(u) {
    var p = el("div", "panel");
    p.appendChild(el("h3", null, "Approver for"));
    p.appendChild(el("p", null, "Tick each kind of Veeam action " + u.username +
      " may approve for other people. Leave all unticked to make them an ordinary user."));
    var box = el("div", "checks");
    state.categories.forEach(function (c) {
      var lab = el("label", "check");
      var cb = el("input");
      cb.type = "checkbox";
      cb.value = c.id;
      cb.checked = u.approver_for.indexOf(c.id) !== -1;
      var txt = el("span", null, c.label);
      txt.appendChild(el("small", null, c.description));
      lab.appendChild(cb); lab.appendChild(txt);
      box.appendChild(lab);
    });
    p.appendChild(box);
    var acts = el("div", "panel-acts");
    var save = el("button", "ubtn primary", "Save");
    var cancel = el("button", "ubtn", "Close");
    save.type = cancel.type = "button";
    save.addEventListener("click", function () {
      var picked = Array.prototype.map.call(box.querySelectorAll("input:checked"), function (x) { return x.value; });
      op({ username: u.username, op: "approver_for", categories: picked }, save).then(function (ok) { if (ok) { openPanel = null; paint(); } });
    });
    cancel.addEventListener("click", function () { openPanel = null; paint(); });
    acts.appendChild(save); acts.appendChild(cancel);
    p.appendChild(acts);
    return p;
  }

  function approvedByPanel(u) {
    var p = el("div", "panel");
    p.appendChild(el("h3", null, "Who approves " + u.username + "\u2019s requests"));
    p.appendChild(el("p", null, state.admin_can_approve
      ? "Tick the people allowed to approve actions " + u.username + " asks for. Once anyone is ticked, only they and the " +
        "administrator can approve, whatever the kind of action. Leave all unticked to use the normal approver groups."
      : "Tick the people allowed to approve actions " + u.username + " asks for. Once anyone is ticked, only they can " +
        "approve, whatever the kind of action. Leave all unticked to use the normal approver groups."));
    var box = el("div", "checks");
    var others = state.users.filter(function (x) {
      return x.status === "approved" && x.role !== "admin" && x.username !== u.username;
    });
    if (!others.length) box.appendChild(el("span", "empty2", "There are no other active accounts to choose from yet."));
    others.forEach(function (x) {
      var lab = el("label", "check");
      var cb = el("input");
      cb.type = "checkbox";
      cb.value = x.username;
      cb.checked = u.approved_by_only.some(function (n) { return n.toLowerCase() === x.username.toLowerCase(); });
      var txt = el("span", null, x.username);
      txt.appendChild(el("small", null, x.approver_for.length
        ? "Also approves: " + x.approver_for.map(catLabel).join(", ")
        : "Not in any approver group"));
      lab.appendChild(cb); lab.appendChild(txt);
      box.appendChild(lab);
    });
    p.appendChild(box);
    var acts = el("div", "panel-acts");
    var save = el("button", "ubtn primary", "Save");
    var cancel = el("button", "ubtn", "Close");
    save.type = cancel.type = "button";
    save.addEventListener("click", function () {
      var picked = Array.prototype.map.call(box.querySelectorAll("input:checked"), function (x) { return x.value; });
      op({ username: u.username, op: "approved_by_only", approvers: picked }, save).then(function (ok) { if (ok) { openPanel = null; paint(); } });
    });
    cancel.addEventListener("click", function () { openPanel = null; paint(); });
    acts.appendChild(save); acts.appendChild(cancel);
    p.appendChild(acts);
    return p;
  }

  function resetPanel(u) {
    var p = el("div", "panel");
    p.appendChild(el("h3", null, "Set a temporary password"));
    p.appendChild(el("p", null, u.username + " is signed out everywhere and must choose a new password at next sign-in. " +
      "Give them the temporary one in person or by phone."));
    var f = el("div", "field");
    var l = el("label", null, "Temporary password");
    var i = el("input");
    i.type = "text"; i.autocomplete = "off"; i.id = "tmp-" + u.username;
    l.setAttribute("for", i.id);
    f.appendChild(l); f.appendChild(i);
    p.appendChild(f);
    var acts = el("div", "panel-acts");
    var gen = el("button", "ubtn", "Generate one");
    var save = el("button", "ubtn primary", "Set password");
    var cancel = el("button", "ubtn", "Close");
    gen.type = save.type = cancel.type = "button";
    gen.addEventListener("click", function () {
      var words = new Uint32Array(4);
      crypto.getRandomValues(words);
      i.value = Array.prototype.map.call(words, function (w) { return w.toString(36).slice(0, 5); }).join("-");
    });
    save.addEventListener("click", function () {
      op({ username: u.username, op: "reset_password", password: i.value }, save).then(function (ok) { if (ok) { openPanel = null; paint(); } });
    });
    cancel.addEventListener("click", function () { openPanel = null; paint(); });
    acts.appendChild(gen); acts.appendChild(save); acts.appendChild(cancel);
    p.appendChild(acts);
    return p;
  }

  function userRow(u) {
    var li = el("li", "urow");
    var nm = el("div", "uname");
    nm.appendChild(el("strong", null, u.username));
    nm.appendChild(el("span", null, "Last sign-in " + fmt(u.last_login) + (u.approved_by ? ". Approved by " + u.approved_by : "")));
    li.appendChild(nm);

    var tags = el("div", "utags");
    if (u.role === "admin") tags.appendChild(el("span", "tag admin", "Admin"));
    else if (u.status === "disabled") tags.appendChild(el("span", "tag bad", "Disabled"));
    else tags.appendChild(el("span", "tag user", "User"));
    if (u.must_change_password) tags.appendChild(el("span", "tag warn", "Temporary password"));
    u.approver_for.forEach(function (c) { tags.appendChild(el("span", "tag ok", catLabel(c))); });
    if (u.approved_by_only.length) {
      tags.appendChild(el("span", "tag warn", "Approved only by " +
        (state.admin_can_approve ? "admin, " : "") + u.approved_by_only.join(", ")));
    }
    li.appendChild(tags);

    var acts = el("div", "uacts");
    if (u.role !== "admin") {
      var ap = el("button", "ubtn ok", "Approver for\u2026");
      var by = el("button", "ubtn", "Approved by\u2026");
      var rp = el("button", "ubtn", "Reset password");
      var dis = el("button", "ubtn no", u.status === "disabled" ? "Enable" : "Disable");
      var rm = el("button", "ubtn no", "Remove");
      ap.type = by.type = rp.type = dis.type = rm.type = "button";
      ap.addEventListener("click", function () { openPanel = u.username + ":approver"; paint(); });
      by.addEventListener("click", function () { openPanel = u.username + ":approvedby"; paint(); });
      rp.addEventListener("click", function () { openPanel = u.username + ":reset"; paint(); });
      dis.addEventListener("click", function () {
        op({ username: u.username, op: u.status === "disabled" ? "enable" : "disable" }, dis);
      });
      rm.addEventListener("click", function () {
        if (confirm("Remove \u201c" + u.username + "\u201d? They are signed out at once, their history is deleted, " +
                    "and anything they are waiting on is cancelled.")) op({ username: u.username, op: "remove" }, rm);
      });
      acts.appendChild(ap); acts.appendChild(by); acts.appendChild(rp); acts.appendChild(dis); acts.appendChild(rm);
    } else {
      acts.appendChild(el("span", "empty2", state.admin_can_approve ? "Can decide any approval" : "Approves nothing"));
    }
    li.appendChild(acts);

    if (openPanel === u.username + ":approver") li.appendChild(approverPanel(u));
    if (openPanel === u.username + ":approvedby") li.appendChild(approvedByPanel(u));
    if (openPanel === u.username + ":reset") li.appendChild(resetPanel(u));
    return li;
  }

  /* ---------------- sections ---------------- */

  function paint() {
    var pend = state.users.filter(function (u) { return u.status === "pending"; });
    var p = document.getElementById("pending");
    p.innerHTML = "";
    if (!pend.length) p.appendChild(el("li", "empty2", "Nothing waiting."));
    pend.forEach(function (u) { p.appendChild(pendingRow(u)); });

    var all = document.getElementById("users");
    all.innerHTML = "";
    state.users.filter(function (u) { return u.status !== "pending"; }).forEach(function (u) { all.appendChild(userRow(u)); });

    var cover = document.getElementById("cover");
    cover.innerHTML = "";
    state.categories.forEach(function (c) {
      var a = el("div", "cat");
      a.appendChild(el("strong", null, c.label));
      a.appendChild(el("span", null, c.description));
      var b = el("div", "names");
      var names = state.coverage[c.id] || [];
      names.forEach(function (n) { b.appendChild(el("span", "tag ok", n)); });
      if (!names.length) {
        b.appendChild(el("span", "tag warn", state.admin_can_approve ? "Only you, the administrator" : "Nobody"));
      }
      cover.appendChild(a); cover.appendChild(b);
    });
    var named = state.users.filter(function (u) { return u.approved_by_only && u.approved_by_only.length; });
    var extra = document.getElementById("namedCover");
    extra.innerHTML = "";
    if (named.length) {
      extra.appendChild(el("p", "lede", "These accounts ignore the groups above. Their requests go only to the people named:"));
      var ul = el("ul", "ulist");
      named.forEach(function (u) {
        var li = el("li", "urow");
        var nm = el("div", "uname");
        nm.appendChild(el("strong", null, u.username));
        li.appendChild(nm);
        var t = el("div", "utags");
        if (state.admin_can_approve) t.appendChild(el("span", "tag admin", "admin"));
        u.approved_by_only.forEach(function (n) { t.appendChild(el("span", "tag ok", n)); });
        li.appendChild(t);
        ul.appendChild(li);
      });
      extra.appendChild(ul);
    }
  }

  function load() {
    return api("/api/admin/users").then(function (r) {
      if (!r.ok) { flash("err", r.data.message || "Could not load accounts."); return; }
      state = r.data;
      paint();
    });
  }

  /* ---------------- activity ---------------- */

  var LABELS = {
    login: "Signed in", login_failed: "Failed sign-in", login_throttled: "Sign-in blocked", logout: "Signed out",
    account_requested: "Account requested", password_changed: "Password changed", question: "Question asked",
    approval_requested: "Approval requested", approval_granted: "Approved", approval_declined: "Declined",
    approval_cancelled: "Request cancelled", approval_expired: "Request expired", action_outcome: "Action finished",
    admin_approve: "Account approved", admin_reject: "Request rejected", admin_remove: "Account removed",
    admin_disable: "Account disabled", admin_enable: "Account enabled", admin_approver_for: "Approver groups changed",
    admin_reset_password: "Password reset", admin_approved_by_only: "Named approvers changed", connection_test: "Connection tested",
    admin_password_reset_console: "Admin password reset from console",
    tool_requested: "Operation requested", tool_ran: "Operation ran", tool_failed: "Operation failed",
    backends_reloaded: "MCP server list reloaded", agent_answer: "Answered by Claude"
  };

  function loadLog() {
    api("/api/admin/audit").then(function (r) {
      var body = document.getElementById("log");
      body.innerHTML = "";
      var rows = (r.data && r.data.entries) || [];
      if (!rows.length) {
        var tr0 = el("tr"), td0 = el("td", null, "Nothing recorded yet.");
        td0.colSpan = 3; tr0.appendChild(td0); body.appendChild(tr0);
      }
      rows.forEach(function (e) {
        var tr = el("tr");
        tr.appendChild(el("td", null, fmt(e.at)));
        tr.appendChild(el("td", null, LABELS[e.event] || e.event));
        var d = Object.keys(e).filter(function (k) { return k !== "at" && k !== "event" && e[k] !== undefined && e[k] !== null; })
          .map(function (k) { return k + ": " + (typeof e[k] === "object" ? JSON.stringify(e[k]) : e[k]); }).join(", ");
        tr.appendChild(el("td", null, d));
        body.appendChild(tr);
      });
    });
  }

  /* ---------------- connection test ---------------- */

  function renderTest(out, d) {
    var card = el("div", "test-one");
    var okCls = d.ok ? "ok" : "err";
    card.appendChild(el("p", "msg show " + okCls,
      (d.label || d.id) + ": " + (d.ok
        ? "started in " + Math.round(d.ms / 100) / 10 + "s" +
          (d.parts && d.parts.length > 1 ? " (" + d.parts.length + " parts)" : (d.server ? " (" + d.server.name + " " + (d.server.version || "") + ")" : "")) +
          ", " + d.tools.length + " tool" + (d.tools.length === 1 ? "" : "s") +
          ", " + (d.mode === "question" ? "answers questions" : d.mode === "agent" ? "answers questions with Claude and offers operations" : "offers operations")
        : (d.message || "failed"))));
    if (d.ok) {
      var ul = el("ul");
      d.tools.slice(0, 40).forEach(function (t) {
        var li = el("li", null, (t.title || t.name) + " ");
        li.appendChild(el("span", "tag " + (t.risk === "read" ? "ok" : t.risk === "destructive" ? "bad" : "warn"),
          t.risk === "read" ? "Read" : t.risk === "destructive" ? "High risk" : "Changes"));
        ul.appendChild(li);
      });
      if (d.tools.length > 40) ul.appendChild(el("li", null, "and " + (d.tools.length - 40) + " more\u2026"));
      card.appendChild(ul);
      if (d.agent) {
        card.appendChild(el("p", "msg show " + (d.agent.ok ? "ok" : "err"),
          d.agent.ok
            ? "Written questions: Claude model " + d.agent.model + " is available. Access: " + (d.agent.access || "read-write") + "." +
              (d.agent.tools !== undefined
                ? " Claude can use " + d.agent.tools + " operations" +
                  (d.agent.can_change ? ", " + d.agent.can_change + " of which can change or delete things (each waits for an approver)." : ", none of which can change anything.")
                : "")
            : "Written questions: " + d.agent.message));
        if (d.agent.unmatched && d.agent.unmatched.length) {
          card.appendChild(el("p", "msg show info",
            "These allow_tools entries match no operation, so Claude cannot use them: " + d.agent.unmatched.join(", ") +
            ". Check the spelling, and that the part that offers them is working (see the part lines below)."));
        }
      }
      if (d.parts && d.parts.length > 1) {
        d.parts.forEach(function (p, i) {
          card.appendChild(el("p", "lede", "Part " + (i + 1) + ": " +
            (p.server ? p.server.name + " " + (p.server.version || "") + ", " : "") +
            p.tool_count + " tools. Started with: " + p.command));
        });
      } else if (d.command) {
        card.appendChild(el("p", "lede", "Started with: " + d.command));
      }
    } else if (d.detail) {
      var pre = el("pre");
      pre.textContent = d.detail;
      card.appendChild(pre);
    }
    out.appendChild(card);
  }

  document.getElementById("testBtn").addEventListener("click", function () {
    var b = this, out = document.getElementById("testOut");
    b.disabled = true; b.textContent = "Testing\u2026";
    out.innerHTML = "";
    api("/api/admin/test-connection", {}).then(function (r) {
      b.disabled = false; b.textContent = "Test connections";
      var d = r.data || {};
      if (d.problem) out.appendChild(el("p", "msg show err", d.problem));
      (d.results || []).forEach(function (one) { renderTest(out, one); });
      if (!d.results || !d.results.length) out.appendChild(el("p", "empty2", "No MCP servers are configured."));
      loadLog();
    }, function () {
      b.disabled = false; b.textContent = "Test connections";
      out.appendChild(el("p", "msg show err", "Could not reach the server."));
    });
  });

  document.getElementById("reloadBtn").addEventListener("click", function () {
    var b = this;
    b.disabled = true;
    api("/api/admin/reload-backends", {}).then(function (r) {
      b.disabled = false;
      flash(r.ok ? "ok" : "err", (r.data.problem || r.data.message) || "Reloaded.");
      loadLog();
    }, function () { b.disabled = false; flash("err", "Could not reach the server."); });
  });

  VA.ready.then(function (s) {
    if (s.role !== "admin") { window.location.href = "/"; return; }
    load();
    loadLog();
  });
})();
