// layer-tree.js — small reusable collapsible/grouped layer-panel UI,
// no framework, plain DOM. Mirrors the CSBP viewer's "grouped/sub-grouped
// collapsible layer control panel" pattern (see brief) rather than
// inventing a new interaction model.
//
// Deliberately generic — it doesn't know about Mapbox, IFC, or 12d.
// Callers wire each row's checkbox to whatever visibility mechanism is
// appropriate (setLayoutProperty, a filter expression, etc.) via
// `onChange`.

/**
 * Create a collapsible group in `container`. Returns handles for adding
 * rows and reading/setting the group's own checkbox state.
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

  let rowCount = 0;
  // Tracks every row so the group checkbox can actually cascade — not
  // just grey rows out, but re-fire each row's own onChange (the same
  // code path an individual toggle takes) so group-off really hides
  // everything, and group-on restores whatever each row was
  // individually set to (a row left unchecked before group-off stays
  // unchecked after group-on, matching how e.g. QGIS/Civil3D layer
  // panels behave).
  const rows = [];

  groupCheckbox.addEventListener("change", () => {
    const groupOn = groupCheckbox.checked;
    for (const { input, onChange } of rows) {
      input.disabled = !groupOn;
      onChange(groupOn && input.checked);
    }
  });

  return {
    body,
    groupCheckbox,
    /** Add a togglable row (checkbox). Removes the "nothing loaded yet" note on first call. */
    addRow({ label, checked = true, color = null, type = "checkbox", name = null, onChange }) {
      if (rowCount === 0) emptyNote.remove();
      rowCount++;

      const row = document.createElement("label");
      row.className = "layer-row";

      const input = document.createElement("input");
      input.type = type;
      if (name) input.name = name;
      input.checked = checked;
      input.disabled = !groupCheckbox.checked;
      input.addEventListener("change", () => onChange(input.checked));
      row.appendChild(input);

      if (color) {
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.background = color;
        row.appendChild(swatch);
      }

      row.appendChild(document.createTextNode(label));
      body.appendChild(row);
      rows.push({ input, onChange });
      return input;
    },
  };
}
