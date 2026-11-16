// The day's record, pared down for playing back: what is kept and left out, how far back the hub is read, and that
// the demo's made-up hub keeps a day the same way. Nothing here goes on line.
import assert from "node:assert/strict";
import test from "node:test";
import { dayDigest, dayOf } from "../day.mjs";
import { demoWorld } from "../demo-world.mjs";

const DAY = Date.parse("2026-11-14T00:00:00+08:00");
const NOW = DAY + 15 * 3_600_000;
const iso = (hours) => new Date(DAY + hours * 3_600_000).toISOString();
const run = (id, state, created, claimed = null, finished = null, more = {}) => ({ id, rule: "早报", agent: "claude", state, attempts: 0, createdAt: iso(created), claimedAt: claimed === null ? null : iso(claimed), finishedAt: finished === null ? null : iso(finished), ...more });

test("a round is its line, Agent, ending, three times and cost: nothing it said", () => {
  const { runs } = dayDigest([run(7, "done", 8, 8.1, 8.2, { summary: "机密的结论", error: "机密的报错", events: [{ summary: "机密的任务" }], usage: { cost: 0.25, input: 9 }, session: "abc" })], [], DAY, NOW);
  assert.deepEqual(runs, [[7, "早报", "claude", "done", 0, DAY + 8 * 3_600_000, DAY + 8.1 * 3_600_000, DAY + 8.2 * 3_600_000, 0.25]]);
  assert.equal(JSON.stringify(runs).includes("机密"), false);
});

test("what was over before the day began is left out; what is still open is kept however old", () => {
  const { runs } = dayDigest([run(1, "done", -30, -29, -28), run(2, "done", -2, -1, 1), run(3, "claimed", -40, -39), run(4, "queued", -50), run(5, "nothing", 3, 3.1, 3.2)], [], DAY, NOW);
  assert.deepEqual(runs.map(([id]) => id), [4, 3, 2, 5]);
});

test("rounds come oldest first, by when they were asked for, then by number", () => {
  const { runs } = dayDigest([run(9, "done", 5, 5, 5), run(3, "done", 9, 9, 9), run(8, "done", 5, 5, 5), run(4, "done", 1, 1, 1)], [], DAY, NOW);
  assert.deepEqual(runs.map(([id]) => id), [4, 8, 9, 3]);
});

test("a round the hub calls over without saying when was over by the last thing known of it", () => {
  const { runs } = dayDigest([run(1, "cancelled", 2), run(2, "nothing", 3, 3.5), run(3, "queued", 4)], [], DAY, NOW);
  assert.deepEqual(runs.map(([id, , , , , , , finished]) => [id, finished]), [[1, DAY + 2 * 3_600_000], [2, DAY + 3.5 * 3_600_000], [3, null]]);
});

test("rows that can't be read are dropped, not passed on", () => {
  const bad = [null, {}, { id: "7", createdAt: iso(1) }, { id: 1.5, createdAt: iso(1) }, { id: 5, createdAt: "昨天" }, { id: 6 }, run(8, "done", 30, 30, 30)];
  const { runs, cards } = dayDigest([...bad, run(2, "done", 1, 1, 1, { attempts: "x", usage: { cost: "贵" }, rule: 12, agent: null })], [null, {}, { id: "3", createdAt: iso(1), state: "open" }], DAY, NOW);
  assert.deepEqual(runs, [[2, "12", "", "done", 0, DAY + 3_600_000, DAY + 3_600_000, DAY + 3_600_000, 0]]);
  assert.deepEqual(cards, []);
});

test("a card is when it was put and when it was answered or withdrawn; an open one has no end", () => {
  const cards = [
    { id: 1, rule: "告警", state: "open", createdAt: iso(-20), title: "机密的问题" },
    { id: 2, rule: "告警", state: "decided", createdAt: iso(2), decidedAt: iso(3) },
    { id: 3, rule: "告警", state: "closed", createdAt: iso(4), decidedAt: iso(5), closedAt: iso(6) },
    { id: 4, rule: "告警", state: "decided", createdAt: iso(-9), decidedAt: iso(-8) },
    { id: 5, rule: "告警", state: "closed", createdAt: iso(7) },
  ];
  const digest = dayDigest([], cards, DAY, NOW);
  assert.deepEqual(digest.cards, [[1, "告警", DAY - 20 * 3_600_000, null], [2, "告警", DAY + 2 * 3_600_000, DAY + 3 * 3_600_000], [3, "告警", DAY + 4 * 3_600_000, DAY + 6 * 3_600_000], [5, "告警", DAY + 7 * 3_600_000, DAY + 7 * 3_600_000]]);
  assert.equal(JSON.stringify(digest).includes("机密"), false);
});

