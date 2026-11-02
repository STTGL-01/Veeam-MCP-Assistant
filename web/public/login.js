(function () {
  "use strict";

  var panels = { signin: byId("signin"), create: byId("create"), change: byId("change") };
  var minPw = 12;

  function byId(id) { return document.getElementById(id); }

  function showPanel(name) {
    Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== name; });
    var first = panels[name].querySelector("input");
    if (first) first.focus();
  }

  function show(id, cls, text) {
    var e = byId(id);
    e.className = "msg show " + cls;
    e.textContent = text;
  }
  function clear(id) { byId(id).className = "msg"; }

  function post(path, payload) {
    return fetch(path, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
    });
  }

  function busy(btn, text) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = text; }
  function idle(btn) { btn.disabled = false; btn.textContent = btn.dataset.label || btn.textContent; }

  /* ---- sign in ---- */
  function login() {
    var b = byId("loginBtn");
    var u = byId("u").value.trim();
    var p = byId("p").value;
    if (!u || !p) { show("msg", "err", "Enter a username and password."); return; }
    busy(b, "Signing in\u2026");
    post("/api/login", { username: u, password: p }).then(function (res) {
      if (res.ok && res.d.must_change_password) {
        idle(b);
        byId("xc").value = p;
        byId("p").value = "";
        if (u.toLowerCase() === "admin") {
          byId("changeSub").textContent = "You are signed in with the default administrator password. " +
            "Choose a new one before anything else.";
        }
        showPanel("change");
        byId("xn").focus();
        return;
      }
      if (res.ok) { window.location.href = "/"; return; }
      show("msg", "err", res.d.message || "Could not sign in.");
      idle(b);
      byId("p").value = "";
      byId("p").focus();
    }).catch(function () { show("msg", "err", "Could not reach the server."); idle(b); });
  }

  /* ---- request an account ---- */
  function register() {
    var b = byId("createBtn");
    var u = byId("cu").value.trim();
    var p = byId("cp").value;
    if (!u || !p) { show("cmsg", "err", "Enter a username and password."); return; }
    if (p !== byId("cp2").value) { show("cmsg", "err", "The passwords do not match."); return; }
    if (p.length < minPw) { show("cmsg", "err", "Use at least " + minPw + " characters."); return; }
    busy(b, "Sending\u2026");
    post("/api/register", { username: u, password: p }).then(function (res) {
      idle(b);
      if (res.ok) {
        show("cmsg", "ok", res.d.message);
        byId("cu").value = byId("cp").value = byId("cp2").value = "";
      } else {
        show("cmsg", "err", res.d.message || "The request was not sent.");
      }
    }).catch(function () { show("cmsg", "err", "Could not reach the server."); idle(b); });
  }

  /* ---- forced password change ---- */
  function change() {
    var b = byId("changeBtn");
    var c = byId("xc").value;
    var n = byId("xn").value;
    if (!c || !n) { show("xmsg", "err", "Fill in every field."); return; }
    if (n !== byId("xn2").value) { show("xmsg", "err", "The new passwords do not match."); return; }
    busy(b, "Saving\u2026");
    post("/api/change-password", { current_password: c, new_password: n }).then(function (res) {
      if (res.ok) { window.location.href = "/"; return; }
      idle(b);
      show("xmsg", "err", res.d.message || "The password was not changed.");
    }).catch(function () { show("xmsg", "err", "Could not reach the server."); idle(b); });
  }

  function onEnter(ids, fn) {
    ids.forEach(function (id) {
      byId(id).addEventListener("keydown", function (e) { if (e.key === "Enter") fn(); });
    });
  }

  byId("loginBtn").addEventListener("click", login);
  byId("createBtn").addEventListener("click", register);
  byId("changeBtn").addEventListener("click", change);
  onEnter(["u", "p"], login);
  onEnter(["cu", "cp", "cp2"], register);
  onEnter(["xc", "xn", "xn2"], change);
  byId("toCreate").addEventListener("click", function () { clear("cmsg"); showPanel("create"); });
  byId("toSignin").addEventListener("click", function () { clear("msg"); showPanel("signin"); });
  byId("changeOut").addEventListener("click", function () {
    post("/api/logout", {}).then(function () { window.location.reload(); });
  });

  /* ---- context ---- */
  fetch("/api/session", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.min_password) minPw = d.min_password;
    var rule = "At least " + minPw + " characters. A short sentence works well.";
    byId("crule").textContent = rule;
    byId("xrule").textContent = rule;
    if (d.site_title) { byId("siteTitle").textContent = d.site_title; document.title = "Sign in \u2014 " + d.site_title; }
    if (d.site_subtitle) byId("siteSub").textContent = d.site_subtitle;
    if (d.version) { var t = byId("envTag"); t.textContent = "v" + d.version; t.hidden = false; }
    if (d.authenticated && d.must_change_password) showPanel("change");
    else if (d.authenticated) window.location.href = "/";
  }).catch(function () {});

  /* ---- theme ---- */
  function apply(m) {
    if (m === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
  }
  var saved = null;
  try { saved = localStorage.getItem("va-theme"); } catch (e) {}
  apply(saved || ((window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light"));
  byId("themeBtn").addEventListener("click", function () {
    var n = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    apply(n);
    try { localStorage.setItem("va-theme", n); } catch (e) {}
  });
})();
