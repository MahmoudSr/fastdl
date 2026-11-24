'use strict';
// Tests the list logic shared by fastdl's windows (app/ui/shared.js): the order of the list,
// queue places and the status-bar summary.
// Run: node test/ui-test.js
const { compareForList, queuePositions, queueText, progressSummary, isInProgress, typeOf, fmtBytes } = require('../app/ui/shared.js');

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The user's case: 1 download at a time from one site, ~100 files added in a row (oldest = lowest id).
const item = (id, status, added = 1000 + id) => ({ id, status, added });
const batch = [];
for (let id = 1; id <= 100; id++) batch.push(item(id, id < 4 ? 'completed' : id === 4 ? 'downloading' : 'queued'));
batch.push(item(101, 'paused'), item(102, 'failed'));

const order = [...batch].sort(compareForList).map(i => i.id);
check('the running download is at the top, not under 96 queued ones', order[0] === 4, `first: ${order[0]}`);
check('then the queue, in the order it will start (oldest first)', eq(order.slice(1, 97), Array.from({ length: 96 }, (_, n) => n + 5)));
check('then paused', order[97] === 101);
check('then finished and failed, newest first', eq(order.slice(98), [102, 3, 2, 1]));

// Several running: oldest first, like the queue.
const running = [item(9, 'downloading'), item(7, 'downloading'), item(8, 'queued')].sort(compareForList).map(i => i.id);
check('several running downloads keep their start order', eq(running, [7, 9, 8]));

// Finished downloads sort by when they were added, not by id (ids can't go back in time, but be safe).
const finished = [item(1, 'completed', 500), item(2, 'completed', 300), item(3, 'failed', 400)].sort(compareForList).map(i => i.id);
check('finished downloads are newest first by time added', eq(finished, [1, 3, 2]));

// Queue places.
const pos = queuePositions(batch);
check('the next one to start is #1', pos.get(5) === 1 && queueText(1) === 'Queued · next');
check('places count only queued downloads', pos.get(100) === 96 && !pos.has(4) && !pos.has(101) && pos.size === 96);
check('queue text for later places', queueText(3) === 'Queued · #3');

// "In progress" view and the status bar.
check('In progress = downloading, queued and paused', batch.filter(isInProgress).length === 98);
check('status bar summary', progressSummary(batch) === '1 downloading · 96 queued · 1 paused', progressSummary(batch));
check('summary leaves out zeroes', progressSummary([item(1, 'queued')]) === '1 queued');
check('summary when idle', progressSummary([item(1, 'completed')]) === 'Nothing downloading');

// Helpers moved into shared.js still behave.
check('file types', typeOf('Movie.MKV') === 'video' && typeOf('notes') === 'other');
check('byte formatting', fmtBytes(1536) === '1.50 KB' && fmtBytes(null) === '?');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
