const std = @import("std");

pub const NULL: u32 = 0;

/// Generic treap over a flat pool of nodes.
///
/// `Context` must provide:
///   const Key: type
///   fn key(node: Node) Key          -- extract BST key from node
///   fn keyLt(a: Key, b: Key) bool   -- strict total order on Key
///   fn left(node: Node) u32
///   fn right(node: Node) u32
///   fn parent(node: Node) u32
///   fn setLeft(node: *Node, v: u32) void
///   fn setRight(node: *Node, v: u32) void
///   fn setParent(node: *Node, v: u32) void
///   fn priority(node: Node) u32     -- heap priority (higher = closer to root)
///
/// Pool slot 0 is the NULL sentinel and must never hold a real node.
pub fn Tree(comptime Node: type, comptime Context: type) type {
    return struct {
        /// Rotate right: y moves down, x (y's left child) moves up.
        pub fn rotateRight(pool: []Node, root: *u32, y_ix: u32) void {
            const x_ix = Context.left(pool[y_ix]);
            const p_ix = Context.parent(pool[y_ix]);

            Context.setLeft(&pool[y_ix], Context.right(pool[x_ix]));
            if (Context.right(pool[x_ix]) != NULL)
                Context.setParent(&pool[Context.right(pool[x_ix])], y_ix);

            Context.setRight(&pool[x_ix], y_ix);
            Context.setParent(&pool[y_ix], x_ix);
            Context.setParent(&pool[x_ix], p_ix);

            if (p_ix != NULL) {
                if (Context.left(pool[p_ix]) == y_ix)
                    Context.setLeft(&pool[p_ix], x_ix)
                else
                    Context.setRight(&pool[p_ix], x_ix);
            } else {
                root.* = x_ix;
            }
        }

        /// Rotate left: x moves down, y (x's right child) moves up.
        pub fn rotateLeft(pool: []Node, root: *u32, x_ix: u32) void {
            const y_ix = Context.right(pool[x_ix]);
            const p_ix = Context.parent(pool[x_ix]);

            Context.setRight(&pool[x_ix], Context.left(pool[y_ix]));
            if (Context.left(pool[y_ix]) != NULL)
                Context.setParent(&pool[Context.left(pool[y_ix])], x_ix);

            Context.setLeft(&pool[y_ix], x_ix);
            Context.setParent(&pool[x_ix], y_ix);
            Context.setParent(&pool[y_ix], p_ix);

            if (p_ix != NULL) {
                if (Context.left(pool[p_ix]) == x_ix)
                    Context.setLeft(&pool[p_ix], y_ix)
                else
                    Context.setRight(&pool[p_ix], y_ix);
            } else {
                root.* = y_ix;
            }
        }

        /// Restore heap property by rotating ix upward until priority is satisfied.
        pub fn bubbleUp(pool: []Node, root: *u32, ix: u32) void {
            while (Context.parent(pool[ix]) != NULL) {
                const p = Context.parent(pool[ix]);
                if (Context.priority(pool[ix]) <= Context.priority(pool[p])) break;
                if (Context.left(pool[p]) == ix)
                    rotateRight(pool, root, p)
                else
                    rotateLeft(pool, root, p);
            }
            if (Context.parent(pool[ix]) == NULL) root.* = ix;
        }

        /// Store node in pool[len.*], zero its link fields, and link into treap.
        /// pool.len is the capacity. Returns error.OutOfMemory if full.
        pub fn insert(pool: []Node, len: *u32, root: *u32, node: Node) error{OutOfMemory}!u32 {
            if (len.* >= pool.len) return error.OutOfMemory;
            const ix = len.*;
            len.* += 1;
            pool[ix] = node;
            Context.setLeft(&pool[ix], NULL);
            Context.setRight(&pool[ix], NULL);
            Context.setParent(&pool[ix], NULL);
            link(pool, root, ix);
            return ix;
        }

        /// BST-insert new_ix (must have left/right/parent = NULL) then restore heap.
        pub fn link(pool: []Node, root: *u32, new_ix: u32) void {
            const new_key = Context.key(pool[new_ix]);
            if (root.* == NULL) {
                root.* = new_ix;
                return;
            }
            var cur_ix = root.*;
            while (true) {
                if (Context.keyLt(new_key, Context.key(pool[cur_ix]))) {
                    if (Context.left(pool[cur_ix]) == NULL) {
                        Context.setLeft(&pool[cur_ix], new_ix);
                        Context.setParent(&pool[new_ix], cur_ix);
                        break;
                    }
                    cur_ix = Context.left(pool[cur_ix]);
                } else {
                    if (Context.right(pool[cur_ix]) == NULL) {
                        Context.setRight(&pool[cur_ix], new_ix);
                        Context.setParent(&pool[new_ix], cur_ix);
                        break;
                    }
                    cur_ix = Context.right(pool[cur_ix]);
                }
            }
            bubbleUp(pool, root, new_ix);
        }

        /// Remove slot_ix from the treap. Does not decrement len — the caller owns
        /// pool compaction. Rotates ix down to a leaf (always promoting the
        /// higher-priority child) then detaches it.
        pub fn remove(pool: []Node, root: *u32, ix: u32) void {
            while (Context.left(pool[ix]) != NULL or Context.right(pool[ix]) != NULL) {
                const l = Context.left(pool[ix]);
                const r = Context.right(pool[ix]);
                if (r == NULL or (l != NULL and Context.priority(pool[l]) > Context.priority(pool[r]))) {
                    rotateRight(pool, root, ix);
                } else {
                    rotateLeft(pool, root, ix);
                }
            }
            const p = Context.parent(pool[ix]);
            if (p != NULL) {
                if (Context.left(pool[p]) == ix)
                    Context.setLeft(&pool[p], NULL)
                else
                    Context.setRight(&pool[p], NULL);
            } else {
                root.* = NULL;
            }
        }

        /// Floor: returns the slot_ix with the largest key <= query.
        /// Returns exact match if present, otherwise the largest predecessor.
        /// Error.NotFound if query is smaller than all keys in the tree.
        pub fn find(pool: []const Node, root: u32, query: Context.Key) error{NotFound}!u32 {
            var cur_ix = root;
            var best_ix: u32 = NULL;
            while (cur_ix != NULL) {
                const node_key = Context.key(pool[cur_ix]);
                if (Context.keyLt(node_key, query)) {
                    best_ix = cur_ix;
                    cur_ix = Context.right(pool[cur_ix]);
                } else if (Context.keyLt(query, node_key)) {
                    cur_ix = Context.left(pool[cur_ix]);
                } else {
                    return cur_ix;
                }
            }
            if (best_ix == NULL) return error.NotFound;
            return best_ix;
        }

        /// Ceiling: returns the slot_ix with the smallest key >= query.
        /// Returns exact match if present, otherwise the smallest successor.
        /// Error.NotFound if query is larger than all keys in the tree.
        pub fn ceiling(pool: []const Node, root: u32, query: Context.Key) error{NotFound}!u32 {
            var cur_ix = root;
            var best_ix: u32 = NULL;
            while (cur_ix != NULL) {
                const node_key = Context.key(pool[cur_ix]);
                if (Context.keyLt(query, node_key)) {
                    best_ix = cur_ix;
                    cur_ix = Context.left(pool[cur_ix]);
                } else if (Context.keyLt(node_key, query)) {
                    cur_ix = Context.right(pool[cur_ix]);
                } else {
                    return cur_ix;
                }
            }
            if (best_ix == NULL) return error.NotFound;
            return best_ix;
        }

        /// In-order next of slot_ix. Error.End if slot_ix is the last node.
        pub fn next(pool: []const Node, slot_ix: u32) error{End}!u32 {
            if (Context.right(pool[slot_ix]) != NULL) {
                var x = Context.right(pool[slot_ix]);
                while (Context.left(pool[x]) != NULL) x = Context.left(pool[x]);
                return x;
            }
            var x = slot_ix;
            var p = Context.parent(pool[x]);
            while (p != NULL and Context.right(pool[p]) == x) {
                x = p;
                p = Context.parent(pool[x]);
            }
            if (p == NULL) return error.End;
            return p;
        }

        /// In-order prev of slot_ix. Error.Start if slot_ix is the first node.
        pub fn prev(pool: []const Node, slot_ix: u32) error{Start}!u32 {
            if (Context.left(pool[slot_ix]) != NULL) {
                var x = Context.left(pool[slot_ix]);
                while (Context.right(pool[x]) != NULL) x = Context.right(pool[x]);
                return x;
            }
            var x = slot_ix;
            var p = Context.parent(pool[x]);
            while (p != NULL and Context.left(pool[p]) == x) {
                x = p;
                p = Context.parent(pool[x]);
            }
            if (p == NULL) return error.Start;
            return p;
        }
    };
}

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

