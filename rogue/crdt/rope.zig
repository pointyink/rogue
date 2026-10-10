const NodeId = @import("node_id.zig").NodeId;

pub const NULL: u32 = 0;

pub const Node = struct {
    parent: u32,
    left: u32,
    right: u32,
    tot_size: u32,
    vis_size: u32,
};

fn priority(node_id: NodeId) u32 {
    return @truncate(NodeId.HashContext.hash(.{}, node_id));
}

// ═══════════════════════════════════════════════════════════
// Index <-> slot
// ═══════════════════════════════════════════════════════════

pub fn visIxToSlot(nodes: []const Node, deleted: []const bool, root: u32, vis_ix: u32) ?u32 {
    var cur = root;
    var rem = vis_ix;
    while (cur != NULL) {
        const l = nodes[cur].left;
        const lv: u32 = if (l != NULL) nodes[l].vis_size else 0;
        if (rem < lv) {
            cur = l;
        } else {
            rem -= lv;
            if (!deleted[cur]) {
                if (rem == 0) return cur;
                rem -= 1;
            }
            cur = nodes[cur].right;
        }
    }
    return null;
}

pub fn totIxToSlot(nodes: []const Node, root: u32, tot_ix: u32) ?u32 {
    var cur = root;
    var rem = tot_ix;
    while (cur != NULL) {
        const l = nodes[cur].left;
        const lt: u32 = if (l != NULL) nodes[l].tot_size else 0;
        if (rem < lt) {
            cur = l;
        } else {
            rem -= lt;
            if (rem == 0) return cur;
            rem -= 1;
            cur = nodes[cur].right;
        }
    }
    return null;
}

pub fn slotToVisIx(nodes: []const Node, deleted: []const bool, slot_ix: u32) u32 {
    var rank: u32 = 0;
    const l = nodes[slot_ix].left;
    if (l != NULL) rank += nodes[l].vis_size;
    var cur = slot_ix;
    while (nodes[cur].parent != NULL) {
        const par = nodes[cur].parent;
        if (nodes[par].right == cur) {
            const pl = nodes[par].left;
            rank += (if (pl != NULL) nodes[pl].vis_size else 0);
            rank += if (deleted[par]) 0 else 1;
        }
        cur = par;
    }
    return rank;
}

pub fn slotToTotIx(nodes: []const Node, slot_ix: u32) u32 {
    var rank: u32 = 0;
    const l = nodes[slot_ix].left;
    if (l != NULL) rank += nodes[l].tot_size;
    var cur = slot_ix;
    while (nodes[cur].parent != NULL) {
        const par = nodes[cur].parent;
        if (nodes[par].right == cur) {
            const pl = nodes[par].left;
            rank += (if (pl != NULL) nodes[pl].tot_size else 0) + 1;
        }
        cur = par;
    }
    return rank;
}

// ═══════════════════════════════════════════════════════════
// Treap maintenance
// ═══════════════════════════════════════════════════════════

fn recalcOne(nodes: []Node, deleted: []const bool, slot_ix: u32) void {
    const l = nodes[slot_ix].left;
    const r = nodes[slot_ix].right;
    nodes[slot_ix].tot_size = 1 +
        (if (l != NULL) nodes[l].tot_size else 0) +
        (if (r != NULL) nodes[r].tot_size else 0);
    nodes[slot_ix].vis_size =
        (if (deleted[slot_ix]) @as(u32, 0) else 1) +
        (if (l != NULL) nodes[l].vis_size else 0) +
        (if (r != NULL) nodes[r].vis_size else 0);
}

pub fn updateSizes(nodes: []Node, deleted: []const bool, start_ix: u32) void {
    var cur = start_ix;
    while (cur != NULL) {
        recalcOne(nodes, deleted, cur);
        cur = nodes[cur].parent;
    }
}

fn rotateRight(nodes: []Node, deleted: []const bool, root: *u32, y: u32) void {
    const x = nodes[y].left;
    const p = nodes[y].parent;
    nodes[y].left = nodes[x].right;
    if (nodes[x].right != NULL) nodes[nodes[x].right].parent = y;
    nodes[x].right = y;
    nodes[y].parent = x;
    nodes[x].parent = p;
    if (p != NULL) {
        if (nodes[p].left == y) nodes[p].left = x else nodes[p].right = x;
    } else {
        root.* = x;
    }
    recalcOne(nodes, deleted, y);
    recalcOne(nodes, deleted, x);
}

fn rotateLeft(nodes: []Node, deleted: []const bool, root: *u32, x: u32) void {
    const y = nodes[x].right;
    const p = nodes[x].parent;
    nodes[x].right = nodes[y].left;
    if (nodes[y].left != NULL) nodes[nodes[y].left].parent = x;
    nodes[y].left = x;
    nodes[x].parent = y;
    nodes[y].parent = p;
    if (p != NULL) {
        if (nodes[p].left == x) nodes[p].left = y else nodes[p].right = y;
    } else {
        root.* = y;
    }
    recalcOne(nodes, deleted, x);
    recalcOne(nodes, deleted, y);
}

fn bubbleUp(nodes: []Node, deleted: []const bool, node_ids: []const NodeId, root: *u32, slot_ix: u32) void {
    while (nodes[slot_ix].parent != NULL) {
        const p = nodes[slot_ix].parent;
        if (priority(node_ids[slot_ix]) <= priority(node_ids[p])) break;
        if (nodes[p].left == slot_ix) rotateRight(nodes, deleted, root, p) else rotateLeft(nodes, deleted, root, p);
    }
    if (nodes[slot_ix].parent == NULL) root.* = slot_ix;
}

