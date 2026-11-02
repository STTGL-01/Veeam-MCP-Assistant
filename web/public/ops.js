/* Operations panel: lists the tools an MCP server offers and builds a form
   from each tool's own schema. Nothing here guesses what a tool does; the
   server tells us its name, description and parameters. */
(function () {
  "use strict";

  var api = VA.api, el = VA.el;

  var RISK = {
    read: ["read", "Only reads data. Runs straight away."],
    write: ["write", "Changes something in Veeam. An approver has to agree before it runs."],
    destructive: ["destructive", "High risk: can interrupt protection, overwrite data or permanently delete it. An approver has to agree, and it cannot be undone from here."]
  };

  function close(veil) {
    veil.remove();
    document.removeEventListener("keydown", veil._onKey);
  }

  function shell(title, sub) {
    var veil = el("div", "ops-veil");
    var box = el("div", "ops");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", title);
    var head = el("header");
    head.appendChild(el("h2", null, title));
    head.appendChild(el("p", null, sub));
    var body = el("div", "body");
    var foot = el("footer");
    box.appendChild(head); box.appendChild(body); box.appendChild(foot);
    veil.appendChild(box);
    veil._onKey = function (e) { if (e.key === "Escape") close(veil); };
    document.addEventListener("keydown", veil._onKey);
    veil.addEventListener("click", function (e) { if (e.target === veil) close(veil); });
    document.body.appendChild(veil);
    return { veil: veil, head: head, body: body, foot: foot };
  }

  /* ---------------- tool list ---------------- */

  function open(backend, onStarted) {
    var ui = shell(backend.label, "Pick an operation. Reads run straight away; anything that changes or removes something goes to an approver first.");
    ui.body.appendChild(el("p", "empty2", "Loading operations\u2026"));

    var search = el("input", "search");
    search.type = "text";
    search.placeholder = "Search operations\u2026";
    search.setAttribute("aria-label", "Search operations");
    ui.head.appendChild(search);

    var cancel = el("button", "ubtn", "Close");
    cancel.type = "button";
    cancel.addEventListener("click", function () { close(ui.veil); });
    ui.foot.appendChild(el("span", "sp"));
    ui.foot.appendChild(cancel);

    api("/api/tools?backend=" + encodeURIComponent(backend.id)).then(function (r) {
      ui.body.innerHTML = "";
      if (!r.ok) {
        ui.body.appendChild(el("p", "msg show err", r.data.message || "The operations could not be listed."));
        if (r.data.detail) { var pre = el("pre"); pre.textContent = r.data.detail; ui.body.appendChild(pre); }
        return;
      }
      var tools = r.data.tools || [];
      (r.data.warnings || []).forEach(function (w) {
        var n = el("p", "msg show info", w);
        ui.head.appendChild(n);
      });
      if (!tools.length) { ui.body.appendChild(el("p", "empty2", "This server offers no operations.")); return; }

      // "Area: Summary" titles are grouped under their area.
      function areaOf(t) {
        var title = t.title || t.name;
        var i = title.indexOf(": ");
        return i > 0 ? title.slice(0, i) : "";
      }
      var LIMIT = 150;
      tools = tools.slice().sort(function (a, b) {
        var x = areaOf(a), y = areaOf(b);
        if (x !== y) return x === "" ? -1 : y === "" ? 1 : x.localeCompare(y);
        return (a.title || a.name).localeCompare(b.title || b.name);
      });

      function paint(filter) {
        ui.body.innerHTML = "";
        var words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
        var shown = tools.filter(function (t) {
          var hay = (t.name + " " + t.title + " " + t.description).toLowerCase();
          return words.every(function (w) { return hay.indexOf(w) !== -1; });
        });
        var head = el("p", "lede", shown.length === tools.length
          ? tools.length + " operations. Type to search, for example \u201cdelete backup\u201d or \u201crepositories\u201d."
          : shown.length + " of " + tools.length + " operations match.");
        ui.body.appendChild(head);
        if (!shown.length) { ui.body.appendChild(el("p", "empty2", "Nothing matches.")); return; }
        var area = null;
        shown.slice(0, LIMIT).forEach(function (t) {
          var a = areaOf(t);
          if (a !== area) {
            area = a;
            ui.body.appendChild(el("h3", "ops-area", a || "General"));
          }
          var b = el("button", "tool");
          b.type = "button";
          var nm = el("div", "tname");
          var title = t.title || t.name;
          nm.appendChild(el("strong", null, a ? title.slice(a.length + 2) : title));
          nm.appendChild(el("code", null, t.name));
          if (t.description) nm.appendChild(el("span", null, t.description.split("\n")[0].slice(0, 180)));
          b.appendChild(nm);
          b.appendChild(el("span", "tag " + (t.risk === "read" ? "ok" : t.risk === "destructive" ? "bad" : "warn"),
            t.risk === "read" ? "Read" : t.risk === "destructive" ? "High risk" : "Changes"));
          b.addEventListener("click", function () {
            close(ui.veil);
            openForm(backend, t, onStarted);
          });
          ui.body.appendChild(b);
        });
        if (shown.length > LIMIT) {
          ui.body.appendChild(el("p", "empty2", "Showing the first " + LIMIT + ". Type more of the name to narrow the list."));
        }
      }
      paint("");
      search.addEventListener("input", function () { paint(search.value); });
      search.focus();
    });
  }

  /* ---------------- one tool's form ---------------- */

  function fieldFor(name, spec, required) {
    spec = spec && typeof spec === "object" ? spec : {};
    var type = spec.type;
    if (Array.isArray(type)) type = type.filter(function (x) { return x !== "null"; })[0];
    var wrap = el("div", "form-field");
    var id = "f-" + name.replace(/[^A-Za-z0-9_-]/g, "");
    var input;

    function label(text) {
      var l = el("label", null, text);
      l.setAttribute("for", id);
      if (required) l.appendChild(el("span", "req", " *"));
      return l;
    }

    if (Array.isArray(spec.enum) && spec.enum.length) {
      input = el("select");
      if (!required) input.appendChild(el("option", null, ""));
      spec.enum.forEach(function (v) {
        var o = el("option", null, String(v));
        o.value = String(v);
        input.appendChild(o);
      });
      wrap.appendChild(label(spec.title || name));
    } else if (type === "boolean") {
      wrap.className = "form-field check";
      input = el("input");
      input.type = "checkbox";
      wrap.appendChild(input);
      wrap.appendChild(label(spec.title || name));
      input.id = id;
      if (spec.description) wrap.appendChild(el("small", null, spec.description));
      return { node: wrap, read: function () { return input.checked; }, empty: function () { return false; } };
    } else if (type === "integer" || type === "number") {
      input = el("input");
      input.type = "number";
      if (type === "integer") input.step = "1";
      wrap.appendChild(label(spec.title || name));
    } else if (type === "object" || type === "array") {
      input = el("textarea");
      input.placeholder = type === "array" ? "[]" : "{}";
      wrap.appendChild(label((spec.title || name) + " (JSON)"));
    } else {
      input = el("input");
      input.type = "text";
      wrap.appendChild(label(spec.title || name));
    }
    input.id = id;
    if (spec.description) wrap.appendChild(el("small", null, String(spec.description).slice(0, 300)));
    wrap.appendChild(input);
    if (spec.default !== undefined && spec.default !== null && type !== "object" && type !== "array") input.value = String(spec.default);

    return {
      node: wrap,
      empty: function () { return String(input.value).trim() === ""; },
      read: function () {
        var v = String(input.value).trim();
        if (v === "") return undefined;
        if (type === "integer" || type === "number") {
          var n = Number(v);
          if (!isFinite(n)) throw new Error(name + " must be a number.");
          return n;
        }
        if (type === "object" || type === "array") {
          try { return JSON.parse(v); } catch (e) { throw new Error(name + " must be valid JSON."); }
        }
        return v;
      }
    };
  }

  function openForm(backend, tool, onStarted) {
    var ui = shell(tool.title || tool.name, backend.label);
    var risk = RISK[tool.risk] || RISK.write;
    ui.body.appendChild(el("div", "risk-note " + risk[0], risk[1]));
    if (tool.description) ui.body.appendChild(el("p", "lede", tool.description.slice(0, 1200)));

    var msg = el("p", "msg");
    ui.body.appendChild(msg);

    var props = (tool.schema && tool.schema.properties) || {};
    var required = (tool.schema && tool.schema.required) || [];
    var names = Object.keys(props);
    var fields = {};
    if (!names.length) {
      ui.body.appendChild(el("p", "empty2", "This operation takes no parameters."));
    }
    names.forEach(function (n) {
      var f = fieldFor(n, props[n], required.indexOf(n) !== -1);
      fields[n] = f;
      ui.body.appendChild(f.node);
    });

    var back = el("button", "ubtn", "Back");
    var run = el("button", "ubtn " + (tool.risk === "read" ? "primary" : "no"),
      tool.risk === "read" ? "Run" : "Send for approval");
    back.type = run.type = "button";
    ui.foot.appendChild(el("span", "sp"));
    ui.foot.appendChild(back);
    ui.foot.appendChild(run);
    back.addEventListener("click", function () { close(ui.veil); open(backend, onStarted); });

    run.addEventListener("click", function () {
      var args = {};
      try {
        for (var i = 0; i < names.length; i++) {
          var n = names[i];
          if (required.indexOf(n) !== -1 && fields[n].empty()) throw new Error(n + " is needed.");
          var v = fields[n].read();
          if (v !== undefined) args[n] = v;
        }
      } catch (err) {
        msg.className = "msg show err";
        msg.textContent = err.message;
        return;
      }
      if (tool.risk === "destructive" &&
          !confirm("Send \u201c" + (tool.title || tool.name) + "\u201d for approval?\n\n" +
                   "If an approver agrees, this is a high-risk change in Veeam that cannot be undone from here.")) return;
      run.disabled = true;
      api("/api/run-tool", { backend: backend.id, tool: tool.name, args: args }).then(function (r) {
        if (!r.ok) {
          run.disabled = false;
          msg.className = "msg show err";
          msg.textContent = r.data.message || "That did not start.";
          return;
        }
        close(ui.veil);
        onStarted(r.data.turn);
      }, function () {
        run.disabled = false;
        msg.className = "msg show err";
        msg.textContent = "Could not reach the server.";
      });
    });

    var first = ui.body.querySelector("input, select, textarea");
    if (first) first.focus();
  }

  window.VAOps = { open: open };
})();
