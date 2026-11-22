// ArimaOps Engineering Handbook — offline-first client interactivity (file:// and HTTP safe).
(function () {
  var THEME_KEY = "arima-handbook-theme";
  var ACCENT_KEY = "arima-handbook-accent";
  var LABS_KEY = "arima-handbook-labs";

  var root = document.documentElement;

  function applyStoredPrefs() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      if (t === "light" || t === "dark") root.setAttribute("data-theme", t);
      var a = localStorage.getItem(ACCENT_KEY);
      if (a === "red" || a === "build") root.setAttribute("data-accent", a);
    } catch (_) {}
  }
  applyStoredPrefs();

  function effectiveTheme() {
    var explicit = root.getAttribute("data-theme");
    if (explicit === "light" || explicit === "dark") return explicit;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function initThemeAndAccent() {
    var themeBtn = document.getElementById("theme-toggle");
    var accentBtn = document.getElementById("accent-toggle");

    function syncLabels() {
      if (themeBtn) {
        var mode = effectiveTheme();
        themeBtn.textContent = mode === "dark" ? "Light" : "Dark";
        themeBtn.setAttribute("aria-label", "Switch to " + (mode === "dark" ? "light" : "dark") + " theme");
      }
      if (accentBtn) {
        var acc = root.getAttribute("data-accent") === "red" ? "red" : "build";
        var label = accentBtn.querySelector("[data-accent-label]");
        if (label) label.textContent = acc === "red" ? "Red team" : "Build";
      }
    }

    if (themeBtn) {
      themeBtn.addEventListener("click", function () {
        var next = effectiveTheme() === "dark" ? "light" : "dark";
        root.setAttribute("data-theme", next);
        try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
        syncLabels();
      });
    }

    if (accentBtn) {
      accentBtn.addEventListener("click", function () {
        var next = root.getAttribute("data-accent") === "red" ? "build" : "red";
        root.setAttribute("data-accent", next);
        try { localStorage.setItem(ACCENT_KEY, next); } catch (_) {}
        syncLabels();
      });
    }
    syncLabels();
  }

  function initSidebarAndActiveNav() {
    var menuBtn = document.getElementById("menu-toggle");
    var sidebar = document.getElementById("sidebar");
    if (menuBtn && sidebar) {
      menuBtn.addEventListener("click", function () {
        var open = sidebar.classList.toggle("open");
        menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });
      document.addEventListener("click", function (e) {
        if (!sidebar.classList.contains("open")) return;
        if (!sidebar.contains(e.target) && !menuBtn.contains(e.target)) {
          sidebar.classList.remove("open");
          menuBtn.setAttribute("aria-expanded", "false");
        }
      });
    }

    var file = location.pathname.split("/").pop() || "index.html";
    var links = document.querySelectorAll(".nav-link");
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute("href");
      if (href === file) {
        links[i].classList.add("active");
        links[i].setAttribute("aria-current", "page");
      }
    }
  }

  function initToc() {
    var tocList = document.getElementById("toc-list");
    var main = document.getElementById("main");
    if (!tocList || !main) return;
    var headings = main.querySelectorAll("h2[id], h3[id]");
    if (!headings.length) return;

    var links = [];
    for (var i = 0; i < headings.length; i++) {
      var h = headings[i];
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "#" + h.id;
      a.textContent = h.textContent;
      if (h.tagName === "H3") a.className = "toc-sub";
      li.appendChild(a);
      tocList.appendChild(li);
      links.push({ el: h, link: a });
    }

    if ("IntersectionObserver" in window && links.length) {
      var obs = new IntersectionObserver(function (entries) {
        for (var j = 0; j < entries.length; j++) {
          if (!entries[j].isIntersecting) continue;
          var id = entries[j].target.id;
          for (var k = 0; k < links.length; k++) {
            links[k].link.classList.toggle("active", links[k].el.id === id);
          }
        }
      }, { rootMargin: "-70px 0px -70% 0px", threshold: 0.01 });
      for (var m = 0; m < links.length; m++) obs.observe(links[m].el);
    }
  }

  function initCopyButtons() {
    var blocks = document.querySelectorAll(".code-block");
    for (var i = 0; i < blocks.length; i++) {
      (function (block) {
        var btn = block.querySelector(".copy-btn");
        var pre = block.querySelector("pre");
        if (!btn || !pre) return;
        btn.addEventListener("click", function () {
          var text = pre.innerText || pre.textContent || "";
          function flash() {
            btn.textContent = "Copied";
            setTimeout(function () { btn.textContent = "Copy"; }, 1400);
          }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(flash).catch(fallback);
          } else {
            fallback();
          }
          function fallback() {
            var ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand("copy"); } catch (_) {}
            document.body.removeChild(ta);
            flash();
          }
        });
      })(blocks[i]);
    }
  }

  function initSteppers() {
    var steppers = document.querySelectorAll("[data-stepper]");
    for (var i = 0; i < steppers.length; i++) {
      (function (rootEl) {
        var btns = rootEl.querySelectorAll(".step-btn[data-target]");
        var detail = rootEl.querySelector(".stepper-detail");
        var stepEls = rootEl.querySelectorAll("[data-step]");
        var descriptions = {};
        try {
          descriptions = JSON.parse(rootEl.getAttribute("data-steps") || "{}");
        } catch (_) {}

        function activate(key) {
          for (var b = 0; b < btns.length; b++) {
            btns[b].classList.toggle("active", btns[b].getAttribute("data-target") === key);
          }
          if (key === "all") {
            rootEl.classList.remove("is-active");
            for (var s = 0; s < stepEls.length; s++) stepEls[s].classList.remove("step-on");
          } else {
            rootEl.classList.add("is-active");
            for (var s2 = 0; s2 < stepEls.length; s2++) {
              var tokens = (stepEls[s2].getAttribute("data-step") || "").split(/\s+/);
              stepEls[s2].classList.toggle("step-on", tokens.indexOf(key) !== -1);
            }
          }
          if (detail && descriptions[key]) {
            detail.innerHTML = descriptions[key];
          }
        }

        for (var b2 = 0; b2 < btns.length; b2++) {
          btns[b2].addEventListener("click", function () {
            activate(this.getAttribute("data-target"));
          });
        }
      })(steppers[i]);
    }
  }

  function initQuizzes() {
    var quizzes = document.querySelectorAll("[data-quiz]");
    for (var i = 0; i < quizzes.length; i++) {
      (function (card) {
        var opts = card.querySelectorAll(".quiz-opt");
        var fb = card.querySelector(".quiz-feedback");
        for (var j = 0; j < opts.length; j++) {
          opts[j].addEventListener("click", function () {
            var isRight = this.hasAttribute("data-correct");
            for (var k = 0; k < opts.length; k++) {
              opts[k].classList.remove("correct", "wrong");
              if (opts[k].hasAttribute("data-correct")) opts[k].classList.add("correct");
            }
            if (!isRight) this.classList.add("wrong");
            if (fb) {
              var prefix = isRight ? "<strong>Correct.</strong> " : "<strong>Not quite.</strong> ";
              var why = fb.getAttribute("data-explain") || fb.innerHTML;
              if (!fb.getAttribute("data-explain")) fb.setAttribute("data-explain", why);
              fb.innerHTML = prefix + why;
              fb.classList.add("show");
            }
          });
        }
      })(quizzes[i]);
    }
  }

  function initLabs() {
    var cards = document.querySelectorAll(".lab-card[data-lab-id]");
    if (!cards.length) return;
    var countEl = document.getElementById("labs-count");
    var fillEl = document.getElementById("labs-progress-fill");
    var resetBtn = document.getElementById("labs-reset");

    function loadState() {
      try { return JSON.parse(localStorage.getItem(LABS_KEY) || "{}"); }
      catch (_) { return {}; }
    }
    function saveState(st) {
      try { localStorage.setItem(LABS_KEY, JSON.stringify(st)); } catch (_) {}
    }

    function render() {
      var st = loadState();
      var done = 0;
      for (var i = 0; i < cards.length; i++) {
        var id = cards[i].getAttribute("data-lab-id");
        var cb = cards[i].querySelector("input[type='checkbox']");
        var isDone = !!st[id];
        if (cb) cb.checked = isDone;
        cards[i].classList.toggle("done", isDone);
        if (isDone) done++;
      }
      if (countEl) countEl.textContent = done + " / " + cards.length + " labs completed";
      if (fillEl) fillEl.style.width = Math.round((done / cards.length) * 100) + "%";
    }

    for (var i = 0; i < cards.length; i++) {
      (function (card) {
        var id = card.getAttribute("data-lab-id");
        var cb = card.querySelector("input[type='checkbox']");
        if (!cb) return;
        cb.addEventListener("change", function () {
          var st = loadState();
          st[id] = cb.checked;
          saveState(st);
          render();
        });
      })(cards[i]);
    }

    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        saveState({});
        render();
      });
    }
    render();
  }

  function initFilters() {
    var groups = document.querySelectorAll("[data-filter-group]");
    for (var i = 0; i < groups.length; i++) {
      (function (bar) {
        var targetSel = bar.getAttribute("data-filter-group");
        var items = document.querySelectorAll(targetSel);
        var btns = bar.querySelectorAll(".filter-btn[data-tag]");
        for (var j = 0; j < btns.length; j++) {
          btns[j].addEventListener("click", function () {
            var tag = this.getAttribute("data-tag");
            for (var k = 0; k < btns.length; k++) btns[k].classList.toggle("active", btns[k] === this);
            for (var m = 0; m < items.length; m++) {
              var tags = (items[m].getAttribute("data-tags") || "").split(/\s+/);
              items[m].style.display = tag === "all" || tags.indexOf(tag) !== -1 ? "" : "none";
            }
          });
        }
      })(groups[i]);
    }
  }

  function initSearch() {
    var openBtn = document.getElementById("search-open");
    var backdrop = document.getElementById("search-backdrop");
    var input = document.getElementById("search-input");
    var results = document.getElementById("search-results");
    if (!backdrop || !input || !results) return;

    var index = Array.isArray(window.HANDBOOK_INDEX) ? window.HANDBOOK_INDEX : [];
    var selected = 0;
    var visible = [];

    function render(q) {
      var term = (q || "").trim().toLowerCase();
      if (!term) {
        visible = index.slice(0, 10);
      } else {
        var words = term.split(/\s+/);
        visible = index
          .map(function (item) {
            var hay = (item.title + " " + item.section + " " + item.keywords + " " + item.summary).toLowerCase();
            var score = 0;
            for (var i = 0; i < words.length; i++) {
              if (hay.indexOf(words[i]) === -1) return null;
              if (item.title.toLowerCase().indexOf(words[i]) !== -1) score += 4;
              if (item.keywords.toLowerCase().indexOf(words[i]) !== -1) score += 2;
              score += 1;
            }
            return { item: item, score: score };
          })
          .filter(Boolean)
          .sort(function (a, b) { return b.score - a.score; })
          .slice(0, 14)
          .map(function (x) { return x.item; });
      }
      selected = 0;
      paint();
    }

    function paint() {
      results.innerHTML = "";
      if (!visible.length) {
        var empty = document.createElement("div");
        empty.className = "search-empty";
        empty.textContent = "No matching handbook sections. Try a file name like hub.ts, commandPolicy, tmux, or TOTP.";
        results.appendChild(empty);
        return;
      }
      for (var i = 0; i < visible.length; i++) {
        var it = visible[i];
        var a = document.createElement("a");
        a.className = "search-item" + (i === selected ? " selected" : "");
        a.href = it.page + (it.anchor ? "#" + it.anchor : "");
        var top = document.createElement("div");
        top.className = "search-item-top";
        var t = document.createElement("span");
        t.textContent = it.title;
        var p = document.createElement("span");
        p.className = "search-item-page";
        p.textContent = it.section;
        top.appendChild(t);
        top.appendChild(p);
        var sub = document.createElement("div");
        sub.className = "search-item-sub";
        sub.textContent = it.summary;
        a.appendChild(top);
        a.appendChild(sub);
        a.addEventListener("click", function () { close(); });
        results.appendChild(a);
      }
    }

    function open() {
      backdrop.classList.add("open");
      input.value = "";
      render("");
      setTimeout(function () { input.focus(); }, 10);
    }

    function close() {
      backdrop.classList.remove("open");
    }

    if (openBtn) openBtn.addEventListener("click", open);
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) close();
    });
    input.addEventListener("input", function () { render(input.value); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (visible.length) { selected = (selected + 1) % visible.length; paint(); }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (visible.length) { selected = (selected - 1 + visible.length) % visible.length; paint(); }
      } else if (e.key === "Enter" && visible[selected]) {
        e.preventDefault();
        var item = visible[selected];
        close();
        location.href = item.page + (item.anchor ? "#" + item.anchor : "");
      } else if (e.key === "Escape") {
        close();
      }
    });

    document.addEventListener("keydown", function (e) {
      var tag = (e.target && e.target.tagName) || "";
      var inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target && e.target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (backdrop.classList.contains("open")) close(); else open();
      } else if (!inField && e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        open();
      } else if (e.key === "Escape" && backdrop.classList.contains("open")) {
        close();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initThemeAndAccent();
    initSidebarAndActiveNav();
    initToc();
    initCopyButtons();
    initSteppers();
    initQuizzes();
    initLabs();
    initFilters();
    initSearch();
  });
})();
