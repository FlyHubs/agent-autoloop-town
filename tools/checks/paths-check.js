// Run in the page: walks every path something is driven along and every belt, looking for a place where the curve
// gives no point or no heading (which would make whatever is travelling it jump to the end).
(() => {
  const { town } = window.TOWN.peek();
  const bad = [];
  const walk = (name, curve) => {
    let nulls = 0;
    let nans = 0;
    for (let step = 0; step <= 2000; step++) {
      const u = Math.min(0.9999, step / 2000);
      const point = curve.getPointAt(u);
      const heading = curve.getTangentAt(u);
      if (!point || !heading) nulls++;
      else if (![point.x, point.y, point.z, heading.x, heading.y, heading.z].every(Number.isFinite)) nans++;
    }
    if (nulls || nans) bad.push({ name, nulls, nans });
    return Number(curve.getLength().toFixed(2));
  };
  const lengths = Object.fromEntries(Object.entries(town.mail).map(([name, curve]) => [name, walk(`mail.${name}`, curve)]));
  town.belts.forEach((belt, index) => walk(`belt.${index}`, belt.curve));
  return JSON.stringify({ mail: lengths, belts: town.belts.length, bad, out: town.post.out.toArray().map((value) => Number(value.toFixed(2))), door: town.house.door.toArray().map((value) => Number(value.toFixed(2))) });
})()
