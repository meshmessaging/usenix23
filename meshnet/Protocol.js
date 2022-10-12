class DefaultMap extends Map {
    constructor(def) {
        super();
        this.def = def;
    }
    get(key) {
        if (this.has(key)) {
            return super.get(key);
        }
        const value = this.def(key);
        this.set(key, value);
        return value;
    }
}

const reducer = {
    max: list => list.reduce((s, x) => Math.min(s, x), Infinity),
    mean: list => list.reduce((s, x) => s + x, 0) / list.length,
    min: list => list.reduce((s, x) => Math.max(s, x), -Infinity),
    // @Note: swapped max and min due to counting consumed part
};

const split = function * (limit, ...lists) {
    const listRef = lists[0];
    if (listRef.length <= limit) {
        yield lists;
    }
    for (let start = 0; start < listRef.length; start += limit) {
        const size = Math.min(limit, listRef.length - start);
        yield lists.map(list => list.slice(start, start + size));
    }
};

class Protocol {
    constructor(nHop, nRep, useBatch, encHop, encRep, isContactsOnly) {
        this.nHop = nHop;
        this.nRep = nRep;
        this.maxBatch = useBatch ? Infinity : 1;
        this.getEncHop = reducer[encHop];
        this.getEncRep = reducer[encRep];
        this.isContactsOnly = isContactsOnly;

        this.userSessions = new DefaultMap(_ => new Set());
        this.userMessages = new DefaultMap(_ => new Map());
        this.userPendingMessages = new DefaultMap(_ => new Map());
        this.userFilter = new DefaultMap(_ => new Set());
        this.userEncFilter = new DefaultMap(_ => new Set());
        this.userRecvFilter = new DefaultMap(_ => new Set());
        this.log = {recv: new Set(), recvDetail: [], drop: new Set(), encs: []};
    }

    store(user, id, entry) {
        const messages = this.userMessages.get(user);
        const filter = this.userFilter.get(user);
        if (!messages.has(id) && !filter.has(id)) {
            messages.set(id, entry);
            filter.add(id);
        }
    }

    onSend(t, user, target, id) {
        const message = {id, type: 'plain', source: user, target, timestamp: t};
        const entry = {message, from: [], hops: [], rep: 0};
        this.store(user, id, entry);
        this.userEncFilter.get(user).add(id);
    }

    dec(t, message, hops, encs = []) {
        const recvFilter = this.userRecvFilter.get(message.target);
        if (recvFilter.has(message.id)) {
            return;
        }
        if (message.size > 1e2) { // save memory
            recvFilter.add(message.id);
        }
        if (message.type === 'batch') {
            for (const {message: messageChild, hops: hopsChild} of message.batch) {
                const hopsConcat = hopsChild.slice();
                for (const i of Object.keys(hops).map(Number).sort((a, b) => a - b)) { // @Note: `hops` is sparse
                    hopsConcat.push(hops[i]);
                }
                this.dec(t, messageChild, hopsConcat, [message].concat(encs));
            }
            return;
        }
        const {id} = message;
        if (this.log.recv.has(id)) {
            return;
        }
        this.log.recv.add(id);
        this.log.recvDetail.push({...message, tSend: message.timestamp, tRecv: t, hops, encs});
    }

    cast(t, user, link, id, messages = this.userMessages.get(user), pending = false) {
        const entry = messages.get(id);
        const {message, from, hops, rep} = entry;
        if (from.includes(link)) { // @Note: avoid ping-pong, saving for `nRep`
            return;
        }
        if (rep + 1 > this.nRep) {
            messages.delete(id);
        } else {
            entry.rep += 1;
        }
        if (link === message.target) {
            return this.dec(t, message, hops);
        }
        if (hops.length + 1 > this.nHop) {
            messages.delete(id);
            this.log.drop.add(id);
            return;
        }
        const entryHop = {message, from: [user], hops: hops.concat(link), rep: 0};
        if (pending) {
            const messagesPending = this.userPendingMessages.get(link);
            if (!messagesPending.has(id)) {
                messagesPending.set(id, entryHop);
            }
            return;
        }
        this.store(link, id, entryHop);
    }

    onSession(user, link, graph) {}

    beforeLink(t) {
        // process pending messages
        this.afterLink();
        // do batching
        for (const user of this.userMessages.keys()) {
            this.beforeLinkUser(t, user);
        }
    }

    beforeLinkUser(t, user) {
        const messages = this.userMessages.get(user);
        const sessions = this.userSessions.get(user);
        const encFilter = this.userEncFilter.get(user);
        const messagesBatched = new Map();
        const targets = new DefaultMap(_ => ({batch: [], from: [], hop: [], rep: []}));
        for (const [id, {message, from, hops, rep}] of messages) {
            const {target} = message;
            if (sessions.has(target) && !encFilter.has(id)) { // @Note: avoid repeated re-encryption
                const entry = targets.get(target);
                entry.batch.push({message, hops});
                entry.from.push(...from); // @Note: avoid ping-pong re-encryptions
                entry.hop.push(hops.length);
                entry.rep.push(rep);
                encFilter.add(id);
            } else {
                messagesBatched.set(id, {message, from, hops, rep});
            }
        }
        if (targets.size > 0) {
            for (const [target, {batch: batchAll, from: fromAll, hop: hopAll, rep: repAll}] of targets)
            for (const [batch, from, hop, rep] of split(this.maxBatch, batchAll, fromAll, hopAll, repAll)) {
                const id = `${user.id}:[${batch.map(({message}) => message.id).sort()}]`;
                const size = batch.reduce((s, {message}) => s + (message.size ?? 1), 0);
                const message = {id, type: 'batch', batch, size, creator: user, target, timestamp: t};
                messagesBatched.set(id, {message, from, hops: Array(Math.round(this.getEncHop(hop))), rep: this.getEncRep(rep)});
                this.userFilter.get(user).add(id);
                this.userEncFilter.get(user).add(id);
                this.log.encs.push(message);
            }
            this.userMessages.set(user, messagesBatched);
        }
    }

    onLink(t, user, links, pending = false) {
        const messages = this.userMessages.get(user);
        for (const link of links) {
            for (const id of [...messages.keys()]) { // @Note: delete during iteration
                this.cast(t, user, link, id, messages, pending);
            }
        }
    }

    afterLink() {
        for (const [user, messages] of this.userPendingMessages) {
            for (const [id, entry] of messages) {
                this.store(user, id, entry);
            }
        }
        this.userPendingMessages.clear();
    }
}

class GlobalProtocol extends Protocol {
    onSession(user, link, graph) {
        const sessions = this.userSessions.get(link);
        const contacts = graph.get(link.id);
        for (const session of this.userSessions.get(user)) {
            if (this.isContactsOnly && !contacts.includes(session.id)) {
                continue;
            }
            sessions.add(session);
        }
        if (this.isContactsOnly && !contacts.includes(user.id)) {
            return;
        }
        sessions.add(user);
    }
}

class SessionProtocol extends Protocol {
    onSession(user, link, graph) {
        if (this.isContactsOnly && !graph.get(link.id).includes(user.id)) {
            return;
        }
        this.userSessions.get(link).add(user);
    }
}

export default Protocol;
export {GlobalProtocol, SessionProtocol};
