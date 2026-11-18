// Product site behaviour: theme toggle (follows the system until you pick), copy buttons, the demo video tabs,
// and a lightbox for screenshots. Everything works without it; nothing autoplays under reduced motion.
(function () {
  var root = document.documentElement;
  var store = {
    get: function () { try { return localStorage.getItem("arimaops-theme"); } catch (e) { return null; } },
    set: function (v) { try { localStorage.setItem("arimaops-theme", v); } catch (e) { /* private window */ } },
  };
  var saved = store.get();
  if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  var dark = function () { return root.getAttribute("data-theme") ? root.getAttribute("data-theme") === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; };

  document.querySelectorAll(".theme-toggle").forEach(function (b) {
    var label = function () { b.setAttribute("aria-label", dark() ? "Switch to light theme" : "Switch to dark theme"); };
    label();
    b.addEventListener("click", function () {
      var next = dark() ? "light" : "dark";
      root.setAttribute("data-theme", next);
      store.set(next);
      label();
    });
  });

  document.querySelectorAll("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var el = document.getElementById(b.getAttribute("data-copy"));
      var done = function (t) { b.textContent = t; setTimeout(function () { b.textContent = "Copy"; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(el.textContent.trim()).then(function () { done("Copied"); }, function () { done("Select it"); });
      else done("Select it");
    });
  });

  var still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll("video[autoplay]").forEach(function (v) { if (still) { v.removeAttribute("autoplay"); v.pause(); v.controls = true; } });

  // Demo tabs: swap the video, its poster and its caption.
  document.querySelectorAll("[data-demo-tabs]").forEach(function (tabs) {
    var video = document.getElementById(tabs.getAttribute("data-demo-tabs"));
    var cap = document.getElementById(tabs.getAttribute("data-caption"));
    tabs.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        tabs.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-selected", String(x === b)); });
        var name = b.getAttribute("data-video");
        video.poster = "assets/video/" + name + "-poster.jpg";
        video.innerHTML = '<source src="assets/video/' + name + '.webm" type="video/webm"><source src="assets/video/' + name + '.mp4" type="video/mp4">';
        video.load();
        if (!still) video.play().catch(function () {});
        if (cap) cap.textContent = b.getAttribute("data-caption");
      });
    });
  });

  // Click a screenshot to see it full size; Esc or a click closes it.
  document.querySelectorAll(".shot img").forEach(function (img) {
    img.addEventListener("click", function () {
      var box = document.createElement("div");
      box.className = "lightbox";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-label", img.alt);
      box.innerHTML = '<img alt="">';
      box.firstChild.src = img.src;
      box.firstChild.alt = img.alt;
      var close = function () { box.remove(); document.removeEventListener("keydown", onKey); };
      var onKey = function (e) { if (e.key === "Escape") close(); };
      box.addEventListener("click", close);
      document.addEventListener("keydown", onKey);
      document.body.appendChild(box);
    });
  });
})();