const TestNode = struct {
    key: u32,
    priority: u32,
    left: u32 = NULL,
    right: u32 = NULL,
    parent: u32 = NULL,
};

const TestCtx = struct {
    pub const Key = u32;
    pub fn key(n: TestNode) Key {
        return n.key;
    }
    pub fn keyLt(a: Key, b: Key) bool {
        return a < b;
    }
    pub fn left(n: TestNode) u32 {
        return n.left;
    }
    pub fn right(n: TestNode) u32 {
        return n.right;
    }
    pub fn parent(n: TestNode) u32 {
        return n.parent;
    }
    pub fn setLeft(n: *TestNode, v: u32) void {
        n.left = v;
    }
    pub fn setRight(n: *TestNode, v: u32) void {
        n.right = v;
    }
    pub fn setParent(n: *TestNode, v: u32) void {
        n.parent = v;
    }
    pub fn priority(n: TestNode) u32 {
        return n.priority;
    }
};

const T = Tree(TestNode, TestCtx);

/// Build a 5-node pool with keys {3,1,4,2,5} and priorities {10,5,8,3,6}.
/// Inserting in pool order gives this tree:
///
///          [1] key=3 prio=10
///          /           \
///    [2] key=1 prio=5   [3] key=4 prio=8
///          \                  \
///    [4] key=2 prio=3    [5] key=5 prio=6
///
/// In-order: 1,2,3,4,5 (slot indices: 2,4,1,3,5)
fn buildPool() [6]TestNode {
    return .{
        .{ .key = 0, .priority = 0 }, // slot 0: NULL sentinel
        .{ .key = 3, .priority = 10 },
        .{ .key = 1, .priority = 5 },
        .{ .key = 4, .priority = 8 },
        .{ .key = 2, .priority = 3 },
        .{ .key = 5, .priority = 6 },
    };
}

