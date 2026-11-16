// A day of the hub's rounds and cards, pared down to when each began and ended: what the page plays the day back
// from. Nothing a round was asked or said goes into it: only which line, which Agent, how it ended, when, and what it
// cost.

const ENDED = ["done", "nothing", "cancelled"];
/** Text, a number, or nothing: a value of another kind in the hub's state is taken as nothing. */
const text = (value) => (typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "");
const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
/** A time the hub gives as text, in milliseconds; null where there is none or it can't be read. */
const at = (stamp) => {
  const time = typeof stamp === "string" ? Date.parse(stamp) : NaN;
  return Number.isFinite(time) ? time : null;
};

/**
 * The rows of the day that began at `since`, from rounds and cards as GET /v1/state gives them, oldest first.
 * A round is [id, line, Agent, state, attempts, asked for, taken up, finished, cost]; a card is [id, line, put,
 * answered or withdrawn]. Times are milliseconds, null where it hasn't happened. A round or a card that was over
 * before the day began is left out; one still open is kept however old it is.
 */
export function dayDigest(runs, cards, since, now, more = false) {
  const rounds = runs
    .map((run) => {
      const [created, claimed, finished] = [at(run?.createdAt), at(run?.claimedAt), at(run?.finishedAt)];
      const state = text(run?.state);
      // One the hub calls over without saying when: it was over by the last thing known of it.
      return [run?.id, text(run?.rule), text(run?.agent), state, number(run?.attempts), created, claimed, finished ?? (ENDED.includes(state) ? (claimed ?? created) : null), number(run?.usage?.cost)];
    })
    .filter(([id, , , , , created, , finished]) => Number.isSafeInteger(id) && created !== null && created <= now && (finished === null || finished >= since))
    .sort((one, other) => one[5] - other[5] || one[0] - other[0]);
  const asked = cards
    .map((card) => {
      const created = at(card?.createdAt);
      return [card?.id, text(card?.rule), created, card?.state === "open" ? null : (at(card?.closedAt) ?? at(card?.decidedAt) ?? created)];
    })
    .filter(([id, , created, over]) => Number.isSafeInteger(id) && created !== null && created <= now && (over === null || over >= since))
    .sort((one, other) => one[2] - other[2] || one[0] - other[0]);
  return { since, now, more, runs: rounds, cards: asked };
}

/**
 * Reads the hub's state back a page at a time, as far as the start of the day and the two pages before that: a round
 * asked for the day before may have finished in this one. `ask(before)` gives a page of GET /v1/state, the latest when
 * `before` is undefined. At most `most` pages are read; `more` in what comes back says the day goes further back
 * than that.
 */
export async function dayOf(since, ask, now = Date.now(), most = 50, within = 20_000) {
  const runs = new Map();
  const began = Date.now();
  const list = (value) => (Array.isArray(value) ? value : []);
  // Only what the day is made from is kept of each round, page by page.
  const slim = (run) => ({ id: run?.id, rule: run?.rule, agent: run?.agent, state: run?.state, attempts: run?.attempts, createdAt: run?.createdAt, claimedAt: run?.claimedAt, finishedAt: run?.finishedAt, usage: { cost: run?.usage?.cost } });
  let cards = [];
  let before;
  let more = false;
  let past = 0;
  for (let page = 0; ; page++) {
    const state = await ask(before);
    if (page === 0) cards = [...new Map([...list(state?.recentCards), ...list(state?.cards)].map((card) => [card?.id, card])).values()];
    const these = list(state?.runs);
    for (const run of these) runs.set(run?.id, slim(run));
    // The hub says where the next page starts; one that doesn't go back from here would be read for ever.
    if (!state?.hasMore || !Number.isSafeInteger(state.nextBefore) || (before !== undefined && state.nextBefore >= before)) break;
    if (these.every((run) => !(at(run?.createdAt) >= since)) && ++past >= 2) break;
    // A slow hub doesn't keep the page waiting for long: what has been read so far, and word that there is more.
    if (page + 1 >= most || Date.now() - began > within) {
      more = true;
      break;
    }
    before = state.nextBefore;
  }
  return dayDigest([...runs.values()], cards, since, now, more);
}
