(function () {
  "use strict";

  var api = VA.api, el = VA.el;
  var timer = null;
  var lastSig = "";
  var STATUS = {
    approved: ["ok", "Approved"], declined: ["bad", "Declined"], cancelled: ["user", "Cancelled"],
    expired: ["warn", "Expired"], failed: ["bad", "Failed"]
  };

  function fmt(iso) {
    try { return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return ""; }
  }
  function remaining(iso) {
    var ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return "Closing";
    var m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    return m + ":" + (s < 10 ? "0" : "") + s + " left to decide";
  }
  function note(cls, text) {
    var m = document.getElementById("msg");
    m.className = text ? "msg show " + cls : "msg";
    m.textContent = text || "";
  }

  function waitingItem(a) {
    var li = el("li", "req-item");
    var top = el("div", "req-top");
    top.appendChild(el("h3", null, a.title));
    top.appendChild(el("span", "tag pending", a.category_label));
    if (a.named_approvers) top.appendChild(el("span", "tag ok", "You are a named approver"));
    li.appendChild(top);
    li.appendChild(el("p", "req-meta", "Requested by " + a.requester + " on " + fmt(a.created) +
      (a.backend_label ? " \u00b7 " + a.backend_label : "")));

    var q = el("div", "req-q");
    q.appendChild(el("b", null, a.tool ? "What they asked to run" : "Their question"));
    q.appendChild(document.createTextNode(a.question));
    li.appendChild(q);

    if (a.dynamic_description) li.appendChild(el("p", "req-desc", a.dynamic_description));
    if (a.description) li.appendChild(el("p", "req-risk", a.description));
    if (a.method || a.path) li.appendChild(el("span", "req-call", (a.method || "") + " " + (a.path || "")));

    if (a.body || a.query_params) {
      var d = el("details");
      d.appendChild(el("summary", null, "Exact request that will be sent"));
      var pre = el("pre");
      var text = "";
      if (a.query_params) text += "Query: " + JSON.stringify(a.query_params, null, 2) + "\n";
      if (a.body) {
        try { text += "Body: " + JSON.stringify(JSON.parse(a.body), null, 2); }
        catch (e) { text += "Body: " + a.body; }
      }
      pre.textContent = text;
      d.appendChild(pre);
      li.appendChild(d);
    }

    var acts = el("div", "req-acts");
    var reason = el("input");
    reason.type = "text";
    reason.maxLength = 500;
    reason.placeholder = "Note for the requester (optional)";
    reason.setAttribute("aria-label", "Note for the requester");
    var cd = el("span", "countdown", remaining(a.expires_at));
    cd.dataset.expires = a.expires_at;
    var yes = el("button", "ubtn primary", "Approve and run");
    var no = el("button", "ubtn no", "Decline");
    yes.type = no.type = "button";
    if (a.status === "deciding") { yes.disabled = no.disabled = true; yes.textContent = "Sending decision\u2026"; }

    function decide(approve) {
      if (approve && !confirm("Run \u201c" + a.title + "\u201d on the Veeam server now?")) return;
      yes.disabled = no.disabled = true;
      api("/api/approvals/decide", { id: a.id, approve: approve, note: reason.value }).then(function (r) {
        note(r.ok ? "ok" : "err", r.data.message || (r.ok ? "Done." : "The decision was not recorded."));
        load();
      }, function () { note("err", "Could not reach the server."); yes.disabled = no.disabled = false; });
    }
    yes.addEventListener("click", function () { decide(true); });
    no.addEventListener("click", function () { decide(false); });

    acts.appendChild(reason);
    acts.appendChild(cd);
    acts.appendChild(no);
    acts.appendChild(yes);
    li.appendChild(acts);
    return li;
  }

  function recentItem(a) {
    var li = el("li", "hist");
    var w = el("div", "what");
    w.appendChild(el("strong", null, a.title));
    var line = "Asked by " + a.requester;
    if (a.decided_by && a.decided_by !== "system") line += ", decided by " + a.decided_by;
    if (a.decided_at) line += " on " + fmt(a.decided_at);
    if (a.note) line += ". " + a.note;
    w.appendChild(el("span", null, line));
    li.appendChild(w);
    li.appendChild(el("span", "tag user", a.category_label));
    var s = STATUS[a.status] || ["user", a.status];
    var label = s[1];
    if (a.status === "approved" && a.outcome) label = a.outcome.executed ? "Approved and ran" : "Approved, did not run";
    li.appendChild(el("span", "tag " + (a.status === "approved" && a.outcome && !a.outcome.executed ? "bad" : s[0]), label));
    return li;
  }

  function paint(d) {
    var sig = JSON.stringify([d.waiting.map(function (a) { return a.id + a.status; }), d.recent.length && d.recent[0].id]);
    if (sig === lastSig) return;
    lastSig = sig;
    var w = document.getElementById("waiting");
    w.innerHTML = "";
    if (!d.waiting.length) w.appendChild(el("li", "empty2", "Nothing is waiting for you."));
    d.waiting.forEach(function (a) { w.appendChild(waitingItem(a)); });

    var r = document.getElementById("recent");
    r.innerHTML = "";
    if (!d.recent.length) r.appendChild(el("li", "empty2", "No decisions yet."));
    d.recent.forEach(function (a) { r.appendChild(recentItem(a)); });
  }

  function load() {
    clearTimeout(timer);
    api("/api/approvals").then(function (r) {
      if (r.ok) paint(r.data);
      timer = setTimeout(load, 5000);
    }, function () { timer = setTimeout(load, 10000); });
  }

  setInterval(function () {
    document.querySelectorAll(".countdown").forEach(function (n) { n.textContent = remaining(n.dataset.expires); });
  }, 1000);

  VA.ready.then(function (s) {
    var mine = document.getElementById("mine");
    api("/api/categories").then(function (r) {
      var cats = (r.data && r.data.categories) || [];
      var any = false;
      cats.forEach(function (c) {
        var all = s.role === "admin";
        if (all || s.approver_for.indexOf(c.id) !== -1) {
          any = true;
          mine.appendChild(el("span", "tag ok", c.label));
        }
      });
      if (s.role === "admin") mine.appendChild(el("span", "tag user", "As administrator you can decide any group"));
      if (!any) mine.appendChild(el("span", "empty2", "No groups assigned."));
      (s.approves_for_people || []).forEach(function (n) {
        any = true;
        mine.appendChild(el("span", "tag warn", "All requests from " + n));
      });
    });
    load();
  });
})();
