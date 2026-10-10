const NodeId = @import("node_id.zig").NodeId;
pub const CompositeId = @import("node_id.zig").CompositeId;
const Side = @import("op.zig").Side;
const TreeT = @import("tree.zig").Tree;

pub const NULL: u32 = 0;

pub const Node = union(enum) {
    insert: struct {
        id: CompositeId,
        len: u32,
        fugue_parent: NodeId,
        side: Side,
        left: u32,
        right: u32,
        parent: u32,
    },
    hide: struct {
        id: CompositeId,
        target: NodeId,
        len: u32,
        left: u32,
        right: u32,
        parent: u32,
    },
    show: struct {
        id: CompositeId,
        target: NodeId,
        len: u32,
        left: u32,
        right: u32,
        parent: u32,
    },

    pub fn compositeId(self: @This()) CompositeId {
        return switch (self) {
            inline else => |o| o.id,
        };
    }

    pub fn groupId(self: @This()) NodeId {
        return self.compositeId().groupId();
    }

    pub fn opId(self: @This()) NodeId {
        return self.compositeId().opId();
    }

    fn treeLeft(self: @This()) u32 {
        return switch (self) {
            inline else => |o| o.left,
        };
    }
    fn treeRight(self: @This()) u32 {
        return switch (self) {
            inline else => |o| o.right,
        };
    }
    fn treeParent(self: @This()) u32 {
        return switch (self) {
            inline else => |o| o.parent,
        };
    }
    fn setLeft(self: *@This(), v: u32) void {
        switch (self.*) {
            inline else => |*o| o.left = v,
        }
    }
    fn setRight(self: *@This(), v: u32) void {
        switch (self.*) {
            inline else => |*o| o.right = v,
        }
    }
    fn setParent(self: *@This(), v: u32) void {
        switch (self.*) {
            inline else => |*o| o.parent = v,
        }
    }
};

const Context = struct {
    pub const Key = CompositeId;
    pub fn key(n: Node) CompositeId {
        return n.compositeId();
    }
    pub fn keyLt(a: CompositeId, b: CompositeId) bool {
        return a.lessThan(b);
    }
    pub fn left(n: Node) u32 {
        return n.treeLeft();
    }
    pub fn right(n: Node) u32 {
        return n.treeRight();
    }
    pub fn parent(n: Node) u32 {
        return n.treeParent();
    }
    pub fn setLeft(n: *Node, v: u32) void {
        n.setLeft(v);
    }
    pub fn setRight(n: *Node, v: u32) void {
        n.setRight(v);
    }
    pub fn setParent(n: *Node, v: u32) void {
        n.setParent(v);
    }
    pub fn priority(n: Node) u32 {
        return @truncate(NodeId.HashContext.hash(.{}, n.opId()));
    }
};

const T = TreeT(Node, Context);

pub fn insert(pool: []Node, len: *u32, root: *u32, node: Node) !u32 {
    return T.insert(pool, len, root, node);
}

/// Floor: largest key <= query. Error.NotFound if query is smaller than all keys.
pub fn find(pool: []const Node, root: u32, key: CompositeId) error{NotFound}!u32 {
    return T.find(pool, root, key);
}

/// Ceiling: smallest key >= query. Error.NotFound if query is larger than all keys.
pub fn ceiling(pool: []const Node, root: u32, key: CompositeId) error{NotFound}!u32 {
    return T.ceiling(pool, root, key);
}

pub fn next(pool: []const Node, ix: u32) error{End}!u32 {
    return T.next(pool, ix);
}

/// Remove the node with the given CompositeId key, if present. Shrinks the pool
/// when the removed node was the last-allocated one (reverse-order revert).
pub fn remove(pool: []Node, len: *u32, root: *u32, key: CompositeId) void {
    const ix = T.find(pool, root.*, key) catch return;
    T.remove(pool, root, ix);
    if (ix == len.* - 1) len.* -= 1;
}
