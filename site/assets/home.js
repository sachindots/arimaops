// Home page motion: reveal on scroll, count-up numbers, comparison bars, the key-check demo and tour chapters.
(function () {
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.classList.remove("no-js");

  function formatNumber(n, decimals) { return n.toFixed(decimals || 0); }
  function countUp(el) {
    var target = parseFloat(el.getAttribute("data-count"));
    var dec = parseInt(el.getAttribute("data-decimals") || "0", 10);
    var suffix = el.getAttribute("data-suffix") || "";
    if (reduce) { el.textContent = formatNumber(target, dec) + suffix; return; }
    var t0 = performance.now(), dur = 1400;
    function step(t) {
      var k = Math.min(1, (t - t0) / dur);
      el.textContent = formatNumber(target * (1 - Math.pow(1 - k, 3)), dec) + suffix;
      if (k < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  var seen = typeof IntersectionObserver === "function" ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      e.target.querySelectorAll("[data-count]").forEach(countUp);
      if (e.target.hasAttribute("data-count")) countUp(e.target);
      seen.unobserve(e.target);
    });
  }, { threshold: 0.25 }) : null;
  var targets = document.querySelectorAll(".reveal, .bars, .bar-row, .ticks, .metrics");
  if (seen) targets.forEach(function (el, i) { if (el.classList.contains("reveal")) el.style.setProperty("--rd", (i % 4) * 0.08 + "s"); seen.observe(el); });
  else targets.forEach(function (el) { el.classList.add("in"); el.querySelectorAll("[data-count]").forEach(countUp); });

  // A pretend key being pasted, checked and confirmed, over and over.
  document.querySelectorAll("[data-keydemo]").forEach(function (box) {
    var dots = box.querySelector("[data-kd-dots]"), status = box.querySelector("[data-kd-status]");
    var KEY_LEN = 30;
    function show(kind, text, icon) { status.className = "kd-status " + kind; status.innerHTML = '<span class="ico">' + (icon || "") + "</span><span>" + text + "</span>"; }
    function run() {
      var n = 0; dots.textContent = ""; status.className = "kd-status"; status.textContent = "";
      var typing = setInterval(function () {
        n += 3; dots.textContent = new Array(n + 1).join("•");
        if (n >= KEY_LEN) {
          clearInterval(typing);
          setTimeout(function () { show("checking", "Checking the key…", ""); }, 300);
          setTimeout(function () { show("ok", "The key works with Anthropic.", "✓"); }, 1700);
          setTimeout(run, 5200);
        }
      }, 70);
    }
    if (reduce) { dots.textContent = new Array(KEY_LEN + 1).join("•"); show("ok", "The key works with Anthropic.", "✓"); return; }
    var started = false;
    var io = new IntersectionObserver(function (es) { if (es[0].isIntersecting && !started) { started = true; run(); } }, { threshold: 0.4 });
    io.observe(box);
  });

  // Tour chapters seek the video and follow it.
  var video = document.getElementById("tour-video");
  if (video) {
    var buttons = Array.prototype.slice.call(document.querySelectorAll(".chapters button"));
    buttons.forEach(function (b) {
      b.addEventListener("click", function () { video.currentTime = parseFloat(b.getAttribute("data-seek")); video.play(); video.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" }); });
    });
    video.addEventListener("timeupdate", function () {
      var t = video.currentTime, active = -1;
      buttons.forEach(function (b, i) { if (t >= parseFloat(b.getAttribute("data-seek"))) active = i; });
      buttons.forEach(function (b, i) { b.classList.toggle("on", i === active); });
    });
  }
})();
