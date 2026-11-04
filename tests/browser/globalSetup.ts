import { fastify, type FastifyInstance, type FastifyReply, type FastifyRequest, RequestPayload } from "fastify";
import { fastifyStatic } from "@fastify/static";
import path from "path";
import { streamToString } from "../../lib/utils";

let server: FastifyInstance | undefined;

export async function setup() {
    console.log(`[GlobalSetup] Running setup in pid ${process.pid}`);
    if (server) {
        console.log("[GlobalSetup] Server already running, skipping setup");
        return;
    }
    // Setup mock http server
    try {
        server = fastify();
        await server.register(import("@fastify/cors"));
        // Serve from the same data directory as the Node tests
        server.register(fastifyStatic, {
            root: path.join(__dirname, "../data/mock-ldes"),
        });

        server.addHook(
            "onSend",
            async (request: FastifyRequest, reply: FastifyReply, payload: RequestPayload) => {
                const st = await streamToString(payload);

                if (st.startsWith("# delay ")) {
                    const reg = /# delay (?<delay>[0-9]+)/;
                    const found = st.match(reg);
                    const delay = found?.groups && found?.groups["delay"];
                    if (delay) {
                        try {
                            const delayInt = parseInt(delay);
                            await new Promise((res) =>
                                setTimeout(res, delayInt),
                            );
                        } catch (ex: unknown) {
                            /* empty */
                        }
                    }
                }
                if (st.startsWith("# immutable")) {
                    reply.header("Cache-Control", "immutable");
                }
                return st;
            },
        );

        await server.listen({ port: 3042 });
        console.log(
            `Mock server listening on ${server.addresses()[0].port}`,
        );
    } catch (err) {
        console.error("Failed to start mock server", err);
        process.exit(1);
    }
}

export async function teardown() {
    if (server) {
        await server.close();
    }
}