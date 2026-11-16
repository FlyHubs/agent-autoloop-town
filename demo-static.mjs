// Lets the page stand on its own, with no server behind it: on a static site it shows the town on demo data made here in
// the browser. The town's own server takes this file's tag out of the page, so there it is never loaded.
//
// How it knows: the server fills in the page's settings, and a static site leaves them as the server's marks.
import { demoWorld } from "./demo-world.mjs";

if (/^__TOWN_/.test(window.TOWN?.mode ?? "")) {
  const world = demoWorld();
  window.TOWN = { token: "static", mode: "demo", hub: "", tasks: "town" };
  const real = window.fetch.bind(window);
  const answer = (status, value) => new Response(typeof value === "string" ? value : JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  const refuse = (status, error) => answer(status, { error });
  const bodyOf = (init) => {
    try {
      return typeof init.body === "string" && init.body ? JSON.parse(init.body) : {};
    } catch {
      return {};
    }
  };
  let uploads = 0;

  /** What the town's server would say to each thing the page asks of it, said here instead. */
  async function stand(route, search, init) {
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET" && route === "/api/state") return answer(200, world.state());
    if (method === "GET" && route === "/api/day") return answer(200, world.day(Number(search.get("since")) || 0));
    if (method === "GET" && route === "/api/models") return real(new URL("models/index.json", document.baseURI));
    if (method === "GET" && route === "/api/stream") {
      const after = Number(search.get("after"));
      const words = new TextEncoder();
      const gone = new AbortController();
      init.signal?.addEventListener("abort", () => gone.abort());
      const body = new ReadableStream({
        start(stream) {
          const write = (text) => {
            try {
              stream.enqueue(words.encode(text));
            } catch {
              gone.abort();
            }
          };
          write(": 接上了\n\n");
          world.stream(Number.isSafeInteger(after) ? after : 0, (fact) => write(`id: ${fact.seq}\nevent: fact\ndata: ${JSON.stringify(fact)}\n\n`), gone.signal);
          gone.signal.addEventListener("abort", () => {
            try {
              stream.close();
            } catch {
              // Closed already.
            }
          });
        },
        cancel: () => gone.abort(),
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
    }
    const round = /^\/api\/runs\/([1-9][0-9]*)\/steps$/.exec(route);
    if (method === "GET" && round) return answer(200, { steps: world.steps(Number(round[1])) });
    const card = /^\/api\/cards\/([1-9][0-9]*)\/answer$/.exec(route);
    if (method === "POST" && card) {
      const given = bodyOf(init);
      const said = {};
      if (Number.isInteger(given.choice) && given.choice >= 0) said.choice = given.choice;
      if (typeof given.text === "string" && given.text.trim()) said.text = given.text.trim().slice(0, 4000);
      const done = world.answer(Number(card[1]), said);
      return answer(done.status, done.text);
    }
    if (method === "POST" && route === "/api/tasks") {
      const given = bodyOf(init);
      const text = typeof given.text === "string" ? given.text.trim() : "";
      if (typeof given.type !== "string" || !/^task(\.[a-z0-9_-]+)+$/.test(given.type)) return refuse(400, "类型要是 task. 开头");
      if (!text || [...text].length > 4000) return refuse(400, "任务要写，最多 4000 字");
      const files = Array.isArray(given.files) ? given.files.length : 0;
      const tail = files ? ` 〔附件 ${files}〕` : "";
      return answer(200, world.task(given.type, [...text].slice(0, 200 - [...tail].length).join("") + tail));
    }
    const rule = /^\/api\/rules\/([^/]+)\/run$/.exec(route);
    if (method === "POST" && rule) {
      const done = world.run(decodeURIComponent(rule[1]));
      return answer(done.status, done.text);
    }
    // A file given with a task goes nowhere here: there is no working folder to put it in. It is only counted.
    if (method === "POST" && route === "/api/uploads") {
      const size = init.body?.size ?? init.body?.byteLength ?? 0;
      if (!size) return refuse(400, "这个文件是空的");
      if (size > 20 * 1024 * 1024) return refuse(413, "单个附件最多 20 MB");
      return answer(200, { id: String(++uploads).padStart(24, "0"), name: (search.get("name") ?? "附件").split(/[\\/]/).pop().slice(-100) || "附件", size });
    }
    if (method === "DELETE" && /^\/api\/uploads\/[0-9a-f]{24}$/.test(route)) return answer(200, { ok: true });
    // The weather is asked of Open-Meteo straight from the browser, and only once a city has been typed in.
    if (method === "GET" && route === "/api/weather") {
      const city = (search.get("city") ?? "").trim();
      if (!city || [...city].length > 40) return refuse(400, "城市要写，最多 40 个字");
      try {
        const ask = async (url) => (await real(url, { signal: AbortSignal.timeout(15_000) })).json();
        const place = (await ask(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`)).results?.[0];
        if (!place) return refuse(502, "没找到这个城市");
        const now = (await ask(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code,is_day&timezone=auto`)).current;
        if (!now) return refuse(502, "天气服务没给数据");
        return answer(200, { city: place.name, temperature: Math.round(now.temperature_2m), code: now.weather_code, isDay: Boolean(now.is_day) });
      } catch {
        return refuse(502, "天气服务连不上");
      }
    }
    return refuse(404, "没有这个地址");
  }

  window.fetch = (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, document.baseURI);
    const at = url.pathname.lastIndexOf("/api/");
    if (url.origin !== location.origin || at < 0) return real(input, init);
    return stand(url.pathname.slice(at), url.searchParams, init);
  };
}