fn buildTree() struct { pool: [6]TestNode, root: u32 } {
    var pool = buildPool();
    var root: u32 = NULL;
    for (1..6) |i| T.link(&pool, &root, @intCast(i));
    return .{ .pool = pool, .root = root };
}

fn inorder(pool: []const TestNode, ix: u32, out: *[5]u32, pos: *usize) void {
    if (ix == NULL) return;
    inorder(pool, pool[ix].left, out, pos);
    out[pos.*] = pool[ix].key;
    pos.* += 1;
    inorder(pool, pool[ix].right, out, pos);
}

test "insert: BST ordering preserved" {
    const t = buildTree();
    var keys: [5]u32 = undefined;
    var pos: usize = 0;
    inorder(&t.pool, t.root, &keys, &pos);
    try std.testing.expectEqualSlices(u32, &[_]u32{ 1, 2, 3, 4, 5 }, &keys);
}

test "insert: heap property holds" {
    const t = buildTree();
    // Every node's priority >= its children's priorities.
    for (1..6) |i| {
        const l = t.pool[i].left;
        const r = t.pool[i].right;
        if (l != NULL) try std.testing.expect(t.pool[i].priority >= t.pool[l].priority);
        if (r != NULL) try std.testing.expect(t.pool[i].priority >= t.pool[r].priority);
    }
}

test "insert: root has highest priority" {
    const t = buildTree();
    // The root should be the node with the highest priority (slot 1, prio=10).
    try std.testing.expectEqual(@as(u32, 1), t.root);
}

