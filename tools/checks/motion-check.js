// Run in the page: watches the new machines' moving parts for eight seconds and says which of them moved.
(async () => {
  const { town } = window.TOWN.peek();
  const lanes = [...town.lanes.entries()].map(([name, lane]) => ({ name, lane, model: lane.machine.children[0]?.name ?? "", spun: 0, dipped: 0, running: false, was: lane.spin ? lane.spin.part.quaternion.clone() : null }));
  const agents = [...town.agents.values()].map((entry) => ({ model: entry.figure.children[0]?.name ?? "", entry, low: Infinity, high: -Infinity, sparkWas: entry.spark?.quaternion.clone(), sparkTurned: 0 }));
  const began = performance.now();
  while (performance.now() - began < 8000) {
    await new Promise((done) => requestAnimationFrame(done));
    for (const each of lanes) {
      each.running ||= each.lane.running;
      if (each.was) (each.spun = Math.max(each.spun, each.was.angleTo(each.lane.spin.part.quaternion)));
      if (each.lane.press) each.dipped = Math.max(each.dipped, each.lane.press.home.y - each.lane.press.part.position.y);
    }
    for (const each of agents) {
      each.low = Math.min(each.low, each.entry.body.position.y);
      each.high = Math.max(each.high, each.entry.body.position.y);
      if (each.sparkWas) each.sparkTurned = Math.max(each.sparkTurned, each.sparkWas.angleTo(each.entry.spark.quaternion));
    }
  }
  const round = (value) => Number(value.toFixed(2));
  return JSON.stringify({
    machines: lanes.map((each) => ({ rule: each.name, model: each.model.replace("fine_machine_", "").replace("_root", ""), ranOrKicked: each.running, spinTurned: each.was ? round(each.spun) : undefined, pressDipped: each.lane.press ? round(each.dipped) : undefined, handsOffRest: each.lane.hands.filter(Boolean).map((hand) => round(hand.rest.angleTo(hand.part.quaternion))) })),
    agents: agents.map((each) => ({ model: each.model.replace("fine_agent_", "").replace("_root", ""), bodyBobbed: round(each.high - each.low), sparkTurned: round(each.sparkTurned) })),
    errors: window.TOWN.errors,
  });
})()
