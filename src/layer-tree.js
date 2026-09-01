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
//
// Rename + delete (2026-08-31, per Cameron: "we also need to be able to
// rename, edit and delete layers/groups"):
//  - Rename is handled ENTIRELY here, generically, for every row/group —
//    it's purely a display-text change (the underlying filter key a
//    controller uses — a model path, a surfaceId, an ifcId — never
//    changes), so it needs no cooperation from callers at all.
//  - Delete DOES need cooperation: only rows/groups constructed with an
//    `onDelete` callback get a delete button at all (so e.g. the Base
//    Map group and its Satellite/Streets radio rows, which aren't
//    user-uploaded data, simply have no delete affordance) — clicking it
//    calls the caller's `onDelete()` first (to actually remove that
//    data from the map/controller state), then removes the row/group's
//    own DOM node and fixes up the empty-group bookkeeping.

/** Turns `labelEl`'s text into an editable field when `editBtn` is clicked. Generic — used for both rows and group headers. */
function makeRenamable(labelEl, editBtn) {
  editBtn.addEventListener("click", (e) => {
    // stopPropagation so this doesn't also bubble up into a row's "click
    // elsewhere on the row toggles the checkbox" handler, or a group
    // header's "click toggles collapsed" handler.
    e.stopPropagation();
    const current = labelEl.textContent;
    const input = document.createElement("input");
    input.type = "text";
    input.value = current;
    input.className = "layer-rename-input";
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") input.blur();
      if (ev.key === "Escape") {
        input.value = current;
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      const next = input.value.trim();
      labelEl.textContent = next.length > 0 ? next : current;
      labelEl.title = labelEl.textContent;
      input.replaceWith(labelEl);
    });
    labelEl.replaceWith(input);
    input.focus();
    input.select();
  });
}

/** A small icon-only button, shared styling for rename (✎) / delete (🗑) affordances. */
function makeIconButton(symbol, title) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = symbol;
  btn.title = title;
  btn.className = "layer-icon-btn";
  return btn;
}

/**
 * Create a collapsible group in `container`. Returns handles for adding
 * rows/subgroups and reading/setting the group's own checkbox state.
 *
 * @param {HTMLElement} container
 * @param {{ label: string, defaultOpen?: boolean, onDelete?: () => void }} opts
 *   `onDelete`, if given, adds a delete button to this group's OWN header
 *   (deleting the whole group's contents at once) — see file header.
 */
export function createLayerGroup(container, { label, defaultOpen = true, onDelete = null } = {}) {
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

  const renameBtn = makeIconButton("✎", "Rename this group");
  makeRenamable(title, renameBtn);

  header.append(groupCheckbox, caret, title, renameBtn);

  if (onDelete) {
    const deleteBtn = makeIconButton("🗑", "Delete this entire group's contents");
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onDelete();
      group.remove();
    });
    header.append(deleteBtn);
  }

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

  /** Removes one child entry (row or subgroup) from bookkeeping, restoring the empty note if that was the last one. */
  function forgetChild(entry) {
    const i = children.indexOf(entry);
    if (i !== -1) children.splice(i, 1);
    childCount--;
    if (childCount === 0) body.appendChild(emptyNote);
  }

  const api = {
    body,
    groupCheckbox,

    /**
     * Add a togglable row (checkbox). Removes the "nothing loaded yet"
     * note on first call.
     * @param {{ onDelete?: () => void }} [opts.onDelete] - if given, adds
     *   a delete button to this row — see file header for why this is
     *   opt-in per row, not automatic.
     */
    addRow({ label, checked = true, color = null, type = "checkbox", name = null, onChange, onDelete = null }) {
      if (childCount === 0) emptyNote.remove();
      childCount++;

      // A plain <div>, not a <label> — a real <label> forwards clicks
      // anywhere inside it (including on a nested rename/delete
      // <button>) to its associated control, and that forwarding isn't
      // reliably stoppable with preventDefault()/stopPropagation() on
      // the button's own click handler (found 2026-08-31 via direct
      // testing: clicking the rename button fired a spurious `change`
      // event on the checkbox, same value, but still an unwanted extra
      // onChange() call). Toggling is instead handled explicitly below,
      // for exactly the parts of the row that should trigger it.
      const row = document.createElement("div");
      row.className = "layer-row";

      const input = document.createElement("input");
      input.type = type;
      if (name) input.name = name;
      input.checked = checked;
      input.addEventListener("change", () => {
        if (!input.disabled) onChange(input.checked);
      });
      row.appendChild(input);

      // Clicking anywhere else on the row (the swatch, the label text —
      // NOT the checkbox itself, which already handles its own clicks
      // natively, and NOT the icon buttons, which stop propagation
      // before this ever runs) toggles the checkbox — reproduces the
      // old <label> behaviour's convenience without its forwarding quirk.
      row.addEventListener("click", (e) => {
        if (e.target === input || input.disabled) return;
        input.checked = !input.checked;
        onChange(input.checked);
      });

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

      const renameBtn = makeIconButton("✎", "Rename this layer");
      makeRenamable(labelText, renameBtn);
      row.appendChild(renameBtn);

      const entry = {
        applyParentEnabled(effectiveParentOn) {
          input.disabled = !effectiveParentOn;
          onChange(effectiveParentOn && input.checked);
        },
      };

      if (onDelete) {
        const deleteBtn = makeIconButton("🗑", "Delete this layer");
        // stopPropagation so this doesn't also bubble up into the row's
        // own "click elsewhere on the row toggles the checkbox" handler.
        deleteBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          onDelete();
          row.remove();
          forgetChild(entry);
        });
        row.appendChild(deleteBtn);
      }

      body.appendChild(row);
      children.push(entry);
      recomputeAndCascade(); // apply this group's current effective state to the new row immediately
      return input;
    },

    /**
     * Add a nested group inside this one. Returns the same kind of
     * handle, recursively.
     * @param {{ onDelete?: () => void }} [opts.onDelete] - deletes this
     *   whole subgroup's contents at once — see file header.
     */
    addSubgroup({ label, defaultOpen = true, onDelete = null } = {}) {
      if (childCount === 0) emptyNote.remove();
      childCount++;

      const sub = createLayerGroup(body, { label, defaultOpen, onDelete });
      const entry = {
        applyParentEnabled(effectiveParentOn) {
          sub.setParentEnabled(effectiveParentOn);
        },
      };
      children.push(entry);
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