pub fn insertAfter(nodes: []Node, deleted: []const bool, node_ids: []const NodeId, root: *u32, pred_ix: u32, slot_ix: u32) void {
    nodes[slot_ix].tot_size = 1;
    nodes[slot_ix].vis_size = if (deleted[slot_ix]) 0 else 1;
    nodes[slot_ix].left = NULL;
    nodes[slot_ix].right = NULL;
    nodes[slot_ix].parent = NULL;

    if (root.* == NULL) {
        root.* = slot_ix;
        return;
    }

    if (pred_ix == NULL) {
        var cur = root.*;
        while (nodes[cur].left != NULL) cur = nodes[cur].left;
        nodes[cur].left = slot_ix;
        nodes[slot_ix].parent = cur;
    } else if (nodes[pred_ix].right == NULL) {
        nodes[pred_ix].right = slot_ix;
        nodes[slot_ix].parent = pred_ix;
    } else {
        var cur = nodes[pred_ix].right;
        while (nodes[cur].left != NULL) cur = nodes[cur].left;
        nodes[cur].left = slot_ix;
        nodes[slot_ix].parent = cur;
    }

    updateSizes(nodes, deleted, slot_ix);
    bubbleUp(nodes, deleted, node_ids, root, slot_ix);
}

/// Remove slot_ix from the rope treap (rotate down to a leaf, then detach), and
/// recompute sizes up the path. Does not touch the slot's data or the pool's
/// len — the caller owns those.
pub fn remove(nodes: []Node, deleted: []const bool, node_ids: []const NodeId, root: *u32, slot_ix: u32) void {
    while (nodes[slot_ix].left != NULL or nodes[slot_ix].right != NULL) {
        const l = nodes[slot_ix].left;
        const r = nodes[slot_ix].right;
        if (r == NULL or (l != NULL and priority(node_ids[l]) > priority(node_ids[r]))) {
            rotateRight(nodes, deleted, root, slot_ix);
        } else {
            rotateLeft(nodes, deleted, root, slot_ix);
        }
    }
    const p = nodes[slot_ix].parent;
    if (p != NULL) {
        if (nodes[p].left == slot_ix) nodes[p].left = NULL else nodes[p].right = NULL;
        updateSizes(nodes, deleted, p);
    } else {
        root.* = NULL;
    }
}

// ═══════════════════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════════════════

pub fn prevTot(nodes: []const Node, slot_ix: u32) u32 {
    if (nodes[slot_ix].left != NULL) {
        var cur = nodes[slot_ix].left;
        while (nodes[cur].right != NULL) cur = nodes[cur].right;
        return cur;
    }
    var cur = slot_ix;
    while (nodes[cur].parent != NULL) {
        const par = nodes[cur].parent;
        if (nodes[par].right == cur) return par;
        cur = par;
    }
    return NULL;
}

pub fn nextTot(nodes: []const Node, slot_ix: u32) u32 {
    if (nodes[slot_ix].right != NULL) {
        var cur = nodes[slot_ix].right;
        while (nodes[cur].left != NULL) cur = nodes[cur].left;
        return cur;
    }
    var cur = slot_ix;
    while (nodes[cur].parent != NULL) {
        const par = nodes[cur].parent;
        if (nodes[par].left == cur) return par;
        cur = par;
    }
    return NULL;
}

fn leftmostVisible(nodes: []const Node, deleted: []const bool, root_ix: u32) u32 {
    var cur = root_ix;
    while (true) {
        const l = nodes[cur].left;
        if (l != NULL and nodes[l].vis_size > 0) {
            cur = l;
            continue;
        }
        if (!deleted[cur]) return cur;
        const r = nodes[cur].right;
        if (r != NULL and nodes[r].vis_size > 0) {
            cur = r;
            continue;
        }
        return NULL;
    }
}

fn rightmostVisible(nodes: []const Node, deleted: []const bool, root_ix: u32) u32 {
    var cur = root_ix;
    while (true) {
        const r = nodes[cur].right;
        if (r != NULL and nodes[r].vis_size > 0) {
            cur = r;
            continue;
        }
        if (!deleted[cur]) return cur;
        const l = nodes[cur].left;
        if (l != NULL and nodes[l].vis_size > 0) {
            cur = l;
            continue;
        }
        return NULL;
    }
}

pub fn prevVis(nodes: []const Node, deleted: []const bool, slot_ix: u32) u32 {
    const l = nodes[slot_ix].left;
    if (l != NULL and nodes[l].vis_size > 0) return rightmostVisible(nodes, deleted, l);
    var cur = slot_ix;
    while (nodes[cur].parent != NULL) {
        const par = nodes[cur].parent;
        if (nodes[par].right == cur) {
            if (!deleted[par]) return par;
            const pl = nodes[par].left;
            if (pl != NULL and nodes[pl].vis_size > 0) return rightmostVisible(nodes, deleted, pl);
        }
        cur = par;
    }
    return NULL;
}

pub fn nextVis(nodes: []const Node, deleted: []const bool, slot_ix: u32) u32 {
    const r = nodes[slot_ix].right;
    if (r != NULL and nodes[r].vis_size > 0) return leftmostVisible(nodes, deleted, r);
    var cur = slot_ix;
    while (nodes[cur].parent != NULL) {
        const par = nodes[cur].parent;
        if (nodes[par].left == cur) {
            if (!deleted[par]) return par;
            const pr = nodes[par].right;
            if (pr != NULL and nodes[pr].vis_size > 0) return leftmostVisible(nodes, deleted, pr);
        }
        cur = par;
    }
    return NULL;
}

// ═══════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════

pub fn height(nodes: []const Node, slot_ix: u32) u32 {
    if (slot_ix == NULL) return 0;
    return 1 + @max(height(nodes, nodes[slot_ix].left), height(nodes, nodes[slot_ix].right));
}
