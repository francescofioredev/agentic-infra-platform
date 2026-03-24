/**
 * Mermaid diagram zoom — click to fullscreen with pan & zoom.
 *
 * Material for MkDocs renders mermaid into a CLOSED Shadow DOM, so we
 * cannot access the SVG directly. Instead we move the entire .mermaid
 * element (shadow DOM travels with it) into a fullscreen overlay and
 * apply CSS transforms for zoom/pan.
 */
(function () {
  "use strict";

  var overlay = null;
  var state = { scale: 1, x: 0, y: 0, dragging: false, sx: 0, sy: 0 };
  var placeholder = null;
  var origStyle = "";
  var activeMermaid = null;

  var MIN_SCALE = 0.1;
  var MAX_SCALE = 8;
  var ZOOM_STEP = 0.15;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function applyTransform() {
    if (!activeMermaid) return;
    activeMermaid.style.transform =
      "translate(" + state.x + "px," + state.y + "px) scale(" + state.scale + ")";
  }

  function getTitle(el) {
    var node = el;
    while (node) {
      node = node.previousElementSibling;
      if (node && /^H[2-3]$/.test(node.tagName))
        return node.textContent.replace(/[¶#]/g, "").trim();
    }
    return "Diagram";
  }

  function updateLabel() {
    if (!overlay) return;
    var l = overlay.querySelector(".diagram-toolbar-zoom");
    if (l) l.textContent = Math.round(state.scale * 100) + "%";
  }

  /* ── Open ── */
  function open(mermaidEl) {
    if (overlay) return;

    activeMermaid = mermaidEl;
    origStyle = mermaidEl.style.cssText || "";

    /* Placeholder so we can put the element back */
    placeholder = document.createComment("mermaid-zoom-placeholder");
    mermaidEl.parentNode.insertBefore(placeholder, mermaidEl);

    var title = getTitle(mermaidEl);

    overlay = document.createElement("div");
    overlay.className = "diagram-overlay";
    overlay.innerHTML =
      '<div class="diagram-toolbar">' +
        '<span class="diagram-toolbar-title">' + title + '</span>' +
        '<div class="diagram-toolbar-controls">' +
          '<button data-action="zoom-in" title="Zoom in (+)">+</button>' +
          '<span class="diagram-toolbar-zoom">100%</span>' +
          '<button data-action="zoom-out" title="Zoom out (−)">−</button>' +
          '<button data-action="fit" title="Fit (F)">Fit</button>' +
          '<button data-action="close" title="Close (Esc)">✕</button>' +
        '</div>' +
      '</div>' +
      '<div class="diagram-viewport"></div>';

    var viewport = overlay.querySelector(".diagram-viewport");

    /* Move the actual element (shadow DOM travels with it) */
    viewport.appendChild(mermaidEl);
    mermaidEl.style.cssText = "position:absolute;transform-origin:0 0;";

    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";

    requestAnimationFrame(function () {
      overlay.classList.add("active");
      requestAnimationFrame(function () { fit(viewport); });
    });

    /* Toolbar actions */
    overlay.addEventListener("click", function (e) {
      var a = e.target.dataset && e.target.dataset.action;
      if (!a) return;
      e.stopPropagation();
      if (a === "close") close();
      else if (a === "zoom-in") zoomCenter(ZOOM_STEP, viewport);
      else if (a === "zoom-out") zoomCenter(-ZOOM_STEP, viewport);
      else if (a === "fit") fit(viewport);
    });

    /* Click on backdrop closes */
    viewport.addEventListener("dblclick", function () { fit(viewport); });

    /* Wheel zoom */
    viewport.addEventListener("wheel", function (e) {
      e.preventDefault();
      var d = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      zoomAt(d, e.clientX, e.clientY, viewport);
    }, { passive: false });

    /* Pan — mouse */
    viewport.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      state.dragging = true;
      state.sx = e.clientX - state.x;
      state.sy = e.clientY - state.y;
      viewport.classList.add("grabbing");
      e.preventDefault();
    });

    /* Pan — touch */
    viewport.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1) return;
      state.dragging = true;
      state.sx = e.touches[0].clientX - state.x;
      state.sy = e.touches[0].clientY - state.y;
      viewport.classList.add("grabbing");
    }, { passive: true });

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onUp);
    window.addEventListener("keydown", onKey);
  }

  /* ── Fit ── */
  function fit(viewport) {
    if (!activeMermaid) return;
    var sw = activeMermaid.scrollWidth || activeMermaid.offsetWidth || 800;
    var sh = activeMermaid.scrollHeight || activeMermaid.offsetHeight || 600;
    var vw = viewport.clientWidth;
    var vh = viewport.clientHeight;
    var pad = 40;
    state.scale = Math.min((vw - pad) / sw, (vh - pad) / sh, 3);
    state.x = (vw - sw * state.scale) / 2;
    state.y = (vh - sh * state.scale) / 2;
    applyTransform();
    updateLabel();
  }

  /* ── Zoom ── */
  function zoomCenter(delta, viewport) {
    var r = viewport.getBoundingClientRect();
    zoomAt(delta, r.left + r.width / 2, r.top + r.height / 2, viewport);
  }

  function zoomAt(delta, cx, cy, viewport) {
    var r = viewport.getBoundingClientRect();
    var mx = cx - r.left;
    var my = cy - r.top;
    var prev = state.scale;
    state.scale = clamp(state.scale * (1 + delta), MIN_SCALE, MAX_SCALE);
    var ratio = state.scale / prev;
    state.x = mx - ratio * (mx - state.x);
    state.y = my - ratio * (my - state.y);
    applyTransform();
    updateLabel();
  }

  /* ── Pan handlers ── */
  function onMove(e) {
    if (!state.dragging || !activeMermaid) return;
    state.x = e.clientX - state.sx;
    state.y = e.clientY - state.sy;
    applyTransform();
  }
  function onTouchMove(e) {
    if (!state.dragging || !activeMermaid) return;
    e.preventDefault();
    state.x = e.touches[0].clientX - state.sx;
    state.y = e.touches[0].clientY - state.sy;
    applyTransform();
  }
  function onUp() {
    state.dragging = false;
    if (overlay) {
      var vp = overlay.querySelector(".diagram-viewport");
      if (vp) vp.classList.remove("grabbing");
    }
  }
  function onKey(e) {
    if (!overlay) return;
    var vp = overlay.querySelector(".diagram-viewport");
    if (e.key === "Escape") close();
    else if (e.key === "+" || e.key === "=") zoomCenter(ZOOM_STEP, vp);
    else if (e.key === "-") zoomCenter(-ZOOM_STEP, vp);
    else if (e.key === "f" || e.key === "F") fit(vp);
  }

  /* ── Close ── */
  function close() {
    if (!overlay || !activeMermaid) return;
    /* Move element back to its original position */
    activeMermaid.style.cssText = origStyle;
    if (placeholder && placeholder.parentNode) {
      placeholder.parentNode.insertBefore(activeMermaid, placeholder);
      placeholder.remove();
    }
    overlay.classList.remove("active");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("touchend", onUp);
    window.removeEventListener("keydown", onKey);
    document.body.style.overflow = "";
    var ref = overlay;
    overlay = null;
    activeMermaid = null;
    placeholder = null;
    state = { scale: 1, x: 0, y: 0, dragging: false, sx: 0, sy: 0 };
    setTimeout(function () { ref.remove(); }, 200);
  }

  /* ── Event delegation — works regardless of Mermaid rendering timing ── */
  document.addEventListener("click", function (e) {
    if (overlay) return;
    var el = e.target.closest(".mermaid");
    if (!el) return;
    /* Skip if it's still unprocessed <pre> with raw code */
    if (el.tagName === "PRE" && el.querySelector("code")) return;
    if (window.getSelection && window.getSelection().toString()) return;
    e.preventDefault();
    e.stopPropagation();
    open(el);
  });
})();
