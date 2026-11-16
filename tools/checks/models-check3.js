// Run in the page: which of the small remodelled things the town is actually using, and what each is made of.
(() => {
  const { scene } = window.TOWN.peek();
  const seen = {};
  scene.traverse((part) => {
    if (!/^fine_(parcel|letter|clock|crate|pallet|bench|town_scooter|town_lamp)_root$/.test(part.name)) return;
    const name = part.name.replace("_root", "");
    const entry = (seen[name] ??= { copies: 0, triangles: 0, materials: new Set(), size: null });
    entry.copies += 1;
    if (entry.copies > 1) return;
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    part.updateMatrixWorld(true);
    const inverse = part.matrixWorld.clone().invert();
    const corner = part.position.clone();
    part.traverse((mesh) => {
      if (!mesh.isMesh) return;
      entry.triangles += (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / 3;
      entry.materials.add(mesh.material.name);
      mesh.geometry.computeBoundingBox();
      const ends = [mesh.geometry.boundingBox.min, mesh.geometry.boundingBox.max];
      for (const x of ends) for (const y of ends) for (const z of ends) {
        corner.set(x.x, y.y, z.z).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
        corner.toArray().forEach((value, axis) => ((low[axis] = Math.min(low[axis], value)), (high[axis] = Math.max(high[axis], value))));
      }
    });
    entry.size = high.map((value, axis) => Number((value - low[axis]).toFixed(2)));
  });
  // The fence is drawn as many copies of each of its meshes, not as copies of the model.
  let fence = 0;
  let panels = 0;
  scene.traverse((part) => {
    if (!part.isInstancedMesh || part.material?.name !== "steel") return;
    fence += (part.geometry.index ? part.geometry.index.count : part.geometry.attributes.position.count) / 3;
    panels = Math.max(panels, part.count);
  });
  return JSON.stringify({
    loaded: window.TOWN.models().filter((name) => name.startsWith("fine_")).length,
    things: Object.fromEntries(Object.entries(seen).map(([name, entry]) => [name.replace("fine_", ""), `${entry.copies} 个 · ${Math.round(entry.triangles)} 面 · ${entry.size.join("×")} · ${[...entry.materials].sort().join(" ")}`])),
    fence: `${panels} 段 · 每段 ${Math.round(fence)} 面`,
    errors: window.TOWN.errors,
    drawn: window.TOWN.drawn(),
  });
})()
