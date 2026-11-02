/* Small Markdown renderer for Veeam Intelligence answers.
   Builds DOM nodes directly and never assigns HTML from the answer, so nothing
   in a response can inject markup or script. Supports headings, paragraphs,
   bullet and numbered lists, tables, fenced code, block quotes, rules, and
   inline bold, italic, code and http(s) links. */
(function () {
  "use strict";

  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

  function inline(parent, text) {
    // tokens: `code`, **bold**, *italic* / _italic_, [label](http...)
    var re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(\*[^*\s][^*]*\*)|(\b_[^_\s][^_]*_\b)/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var t = m[0], n;
      if (m[1]) { n = el("code"); n.textContent = t.slice(1, -1); }
      else if (m[2] || m[3]) { n = el("strong"); inline(n, t.slice(2, -2)); }
      else if (m[4]) {
        n = el("a");
        n.href = m[5];
        n.target = "_blank";
        n.rel = "noopener noreferrer";
        n.textContent = t.slice(1, t.indexOf("]("));
      }
      else { n = el("em"); inline(n, t.slice(1, -1)); }
      parent.appendChild(n);
      last = m.index + t.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
    return s.split("|").map(function (c) { return c.trim(); });
  }

  function isDivider(line) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line); }

  function render(src) {
    var root = el("div", "md");
    var lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (/^\s*$/.test(line)) { i++; continue; }

      // fenced code
      var fence = line.match(/^\s*(```|~~~)/);
      if (fence) {
        var buf = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(fence[1]) !== 0) { buf.push(lines[i]); i++; }
        i++;
        var pre = el("pre"), code = el("code");
        code.textContent = buf.join("\n");
        pre.appendChild(code);
        root.appendChild(pre);
        continue;
      }

      // heading
      var h = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (h) {
        var level = Math.min(6, h[1].length + 2);   // keep answer headings below the page headings
        var hn = el("h" + level);
        inline(hn, h[2].replace(/\s*#+\s*$/, ""));
        root.appendChild(hn);
        i++;
        continue;
      }

      // rule
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { root.appendChild(el("hr")); i++; continue; }

      // table
      if (line.indexOf("|") !== -1 && i + 1 < lines.length && isDivider(lines[i + 1])) {
        var wrap = el("div", "md-table"), table = el("table");
        var thead = el("thead"), tr = el("tr");
        splitRow(line).forEach(function (c) { var th = el("th"); inline(th, c); tr.appendChild(th); });
        thead.appendChild(tr);
        table.appendChild(thead);
        var tbody = el("tbody");
        i += 2;
        while (i < lines.length && lines[i].indexOf("|") !== -1 && !/^\s*$/.test(lines[i])) {
          var row = el("tr");
          splitRow(lines[i]).forEach(function (c) { var td = el("td"); inline(td, c); row.appendChild(td); });
          tbody.appendChild(row);
          i++;
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        root.appendChild(wrap);
        continue;
      }

      // block quote
      if (/^\s*>/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        var bq = el("blockquote");
        bq.appendChild(render(q.join("\n")));
        root.appendChild(bq);
        continue;
      }

      // lists (one level of nesting by indentation)
      var lm = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (lm) {
        var ordered = /\d/.test(lm[2]);
        var list = el(ordered ? "ol" : "ul");
        var baseIndent = lm[1].length;
        var current = null;
        while (i < lines.length) {
          var m2 = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (m2 && m2[1].length <= baseIndent + 1) {
            current = el("li");
            inline(current, m2[3]);
            list.appendChild(current);
            i++;
          } else if (m2 && current) {
            var sub = current.lastChild && /^(UL|OL)$/.test(current.lastChild.nodeName) ? current.lastChild : null;
            if (!sub) { sub = el(/\d/.test(m2[2]) ? "ol" : "ul"); current.appendChild(sub); }
            var li = el("li");
            inline(li, m2[3]);
            sub.appendChild(li);
            i++;
          } else if (current && /^\s{2,}\S/.test(lines[i])) {
            current.appendChild(document.createTextNode(" "));
            inline(current, lines[i].trim());
            i++;
          } else {
            break;
          }
        }
        root.appendChild(list);
        continue;
      }

      // paragraph
      var para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
             !/^\s*(#{1,6}\s|```|~~~|>|([-*+]|\d+[.)])\s)/.test(lines[i]) &&
             !(lines[i].indexOf("|") !== -1 && i + 1 < lines.length && isDivider(lines[i + 1]))) {
        para.push(lines[i].trim());
        i++;
      }
      if (!para.length) { para.push(lines[i].trim()); i++; }   // never stall on an odd line
      var p = el("p");
      para.forEach(function (t, k) {
        if (k) p.appendChild(el("br"));
        inline(p, t);
      });
      root.appendChild(p);
    }
    return root;
  }

  window.renderMarkdown = render;
})();
