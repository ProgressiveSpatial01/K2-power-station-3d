// layer-tree.js — small reusable collapsible/grouped layer-panel UI,
// no framework, plain DOM. Mirrors the CSBP viewer's "grouped/sub-grouped
// collapsible layer control panel" pattern (see brief) rather than
// inventing a new interaction model.
//
// Deliberately generic — it doesn't know about Mapbox, IFC, or 12d.
// Callers wire each row's checkbox to whatever visibility mechanism is
// appropriate (setLayoutProperty, a filter expression, etc.) via
// `onChange`.
//
// Nested groups (2026-08-26, per Cameron: "build the nested model/sub-
// group tree"): a group can now contain child groups as well as rows,
// to arbitrary depth — see addSubgroup(). Toggling a group's own
// checkbox cascades down through every descendant row's onChange (not
// just direct children), so switching off "Power" really hides both
// "High Voltage" and "Low Voltage" underneath it, and switching it back
// on restores each leaf to whatever it was individually set to (a row
// left unchecked before the group-off stays unchecked after group-on —
// matches how e.g. QGIS/Civil3D layer panels behave). Implemented via
// each group tracking its own `parentEnabled` flag, recomputing
// `effective = parentEnabled && ownCheckbox.checked` on any change (its
// own checkbox, or a `setParentEnabled()` call from its parent), and
// propagating that down to its children — rows apply it directly via
// their `onChange`; subgroups recurse via their own `setParentEnabled()`.

/**
 * Create a collapsible group in `container`. Returns handles for adding
 * rows/subgroups and reading/setting the group's own checkbox state.
 *
 * @param {HTMLElement} container
 * @param {{ label: string, defaultOpen?: boolean }} opts
 */
export function createLayerGroup(container, { label, defaultOpen = true } = {}) {
  const group = document.createElement("div");
  group.className = "layer-group";

  const header = document.createElement("div");
  header.className = "layer-group-header";

  const groupCheckbox = document.createElement("input");
  groupCheckbox.type = "checkbox";
  groupCheckbox.checked = true;

  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = defaultOpen ? "▾" : "▸";

  const title = document.createElement("span");
  title.className = "layer-group-title";
  title.textContent = label;
  title.title = label; // full label on hover, in case it's truncated by CSS

  header.append(groupCheckbox, caret, title);

  const body = document.createElement("div");
  body.className = "layer-group-body";
  body.style.display = defaultOpen ? "block" : "none";

  const emptyNote = document.createElement("div");
  emptyNote.className = "layer-group-empty";
  emptyNote.textContent = "Nothing loaded yet";
  body.appendChild(emptyNote);

  header.addEventListener("click", (e) => {
    if (e.target === groupCheckbox) return; // checkbox has its own handler
    const open = body.style.display !== "none";
    body.style.display = open ? "none" : "block";
    caret.textContent = open ? "▸" : "▾";
  });

  group.append(header, body);
  container.appendChild(group);

  let childCount = 0;
  const children = []; // { applyParentEnabled(effectiveParentOn: boolean) }
  let parentEnabled = true; // this group's own parent's effective state (true if top-level)

  function recomputeAndCascade() {
    groupCheckbox.disabled = !parentEnabled;
    const effective = parentEnabled && groupCheckbox.checked;
    for (const child of children) child.applyParentEnabled(effective);
  }

  groupCheckbox.addEventListener("change", recomputeAndCascade);

  const api = {
    body,
    groupCheckbox,

    /** Add a togglable row (checkbox). Removes the "nothing loaded yet" note on first call. */
    addRow({ label, checked = true, color = null, type = "checkbox", name = null, onChange }) {
      if (childCount === 0) emptyNote.remove();
      childCount++;

      const row = document.createElement("label");
      row.className = "layer-row";

      const input = document.createElement("input");
      input.type = type;
      if (name) input.name = name;
      input.checked = checked;
      input.addEventListener("change", () => {
        if (!input.disabled) onChange(input.checked);
      });
      row.appendChild(input);

      if (color) {
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.background = color;
        row.appendChild(swatch);
      }

      const labelText = document.createElement("span");
      labelText.className = "layer-row-label";
      labelText.textContent = label;
      labelText.title = label;
      row.appendChild(labelText);
      body.appendChild(row);

      children.push({
        applyParentEnabled(effectiveParentOn) {
          input.disabled = !effectiveParentOn;
          onChange(effectiveParentOn && input.checked);
        },
      });
      recomputeAndCascade(); // apply this group's current effective state to the new row immediately
      return input;
    },

    /** Add a nested group inside this one. Returns the same kind of handle, recursively. */
    addSubgroup({ label, defaultOpen = true } = {}) {
      if (childCount === 0) emptyNote.remove();
      childCount++;

      const sub = createLayerGroup(body, { label, defaultOpen });
      children.push({
        applyParentEnabled(effectiveParentOn) {
          sub.setParentEnabled(effectiveParentOn);
        },
      });
      recomputeAndCascade();
      return sub;
    },

    /** Called by a parent group when ITS effective state changes. Not meant for top-level callers. */
    setParentEnabled(on) {
      parentEnabled = on;
      recomputeAndCascade();
    },

    /**
     * Remove every row/subgroup added so far, restoring the "Nothing
     * loaded yet" placeholder. For callers that rebuild a tree from
     * scratch when its underlying data changes shape (see
     * model-tree.js) rather than trying to diff/patch an existing tree.
     */
    clear() {
      body.replaceChildren(emptyNote);
      children.length = 0;
      childCount = 0;
    },
  };

  return api;
}
