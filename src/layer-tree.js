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
//
// Custom groups + drag to organise (2026-10-14, per Cameron: "allow
// sublayers to be built in the layer table and can I drag the layers into
// these sub groups"). A small "organiser" sits on top of the trees the
// controllers build:
//  - USER GROUPS: created with a ＋ button (panel-level, or on any user
//    group, or on a stable group). Purely organisational — they hold rows,
//    have a group checkbox that cascades like any other group, can be
//    renamed, and their ✕ removes the group only (its layers go back where
//    they came from; no data is ever deleted by it).
//  - MOVING LAYERS: a row given a stable `key` can be dragged onto any user
//    group or stable (keyed) group on desktop, or moved with its ⇄ button's
//    menu (works on touch, where HTML5 drag-and-drop doesn't).
//  - SURVIVING REBUILDS: controllers throw their trees away and rebuild them
//    whenever a new model arrives (see the model-tree.js callers). So the
//    arrangement is stored as {rowKey -> group} and applied inside addRow():
//    a rebuilt row whose key has an assignment goes straight into its group.
//    clear() removes only what the rebuilding controller made (rows by
//    ORIGIN, wherever they've since been moved to) and leaves user groups
//    alone.
// Persisted in this browser's localStorage (a view arrangement only — it is
// not shared between visitors or devices). A key that stops matching (e.g.
// a 12d model path that got reworded) just lands back in its original
// place, harmlessly.

const STORE_KEY = "k2-layer-organisation-v1";

const org = {
  defs: new Map(), // user group id -> { id, label, parent }  parent: stable key | user id | null (panel root)
  assign: new Map(), // row key -> group id (user group id or stable key)
  live: new Map(), // group id / stable key -> live group node
  entries: new Set(), // live movable row entries
  rootContainer: null,
  dragging: null,
  loaded: false,
};

function loadOrg() {
  if (org.loaded) return;
  org.loaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    for (const d of raw?.groups ?? []) org.defs.set(d.id, d);
    for (const [k, v] of Object.entries(raw?.assign ?? {})) org.assign.set(k, v);
  } catch {
    // unreadable/blocked storage — start with no custom arrangement
  }
}

function saveOrg() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ groups: [...org.defs.values()], assign: Object.fromEntries(org.assign) })
    );
  } catch {
    // ignore — the arrangement just won't persist
  }
}

function injectOrganiserCss() {
  if (document.getElementById("layer-organiser-css")) return;
  const style = document.createElement("style");
  style.id = "layer-organiser-css";
  style.textContent = `
    .layer-row[draggable="true"] { cursor: grab; }
    .layer-row.dragging { opacity: 0.4; }
    .layer-group.drop-target > .layer-group-header { background: #1d3a57; outline: 1px dashed #2fa3ff; }
    .layer-group.user-group > .layer-group-header .layer-group-title { color: #9fd0ff; }
    .layer-add-group {
      background: #1c1e21; border: 1px solid #3a3d42; border-radius: 4px; color: #ccc;
      font-size: 11px; padding: 3px 8px; cursor: pointer; margin: 0 0 6px;
    }
    .layer-add-group:hover { border-color: #57b6ff; color: #fff; }
    .layer-move-menu {
      position: fixed; z-index: 10000; background: #1c1e21; border: 1px solid #3a3d42; border-radius: 6px;
      padding: 4px; min-width: 190px; max-height: 60vh; overflow-y: auto; box-shadow: 0 6px 18px rgba(0,0,0,0.5);
      font: 12px system-ui, sans-serif;
    }
    .layer-move-menu .menu-title { color: #8a8f98; font-size: 10px; text-transform: uppercase; padding: 4px 8px; }
    .layer-move-menu button {
      display: block; width: 100%; text-align: left; background: none; border: none; color: #ddd;
      padding: 6px 8px; border-radius: 4px; cursor: pointer; font: inherit;
    }
    .layer-move-menu button:hover { background: #2a2d31; color: #fff; }
  `;
  document.head.appendChild(style);
}

