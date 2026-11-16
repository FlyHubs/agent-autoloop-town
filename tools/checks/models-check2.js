// Run in the page: what the town actually got from each remodelled machine and Agent figure.
(() => {
  const { town } = window.TOWN.peek();
  const measure = (model) => {
    let triangles = 0;
    const materials = new Set();
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    const corner = new (model.position.constructor)();
    model.updateMatrixWorld(true);
    const inverse = model.matrixWorld.clone().invert();
    model.traverse((part) => {
      if (!part.isMesh) return;
      triangles += (part.geometry.index ? part.geometry.index.count : part.geometry.attributes.position.count) / 3;
      materials.add(Array.isArray(part.material) ? "(several)" : part.material.name);
      part.geometry.computeBoundingBox();
      const ends = [part.geometry.boundingBox.min, part.geometry.boundingBox.max];
      // In the model's own frame, so sizes can be read against what was asked for.
      for (const x of ends) for (const y of ends) for (const z of ends) {
        corner.set(x.x, y.y, z.z).applyMatrix4(part.matrixWorld).applyMatrix4(inverse);
        corner.toArray().forEach((value, axis) => ((low[axis] = Math.min(low[axis], value)), (high[axis] = Math.max(high[axis], value))));
      }
    });
    const round = (value) => Number(value.toFixed(2));
    return { root: model.children[0]?.name ?? model.name, triangles: Math.round(triangles), x: [round(low[0]), round(high[0])], up: round(high[1]), z: [round(low[2]), round(high[2])], materials: [...materials].sort().join(" ") };
  };
  const machines = {};
  for (const lane of town.lanes.values()) {
    const got = measure(lane.machine);
    if (machines[got.root]) continue;
    machines[got.root] = { ...got, lamp: lane.lamp.name, press: Boolean(lane.press), spin: Boolean(lane.spin), hands: lane.hands.filter(Boolean).length };
  }
  const agents = {};
  for (const entry of town.agents.values()) {
    const got = measure(entry.figure);
    agents[got.root] = { ...got, body: entry.body.name, sparkIsMesh: Boolean(entry.spark?.isMesh), sparkMaterial: entry.spark?.material?.name };
  }
  return JSON.stringify({ loaded: window.TOWN.models().filter((name) => name.startsWith("fine_")).length, machines, agents, errors: window.TOWN.errors, drawn: window.TOWN.drawn() });
})()
