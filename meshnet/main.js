#!env -S deno run

import Network from './Network.js';
import Protocol from './Protocol.js';

const sum = list => list.reduce((s, x) => s + x, 0);
const mean = list => sum(list) / list.length;
const sketch = list => {
    const mean1 = mean(list);
    const mean2 = mean(list.map(x => x ** 2));
    const stddev = Math.sqrt(mean2 - mean1 ** 2);
    const min = list.reduce((s, x) => Math.min(s, x), Infinity);
    const max = list.reduce((s, x) => Math.max(s, x), -Infinity);
    return [mean1, stddev, min, max].map(x => Math.round(x * 1e3) / 1e3);
};

const run = async options => {
    Object.assign(options, {
        batch: true, reHop: 'mean', reRep: 'max', updateContactsOnly: true,
        graph: 'WS', beta: 0.5,
        send: 'poisson',
        pMove: 1,
        dLink: 1,
    });

    const net = new Network([options.size, options.size], options.number);
    const prot = new Protocol(options.nHop, options.nRep, options.batch, options.reHop, options.reRep, options.updateContactsOnly);

    const graph = net.getSocialGraph(options.graph, options.pDeg, options.beta);

    const msgIds = await net.run(prot, graph, options.T, options.send, options.pSend, options.pMove, options.dMove, options.dLink);
    const {log} = prot;

    const encsRecvAll = log.recvDetail.map(message => message.encs);
    const encsRecv = new Set(encsRecvAll.flat());

    const stat = {
        'Sent': msgIds.length,
        '- Received': log.recv.size,
        '- Delivery rate': Math.round(log.recv.size / msgIds.length * 1e3) / 1e3,
        '- Reaching hop limit': msgIds.filter(id => !log.recv.has(id) && log.drop.has(id)).length,
        '- Still on the way': msgIds.filter(id => !log.recv.has(id) && !log.drop.has(id)).length,
        'Hop number': sketch(log.recvDetail.map(message => message.hops.length)),
        'Latency': sketch(log.recvDetail.map(message => message.tRecv - message.tSend)),
        'Re-encryption number': log.encs.length,
        '- Number for received': encsRecv.size,
        '- Number per received': sketch(encsRecvAll.map(encs => encs.length)),
        // 'Re-encryption batch size': sketch(log.encs.map(enc => enc.size)),
        // '- Batch size for received': sketch(Array.from(encsRecv, enc => enc.size)),
    };

    console.log(stat);
};

// await run({size: 20, number:  250, nHop: 10, nRep: 20, pDeg: 0.1, T: 100, pSend: 5, dMove: 1});
// await run({size: 20, number: 1000, nHop:  5, nRep:  5, pDeg: 0.1, T: 100, pSend: 5, dMove: 5});
// await run({size: 20, number:   50, nHop: 10, nRep: 25, pDeg: 0.1, T: 100, pSend: 5, dMove: 5});
