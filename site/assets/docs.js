/* Proofbench docs chrome — vanilla JS, no build step.
   Shared by every page under site/docs/: copy buttons on code blocks,
   active sidebar link, and the docs search (static JSON index). */
(function () {
  "use strict";

  var content = document.getElementById("content");

  /* ---------- 1. Copy buttons on every pre>code ---------- */
  if (content) {
    content.querySelectorAll("pre").forEach(function (pre) {
      var code = pre.querySelector("code");
      if (!code || pre.querySelector(".copy-btn")) return;

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-btn";
      btn.setAttribute("aria-label", "Copy code");
      btn.textContent = "Copy";
      btn.addEventListener("click", function () {
        var text = code.textContent || "";
        if (!text) return;
        var done = function () {
          btn.textContent = "Copied";
          btn.classList.add("is-copied");
          setTimeout(function () {
            btn.textContent = "Copy";
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
      pre.appendChild(btn);
    });
  }

  /* ---------- 2. Active sidebar link ---------- */
  var currentPage = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".sidebar a").forEach(function (a) {
    var href = a.getAttribute("href") || "";
    if (href.split("/").pop() === currentPage) {
      a.classList.add("active");
      a.setAttribute("aria-current", "page");
    }
  });

  /* ---------- 3. Search ---------- */
  var searchInput = document.getElementById("docs-search");
  if (!searchInput) return;

  var resultsEl = document.createElement("div");
  resultsEl.className = "docs-search-results";
  resultsEl.hidden = true;
  searchInput.insertAdjacentElement("afterend", resultsEl);

  var sidebarLinks = document.querySelectorAll(".sidebar nav a");
  var indexData = null;

  fetch("docs-index.json")
    .then(function (res) {
      if (!res.ok) throw new Error("no docs index");
      return res.json();
    })
    .then(function (data) {
      indexData = data;
    })
    .catch(function () {
      /* graceful no-op — file:// or index not generated yet */
    });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderResults(query) {
    if (!indexData || !query) {
      resultsEl.innerHTML = "";
      resultsEl.hidden = true;
      return;
    }
    var matches = indexData
      .filter(function (entry) {
        var hay = (
          (entry.title || "") +
          " " +
          (entry.headings || []).join(" ") +
          " " +
          (entry.keywords || "")
        ).toLowerCase();
        return hay.indexOf(query) !== -1;
      })
      .slice(0, 8);

    if (!matches.length) {
      resultsEl.innerHTML = "";
      resultsEl.hidden = true;
      return;
    }

    resultsEl.hidden = false;
    resultsEl.innerHTML = matches
      .map(function (m) {
        var heading = (m.headings || []).filter(function (h) {
          return h.toLowerCase().indexOf(query) !== -1;
        })[0];
        return (
          '<a href="' + escapeHtml(m.href) + '">' +
          '<span class="result-title">' + escapeHtml(m.title) + "</span>" +
          (heading ? '<span class="result-heading">' + escapeHtml(heading) + "</span>" : "") +
          "</a>"
        );
      })
      .join("");
  }

  searchInput.addEventListener("input", function () {
    var query = searchInput.value.trim().toLowerCase();

    sidebarLinks.forEach(function (a) {
      var li = a.closest("li");
      if (!li) return;
      var match = !query || a.textContent.toLowerCase().indexOf(query) !== -1;
      li.style.display = match ? "" : "none";
    });

    renderResults(query);
  });

  document.addEventListener("keydown", function (evt) {
    if (evt.key === "/" && document.activeElement !== searchInput) {
      evt.preventDefault();
      searchInput.focus();
    } else if (evt.key === "Escape" && document.activeElement === searchInput) {
      searchInput.value = "";
      searchInput.dispatchEvent(new Event("input"));
      searchInput.blur();
    }
  });
})();
