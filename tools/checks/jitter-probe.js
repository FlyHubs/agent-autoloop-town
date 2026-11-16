// Clicks a dock button, then for each frame of the move measures how far the camera's aim is from the point it orbits
// (degrees), and how far a name plate sits from where its building is drawn (pixels). Both should be ~0 if nothing lags.
new Promise((done) => {
  const THREE_ = window.__probe;
  const button = [...document.querySelectorAll("#dock button")].find((each) => each.textContent.includes(window.__which));
  const tag = [...document.querySelectorAll(".tag")].find((each) => each.textContent.includes("中台") || each.textContent.includes("任务大厅"));
  const samples = [];
  let frames = 0;
  button.click();
  const tick = () => {
    const probe = window.TOWN.aim ? window.TOWN.aim() : null;
    if (probe) samples.push(probe);
    if (++frames < 45) requestAnimationFrame(tick);
    else done(JSON.stringify({ which: window.__which, frames: samples.length, worstAimDegrees: Math.max(...samples.map((s) => s.aim)).toFixed(3), worstPlatePixels: Math.max(...samples.map((s) => s.plate)).toFixed(2) }));
  };
  requestAnimationFrame(tick);
});
