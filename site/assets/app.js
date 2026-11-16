/* ArimaOps site — interaction + motion engine.
   Lightbox and copy work always. Heavy motion (canvas, parallax, tilt, cursor glow,
   flow pulse, reveals) runs only when the viewer has no reduced-motion preference.
   No JS => the page is fully visible and static (CSS keeps everything shown). */
(function () {
  "use strict";
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var fine = matchMedia("(hover:hover) and (pointer:fine)").matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };

  /* ---------- Copy buttons (always) ---------- */
  $$("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var el = document.getElementById(b.dataset.copy);
      var text = el.textContent.replace(/​/g, "").trim();
      var done = function (w) { b.textContent = w; setTimeout(function () { b.textContent = "Copy"; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { done("Copied"); }, function () { done("Copy"); });
      else done("Copy");
    });
  });

  /* ---------- Lightbox (always — this is the "click the image" fix) ---------- */
  var shots = $$(".shot").filter(function (el) { return el.tagName === "IMG"; });
  if (shots.length) {
    var lb = document.createElement("div");
    lb.id = "lb"; lb.setAttribute("role", "dialog"); lb.setAttribute("aria-modal", "true"); lb.hidden = true;
    lb.innerHTML =
      '<span class="count"></span>' +
      '<button class="x" aria-label="Close">✕</button>' +
      '<button class="nav-btn prev" aria-label="Previous">‹</button>' +
      '<button class="nav-btn next" aria-label="Next">›</button>' +
      '<figure style="margin:0"><img alt=""><figcaption></figcaption></figure>';
    document.body.appendChild(lb);
    var lbImg = $("img", lb), lbCap = $("figcaption", lb), lbCount = $(".count", lb);
    var idx = 0;
    function show(i) {
      idx = (i + shots.length) % shots.length;
      var s = shots[idx];
      lbImg.src = s.currentSrc || s.src;
      lbImg.alt = s.alt || "";
      lbCap.textContent = s.alt || "";
      lbCount.textContent = (idx + 1) + " / " + shots.length;
    }
    function open(i) { show(i); lb.hidden = false; lb.classList.add("open"); document.body.style.overflow = "hidden"; $(".x", lb).focus(); }
    function close() { lb.classList.remove("open"); lb.hidden = true; document.body.style.overflow = ""; }
    shots.forEach(function (s, i) {
      s.setAttribute("role", "button"); s.setAttribute("tabindex", "0");
      s.addEventListener("click", function () { open(i); });
      s.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(i); } });
    });
    $(".x", lb).addEventListener("click", close);
    $(".prev", lb).addEventListener("click", function () { show(idx - 1); });
    $(".next", lb).addEventListener("click", function () { show(idx + 1); });
    lb.addEventListener("click", function (e) { if (e.target === lb) close(); });
    document.addEventListener("keydown", function (e) {
      if (lb.hidden) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") show(idx - 1);
      else if (e.key === "ArrowRight") show(idx + 1);
    });
  }

  /* ---------- Video expand -> fullscreen ---------- */
  var vid = $("#demo");
  if (vid) {
    var frame = document.createElement("div"); // handled in HTML already if present
    var exp = $(".video-frame .expand");
    if (exp) exp.addEventListener("click", function () {
      var el = vid; var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitEnterFullscreen;
      if (fn) { try { fn.call(el); } catch (e) {} vid.play && vid.play(); }
    });
  }

  if (reduce) return; // everything below is motion — stop here for reduced-motion
  var root = document.documentElement;
  root.setAttribute("data-anim", "");

  /* ---------- Scroll progress + sticky nav ---------- */
  var bar = document.createElement("div"); bar.id = "progress"; document.body.appendChild(bar);
  var top = $(".top");
  function onScroll() {
    var h = document.documentElement.scrollHeight - innerHeight;
    bar.style.width = (h > 0 ? (scrollY / h) * 100 : 0) + "%";
    if (top) top.classList.toggle("scrolled", scrollY > 20);
    parallax();
  }
  var tick = false;
  addEventListener("scroll", function () { if (tick) return; tick = true; requestAnimationFrame(function () { tick = false; onScroll(); }); }, { passive: true });

  /* ---------- Cursor spotlight ---------- */
  if (fine) {
    var glow = document.createElement("div"); glow.id = "glow"; document.body.appendChild(glow);
    addEventListener("pointermove", function (e) { glow.style.left = e.clientX + "px"; glow.style.top = e.clientY + "px"; }, { passive: true });
  }

  /* ---------- Hero entrance ---------- */
  var hero = $(".hero"); if (hero) requestAnimationFrame(function () { hero.classList.add("lit"); });

  /* ---------- Hero command: blinking caret ---------- */
  var cmd = $("#cmd"); if (cmd) { var c = document.createElement("span"); c.className = "caret"; c.innerHTML = "&nbsp;"; cmd.after(c); }

  /* ---------- Hero canvas: particle orbit core ---------- */
  var cv = $("#orbit");
  if (cv && cv.getContext) {
    var ctx = cv.getContext("2d"), W, H, DPR = Math.min(devicePixelRatio || 1, 2), parts = [], orbs = [], cx, cy, raf, t = 0;
    var RED = document.body.dataset.orbit === "red";
    var CORE = RED ? "255,91,115" : "0,240,255", DOT = RED ? "255,150,165" : "120,200,255";
    var H1 = RED ? "#ff5b73" : "#00f0ff", H2 = RED ? "#ff9ca8" : "#6366f1";
    function size() {
      var r = cv.getBoundingClientRect(); W = r.width; H = r.height;
      cv.width = W * DPR; cv.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      cx = W * (W > 820 ? 0.62 : 0.5); cy = H * 0.5;
      var n = Math.min(90, Math.round(W * H / 14000));
      parts = []; for (var i = 0; i < n; i++) parts.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .25, r: Math.random() * 1.6 + .4 });
      orbs = []; for (var k = 0; k < 5; k++) orbs.push({ a: Math.random() * 6.28, rad: 60 + k * 34, sp: (.0022 + k * .0009) * (k % 2 ? 1 : -1), r: 2.6 - k * .25, hue: k % 2 });
    }
    function draw() {
      t++; ctx.clearRect(0, 0, W, H);
      // drifting particles + near-core constellation
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i]; p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > W) p.vx *= -1; if (p.y < 0 || p.y > H) p.vy *= -1;
        var dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832);
        ctx.fillStyle = "rgba(" + DOT + "," + (d < 320 ? .5 : .18) + ")"; ctx.fill();
        if (d < 230) { ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(cx, cy); ctx.strokeStyle = "rgba(" + CORE + "," + (0.16 * (1 - d / 230)) + ")"; ctx.lineWidth = .6; ctx.stroke(); }
      }
      // glowing core
      var pulse = 1 + Math.sin(t * .03) * .08;
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 90 * pulse);
      g.addColorStop(0, "rgba(" + CORE + ",.5)"); g.addColorStop(.3, "rgba(" + CORE + ",.14)"); g.addColorStop(1, "rgba(" + CORE + ",0)");
      ctx.beginPath(); ctx.arc(cx, cy, 90 * pulse, 0, 6.2832); ctx.fillStyle = g; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, 5.5 * pulse, 0, 6.2832); ctx.fillStyle = "rgba(220,250,255,.95)"; ctx.fill();
      // orbiting nodes + rings
      for (var o = 0; o < orbs.length; o++) {
        var b = orbs[o]; b.a += b.sp;
        ctx.beginPath(); ctx.arc(cx, cy, b.rad, 0, 6.2832); ctx.strokeStyle = "rgba(120,140,255,.06)"; ctx.lineWidth = 1; ctx.stroke();
        var ox = cx + Math.cos(b.a) * b.rad, oy = cy + Math.sin(b.a) * b.rad * .7;
        ctx.beginPath(); ctx.arc(ox, oy, b.r + 1.6, 0, 6.2832);
        ctx.fillStyle = b.hue ? "rgba(" + (RED ? "255,91,115" : "99,102,241") + ",.9)" : "rgba(" + CORE + ",.9)"; ctx.shadowBlur = 12; ctx.shadowColor = b.hue ? H2 : H1; ctx.fill(); ctx.shadowBlur = 0;
      }
      raf = requestAnimationFrame(draw);
    }
    size(); draw();
    var rz; addEventListener("resize", function () { clearTimeout(rz); rz = setTimeout(size, 150); });
    document.addEventListener("visibilitychange", function () { if (document.hidden) cancelAnimationFrame(raf); else draw(); });
  }

  /* ---------- Parallax on screenshots ---------- */
  var pxEls = $$(".feature .shot, .phone-row .shot");
  function parallax() {
    var h = innerHeight;
    pxEls.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > h) return;
      var d = (r.top + r.height / 2 - h / 2) / h; // -0.5..0.5
      el.style.setProperty("--py", (d * -22).toFixed(1) + "px");
    });
  }

  /* ---------- Card tilt + glow follow ---------- */
  if (fine) $$(".card").forEach(function (c) {
    c.addEventListener("pointermove", function (e) {
      var r = c.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      c.style.transform = "perspective(800px) rotateX(" + ((py - .5) * -5).toFixed(2) + "deg) rotateY(" + ((px - .5) * 6).toFixed(2) + "deg) translateY(-2px)";
      c.style.setProperty("--mx", (px * 100) + "%"); c.style.setProperty("--my", (py * 100) + "%");
    });
    c.addEventListener("pointerleave", function () { c.style.transform = ""; });
  });

  /* ---------- Flow strip: a pulse travelling through the stages ---------- */
  var flow = $(".flowstrip");
  if (flow) {
    var cells = $$(".st, .arr", flow), fi = 0;
    setInterval(function () {
      cells.forEach(function (c) { c.classList.remove("pulse"); });
      cells[fi].classList.add("pulse"); if (cells[fi + 1]) cells[fi + 1].classList.add("pulse");
      fi = (fi + 2) % cells.length;
    }, 900);
  }

  /* ---------- Scroll reveals + count-up ---------- */
  var sel = ".band:not(.hero) .head, .feature, .card, .stat, .st, .steps > *, .phone-row, .grid > *, .shot:not(.hero-shot)";
  var revs = $$(sel); revs.forEach(function (el, i) { el.classList.add("reveal"); var d = i % 3; if (d) el.classList.add("d" + d); });
  var stats = $$(".stat b"), pending = revs.slice();
  function sweep() {
    var h = innerHeight;
    pending = pending.filter(function (el) { if (el.getBoundingClientRect().top < h * 0.92) { el.classList.add("in"); return false; } return true; });
    stats = stats.filter(function (el) { if (el.getBoundingClientRect().top < h * 0.9) { countUp(el); return false; } return true; });
    if (!pending.length && !stats.length) removeEventListener("scroll", onSweep);
  }
  var st2 = false;
  function onSweep() { if (st2) return; st2 = true; requestAnimationFrame(function () { st2 = false; sweep(); }); }
  addEventListener("scroll", onSweep, { passive: true });
  addEventListener("resize", sweep);
  function countUp(el) {
    var m = el.textContent.trim().match(/^([^0-9]*)([0-9]+(?:\.[0-9]+)?)(.*)$/); if (!m) return;
    var pre = m[1], target = parseFloat(m[2]), suf = m[3], dec = (m[2].split(".")[1] || "").length, t0 = null;
    requestAnimationFrame(function step(ts) {
      if (!t0) t0 = ts; var p = Math.min(1, (ts - t0) / 1100), v = target * (1 - Math.pow(1 - p, 3));
      el.textContent = pre + v.toFixed(dec) + suf; if (p < 1) requestAnimationFrame(step); else el.textContent = pre + target.toFixed(dec) + suf;
    });
  }
  onScroll(); sweep();
})();
