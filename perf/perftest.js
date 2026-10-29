import Benchmark from "benchmark";
import { Parser } from "n3";
import { Tree } from "../dist/tests/helper.js";
import { TREE } from "@treecg/types";
import { replicateLDES } from "../dist/lib/client.js";
import { intoConfig } from "../dist/lib/config.js";
import { Ldes2Tree } from "./ldes2Tree.js";

// Increase the max listeners to prevent warnings
process.setMaxListeners(35);

let tree = new Tree(
    (x, numb) => {
        if (!numb) {
            return new Parser().parse(`<${x}> <http://example.com/value> 0.`);
        } else {
            return new Parser().parse(`<${x}> <http://example.com/value> ${numb}.`);
        }
    },
    "http://example.com/value",
);

function build_tree(depth, width, delay = 200, member_count = 5) {
    const tree = new Tree(
        (x, numb) => {
            if (!numb) {
                return new Parser().parse(`<${x}> <http://example.com/value> 0.`);
            } else {
                return new Parser().parse(`<${x}> <http://example.com/value> ${numb}.`);
            }
        },
        "http://example.com/value",
    );
    wide_tree(tree, depth, width, tree.root(), 0, delay, member_count);
    return tree;
}

function wide_tree(tree, depth, width, node, member, delay, memberCount) {
    if (depth === 0) return member;

    const newId = tree.newFragment(delay);
    const frag = tree.fragment(newId);
    tree.fragment(node).relation(newId, TREE.Relation);

    for (let i = 0; i < memberCount; i++) {
        frag.addMember("member-" + member, member);
        member += 1;
    }

    for (let i = 0; i < width; i++) {
        member = wide_tree(tree, depth - 1, width, newId, member, delay, memberCount);
    }

    return member;
}

async function bench_it(url = tree.base() + tree.root(), fetch = undefined, expected = undefined) {
    let client = replicateLDES(
        intoConfig({
            url,
            fetcher: { maxFetched: 1, concurrentRequests: 1 },
            mediator: { maxRequests: 1, maxMembers: 1 },
            onlyDefaultGraph: true,
            fetch,
        }),
        undefined,
        undefined,
        "none",
    );

    const stream = client.stream();
    const members = stream.getReader();

    let count = 0;
    let item = await members.read();
    while (item && !item.done) {
        count++;
        item = await members.read();
    }
    // A client that fails to read pages would be fast
    if (expected !== undefined && count !== expected) {
        throw new Error(`Expected ${expected} members, got ${count}`);
    }
    console.log("run finished");
}

// The same pagination in LDES 2.0: pages that are RDF Message logs, which link to their children by the sequence of their members
function build_ldes2(depth, width, delay, member_count) {
    const ldes2 = new Ldes2Tree();
    ldes2.build(depth, width, delay, member_count);
    return ldes2;
}

const deferred = (fn) => ({
    defer: true,
    fn: async function (d) {
        await fn();
        d.resolve();
    },
});

var suite = new Benchmark.Suite();

// 14 pages of 10 members, with a delay of 50 ms per page
tree = build_tree(3, 3, 50, 10);
global.fetch = tree.mock();
const delayed = build_ldes2(3, 3, 50, 10);

// 14 pages of 100 members without a delay: the cost of the client itself
const plain = build_tree(3, 3, 0, 100);
const nodelay = build_ldes2(3, 3, 0, 100);

// add tests
suite
    .add("tree-3-3", deferred(() => bench_it()))
    .add("ldes2-tree-3-3", deferred(() => bench_it(delayed.base() + delayed.root(), delayed.mock(), 130)))
    .add("tree-3-3-nodelay", deferred(() => bench_it(plain.base() + plain.root(), plain.mock(), 1300)))
    .add("ldes2-tree-3-3-nodelay", deferred(() => bench_it(nodelay.base() + nodelay.root(), nodelay.mock(), 1300)))
    // add listeners
    .on("cycle", function (event) {
        console.log(String(event.target));
    })
    .on("complete", function () {
        console.log("Fastest is " + this.filter("fastest").map("name"));
    })
    // run async
    .run({ "async": true });