/** Turns `labelEl`'s text into an editable field when `editBtn` is clicked. Generic — used for both rows and group headers. */
function makeRenamable(labelEl, editBtn, onRename = null) {
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
      if (onRename && labelEl.textContent !== current) onRename(labelEl.textContent);
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

function newUserGroupId() {
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Moves a row entry into `target`, persisting the arrangement. */
function moveEntry(entry, target) {
  if (!target || target === entry.holder) return;
  entry.holder.release(entry);
  target.adopt(entry);
  if (target === entry.origin) org.assign.delete(entry.key);
  else org.assign.set(entry.key, target.groupId);
  saveOrg();
}

/** Stable-keyed and user groups currently on the page, document order, with nesting depth. */
function droppableNodes() {
  const depthOf = (n) => {
    let d = 0;
    for (let p = n.parent; p; p = p.parent) d++;
    return d;
  };
  const out = [];
  for (const node of org.live.values()) if (node.groupEl.isConnected) out.push({ node, depth: depthOf(node) });
  out.sort((a, b) =>
    a.node.groupEl.compareDocumentPosition(b.node.groupEl) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );
  return out;
}

function openMoveMenu(entry, anchor) {
  document.querySelector(".layer-move-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "layer-move-menu";
  const title = document.createElement("div");
  title.className = "menu-title";
  title.textContent = "Move layer to…";
  menu.appendChild(title);
  const add = (label, node) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => {
      menu.remove();
      moveEntry(entry, node);
    });
    menu.appendChild(b);
  };
  if (entry.origin?.groupEl.isConnected && entry.holder !== entry.origin) add("↩ Back to original place", entry.origin);
  for (const { node, depth } of droppableNodes()) {
    if (node === entry.holder) continue;
    add(`${" ".repeat(depth)}${node.titleEl.textContent}`, node);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
  const close = (ev) => {
    if (menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener("pointerdown", close, true);
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

/**
 * Turns on custom groups for a layer panel: adds a "＋ New group" button
 * above `container` and recreates any saved top-level custom groups in it.
 * Call once per page, after the stable (keyed) groups exist.
 */
export function enableLayerOrganiser(container) {
  loadOrg();
  injectOrganiserCss();
  org.rootContainer = container;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "layer-add-group";
  btn.textContent = "＋ New group";
  btn.title = "Add a group to the layer list, then drag layers into it (or use a layer's ⇄ button)";
  btn.addEventListener("click", () => createUserGroup(null));
  container.before(btn);
  for (const def of [...org.defs.values()]) {
    if (def.parent === null && !org.live.has(def.id)) createLayerGroup(container, { label: def.label, defaultOpen: false, _user: def });
  }
}

function createUserGroup(parentId) {
  const def = { id: newUserGroupId(), label: "New group", parent: parentId };
  org.defs.set(def.id, def);
  saveOrg();
  if (parentId === null) createLayerGroup(org.rootContainer, { label: def.label, _user: def });
  else org.live.get(parentId)?.api.addSubgroup({ label: def.label, _user: def });
}

/**
 * Create a collapsible group in `container`. Returns handles for adding
 * rows/subgroups and reading/setting the group's own checkbox state.
 *
 * @param {HTMLElement} container
 * @param {{ label: string, defaultOpen?: boolean, onDelete?: () => void, key?: string }} opts
 *   `onDelete`, if given, adds a delete button to this group's OWN header
 *   (deleting the whole group's contents at once) — see file header.
 *   `key` makes a group stable/addressable: rows can be dragged into it and
 *   custom groups can be created inside it. Only give it to groups created
 *   once at page start, never to groups a controller rebuilds.
 */
export function createLayerGroup(container, opts = {}) {
  const { label, defaultOpen = true, onDelete = null, key = null, _user = null, _parent = null } = opts;
  loadOrg();

  const group = document.createElement("div");
  group.className = "layer-group" + (_user ? " user-group" : "");

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
  makeRenamable(title, renameBtn, _user ? (text) => { _user.label = text; saveOrg(); } : null);

  header.append(groupCheckbox, caret, title);

  // The node: this group's identity inside the organiser (parent chain for
  // origin tracking and menu indentation, adopt/release for moving rows).
  const node = {
    api: null,
    parent: _parent,
    isUser: !!_user,
    groupId: _user ? _user.id : key,
    groupEl: group,
    titleEl: title,
    adopt: null,
    release: null,
  };

  if (_user || key) {
    const addBtn = makeIconButton("＋", "Add a group inside this one");
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      createUserGroup(node.groupId);
    });
    header.append(addBtn);
  }
  header.append(renameBtn);

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
  // Row entries ({type:"row"}) and subgroup entries ({type:"group", node}), each with applyParentEnabled().
  const children = [];
  let parentEnabled = true; // this group's own parent's effective state (true if top-level)

  const effectiveOn = () => parentEnabled && groupCheckbox.checked;

  function recomputeAndCascade() {
    groupCheckbox.disabled = !parentEnabled;
    const effective = effectiveOn();
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

  function addChild(entry, el) {
    if (childCount === 0) emptyNote.remove();
    childCount++;
    body.appendChild(el);
    children.push(entry);
  }

  node.adopt = (entry) => {
    addChild(entry, entry.row);
    entry.holder = node;
    entry.applyParentEnabled(effectiveOn());
  };
  node.release = (entry) => forgetChild(entry);

  // --- drop target (desktop drag and drop onto a keyed or user group) ---
  if (_user || key) {
    const canDrop = () => org.dragging && org.dragging.holder !== node;
    for (const el of [header, body]) {
      el.addEventListener("dragover", (e) => {
        if (!org.dragging) return;
        e.preventDefault();
        e.stopPropagation();
        if (canDrop()) group.classList.add("drop-target");
      });
      el.addEventListener("dragleave", (e) => {
        if (!group.contains(e.relatedTarget)) group.classList.remove("drop-target");
      });
      el.addEventListener("drop", (e) => {
        if (!org.dragging) return;
        e.preventDefault();
        e.stopPropagation();
        group.classList.remove("drop-target");
        moveEntry(org.dragging, node);
      });
    }
  }

  const api = {
    body,
    groupCheckbox,
    _node: node,

    /**
     * Add a togglable row (checkbox). Removes the "nothing loaded yet"
     * note on first call.
     * @param {{ onDelete?: () => void }} [opts.onDelete] - if given, adds
     *   a delete button to this row — see file header for why this is
     *   opt-in per row, not automatic.
     * @param {string} [opts.key] - stable id (unique per page) that makes
     *   this row draggable/movable and lets its placement survive tree
     *   rebuilds. Omit for rows that shouldn't be movable (e.g. Base Map).
     */
    addRow({ label, checked = true, color = null, type = "checkbox", name = null, onChange, onDelete = null, key: rowKey = null }) {
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
        type: "row",
        key: rowKey,
        row,
        origin: node,
        holder: node,
        applyParentEnabled(effectiveParentOn) {
          input.disabled = !effectiveParentOn;
          onChange(effectiveParentOn && input.checked);
        },
        /** Remove this row from the DOM and every bookkeeping list, WITHOUT calling the caller's onDelete. */
        destroy() {
          row.remove();
          entry.holder.release(entry);
          org.entries.delete(entry);
        },
      };

      if (rowKey && type === "checkbox") {
        const moveBtn = makeIconButton("⇄", "Move this layer to a group (or drag it onto one)");
        moveBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openMoveMenu(entry, moveBtn);
        });
        row.appendChild(moveBtn);

        row.draggable = true;
        row.addEventListener("dragstart", (e) => {
          org.dragging = entry;
          row.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", rowKey);
        });
        row.addEventListener("dragend", () => {
          org.dragging = null;
          row.classList.remove("dragging");
          document.querySelectorAll(".layer-group.drop-target").forEach((g) => g.classList.remove("drop-target"));
        });
        org.entries.add(entry);
      }

      if (onDelete) {
        const deleteBtn = makeIconButton("🗑", "Delete this layer");
        // stopPropagation so this doesn't also bubble up into the row's
        // own "click elsewhere on the row toggles the checkbox" handler.
        deleteBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          onDelete();
          entry.destroy();
        });
        row.appendChild(deleteBtn);
      }

      // A saved arrangement wins over the group this row was created in.
      const savedId = rowKey ? org.assign.get(rowKey) : null;
      const home = (savedId && org.live.get(savedId)) || node;
      home.adopt(entry);
      return input;
    },

    /**
     * Add a nested group inside this one. Returns the same kind of
     * handle, recursively.
     * @param {{ onDelete?: () => void }} [opts.onDelete] - deletes this
     *   whole subgroup's contents at once — see file header.
     */
    addSubgroup({ label, defaultOpen = true, onDelete = null, key: subKey = null, _user: userDef = null } = {}) {
      const subOnDelete = onDelete
        ? () => {
            onDelete();
            // Rows that came from inside this group may have been moved elsewhere — remove those too.
            purgeOrigin(sub._node);
          }
        : null;
      const sub = createLayerGroup(body, { label, defaultOpen, onDelete: subOnDelete, key: subKey, _user: userDef, _parent: node });
      const entry = {
        type: "group",
        node: sub._node,
        applyParentEnabled(effectiveParentOn) {
          sub.setParentEnabled(effectiveParentOn);
        },
      };
      if (childCount === 0) emptyNote.remove();
      childCount++;
      children.push(entry);
      sub._entry = entry;
      sub._forgetFromParent = () => forgetChild(entry);
      recomputeAndCascade();
      return sub;
    },

    /** Called by a parent group when ITS effective state changes. Not meant for top-level callers. */
    setParentEnabled(on) {
      parentEnabled = on;
      recomputeAndCascade();
    },

    /**
     * Remove everything the CALLER built in this group — rows (wherever
     * they've been moved to since) and auto-built subgroups — restoring the
     * "Nothing loaded yet" placeholder. Custom (user) groups, and rows that
     * were moved in from other trees, stay. For callers that rebuild a tree
     * from scratch when its underlying data changes shape (see
     * model-tree.js) rather than trying to diff/patch an existing tree.
     */
    clear() {
      purgeOrigin(node);
      for (const child of [...children]) {
        if (child.type === "group" && !child.node.isUser) {
          child.node.groupEl.remove();
          forgetChild(child);
        }
      }
    },
  };

  node.api = api;
  api.groupEl = group;

  // The `clear()` callers rely on keeping this node's own rows/subgroups
  // bookkeeping consistent; user groups register so rows can be adopted.
  if (_user) org.live.set(_user.id, node);
  else if (key) org.live.set(key, node);

  if (_user) {
    // ✕: remove the group only. Its layers go back where they came from.
    const removeBtn = makeIconButton("✕", "Remove this group (its layers go back where they were; nothing is deleted)");
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeUserGroup(node, api);
    });
    header.append(removeBtn);
  } else if (onDelete) {
    const deleteBtn = makeIconButton("🗑", "Delete this entire group's contents");
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onDelete();
      group.remove();
    });
    header.append(deleteBtn);
  }

  // Recreate saved custom groups that belong inside this one.
  if (_user || key) {
    for (const def of [...org.defs.values()]) {
      if (def.parent === node.groupId && !org.live.has(def.id)) api.addSubgroup({ label: def.label, defaultOpen: false, _user: def });
    }
  }

  return api;
}

