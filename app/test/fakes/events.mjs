export const pushed = [];
export class Queue { constructor(p) { this.key = p.key; } async push(e) { pushed.push(e); return { jobId: String(pushed.length) }; } }