test "insert: bubble up triggers rotation" {
    // Two nodes: first key=5 prio=1, then key=3 prio=9.
    // After BST insert, key=3 is left child of key=5.
    // BubbleUp should rotate right, making key=3 the root.
    var pool = [3]TestNode{
        .{ .key = 0, .priority = 0 }, // NULL
        .{ .key = 5, .priority = 1 },
        .{ .key = 3, .priority = 9 },
    };
    var root: u32 = NULL;
    T.link(&pool, &root, 1);
    T.link(&pool, &root, 2);
    try std.testing.expectEqual(@as(u32, 2), root); // key=3 is root
    try std.testing.expectEqual(@as(u32, 1), pool[2].right); // key=5 is right child
    try std.testing.expectEqual(@as(u32, NULL), pool[2].left);
}

test "find: exact match" {
    const t = buildTree();
    const ix = try T.find(&t.pool, t.root, 3);
    try std.testing.expectEqual(@as(u32, 3), t.pool[ix].key);
}

test "find: floor (between keys)" {
    const t = buildTree();
    // Query 6: all keys <= 6, floor is key=5 (slot 5).
    const ix = try T.find(&t.pool, t.root, 6);
    try std.testing.expectEqual(@as(u32, 5), t.pool[ix].key);
}

test "find: floor picks closest predecessor" {
    // Query between 20 and 30 in a pool with keys 10,20,30.
    var pool = [4]TestNode{
        .{ .key = 0, .priority = 0 },
        .{ .key = 10, .priority = 9 },
        .{ .key = 20, .priority = 5 },
        .{ .key = 30, .priority = 7 },
    };
    var root: u32 = NULL;
    for (1..4) |i| T.link(&pool, &root, @intCast(i));
    const ix = try T.find(&pool, root, 25);
    try std.testing.expectEqual(@as(u32, 20), pool[ix].key);
}

test "find: NotFound when query smaller than all keys" {
    const t = buildTree();
    try std.testing.expectError(error.NotFound, T.find(&t.pool, t.root, 0));
}

test "ceiling: exact match" {
    const t = buildTree();
    const ix = try T.ceiling(&t.pool, t.root, 4);
    try std.testing.expectEqual(@as(u32, 4), t.pool[ix].key);
}

test "ceiling: smallest successor" {
    var pool = [4]TestNode{
        .{ .key = 0, .priority = 0 },
        .{ .key = 10, .priority = 9 },
        .{ .key = 20, .priority = 5 },
        .{ .key = 30, .priority = 7 },
    };
    var root: u32 = NULL;
    for (1..4) |i| T.link(&pool, &root, @intCast(i));
    const ix = try T.ceiling(&pool, root, 25);
    try std.testing.expectEqual(@as(u32, 30), pool[ix].key);
}

test "ceiling: NotFound when query larger than all keys" {
    const t = buildTree();
    try std.testing.expectError(error.NotFound, T.ceiling(&t.pool, t.root, 6));
}

test "next: walks in-order" {
    const t = buildTree();
    // In-order: slots 2(k=1), 4(k=2), 1(k=3), 3(k=4), 5(k=5)
    const expected_keys = [_]u32{ 2, 3, 4, 5 };
    var cur: u32 = 2; // start at key=1
    for (expected_keys) |expected_key| {
        cur = try T.next(&t.pool, cur);
        try std.testing.expectEqual(expected_key, t.pool[cur].key);
    }
}

test "next: End error at last node" {
    const t = buildTree();
    try std.testing.expectError(error.End, T.next(&t.pool, 5)); // slot 5 = key=5 (last)
}

test "prev: walks in reverse order" {
    const t = buildTree();
    // In-order reverse: slots 5(k=5), 3(k=4), 1(k=3), 4(k=2), 2(k=1)
    const expected_keys = [_]u32{ 4, 3, 2, 1 };
    var cur: u32 = 5; // start at key=5
    for (expected_keys) |expected_key| {
        cur = try T.prev(&t.pool, cur);
        try std.testing.expectEqual(expected_key, t.pool[cur].key);
    }
}

test "prev: Start error at first node" {
    const t = buildTree();
    try std.testing.expectError(error.Start, T.prev(&t.pool, 2)); // slot 2 = key=1 (first)
}

