// Run in the page: opens the task card, types a task and attaches one file, then presses the button once.
// In the demo town that sends it (nothing real happens). In the live town the first press only asks to confirm,
// and this then presses "取消": nothing is sent there.
(async () => {
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  [...document.querySelectorAll(".dock button")].find((button) => button.textContent.includes("派活")).click();
  await wait(300);
  const card = document.getElementById("task");
  const words = card.querySelector("textarea");
  words.value = "把附件里的需求整理成待办清单。";
  words.dispatchEvent(new Event("input", { bubbles: true }));
  const carried = new DataTransfer();
  carried.items.add(new File(["# 需求\n1. 导出要支持 CSV\n"], "需求说明.md", { type: "text/markdown" }));
  card.querySelector(".compose").dispatchEvent(new DragEvent("drop", { dataTransfer: carried, bubbles: true, cancelable: true }));
  await wait(1200);
  const see = () => ({ chips: card.querySelectorAll(".attach").length, text: words.value.length, hint: card.querySelector(".sendrow p").textContent, button: card.querySelector(".go").textContent, cancel: !card.querySelector(".sendrow .small").hidden });
  const before = see();
  card.querySelector(".go").click();
  await wait(1800);
  const after = see();
  let cancelled = null;
  if (after.cancel) {
    card.querySelector(".sendrow .small").click();
    await wait(200);
    cancelled = see();
  }
  return JSON.stringify({ mode: window.TOWN.mode, before, after, cancelled, banner: document.getElementById("banner").hidden ? "" : document.getElementById("banner").textContent, errors: window.TOWN.errors });
})()
