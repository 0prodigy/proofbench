/* Proofbench site — tiny vanilla JS. No frameworks, no build step. */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Theme toggle ---------- */
  var root = document.documentElement;
  var themeToggle = document.getElementById("theme-toggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      var current = root.getAttribute("data-theme");
      var isDark = current
        ? current === "dark"
        : window.matchMedia("(prefers-color-scheme: dark)").matches;
      var next = isDark ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem("pb-theme", next);
      } catch (e) {}
    });
  }

  /* ---------- Ladder fill on scroll (once) ---------- */
  var ladders = document.querySelectorAll(".ladder");
  if ("IntersectionObserver" in window && !reduceMotion) {
    var ladderIo = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add("in-view");
            ladderIo.unobserve(e.target);
          }
        });
      },
      { threshold: 0.2 }
    );
    ladders.forEach(function (el) {
      ladderIo.observe(el);
    });
  } else {
    ladders.forEach(function (el) {
      el.classList.add("in-view");
    });
  }

  /* ---------- Tabbed quickstart widget ---------- */
  var tabsWidgets = document.querySelectorAll(".tabs");
  tabsWidgets.forEach(function (widget) {
    var tabs = widget.querySelectorAll('[role="tab"]');
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        activateTab(widget, tab);
      });
      tab.addEventListener("keydown", function (evt) {
        var list = Array.prototype.slice.call(tabs);
        var i = list.indexOf(tab);
        if (evt.key === "ArrowRight" || evt.key === "ArrowLeft") {
          evt.preventDefault();
          var next = evt.key === "ArrowRight" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
          list[next].focus();
          activateTab(widget, list[next]);
        }
      });
    });
  });

  function activateTab(widget, tab) {
    var tabs = widget.querySelectorAll('[role="tab"]');
    tabs.forEach(function (t) {
      var selected = t === tab;
      t.setAttribute("aria-selected", String(selected));
      t.tabIndex = selected ? 0 : -1;
      var panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.classList.toggle("is-active", selected);
    });
  }

  /* ---------- Copy buttons ---------- */
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var frame = btn.closest(".code-frame") || btn.parentElement;
      var codeEl = frame ? frame.querySelector("code") : null;
      var text = codeEl ? codeEl.textContent : "";
      if (!text) return;
      var done = function () {
        var original = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("is-copied");
        setTimeout(function () {
          btn.textContent = original;
          btn.classList.remove("is-copied");
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } catch (e) {}
        document.body.removeChild(ta);
        done();
      }
    });
  });

  /* ---------- Hero replay: terminal typing + certificate ink-in + seal stamp ---------- */
  var body = document.getElementById("term-body");
  var demo = document.getElementById("term-demo");
  var cert = document.getElementById("cert");
  var seal = document.getElementById("cert-seal");
  if (!body || !demo || reduceMotion) return;

  var lines = [
    { cls: "t-cmd", text: "pb up --substrate k8s-attach" },
    { cls: "t-out", text: "forward svc/appservice:8000 -> 127.0.0.1:56493" },
    { cls: "t-out", text: "up: appservice (k8s-attach)", fields: ["repo", "substrate"] },
    { cls: "t-cmd", text: "pb ready" },
    { cls: "t-out", text: "ready: appservice ok" },
    { cls: "t-cmd", text: "pb verify" },
    { cls: "t-out", text: "bundle:  evidence/20260710-010422-verify" },
    { cls: "t-out", text: "proof:   L3", fields: ["rung"] },
    { cls: "t-out", text: "verdict: pass", fields: ["verdict"], seal: true },
    { cls: "t-pass", text: "  [pass] appservice-up" },
    { cls: "t-notrun", text: "  [not-run] action-resolution" },
    { cls: "t-notrun", text: "  [not-run] stage-progress" },
    { cls: "t-notrun", text: "  [not-run] stage-log-observed" }
  ];

  function certField(name) {
    return cert ? cert.querySelector('[data-field="' + name + '"]') : null;
  }

  function blankCert() {
    if (!cert) return;
    cert.querySelectorAll("[data-field]").forEach(function (dd) {
      dd.textContent = "—"; /* em dash */
      dd.classList.add("is-pending");
    });
    if (seal) seal.classList.add("is-pending");
  }

  function inkIn(fieldNames) {
    (fieldNames || []).forEach(function (name) {
      var dd = certField(name);
      if (!dd) return;
      dd.textContent = dd.getAttribute("data-value");
      dd.classList.remove("is-pending");
    });
  }

  function stampSeal() {
    if (!seal) return;
    seal.classList.remove("is-pending");
    seal.classList.add("is-stamped");
  }

  function typeLine(i) {
    if (i >= lines.length) return;
    var l = lines[i];
    var div = document.createElement("div");
    div.className = "term-line " + l.cls;
    body.appendChild(div);

    function settle() {
      if (l.fields) inkIn(l.fields);
      if (l.seal) stampSeal();
      setTimeout(function () {
        typeLine(i + 1);
      }, 160);
    }

    if (l.cls !== "t-cmd") {
      div.textContent = l.text;
      settle();
      return;
    }
    var pos = 0;
    (function tick() {
      div.textContent = l.text.slice(0, pos);
      if (pos < l.text.length) {
        pos++;
        setTimeout(tick, 22);
      } else {
        setTimeout(function () {
          typeLine(i + 1);
        }, 160);
      }
    })();
  }

  if ("IntersectionObserver" in window) {
    body.innerHTML = "";
    blankCert();
    var started = false;
    var termIo = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && !started) {
            started = true;
            typeLine(0);
            termIo.unobserve(e.target);
          }
        });
      },
      { threshold: 0.4 }
    );
    termIo.observe(demo);
  }
})();
