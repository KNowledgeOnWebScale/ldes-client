import Benchmark from "benchmark";
import { Parser } from "n3";
import { Tree } from "../dist/tests/helper.js";
import { TREE } from "@treecg/types";
import { replicateLDES } from "../dist/lib/client.js";
import { intoConfig } from "../dist/lib/config.js";

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
    tree = new Tree(
        (x, numb) => {
            if (!numb) {
                return new Parser().parse(`<${x}> <http://example.com/value> 0.`);
            } else {
                return new Parser().parse(`<${x}> <http://example.com/value> ${numb}.`);
            }
        },
        "http://example.com/value",
    );
    wide_tree(depth, width, tree.root(), 0, delay, member_count);
}

function wide_tree(depth, width, node, member, delay, memberCount) {
    if (depth === 0) return member;

    const newId = tree.newFragment(delay);
    const frag = tree.fragment(newId);
    tree.fragment(node).relation(newId, TREE.Relation);

    for (let i = 0; i < memberCount; i++) {
        frag.addMember("member-" + member, member);
        member += 1;
    }

    for (let i = 0; i < width; i++) {
        member = wide_tree(depth - 1, width, newId, member, delay, memberCount);
    }

    return member;
}

async function bench_it() {
    let client = replicateLDES(
        intoConfig({
            url: tree.base() + tree.root(),
            fetcher: { maxFetched: 1, concurrentRequests: 1 },
            mediator: { maxRequests: 1, maxMembers: 1 },
            onlyDefaultGraph: true,
        }),
        undefined,
        undefined,
        "none",
    );

    const stream = client.stream();
    const members = stream.getReader();

    let item = await members.read();
    while (item && !item.done) {
        item = await members.read();
    }
    console.log("run finished");
}

var suite = new Benchmark.Suite();

build_tree(3, 3, 50, 10);
global.fetch = tree.mock();

// add tests
suite.add("tree-3-3", {
    defer: true,

    fn: async function (deferred) {
        await bench_it();
        deferred.resolve();
    },
})
    // add listeners
    .on("cycle", function (event) {
        console.log(String(event.target));
    })
    .on("complete", function () {
        console.log("Fastest is " + this.filter("fastest").map("name"));
    })
    // run async
    .run({ "async": true });
