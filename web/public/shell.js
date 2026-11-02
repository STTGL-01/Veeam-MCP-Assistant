/* Shared chrome for every signed-in page: hamburger menu, theme switch,
   change-password dialog and sign-out. Pages call VA.ready.then(fn) to get the
   session once it is known. */
(function () {
  "use strict";

  var ICONS = {
    chat: '<path d="M4 5.5h16v10.5H9.5L5 19.5V16H4z"/>',
    check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
    users: '<path d="M16 19v-1.6a3.4 3.4 0 0 0-3.4-3.4H6.4A3.4 3.4 0 0 0 3 17.4V19"/>' +
           '<circle cx="9.5" cy="7.5" r="3.4"/><path d="M21 19v-1.6a3.4 3.4 0 0 0-2.6-3.3"/>' +
           '<path d="M15.5 4.3a3.4 3.4 0 0 1 0 6.4"/>',
    key: '<circle cx="8" cy="12" r="3.6"/><path d="M11.6 12H21"/><path d="M17.5 12v3.2"/><path d="M20 12v2.4"/>',
    out: '<path d="M14.5 20H5.6A1.6 1.6 0 0 1 4 18.4V5.6A1.6 1.6 0 0 1 5.6 4h8.9"/>' +
         '<path d="m17 15.5 3.5-3.5L17 8.5"/><path d="M20.5 12H9.5"/>'
  };

  function icon(n) {
    return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[n] + "</svg>";
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  /* ---------------- API ---------------- */

  function api(path, payload) {
    var opts = { credentials: "same-origin", headers: {} };
    if (payload !== undefined) {
      opts.method = "POST";
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(payload);
    }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401 && d.code === "signed_out") { window.location.href = "/login"; }
        if (r.status === 403 && d.code === "password_change_required") { window.location.href = "/login"; }
        return { ok: r.ok, status: r.status, data: d };
      });
    });
  }

  /* ---------------- theme ---------------- */

  function applyTheme(m) {
    if (m === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
  }
  var saved = null;
  try { saved = localStorage.getItem("va-theme"); } catch (e) {}
  applyTheme(saved || ((window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light"));

  function wireTheme() {
    var b = document.getElementById("themeBtn");
    if (!b) return;
    b.addEventListener("click", function () {
      var n = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(n);
      try { localStorage.setItem("va-theme", n); } catch (e) {}
    });
  }

  /* ---------------- menu ---------------- */

  function here() { return window.location.pathname; }

  function link(menu, href, label, ic, badge) {
    var a = el("a");
    a.href = href;
    a.setAttribute("role", "menuitem");
    a.innerHTML = icon(ic);
    a.appendChild(el("span", null, label));
    if (badge) a.appendChild(el("span", "badge", String(badge)));
    if (here() === href) a.className = "current";
    menu.appendChild(a);
  }

  function action(menu, label, ic, fn) {
    var b = el("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.innerHTML = icon(ic);
    b.appendChild(el("span", null, label));
    b.addEventListener("click", fn);
    menu.appendChild(b);
  }

  function buildMenu(s) {
    var wrap = document.querySelector(".menu-wrap");
    if (!wrap) return;
    var btn = el("button", "menu-btn");
    btn.type = "button";
    btn.setAttribute("aria-label", "Menu");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = "<span></span><span></span><span></span>";
    var menu = el("div", "menu");
    menu.hidden = true;
    menu.setAttribute("role", "menu");

    link(menu, "/", "Ask Veeam Intelligence", "chat");
    if (s.approver) link(menu, "/approvals", "Approvals", "check", s.waiting_approvals);
    if (s.role === "admin") link(menu, "/admin", "Management", "users", s.pending_accounts);
    menu.appendChild(el("div", "sep"));
    action(menu, "Change password", "key", function () { openPassword(s.username); });
    action(menu, "Sign out (" + s.username + ")", "out", signOut);

    wrap.appendChild(btn);
    wrap.appendChild(menu);

    function open() {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      document.addEventListener("click", outside, true);
      document.addEventListener("keydown", onKey);
    }
    function close() {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", outside, true);
      document.removeEventListener("keydown", onKey);
    }
    function outside(e) { if (!wrap.contains(e.target)) close(); }
    function onKey(e) { if (e.key === "Escape") { close(); btn.focus(); } }
    btn.addEventListener("click", function (e) { e.stopPropagation(); if (menu.hidden) open(); else close(); });
    menu.addEventListener("click", close);
  }

  function signOut() {
    api("/api/logout", {}).then(function () { window.location.href = "/login"; },
                                function () { window.location.href = "/login"; });
  }

  /* ---------------- change password ---------------- */

  function openPassword(username) {
    var veil = el("div", "pw-veil");
    var card = el("div", "pw-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "Change password");
    card.appendChild(el("h2", null, "Change password"));
    card.appendChild(el("p", "who", "Signed in as " + username + ". Other sessions for this account will be signed out."));
    var msg = el("p", "pw-msg");
    card.appendChild(msg);

    function field(id, label, ac) {
      var f = el("div", "pw-field");
      var l = el("label", null, label);
      l.setAttribute("for", id);
      var i = el("input");
      i.id = id; i.type = "password"; i.autocomplete = ac;
      f.appendChild(l); f.appendChild(i);
      card.appendChild(f);
      return i;
    }
    var cur = field("pwCur", "Current password", "current-password");
    var nw = field("pwNew", "New password", "new-password");
    var nw2 = field("pwNew2", "Repeat new password", "new-password");

    var foot = el("div", "pw-foot");
    foot.appendChild(el("span", "sp"));
    var cancel = el("button", "ubtn", "Cancel");
    var save = el("button", "ubtn primary", "Change password");
    cancel.type = save.type = "button";
    foot.appendChild(cancel); foot.appendChild(save);
    card.appendChild(foot);
    veil.appendChild(card);
    document.body.appendChild(veil);
    cur.focus();

    function close() { veil.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    function show(cls, text) { msg.className = "pw-msg show " + cls; msg.textContent = text; }
    document.addEventListener("keydown", onKey);
    cancel.addEventListener("click", close);
    veil.addEventListener("click", function (e) { if (e.target === veil) close(); });

    save.addEventListener("click", function () {
      if (!cur.value || !nw.value) { show("err", "Fill in every field."); return; }
      if (nw.value !== nw2.value) { show("err", "The new passwords do not match."); return; }
      save.disabled = true;
      api("/api/change-password", { current_password: cur.value, new_password: nw.value }).then(function (r) {
        save.disabled = false;
        if (r.ok) {
          show("ok", r.data.message || "Password changed.");
          cur.value = nw.value = nw2.value = "";
          setTimeout(close, 1200);
        } else {
          show("err", r.data.message || "The password was not changed.");
        }
      }, function () { save.disabled = false; show("err", "Could not reach the server."); });
    });
  }

  /* ---------------- start ---------------- */

  var ready = api("/api/session").then(function (r) {
    var s = r.data || {};
    if (!s.authenticated || s.must_change_password) { window.location.href = "/login"; throw new Error("signed out"); }
    var name = document.getElementById("whoName");
    if (name) name.textContent = s.username;
    var tag = document.getElementById("envTag");
    if (tag) {
      tag.textContent = s.role === "admin" ? "Admin" : (s.approver ? "Approver" : "User");
      tag.hidden = false;
    }
    buildMenu(s);
    return s;
  });

  document.addEventListener("DOMContentLoaded", wireTheme);
  if (document.readyState !== "loading") wireTheme();

  window.VA = { api: api, el: el, ready: ready };
})();
