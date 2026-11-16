// Run in the page: what the town actually got from each of the four remodelled buildings.
(() => {
  const { town } = window.TOWN.peek();
  const report = (model, names) => {
    let triangles = 0;
    const materials = new Set();
    model.traverse((part) => {
      if (!part.isMesh) return;
      triangles += (part.geometry.index ? part.geometry.index.count : part.geometry.attributes.position.count) / 3;
      materials.add(Array.isArray(part.material) ? "(several)" : part.material.name);
    });
    const size = new (model.position.constructor)();
    const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    model.updateMatrixWorld(true);
    model.traverse((part) => {
      if (!part.isMesh) return;
      part.geometry.computeBoundingBox();
      const corners = [part.geometry.boundingBox.min, part.geometry.boundingBox.max];
      for (const x of corners) for (const y of corners) for (const z of corners) {
        size.set(x.x, y.y, z.z).applyMatrix4(part.matrixWorld);
        box.min = [Math.min(box.min[0], size.x), Math.min(box.min[1], size.y), Math.min(box.min[2], size.z)];
        box.max = [Math.max(box.max[0], size.x), Math.max(box.max[1], size.y), Math.max(box.max[2], size.z)];
      }
    });
    return {
      root: model.children[0]?.name ?? model.name,
      triangles: Math.round(triangles),
      height: Number((box.max[1] - box.min[1]).toFixed(2)),
      span: [Number((box.max[0] - box.min[0]).toFixed(2)), Number((box.max[2] - box.min[2]).toFixed(2))],
      named: Object.fromEntries(names.map((name) => [name, Boolean(model.getObjectByName(name))])),
      materials: [...materials].sort().join(" "),
    };
  };
  return JSON.stringify({
    loaded: window.TOWN.models().filter((name) => name.startsWith("fine_")),
    hall: report(town.hall.model, ["glass", "ribs", "turntable"]),
    workshop: report(town.projects[0].office, []),
    post: report(town.post.model, ["anchor_out"]),
    house: report(town.house.model, ["anchor_door", "mailflag"]),
    flagMaterials: town.house.flag.length,
    turntable: Boolean(town.hall.turntable),
    drawn: window.TOWN.drawn(),
  });
})()