/** Destroy every row whose ORIGIN is `node` or an auto-built group beneath it, wherever it's currently held. */
function purgeOrigin(node) {
  for (const entry of [...org.entries]) {
    for (let n = entry.origin; n; n = n.parent) {
      if (n === node) {
        entry.destroy();
        break;
      }
      if (n.isUser) break;
    }
  }
}

function removeUserGroup(node, api) {
  // Everything inside (this group and any custom groups nested in it).
  const doomed = new Set();
  const collect = (n) => {
    doomed.add(n);
    for (const other of org.live.values()) if (other.parent === n && other.isUser) collect(other);
  };
  collect(node);

  for (const entry of [...org.entries]) {
    if (!doomed.has(entry.holder)) continue;
    if (entry.origin && !doomed.has(entry.origin) && entry.origin.groupEl.isConnected) {
      entry.holder.release(entry);
      entry.origin.adopt(entry);
    } else {
      entry.destroy();
    }
    org.assign.delete(entry.key);
  }
  for (const [k, v] of [...org.assign]) if (doomed.has(org.live.get(v))) org.assign.delete(k);

  for (const n of doomed) {
    org.defs.delete(n.groupId);
    org.live.delete(n.groupId);
  }
  api._forgetFromParent?.();
  node.groupEl.remove();
  saveOrg();
}
