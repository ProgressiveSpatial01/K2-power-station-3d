// surface-compare.js — a small "flip between two surfaces" control for
// the Design → Surfaces sidebar group. Added 2026-08-26, per Cameron: the
// actual intended workflow is uploading multiple dated surfaces (e.g.
// monthly drone flights) and comparing them; asked what "compare" should
// do first, chose "simple toggle/swipe... no numbers" over an elevation-
// delta map or cut/fill volumes (both real, bigger features — see
// README "Open items" for those, deliberately not built yet).
//
// Deliberately dumb: no elevation math here at all, just visibility. Only
// touches the two surfaces the user picked — any other loaded surfaces
// keep whatever their own sidebar checkbox already says, so this reads
// as "a quick way to flip between two", not a wholesale replacement for
// the per-surface checkboxes (which still work normally alongside it).

/**
 * @param {HTMLElement} container - rendered into this element (typically
 *   a layer-group's `.body`, ABOVE where its own rows get added).
 * @param {{
 *   getKnownSurfaceIds: () => string[],
 *   setSurfaceVisible: (id: string, visible: boolean) => void,
 * }} controller - see main-2d.js createSurfaceFeatureController()
 * @returns {{ onSurfacesChanged: (ids: string[]) => void }} call
 *   onSurfacesChanged whenever the controller's known surface list grows
 *   (rebuilds the dropdown options; keeps the current A/B pick if it's
 *   still valid, otherwise re-defaults to the two most recently added).
 */
export function createSurfaceCompareControl(container, { setSurfaceVisible }) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:none; margin:2px 0 10px; padding:8px; border:1px solid #333; border-radius:6px; background:#1c1e21;";
  wrap.innerHTML = `
    <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.06em; color:#8a8f98; margin-bottom:6px;">
      Compare two surfaces
    </div>
    <select class="compare-a" style="width:100%; margin-bottom:4px; font-size:11px; background:#111; color:#ddd; border:1px solid #444; border-radius:4px;"></select>
    <select class="compare-b" style="width:100%; margin-bottom:6px; font-size:11px; background:#111; color:#ddd; border:1px solid #444; border-radius:4px;"></select>
    <div class="compare-buttons" style="display:flex; gap:4px;"></div>
  `;
  container.appendChild(wrap);

  const selectA = wrap.querySelector(".compare-a");
  const selectB = wrap.querySelector(".compare-b");
  const buttonsEl = wrap.querySelector(".compare-buttons");

  let mode = "both"; // "a" | "b" | "both" — least-surprising default: nothing hides when the control first appears
  let allIds = [];

  const modes = [
    { key: "a", label: "Show A" },
    { key: "both", label: "Both" },
    { key: "b", label: "Show B" },
  ];
  const buttonEls = modes.map(({ key, label }) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText =
      "flex:1; font-size:11px; padding:4px 0; border-radius:4px; border:1px solid #444; " +
      "background:#111; color:#ccc; cursor:pointer;";
    btn.addEventListener("click", () => {
      mode = key;
      updateButtonStyles();
      applyState();
    });
    buttonsEl.appendChild(btn);
    return { key, btn };
  });

  function updateButtonStyles() {
    for (const { key, btn } of buttonEls) {
      const active = key === mode;
      btn.style.background = active ? "#2fa3ff" : "#111";
      btn.style.color = active ? "#fff" : "#ccc";
      btn.style.borderColor = active ? "#2fa3ff" : "#444";
    }
  }
  updateButtonStyles();

  function applyState() {
    const aId = selectA.value;
    const bId = selectB.value;
    for (const id of allIds) {
      if (id === aId && id === bId) {
        // Same surface picked for both slots — just show it, don't fight
        // over which rule wins.
        setSurfaceVisible(id, true);
      } else if (id === aId) {
        setSurfaceVisible(id, mode === "a" || mode === "both");
      } else if (id === bId) {
        setSurfaceVisible(id, mode === "b" || mode === "both");
      }
      // Any other loaded surface is untouched — its own sidebar checkbox
      // still controls it normally.
    }
  }

  selectA.addEventListener("change", applyState);
  selectB.addEventListener("change", applyState);

  return {
    onSurfacesChanged(ids) {
      allIds = ids;
      wrap.style.display = ids.length >= 2 ? "block" : "none";
      if (ids.length < 2) return;

      const prevA = selectA.value;
      const prevB = selectB.value;
      // NOT select.replaceChildren(...ids.map(...)) — same argument-count-
      // ceiling issue as the Math.min(...)/allFeatures.push(...) bugs
      // fixed elsewhere (main-2d.js, profile-chart.js). Currently safe in
      // practice (the number of loaded surfaces stays small), but fixed
      // defensively for consistency now that this pattern has bitten twice.
      for (const select of [selectA, selectB]) {
        select.replaceChildren();
        for (const id of ids) {
          const opt = document.createElement("option");
          opt.value = id;
          opt.textContent = id;
          select.appendChild(opt);
        }
      }
      // Keep the existing pick if it's still valid (a new 3rd+ surface
      // arriving shouldn't reset an in-progress comparison); default to
      // the two most-recently-added otherwise — the likeliest pairing
      // for "this month vs last month".
      selectA.value = ids.includes(prevA) ? prevA : ids[ids.length - 2];
      selectB.value = ids.includes(prevB) ? prevB : ids[ids.length - 1];
      applyState();
    },
  };
}
