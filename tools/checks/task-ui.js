// Run in the page (demo town): opens the task card, types a task, attaches two files the way a drop would, and
// reports what the card shows. Sends nothing.
(async () => {
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  [...document.querySelectorAll(".dock button")].find((button) => button.textContent.includes("派活")).click();
  await wait(300);
  const card = document.getElementById("task");
  const words = card.querySelector("textarea");
  words.value = "把附件里的需求整理成一份待办清单，按优先级排好，写进 TODO.md。\n截图里标红的那个按钮先改。";
  words.dispatchEvent(new Event("input", { bubbles: true }));
  // A small picture drawn here, and a text file: what a person would drag in.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const pen = canvas.getContext("2d");
  pen.fillStyle = "#f0a560";
  pen.fillRect(0, 0, 64, 64);
  pen.fillStyle = "#d9534a";
  pen.fillRect(18, 22, 28, 18);
  const picture = await new Promise((done) => canvas.toBlob(done, "image/png"));
  const carried = new DataTransfer();
  carried.items.add(new File([picture], "界面截图.png", { type: "image/png" }));
  carried.items.add(new File(["# 需求\n\n1. 登录页的按钮太小\n2. 导出要支持 CSV\n"], "需求说明.md", { type: "text/markdown" }));
  carried.items.add(new File([""], "空的.txt", { type: "text/plain" }));
  window.dispatchEvent(new DragEvent("drop", { dataTransfer: carried, bubbles: true, cancelable: true }));
  await wait(1500);
  return JSON.stringify({
    shown: !card.hidden,
    to: card.querySelector("select")?.selectedOptions[0]?.textContent,
    chips: [...card.querySelectorAll(".attach")].map((chip) => `${chip.className.replace("attach ", "")}: ${chip.querySelector("b").textContent} · ${chip.querySelector("span:not(.kind)").textContent}`),
    count: card.querySelector(".remain").textContent,
    hint: card.querySelector(".sendrow p").textContent,
    button: card.querySelector(".go").textContent + (card.querySelector(".go").disabled ? "（不能点）" : ""),
    errors: window.TOWN.errors,
  });
})()
