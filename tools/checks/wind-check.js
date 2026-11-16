// Run in the page: measures how much of a forest-only view changes between two frames 0.6 s apart, with the wind
// blowing and with it stilled. Cloud shade is switched off for the test, so nothing else in view moves.
(async () => {
  const { scene, renderer, wind } = window.TOWN.peek();
  const shade = scene.children.find((part) => part.material?.type === "ShaderMaterial");
  if (shade) shade.visible = false;
  window.TOWN.view([-78, 46, 14], [-78, 0, -30]);
  const grab = () =>
    new Promise((done) =>
      requestAnimationFrame(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 420;
        canvas.height = 250;
        const pen = canvas.getContext("2d", { willReadFrequently: true });
        pen.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height);
        done(pen.getImageData(0, 0, canvas.width, canvas.height).data);
      }),
    );
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const changed = async () => {
    await wait(700);
    const first = await grab();
    await wait(600);
    const second = await grab();
    let count = 0;
    for (let i = 0; i < first.length; i += 4) if (Math.abs(first[i] - second[i]) + Math.abs(first[i + 1] - second[i + 1]) + Math.abs(first[i + 2] - second[i + 2]) > 18) count++;
    return Number(((count / (first.length / 4)) * 100).toFixed(2));
  };
  const gust = wind.gust.value;
  const blowing = await changed();
  wind.gust.value = 0;
  const stilled = await changed();
  wind.gust.value = gust * 2.6;
  const gale = await changed();
  wind.gust.value = gust;
  if (shade) shade.visible = true;
  const seen = await grab(); let sum = 0; for (let i = 0; i < seen.length; i += 4) sum += seen[i] + seen[i + 1] + seen[i + 2]; return JSON.stringify({ percentOfPixelsChanged: { blowing, stilled, gale }, meanLevel: Math.round(sum / (seen.length / 4) / 3), clock: Number(wind.time.value.toFixed(1)) });
})()
