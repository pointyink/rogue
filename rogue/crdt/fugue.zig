const NodeId = @import("node_id.zig").NodeId;

pub const NULL: u32 = 0;

pub const Node = struct {
    left_head: u32,
    right_head: u32,
    next_sibling: u32,
};

/// Insert `new_ix` into the sibling list at `head_ptr`, maintaining ascending NodeId order
/// (head = smallest, tail = largest). Returns the prev sibling (the one with id just less
/// than new_id), or NULL if new_ix becomes the new head.
///
/// Sibling invariant: smaller NodeId sits closer to the parent. Because Left children grow
/// leftward from the parent and Right children grow rightward, what "closer to parent"
/// means in doc order differs by side:
///
///   - Right children: ascending NodeId list order matches doc order. Head (smallest) is
///     immediately right of parent; tail (largest) is rightmost. Walking head→tail = doc
///     left-to-right.
///   - Left children: ascending NodeId list order is REVERSE doc order. Head (smallest)
///     is immediately left of parent; tail (largest) is leftmost. Walking head→tail =
///     doc right-to-left.
///
/// Callers placing the new node in the rope must account for this — see `doInsertOne` in
/// rogue.zig where the Left case mirrors the Right case via leftmostDescendant + ropePrevTot.
pub fn siblingInsert(fugue: []Node, node_ids: []const NodeId, head_ptr: *u32, new_id: NodeId, new_ix: u32) u32 {
    var prev_ix: u32 = NULL;
    var cur_ix = head_ptr.*;
    while (cur_ix != NULL and node_ids[cur_ix].lessThan(new_id)) {
        prev_ix = cur_ix;
        cur_ix = fugue[cur_ix].next_sibling;
    }
    fugue[new_ix].next_sibling = cur_ix;
    if (prev_ix == NULL) head_ptr.* = new_ix else fugue[prev_ix].next_sibling = new_ix;
    return prev_ix;
}

/// Unlink `slot_ix` from the sibling list at `head_ptr`. Assumes slot_ix is present.
pub fn siblingRemove(fugue: []Node, head_ptr: *u32, slot_ix: u32) void {
    var prev_ix: u32 = NULL;
    var cur_ix = head_ptr.*;
    while (cur_ix != NULL) {
        if (cur_ix == slot_ix) {
            if (prev_ix == NULL) head_ptr.* = fugue[cur_ix].next_sibling else fugue[prev_ix].next_sibling = fugue[cur_ix].next_sibling;
            return;
        }
        prev_ix = cur_ix;
        cur_ix = fugue[cur_ix].next_sibling;
    }
}

/// Descend via left_head chains to find the leftmost-in-doc node of slot_ix's subtree.
///
/// Left-children of any node sit to the LEFT of that node in doc, so the leftmost left-child
/// is the one furthest from its parent. Per the sibling invariant (smaller id = closer to
/// parent), that's the LARGEST id at each level — which is the tail of the ascending sibling
/// list, hence the "take last sibling" walk.
pub fn leftmostDescendant(fugue: []const Node, slot_ix: u32) u32 {
    var cur = slot_ix;
    while (true) {
        var last: u32 = NULL;
        var sib = fugue[cur].left_head;
        while (sib != NULL) {
            last = sib;
            sib = fugue[sib].next_sibling;
        }
        if (last == NULL) return cur;
        cur = last;
    }
}

/// Descend via right_head chains to find the rightmost-in-doc node of slot_ix's subtree.
///
/// Right-children of any node sit to the RIGHT of that node in doc, so the rightmost right-
/// child is the one furthest from its parent. Per the sibling invariant (smaller id = closer
/// to parent), that's the LARGEST id at each level — the tail of the ascending sibling list,
/// hence the "take last sibling" walk.
pub fn rightmostDescendant(fugue: []const Node, slot_ix: u32) u32 {
    var cur = slot_ix;
    while (true) {
        var last: u32 = NULL;
        var sib = fugue[cur].right_head;
        while (sib != NULL) {
            last = sib;
            sib = fugue[sib].next_sibling;
        }
        if (last == NULL) return cur;
        cur = last;
    }
}