test "rotateRight: correct shape" {
    //   y(2)          x(1)
    //   /      ->         \
    //  x(1)              y(2)
    var pool = [3]TestNode{
        .{ .key = 0, .priority = 0 },
        .{ .key = 1, .priority = 0 },
        .{ .key = 2, .priority = 0 },
    };
    // Manually wire: root=2, 2.left=1
    pool[2].left = 1;
    pool[1].parent = 2;
    var root: u32 = 2;
    T.rotateRight(&pool, &root, 2);
    try std.testing.expectEqual(@as(u32, 1), root);
    try std.testing.expectEqual(@as(u32, 2), pool[1].right);
    try std.testing.expectEqual(@as(u32, NULL), pool[1].left);
    try std.testing.expectEqual(@as(u32, NULL), pool[2].left);
}

test "rotateLeft: correct shape" {
    //  x(1)               y(2)
    //      \     ->       /
    //      y(2)          x(1)
    var pool = [3]TestNode{
        .{ .key = 0, .priority = 0 },
        .{ .key = 1, .priority = 0 },
        .{ .key = 2, .priority = 0 },
    };
    pool[1].right = 2;
    pool[2].parent = 1;
    var root: u32 = 1;
    T.rotateLeft(&pool, &root, 1);
    try std.testing.expectEqual(@as(u32, 2), root);
    try std.testing.expectEqual(@as(u32, 1), pool[2].left);
    try std.testing.expectEqual(@as(u32, NULL), pool[2].right);
    try std.testing.expectEqual(@as(u32, NULL), pool[1].right);
}

fn treeHeight(pool: []const TestNode, ix: u32) u32 {
    if (ix == NULL) return 0;
    return 1 + @max(treeHeight(pool, pool[ix].left), treeHeight(pool, pool[ix].right));
}

test "stress: 1M random inserts" {
    const n: u32 = 1_000_000;

    const pool = try std.testing.allocator.alloc(TestNode, n + 1);
    defer std.testing.allocator.free(pool);
    pool[0] = .{ .key = 0, .priority = 0 };

    var prng = std.Random.DefaultPrng.init(42);
    const rand = prng.random();
    for (1..n + 1) |i| {
        pool[i] = .{
            .key = rand.int(u32),
            .priority = rand.int(u32),
            .left = NULL,
            .right = NULL,
            .parent = NULL,
        };
    }

    var root: u32 = NULL;
    var timer = try std.time.Timer.start();
    for (1..n + 1) |i| T.link(pool, &root, @intCast(i));
    const ns = timer.read();
    std.debug.print("1M inserts: {}ms ({} ns/op)\n", .{
        ns / std.time.ns_per_ms,
        ns / n,
    });

    // Heap property: every parent's priority >= its children's.
    for (1..n + 1) |i| {
        const l = pool[i].left;
        const r = pool[i].right;
        if (l != NULL) try std.testing.expect(pool[i].priority >= pool[l].priority);
        if (r != NULL) try std.testing.expect(pool[i].priority >= pool[r].priority);
    }

    // Height is O(log n).
    const h = treeHeight(pool, root);
    const log2n: u32 = @intFromFloat(@log2(@as(f64, @floatFromInt(n))));
    std.debug.print("height: {}, log2(n): {}\n", .{ h, log2n });
    try std.testing.expect(h <= 5 * log2n);

    // Successor walk: visit all n nodes in non-decreasing key order.
    var cur: u32 = root;
    while (pool[cur].left != NULL) cur = pool[cur].left; // find minimum
    var count: u32 = 1;
    while (true) {
        const nxt = T.next(pool, cur) catch break;
        try std.testing.expect(pool[nxt].key >= pool[cur].key);
        cur = nxt;
        count += 1;
    }
    try std.testing.expectEqual(n, count);

    // Predecessor walk from maximum: visit all n nodes in non-increasing key order.
    // cur is already at the maximum after the successor walk above.
    count = 1;
    while (true) {
        const prv = T.prev(pool, cur) catch break;
        try std.testing.expect(pool[prv].key <= pool[cur].key);
        cur = prv;
        count += 1;
    }
    try std.testing.expectEqual(n, count);
}
