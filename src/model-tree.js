// model-tree.js — turn a flat list of "/"-separated 12d `model` paths
// (e.g. "04 K2 Power Station/Services/Loc/Power/High Voltage") into a
// compacted tree for the sidebar, collapsing single-child chains into
// one node the way a file explorer does (so a long shared prefix like
// ".../Services/Loc/" doesn't turn into three pointless nested folders
// before you reach anything that actually branches).
//
// Pure/generic — no DOM, no Mapbox. See layer-tree.js for the UI this
// feeds into, and main-2d.js buildServicesTree() for how it's rendered.

/**
 * @param {string[]} paths - real model paths, e.g. every distinct
 *   `record.model` from twelve-d.js parse12da() output
 * @returns {Array<TreeNode>} top-level nodes, in first-seen order
 *
 * @typedef {
 *   { type: "leaf", label: string, fullPath: string } |
 *   { type: "branch", label: string, children: TreeNode[] }
 * } TreeNode
 */
export function buildModelTree(paths) {
  const root = { children: new Map() };
  for (const path of paths) {
    let node = root;
    for (const segment of path.split("/")) {
      if (!node.children.has(segment)) node.children.set(segment, { children: new Map() });
      node = node.children.get(segment);
    }
    node.fullPath = path; // this exact node is (also) a real model, not just a path prefix
  }

  return [...root.children.entries()].map(([label, child]) => compact(child, [label]));
}

function compact(node, labelParts) {
  // Collapse a run of single-child, non-leaf nodes into one label —
  // "04 K2 Power Station" -> "Services" -> "Loc" (each with exactly one
  // child, none of them a real model in their own right) becomes one
  // node labelled "04 K2 Power Station/Services/Loc".
  while (node.children.size === 1 && node.fullPath === undefined) {
    const [childLabel, child] = node.children.entries().next().value;
    labelParts.push(childLabel);
    node = child;
  }

  if (node.children.size === 0) {
    return { type: "leaf", label: labelParts.join("/"), fullPath: node.fullPath };
  }

  const children = [];
  if (node.fullPath !== undefined) {
    // Rare: a path that is itself a real model AND a prefix of other
    // models (e.g. both "A/B" and "A/B/C" exist as distinct models).
    // Surface it as an explicit leaf alongside its children rather than
    // silently dropping it.
    children.push({ type: "leaf", label: "(this level)", fullPath: node.fullPath });
  }
  for (const [childLabel, child] of node.children) {
    children.push(compact(child, [childLabel]));
  }
  return { type: "branch", label: labelParts.join("/"), children };
}
