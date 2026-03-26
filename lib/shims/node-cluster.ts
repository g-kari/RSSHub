// Worker-specific shim for node:cluster
// cluster module is not available in Cloudflare Workers; signal non-cluster environment

const cluster = {
    isWorker: false,
    isPrimary: true,
    isMaster: true,
    workers: {} as Record<string, unknown>,
    fork: (): never => {
        throw new Error('cluster.fork is not supported in Cloudflare Workers');
    },
    disconnect: (): never => {
        throw new Error('cluster.disconnect is not supported in Cloudflare Workers');
    },
    setupPrimary: (): never => {
        throw new Error('cluster.setupPrimary is not supported in Cloudflare Workers');
    },
    setupMaster: (): never => {
        throw new Error('cluster.setupMaster is not supported in Cloudflare Workers');
    },
    on: () => cluster,
    once: () => cluster,
    emit: () => false,
    removeListener: () => cluster,
};

export default cluster;
export const { isWorker, isPrimary, isMaster, workers, fork, disconnect, setupPrimary, setupMaster, on, once, emit, removeListener } = cluster;
