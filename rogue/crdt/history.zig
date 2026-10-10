const std = @import("std");
const NodeId = @import("node_id.zig").NodeId;
const TreeT = @import("tree.zig").Tree;
const ContentAddress = @import("content_address.zig").ContentAddress;

pub const NULL: u32 = 0;

pub const Node = struct {
    id: NodeId,
    left: u32,
    right: u32,
    parent: u32,
    visible: bool,
};

const Context = struct {
    pub const Key = NodeId;
    pub fn key(n: Node) NodeId {
        return n.id;
    }
    pub fn keyLt(a: NodeId, b: NodeId) bool {
        return a.lessThan(b);
    }
    pub fn left(n: Node) u32 {
        return n.left;
    }
    pub fn right(n: Node) u32 {
        return n.right;
    }
    pub fn parent(n: Node) u32 {
        return n.parent;
    }
    pub fn setLeft(n: *Node, v: u32) void {
        n.left = v;
    }
    pub fn setRight(n: *Node, v: u32) void {
        n.right = v;
    }
    pub fn setParent(n: *Node, v: u32) void {
        n.parent = v;
    }
    pub fn priority(n: Node) u32 {
        return @truncate(NodeId.HashContext.hash(.{}, n.id));
    }
};

const T = TreeT(Node, Context);

pub fn insert(nodes: []Node, len: *u32, root: *u32, id: NodeId, visible: bool) !void {
    _ = try T.insert(nodes, len, root, .{
        .id = id,
        .visible = visible,
        .left = NULL,
        .right = NULL,
        .parent = NULL,
    });
}

/// Remove the entry with the given op id from the tree, if present. Shrinks the
/// pool when the removed entry was the last-allocated node — true for a reverse-
/// order revert, where entries are removed newest-first.
pub fn removeById(nodes: []Node, len: *u32, root: *u32, id: NodeId) void {
    const ix = T.find(nodes, root.*, id) catch return;
    T.remove(nodes, root, ix);
    if (ix == len.* - 1) len.* -= 1;
}

/// Current visibility: the flag of the highest-id entry (last writer wins by op
/// id). The treap is keyed by NodeId, so the max id is the rightmost node. Returns
/// null when there is no entry yet — the char has never been hidden or shown, so
/// it is visible by default. Order-independent: the winner is a function of the
/// entry set, not of insertion order.
pub fn curVis(nodes: []Node, root: u32) ?bool {
    if (root == NULL) return null;
    var ix = root;
    while (nodes[ix].right != NULL) ix = nodes[ix].right;
    return nodes[ix].visible;
}

/// Returns the visibility state at a content address.
/// Floors on the highest NodeId covered by addr, then walks left until finding
/// the most recent history entry covered by addr.
/// Returns true (visible) if no covered entry exists.
pub fn visibleAt(nodes: []Node, root: u32, addr: *ContentAddress) bool {
    const max_id = addr.maxNodeId();
    if (max_id.isNull()) return true;
    var ix = T.find(nodes, root, max_id) catch return true;
    while (true) {
        if (addr.includes(nodes[ix].id)) return nodes[ix].visible;
        ix = T.prev(nodes, ix) catch return true;
    }
}

/// Advance `addr` (a {replica: max_seq} version vector) with every entry id in
/// this history treap. The caller additionally advances with the char's own
/// (insert) id, which lives outside the history treap.
pub fn advanceAddr(nodes: []Node, root: u32, addr: *ContentAddress, allocator: std.mem.Allocator) !void {
    if (root == NULL) return;
    var ix = root;
    while (nodes[ix].left != NULL) ix = nodes[ix].left;
    while (true) {
        const id = nodes[ix].id;
        try addr.advance(allocator, id.replica_id, id.sequence);
        ix = T.next(nodes, ix) catch break;
    }
}
