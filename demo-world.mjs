// Demo data for the town, in the shape of the hub's own GET /v1/state and its stream of facts: a made-up hub with a few
// rules, Agents and sources, where events arrive, rounds run and questions get asked by chance. The server uses it for
// --demo; the page uses the very same thing in the browser when it is opened with no server behind it. So it may use
// nothing that only Node or only a browser has.

import { dayDigest } from "./day.mjs";

export function demoWorld() {
  // The rounds it has let go of, as the state would have given them but for what they said: for playing the day back.
  const ledger = [];
  const kept = (run) => ({ id: run.id, rule: run.rule, agent: run.agent, state: run.state, attempts: run.attempts, createdAt: run.created_at, claimedAt: run.claimed_at, finishedAt: run.finished_at, usage: run.usage ? JSON.parse(run.usage) : null });
  // Rows in the hub's own shape, changed only through facts in the hub's own shape: the page is driven by the demo
  // exactly as it is by a real hub.
  const iso = (ms) => new Date(ms).toISOString();
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const chance = (odds) => Math.random() < odds;
  const agents = [
    { id: "claude", name: "Claude Code", use: "claude", worker: "mac-mini", room: 2 },
    { id: "codex", name: "Codex", use: "codex", worker: "mac-mini", room: 1 },
    { id: "checker", name: "巡检脚本", use: "command", worker: "mac-mini", room: 1 },
  ];
  const sources = [
    { id: "github", name: "GitHub" },
    { id: "ops", name: "运维告警" },
    { id: "feedback", name: "用户反馈" },
    { id: "content", name: "内容后台" },
    { id: "town", name: "本机" },
  ];
  const rules = [
    { name: "处理 Issue", project: "商城项目", source: "github", agent: "codex", types: ["issues.opened"], every: null, weight: 3 },
    { name: "线上告警", project: "商城项目", source: "ops", agent: "claude", types: ["alert.*"], every: null, weight: 1 },
    { name: "用户反馈", project: "日常事务", source: "feedback", agent: "claude", types: ["feedback.new"], every: null, weight: 3 },
    { name: "每日早报", project: "日常事务", source: "schedule", agent: "codex", types: [], every: "每天 08:00", weight: 1 },
    // A script on a schedule that hands back what it found as events: the polling pattern, and a second hop.
    { name: "网站巡检", project: "商城项目", source: "schedule", agent: "checker", types: [], every: "每 5 分钟", weight: 3, emits: "ops" },
    // Only what's typed into the town comes this way: it never arrives by itself.
    { name: "临时任务", project: "日常事务", source: "town", agent: "claude", types: ["task.new"], every: null, weight: 0 },
    // Enough more for the town to be a village: two more projects, and a line or two for each kind of thing.
    { name: "发布核实", project: "商城项目", source: "github", agent: "codex", types: ["release.published"], every: null, weight: 1 },
    { name: "选题日报", project: "内容", source: "schedule", agent: "claude", types: [], every: "每天 09:00", weight: 1 },
    { name: "读者意见", project: "内容", source: "content", agent: "claude", types: ["comment.new"], every: null, weight: 2 },
    { name: "素材入库", project: "内容", source: "content", agent: "codex", types: ["asset.new"], every: null, weight: 2 },
    { name: "证书巡检", project: "运维", source: "schedule", agent: "checker", types: [], every: "每天 03:00", weight: 1 },
    { name: "账单核对", project: "运维", source: "schedule", agent: "codex", types: [], every: "每周一 10:00", weight: 1 },
  ];
  const said = {
    "处理 Issue": ["修好了登录页的空白问题，改动在本地等你看", "补了导出功能的缺失字段", "重现不了，已在本地加了日志"],
    线上告警: ["是连接池满了，已经自己恢复", "磁盘告警是日志没轮转，已清理", "接口超时来自上游，暂时不用处理"],
    用户反馈: ["退款问题已核实，回复草稿写好了", "是已知问题，已合并到上一条反馈", "按反馈调了文案，等发布"],
    每日早报: ["早报写好了：昨天 6 次提交，2 条待办"],
    网站巡检: ["首页和下单页都正常", "首页正常，价格页恢复了"],
    临时任务: ["照你交代的做完了", "做完了，结果放在本地等你看"],
    发布核实: ["线上版本和这次发布对得上", "发布完成，健康检查通过"],
    选题日报: ["选题日报写好了：3 个可做，1 个待定"],
    读者意见: ["是排版问题，已修正并回复草稿", "和上周那条是同一个建议，已归并", "记下了，暂不改"],
    素材入库: ["12 个素材已归档，2 个缺授权信息", "新素材已入库并打好标签"],
    证书巡检: ["证书都还有 30 天以上", "有一张 14 天后到期，已排进续期"],
    账单核对: ["上周账单和用量对得上", "有一笔对不上，明细放在本地等你看"],
  };
  // What a made-up event says as it comes in, what the round it starts is seen to do, and how that round ends: a
  // few little stories for each rule, so that what is shouted, done and concluded belong together.
  const R = (words) => ["read", words];
  const E = (words) => ["edit", words];
  const X = (words) => ["run", words];
  const F = (words) => ["find", words];
  const S = (words) => ["say", words];
  const stories = {
    "处理 Issue": [
      { shout: "登录页一片空白", steps: [F("找 LoginPage"), R("读 LoginPage.tsx"), S("是会话为空时没兜底。"), E("改 LoginPage.tsx"), X("跑：单元测试")], result: "修好了登录页的空白问题，改动在本地等你看" },
      { shout: "导出少了一列", steps: [R("读 export.ts"), R("读 export.test.ts"), E("改 export.ts"), X("跑：导出测试")], result: "补了导出功能的缺失字段" },
      { shout: "搜索偶尔报错", steps: [R("读 search.log"), F("找 timeout"), S("本地重现不了，先加日志。"), E("改 search.ts")], result: "重现不了，已在本地加了日志" },
    ],
    线上告警: [
      { shout: "订单服务内存 92%", steps: [X("跑：看内存曲线"), R("读 order-service.log"), F("找 连接池"), S("连接池满过一次，已经回落。")], result: "是连接池满了，已经自己恢复" },
      { shout: "磁盘快满了", steps: [X("跑：看磁盘占用"), R("读 logrotate.conf"), X("跑：清理旧日志")], result: "磁盘告警是日志没轮转，已清理" },
      { shout: "接口超时变多", steps: [X("跑：看超时分布"), R("读 gateway.log"), S("都卡在上游的支付接口。")], result: "接口超时来自上游，暂时不用处理" },
    ],
    用户反馈: [
      { shout: "登录不上！", steps: [R("读 auth.log"), R("读 session-store.ts"), S("会话过期后没有续上。"), E("改 login.ts"), X("跑：测试"), E("写 回复草稿.md")], result: "会话过期没续上，已修好，回复草稿写好了" },
      { shout: "退款没到账", steps: [R("读 refund-1042.json"), F("找 退款规则"), E("写 回复草稿.md")], result: "退款问题已核实，回复草稿写好了" },
      { shout: "按钮文案看不懂", steps: [F("找 立即处理"), E("改 zh-CN.json"), X("跑：文案检查")], result: "按反馈调了文案，等发布" },
    ],
    每日早报: [{ shout: "", steps: [X("跑：看昨天的提交"), R("读 notes.md"), E("写 早报.md")], result: "早报写好了：昨天 6 次提交，2 条待办" }],
    临时任务: [{ shout: "", steps: [R("读 任务说明"), E("写 结果.md")], result: "照你交代的做完了" }],
    发布核实: [{ shout: "v2.4.1 发布了", steps: [X("跑：查线上版本"), ["web", "看网页 shop.example"], S("线上是 v2.4.1，和这次发布一致。")], result: "线上版本和这次发布对得上" }],
    选题日报: [{ shout: "", steps: [["web", "搜：本周行业动态"], R("读 选题池.md"), E("写 选题日报.md")], result: "选题日报写好了：3 个可做，1 个待定" }],
    读者意见: [
      { shout: "第三段有错字", steps: [R("读 post-88.md"), E("改 post-88.md"), E("写 回复草稿.md")], result: "是排版问题，已修正并回复草稿" },
      { shout: "想看更多案例", steps: [F("找 案例"), S("和上周那条是同一个建议。")], result: "和上周那条是同一个建议，已归并" },
    ],
    素材入库: [{ shout: "来了 12 个新素材", steps: [X("跑：列出新素材"), R("读 授权清单.csv"), E("写 素材清单.md")], result: "12 个素材已归档，2 个缺授权信息" }],
    账单核对: [{ shout: "", steps: [R("读 账单-上周.csv"), X("跑：对用量"), E("写 核对结果.md")], result: "上周账单和用量对得上" }],
  };
  const asks = {
    线上告警: { title: "订单服务要不要重启？", text: "内存涨到 92%，重启大约中断 20 秒。", options: ["现在重启", "等到凌晨", "先不动"], recommend: 1 },
    用户反馈: { title: "这笔退款怎么处理？", text: "用户超过 7 天才申请，金额 128 元。", options: ["全额退", "退一半", "不退，解释规则"], recommend: 0 },
    "处理 Issue": { title: "要不要顺手升级依赖？", text: "修这个问题最干净的办法是升一个大版本。", options: ["升级", "只打补丁"], recommend: 1 },
  };
  const rows = { events: new Map(), runs: new Map(), run_events: new Map(), cards: new Map(), deliveries: new Map(), timers: new Map(), seen: new Map() };
  const next = { events: 1, runs: 1, cards: 1, timers: 1 };
  const facts = [];
  const readers = new Set();
  const came = new Map(sources.map((source) => [source.id, 30 + Math.floor(Math.random() * 40)]));
  const busyUntil = new Map();
  let seq = 0;
  let doneToday = 0;
  let cost = 0;
  let tokens = 0;

  function commit(type, changes) {
    seq += 1;
    const fact = { version: 1, seq, at: Date.now(), type, changes };
    for (const { table, key, row } of changes) row === null ? rows[table].delete(String(key)) : rows[table].set(String(key), row);
    facts.push(fact);
    if (facts.length > 600) facts.shift();
    for (const reader of readers) reader(fact);
  }
  const put = (table, row, key = row.id) => ({ table, key: String(key), row: { ...row } });
  const queuedFor = (rule) => [...rows.runs.values()].find((run) => run.rule === rule && run.state === "queued");

  /** An event comes in and a rule takes it, into the round already waiting for that rule if there is one. */
  function arrive(rule, type, { fact = "ingest", source = rule?.source, hops = 0, resume = null, summary = "", changes = [], story = null } = {}) {
    const now = Date.now();
    const id = next.events++;
    const told = story === null ? null : stories[rule?.name]?.[story];
    const event = { id, source, key: `demo-${id}`, type, subject: `#${100 + id}`, summary: summary || told?.shout || "", detail: "", link: "", hops, routed: JSON.stringify(rule ? [rule.name] : []), paused: "", received_at: iso(now) };
    changes.push(put("events", event));
    if (source && came.has(source)) came.set(source, came.get(source) + 1);
    if (rule) {
      const waiting = queuedFor(rule.name);
      const run = waiting ?? {
        id: next.runs++, rule: rule.name, agent: rule.agent, grp: rule.name, lane: "", state: "queued", attempts: 0, not_before: iso(now), claim: null, issued: null,
        last_issued: null, last_result: null, last_answer: null, cancel_at: null, resume, session: null, link: null, created_at: iso(now), claimed_at: null,
        seen_at: null, finished_at: null, manual: type === "run.manual" ? 1 : 0, summary: null, error: null, usage: null,
        // Which of its rule's little stories this round plays out: only the demo has such a thing.
        demo_story: story ?? (stories[rule.name] ? Math.floor(Math.random() * stories[rule.name].length) : null),
        // …and the chance that settles how it ends, drawn now, so that what it is seen to do agrees with its ending.
        demo_roll: Math.random(),
      };
      if (!waiting) changes.push(put("runs", run));
      changes.push(put("run_events", { run_id: run.id, event_id: id }, `${run.id}:${id}`));
    }
    commit(fact, changes);
  }

  function finish(run) {
    const now = Date.now();
    const rule = rules.find((each) => each.name === run.rule);
    const roll = run.demo_roll ?? Math.random();
    const used = 4000 + Math.floor(Math.random() * 30000);
    const usage = JSON.stringify({ input: used, output: Math.floor(used / 12), cost: used / 400000 });
    const closing = { issued: null, last_issued: run.issued, last_result: "demo", usage };
    if (roll < 0.09 && run.attempts < 3) {
      const attempts = run.attempts + 1;
      // A real hub waits five minutes, then ten, twenty, up to an hour: here seconds, so there's something to see.
      const retry = { ...run, ...closing, state: "queued", attempts, not_before: iso(now + 9000 * attempts), last_answer: "[]", error: pick(["网络断了一下", "模型服务限流", "仓库被别的进程占着"]), demo_roll: Math.random() };
      return commit("finish", [put("runs", retry)]);
    }
    tokens += used + Math.floor(used / 12);
    cost += used / 400000;
    const changes = [];
    const ended = { ...run, ...closing, finished_at: iso(now), error: null, last_answer: "[]" };
    const ask = asks[run.rule];
    const open = [...rows.cards.values()].some((card) => card.rule === run.rule && card.state === "open");
    if (roll < 0.2 && ask && !open) {
      ended.state = "done";
      ended.summary = `待你决定：${ask.title}`;
      changes.push(put("cards", {
        id: next.cards++, key: `ask-${next.cards}`, kind: "ask", title: ask.title, text: ask.text, options: JSON.stringify(ask.options), recommend: ask.recommend, about: "",
        state: "open", fyi: 0, quiet: 0, choice: null, answer: null, by: null, result: null, rule: run.rule, lane: "", grp: run.rule, source: rule.source, agent: run.agent,
        session: null, run_id: run.id, answer_event: null, version: 1, created_at: iso(now), decided_at: null, closed_at: null,
      }));
    } else if (roll < 0.32) {
      ended.state = "nothing";
      ended.summary = "看过了，没有要做的";
    } else {
      ended.state = "done";
      ended.summary = stories[run.rule]?.[run.demo_story]?.result ?? pick(said[run.rule]);
      // Now and then the receipt asks for a second look later, and the hub turns away one thing it has no say over.
      if (chance(0.12)) changes.push(put("timers", { id: next.timers++, rule: run.rule, lane: "", key: `recheck-${next.timers}`, source: rule.source, agent: run.agent, session: null, about: "到时候再核实一次", at: iso(now + 20000 + Math.random() * 20000), event_id: null, created_at: iso(now), hops: 0 }));
      if (chance(0.05)) ended.last_answer = JSON.stringify([{ card: 0, reason: "不在本轮核对范围" }]);
    }
    if (ended.state === "done") doneToday += 1;
    changes.unshift(put("runs", ended));
    // What a polling script found comes back as an event of its own, one hop further on, in the same fact as its round's end.
    if (rule.emits && ended.state === "done" && chance(0.3)) {
      const taker = rules.find((each) => each.source === rule.emits);
      return arrive(taker, "alert.raised", { fact: "finish", source: rule.emits, hops: 1, summary: "巡检发现异常", changes });
    }
    commit("finish", changes);
  }

  function tick() {
    const now = Date.now();
    if (chance(0.2)) {
      const rule = pick(rules.flatMap((each) => Array(each.weight).fill(each)));
      const story = stories[rule.name] ? Math.floor(Math.random() * stories[rule.name].length) : null;
      if (rule.source === "schedule") arrive(rule, "schedule.tick", { fact: "tick", story });
      else arrive(rule, rule.types[0].replace("*", "raised"), { story });
    } else if (chance(0.012)) arrive(null, "deploy.finished", { source: "ops", summary: "没有规则接这种事件" });
    for (const timer of [...rows.timers.values()]) {
      if (timer.event_id !== null || Date.parse(timer.at) > now) continue;
      const rule = rules.find((each) => each.name === timer.rule);
      arrive(rule, "timer.due", { fact: "tick", changes: [put("timers", { ...timer, event_id: next.events })] });
    }
    for (const agent of agents) {
      const mine = [...rows.runs.values()].filter((run) => run.agent === agent.id);
      const running = mine.filter((run) => run.state === "claimed");
      const waiting = mine.find((run) => run.state === "queued" && Date.parse(run.not_before) <= now && !running.some((other) => other.rule === run.rule));
      if (waiting && running.length < agent.room) {
        busyUntil.set(waiting.id, now + 11000 + Math.random() * 9000);
        commit("claimNext", [put("runs", { ...waiting, state: "claimed", claim: `demo-${seq}`, issued: seq + 1, claimed_at: iso(now), seen_at: iso(now) })]);
      }
    }
    for (const run of [...rows.runs.values()]) if (run.state === "claimed" && busyUntil.get(run.id) <= now) finish(run);
    // A channel comes for a card a little after it's made, and says when it has shown it.
    for (const card of rows.cards.values()) {
      const key = `${card.id}:desktop`;
      const sent = rows.deliveries.get(key);
      if (!sent && now - Date.parse(card.created_at) > 2500) commit("nextCard", [put("deliveries", { card_id: card.id, channel: "desktop", version: 0, ref: null, tries: 1, first_try_at: iso(now), not_before: iso(now + 60000), error: null, given_up: 0 }, key)]);
      else if (sent && sent.ref === null && now - Date.parse(sent.first_try_at) > 1500) commit("delivered", [put("deliveries", { ...sent, version: card.version, ref: `demo-${card.id}` }, key)]);
    }
    for (const [id, run] of rows.runs) if (ended(run) && rows.runs.size > 90) (ledger.push(kept(run)), rows.runs.delete(id), busyUntil.delete(run.id));
    if (ledger.length > 8000) ledger.splice(0, ledger.length - 8000);
  }
  const ended = (run) => ["done", "nothing", "cancelled"].includes(run.state);
  for (const rule of rules.slice(0, 3)) arrive(rule, rule.types[0].replace("*", "raised"));
  setInterval(tick, 1000)?.unref?.();
  setInterval(() => commit("heartbeat", [put("seen", { kind: "worker", name: "mac-mini", seen_at: iso(Date.now()) }, "worker:mac-mini")]), 20000)?.unref?.();

  const view = (card) => ({
    id: card.id, version: card.version, ref: null, kind: card.kind, state: card.state, title: card.title, text: card.text, options: JSON.parse(card.options), recommend: card.recommend,
    choice: card.choice, answer: card.answer, by: card.by, result: card.result, link: null, rule: card.rule, createdAt: card.created_at, decidedAt: card.decided_at, closedAt: card.closed_at, lane: card.lane, about: card.about,
  });
  return {
    /** The day so far, for playing back: every round there has been, and the cards. */
    day(since) {
      return dayDigest([...ledger, ...[...rows.runs.values()].map(kept)], [...rows.cards.values()].map(view), since, Date.now());
    },
    state() {
      const now = Date.now();
      const runs = [...rows.runs.values()];
      const totalsOf = (match) => {
        const mine = runs.filter(match);
        const count = (test) => mine.filter(test).length;
        return {
          running: count((run) => run.state === "claimed"), queued: count((run) => run.state === "queued"), retrying: count((run) => run.state === "queued" && run.attempts > 0),
          unknown: 0, done: count((run) => run.state === "done"), doneToday: count((run) => run.state === "done"), nothing: count((run) => run.state === "nothing"), usage: { input: 0, output: 0, cost: 0 },
        };
      };
      const spend = { rounds: runs.filter(ended).length, tokens, cost, missingTokens: 0, missingCost: 0 };
      const cards = [...rows.cards.values()];
      const eventsOf = (run) => [...rows.run_events.values()].filter((link) => link.run_id === run.id).map((link) => rows.events.get(String(link.event_id))).filter(Boolean)
        .map(({ source, type, subject, summary, link }) => ({ source, type, subject, summary, link }));
      return {
        seq, now: iso(now), timezone: "Asia/Shanghai", spending: { today: spend, week: spend },
        projects: Object.fromEntries(rules.map((rule) => [rule.name, rule.project])),
        totals: { ...totalsOf(() => true), doneToday, attention: cards.filter((card) => card.state === "open").length },
        cards: cards.filter((card) => card.state === "open").map(view),
        recentCards: cards.filter((card) => card.state !== "open").slice(-20).reverse().map(view),
        timers: [...rows.timers.values()].filter((timer) => timer.event_id === null).map(({ rule, lane, key, about, at }) => ({ rule, lane, key, about, at })),
        sources: [...sources.map(({ id, name }) => ({ id, name, events: came.get(id) })), { id: "schedule", name: "定时", events: 0 }],
        lines: rules.map((rule) => ({
          id: rule.name, name: rule.name, group: rule.name, agent: rule.agent, source: rule.source, types: rule.types, every: rule.every,
          next: rule.every ? iso(now + 180000) : null, totals: totalsOf((run) => run.rule === rule.name), paused: null, skippedAt: null,
        })),
        pauses: [], skipped: [], elsewhere: [],
        agents: agents.map(({ id, name, use, worker }) => ({ id, name, use, worker, seenAt: rows.seen.get(`worker:${worker}`)?.seen_at ?? iso(now), online: true, totals: totalsOf((run) => run.agent === id) })),
        channels: [{ id: "desktop", name: "桌面通知", seenAt: iso(now), online: true }, { id: "feishu", name: "飞书", seenAt: iso(now), online: true }],
        runs: runs.sort((a, b) => b.id - a.id).slice(0, 60).map((run) => ({
          id: run.id, rule: run.rule, agent: run.agent, state: run.state, attempts: run.attempts, createdAt: run.created_at, claimedAt: run.claimed_at, finishedAt: run.finished_at,
          notBefore: run.not_before, summary: run.summary ?? "", error: run.error ?? "", link: "", session: null, usage: run.usage ? JSON.parse(run.usage) : null, stopping: false,
          manual: Boolean(run.manual), events: eventsOf(run),
        })),
        hasMore: false, nextBefore: null,
        unrouted: [...rows.events.values()].filter((event) => event.routed === "[]").slice(-20).reverse(),
      };
    },
    /** Every fact after one, then each new one as it happens, until whoever is reading goes away. */
    stream(after, write, gone) {
      for (const fact of facts) if (fact.seq > after) write(fact);
      readers.add(write);
      gone.addEventListener("abort", () => readers.delete(write));
    },
    answer(id, body) {
      const card = rows.cards.get(String(id));
      if (!card || card.state !== "open") return { status: 404, text: JSON.stringify({ error: "没有这张卡片" }) };
      const options = JSON.parse(card.options);
      const chosen = typeof body.choice === "number" ? options[body.choice] : (body.text ?? "已处理");
      const decided = { ...card, state: "decided", choice: body.choice ?? null, answer: chosen, by: "owner", decided_at: iso(Date.now()), answer_event: next.events, version: card.version + 1 };
      arrive(rules.find((each) => each.name === card.rule), "card.answered", { fact: "answer", source: card.source, summary: card.title, changes: [put("cards", decided)] });
      return { status: 200, text: JSON.stringify({ ok: true }) };
    },
    task(type, words) {
      const rule = rules.find((each) => each.source === "town" && each.types.includes(type));
      arrive(rule ?? null, type, { source: "town", summary: [...words].slice(0, 200).join("") });
      return { event: next.events - 1, duplicate: false, routed: rule ? [rule.name] : [] };
    },
    /** What a round has been seen to do so far, as the town's server reads it from a real round's record. */
    steps(id) {
      const run = rows.runs.get(String(id));
      if (!run) return [];
      const all = (stories[run.rule]?.[run.demo_story]?.steps ?? []).map(([kind, words]) => ({ kind, words, ok: true }));
      // One that will find nothing to do only looks; one that will stop to ask, or fail, gets no further than looking.
      const roll = run.demo_roll ?? 1;
      const looking = all.findIndex((line) => line.kind === "edit" || line.kind === "say");
      const lines = roll < 0.32 && run.state !== "done" ? all.slice(0, looking < 0 ? 2 : Math.max(1, looking)) : run.state === "done" && /^待你决定/.test(run.summary ?? "") ? all.slice(0, looking < 0 ? 2 : Math.max(1, looking)) : all;
      if (run.state === "claimed") return lines.slice(0, Math.max(0, Math.floor((Date.now() - Date.parse(run.claimed_at)) / 1500)));
      if (run.state === "queued") return run.attempts ? [...lines.slice(0, 2), { kind: "fail", words: run.error ?? "没跑成", ok: false }] : [];
      return run.summary ? [...lines, { kind: run.state === "cancelled" ? "fail" : "done", words: run.summary, ok: run.state !== "cancelled" }] : lines;
    },
    run(name) {
      const rule = rules.find((each) => each.name === name);
      if (!rule) return { status: 404, text: JSON.stringify({ error: `没有这条规则：${name}` }) };
      const story = stories[name] ? Math.floor(Math.random() * stories[name].length) : null;
      arrive(rule, "run.manual", { fact: "runRule", summary: stories[name]?.[story]?.shout ? "" : "owner 手动运行", story });
      return { status: 200, text: JSON.stringify({ run: queuedFor(name)?.id }) };
    },
  };
}