/** A hub with rounds numbered down from `newest`, one every `gap` hours back from `latest`, read sixty to a page. */
function pagedHub(newest, latest, gap, asked = []) {
  return async (before) => {
    asked.push(before);
    const top = before === undefined ? newest : before - 1;
    const list = [];
    for (let id = top; id > top - 60 && id >= 1; id--) list.push(run(id, "done", latest - (newest - id) * gap, latest - (newest - id) * gap, latest - (newest - id) * gap));
    const hasMore = top - 60 >= 1;
    return { runs: list, hasMore, nextBefore: hasMore ? top - 59 : null, cards: [], recentCards: [] };
  };
}

test("the hub is read back to the start of the day and the two pages before that, and no further", async () => {
  const asked = [];
  // A round every six minutes back from 14:00: 140 of them since midnight, in three pages.
  const day = await dayOf(DAY, pagedHub(1000, 14, 0.1, asked), NOW);
  assert.equal(day.runs.length, 141);
  assert.equal(day.more, false);
  assert.equal(day.runs[0][5] >= DAY, true);
  // Three pages hold the day (the third only in part); the fourth is all of the day before, and so is the fifth.
  assert.deepEqual(asked, [undefined, 941, 881, 821, 761]);
});

test("a round asked for the day before and finished in this one is found on the second page before the day", async () => {
  // It takes the place of round 750, which is on the fifth page: the second that is wholly of the day before.
  const late = run(750, "done", -3, -2, 1);
  const hub = pagedHub(1000, 14, 0.1);
  const day = await dayOf(DAY, async (before) => {
    const state = await hub(before);
    return { ...state, runs: state.runs.map((each) => (each.id === 750 ? late : each)) };
  }, NOW);
  assert.equal(day.runs.some(([id]) => id === 750), true);
  assert.equal(day.runs.length, 142);
});

test("a day too long to read in the pages allowed says so", async () => {
  const asked = [];
  const day = await dayOf(DAY, pagedHub(100_000, 14, 0.0001, asked), NOW, 4);
  assert.equal(asked.length, 4);
  assert.equal(day.more, true);
  assert.equal(day.runs.length, 240);
});

test("a hub with a short history is read once, and one whose pages don't go back is not read for ever", async () => {
  const asked = [];
  assert.equal((await dayOf(DAY, pagedHub(12, 14, 0.1, asked), NOW)).runs.length, 12);
  assert.deepEqual(asked, [undefined]);
  let calls = 0;
  const stuck = async () => (calls++, { runs: [run(5, "done", 1, 1, 1)], hasMore: true, nextBefore: 5, cards: [], recentCards: [] });
  await dayOf(DAY, stuck, NOW);
  assert.equal(calls, 2);
});

test("cards come from the first page only, and an open one listed twice is kept once", async () => {
  const card = { id: 3, rule: "告警", state: "open", createdAt: iso(1) };
  const hub = pagedHub(200, 14, 0.1);
  const day = await dayOf(DAY, async (before) => ({ ...(await hub(before)), cards: [card], recentCards: [card, { id: 2, rule: "告警", state: "decided", createdAt: iso(2), decidedAt: iso(3) }] }), NOW);
  assert.deepEqual(day.cards.map(([id]) => id), [3, 2]);
});

test("a hub that can't be read fails the whole day, not half of it", async () => {
  let calls = 0;
  const hub = pagedHub(1000, 14, 0.1);
  await assert.rejects(dayOf(DAY, async (before) => (++calls === 2 ? Promise.reject(new Error("中台返回 503")) : hub(before)), NOW), /503/);
});

test("the demo's made-up hub gives its day in the same shape, with the rounds it has let go of", () => {
  const world = demoWorld();
  const day = world.day(Date.now() - 3_600_000);
  assert.equal(Array.isArray(day.runs) && Array.isArray(day.cards), true);
  assert.equal(day.runs.length >= 3, true);
  for (const row of day.runs) {
    assert.equal(row.length, 9);
    assert.equal(Number.isSafeInteger(row[0]) && typeof row[1] === "string" && typeof row[2] === "string" && Number.isFinite(row[5]), true);
  }
});
