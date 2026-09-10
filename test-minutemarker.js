/*
 * Test suite for MinuteMarker (../index.html)
 *
 *   cd test && npm install jsdom && node test-minutemarker.js
 *
 * Drives the real page in jsdom with a fake clock, a manually pumped
 * requestAnimationFrame and a stubbed scrollTop, so run-loop timing and
 * picker scroll positions are both deterministic.
 */
const fs = require("fs");
const { JSDOM } = require("jsdom");

function boot(opts = {}) {
  const html = fs.readFileSync(opts.file || __dirname + "/../index.html", "utf8");
  const state = { rafs: new Map(), nextRaf: 1, blobs: new Map(), plays: [], now: 1700000000000, seq: 0 };

  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://example.test/",
    beforeParse(w) {
      w.matchMedia = q => ({ matches: false, media: q, addListener(){}, removeListener(){} });

      w.URL.createObjectURL = blob => {
        const id = "blob:stub/" + (++state.seq);
        state.blobs.set(id, blob);
        return id;
      };
      w.URL.revokeObjectURL = id => { state.blobs.delete(id); };

      const media = w.HTMLMediaElement.prototype;
      media.play = function () { state.plays.push(this.src); this.paused = false; return Promise.resolve(); };
      media.pause = function () { this.paused = true; };
      media.load = function () {};
      Object.defineProperty(media, "currentTime", {
        get(){ return this._ct || 0; }, set(v){ this._ct = v; }, configurable: true
      });
      Object.defineProperty(media, "paused", {
        get(){ return this._p !== false; }, set(v){ this._p = v; }, configurable: true
      });

      w.requestAnimationFrame = cb => { const id = state.nextRaf++; state.rafs.set(id, cb); return id; };
      w.cancelAnimationFrame = id => { state.rafs.delete(id); };

      w.Date.now = () => state.now;
      w.scrollTo = () => {};
      // jsdom has no layout, so scrollTop is a permanent 0 — make it a real value
      Object.defineProperty(w.HTMLElement.prototype, "scrollTop", {
        get(){ return this._scrollTop || 0; },
        set(v){ this._scrollTop = v; this.dispatchEvent(new w.Event("scroll")); },
        configurable: true
      });
      state.visibility = "visible";
      Object.defineProperty(w.Document.prototype, "visibilityState", {
        get(){ return state.visibility; }, configurable: true
      });
      Object.defineProperty(w.Document.prototype, "hidden", {
        get(){ return state.visibility === "hidden"; }, configurable: true
      });
      w.HTMLElement.prototype.scrollIntoView = () => {};

      if (opts.storage) for (const k in opts.storage) w.localStorage.setItem(k, opts.storage[k]);
    }
  });

  const w = dom.window;
  // top-level const/let are lexical globals, not window properties — reach them via eval
  const api = w.eval(`({
    getS: () => S, getPresets: () => presets, run,
    total, sum, clamp, fmt, splitEven,
    SOUNDS, FULL, PALETTE, spansFor, normWeights, colorsFor,
    hexToHsl, hslToHex, makePalette, silentWav, renderInto, buildTrack,
    makeDisk, drawDisk, setTotal, setCount, setSlices, refresh, fitSlices,
    freeTrack, setTrackOK: v => { trackOK = v; }, getTrackUrl: () => trackUrl,
    picker, openPicker, closePicker, pickerSeconds, setWheel,
    wheelIndexAt, wheelTopFor, wrapTo,
    WHEEL_ITEM, WHEEL_COPIES, WHEELS, MAX_PICK
  })`);

  return {
    dom, w, state, api,
    get S(){ return api.getS(); },
    get presets(){ return api.getPresets(); },
    get run(){ return api.run; },
    $: s => w.document.querySelector(s),
    all: s => [...w.document.querySelectorAll(s)],
    tick(ms = 16) {
      state.now += ms;
      const due = [...state.rafs.entries()];
      state.rafs.clear();
      for (const [, cb] of due) cb();
    },
    pending: () => state.rafs.size,
  };
}


let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};
const group = n => console.log("\n" + n);

/* open a duration control, spin the wheels, press Set */
function pick(h, control, hh, mm, ss){
  control.click();
  const c = h.api.picker.cols;
  h.api.setWheel(c.h, hh); h.api.setWheel(c.m, mm); h.api.setWheel(c.s, ss);
  h.$("#pickSet").click();
}

/* ── 1. pure helpers ─────────────────────────────────────────────── */
group("helpers");
{
  const h = boot(), w = h.w, a = h.api;
  const { fmt, splitEven, sum, clamp } = h.api;
  ok("fmt 0", fmt(0) === "0:00", fmt(0));
  ok("fmt 59.4", fmt(59.4) === "1:00", fmt(59.4));
  ok("fmt 300", fmt(300) === "5:00", fmt(300));
  ok("fmt 3600", fmt(3600) === "1:00:00", fmt(3600));
  ok("fmt 3661", fmt(3661) === "1:01:01", fmt(3661));
  ok("fmt negative", fmt(-5) === "0:00", fmt(-5));
  ok("splitEven exact", JSON.stringify(splitEven(300, 3)) === "[100,100,100]");
  ok("splitEven remainder", JSON.stringify(splitEven(100, 3)) === "[34,33,33]", splitEven(100, 3));
  ok("splitEven sums", sum(splitEven(1001, 7)) === 1001);
  ok("clamp", clamp(5, 1, 3) === 3 && clamp(0, 1, 3) === 1 && clamp(2, 1, 3) === 2);
}

/* ── 2. colour ───────────────────────────────────────────────────── */
group("colour");
{
  const h = boot(), w = h.w, a = h.api;
  const { hexToHsl, hslToHex, makePalette } = h.api;
  const round = ([h, s, l]) => [Math.round(h), Math.round(s), Math.round(l)];
  ok("hsl red", JSON.stringify(round(hexToHsl("#FF0000"))) === "[0,100,50]", round(hexToHsl("#FF0000")));
  ok("hsl grey has 0 sat", round(hexToHsl("#808080"))[1] === 0);
  ok("hex roundtrip", hslToHex(...hexToHsl("#63A80F")).toLowerCase() === "#63a80f", hslToHex(...hexToHsl("#63A80F")));
  const p = makePalette("#E5352B", 6, 0);
  ok("palette length", p.length === 6);
  ok("palette keeps base first", p[0] === "#E5352B", p[0]);
  ok("palette all valid hex", p.every(c => /^#[0-9a-f]{6}$/i.test(c)), p);
  ok("palette distinct", new Set(p).size === 6, p);
  const sh = makePalette("#E5352B", 6, 3);
  ok("shuffled differs", sh[0] !== "#E5352B" && sh.every(c => /^#[0-9a-f]{6}$/i.test(c)), sh);
  ok("palette of 1", makePalette("#0E9BD1", 1, 0).length === 1);
}

/* ── 3. config normalisation ─────────────────────────────────────── */
group("applyConfig");
{
  const bad = {
    durations: ["abc", -50, 120], count: 99, slices: 40,
    base: "not-a-colour", sliceColors: ["#E5352B"], sliceDurs: [1, 2],
    sound: "nope", volume: 17, repeat: "yes"
  };
  const h = boot({ storage: { "minutemarker.cfg": JSON.stringify(bad) } });
  const S = h.S;
  ok("durations coerced", JSON.stringify(S.durations) === "[0,0,120]", S.durations);
  ok("count follows durations", S.count === 3, S.count);
  ok("slices clamped to 16", S.slices === 16, S.slices);
  ok("base falls back", S.base === "#E5352B", S.base);
  ok("sliceColors grown to slices", S.sliceColors.length >= 16, S.sliceColors.length);
  ok("sliceDurs rebuilt to slices", S.sliceDurs.length === 16, S.sliceDurs.length);
  ok("sound falls back", S.sound === "chime", S.sound);
  ok("volume clamped", S.volume === 1, S.volume);
  ok("toggle coerced to bool", S.repeat === true);
  ok("page still rendered", h.$("#preview").querySelectorAll("path").length === 16,
     h.$("#preview").querySelectorAll("path").length);
}
{
  const h = boot({ storage: { "minutemarker.cfg": "{{{ broken json" } });
  ok("broken JSON → defaults", h.S.durations[0] === 300 && h.api.total() === 300);
}
{
  const h = boot({ storage: { "minutemarker.cfg": JSON.stringify({ durations: [] }) } });
  ok("empty durations → default", h.api.total() === 300, h.api.total());
}

/* ── 4. setup interactions ───────────────────────────────────────── */
group("setup");
{
  const h = boot(), w = h.w, a = h.api;
  const chips = h.all("#quickChips .chip");
  ok("10 quick chips", chips.length === 10, chips.length);
  chips[4].click();                                   // 10 min
  ok("chip sets total", a.total() === 600, a.total());
  ok("field shows the total", h.$("#totalField").textContent === "10:00");

  h.$("#cPlus").click(); h.$("#cPlus").click();        // 3 timers
  ok("count 3", h.S.count === 3, h.S.count);
  ok("split evenly", JSON.stringify(h.S.durations) === "[200,200,200]", h.S.durations);
  ok("total preserved", a.total() === 600);
  ok("3 duration rows", h.all("#durList .lrow").length === 3);
  ok("seq hint shown", h.$("#seqHint").hidden === false);
  ok("colours cover timers", h.S.sliceColors.length >= 3);

  h.$("#cMinus").click();
  ok("count 2", h.S.count === 2 && a.total() === 600, [h.S.count, a.total()]);

  h.$("#sPlus").click(); h.$("#sPlus").click(); h.$("#sPlus").click();   // 4 slices
  ok("slices 4", h.S.slices === 4, h.S.slices);
  ok("sliceDurs fit first timer", a.sum(h.S.sliceDurs) === h.S.durations[0], [h.S.sliceDurs, h.S.durations[0]]);
  const spans = a.spansFor();
  ok("4 spans", spans.length === 4);
  ok("spans cover 360", Math.abs(spans[0][1] - 360) < 1e-9 && Math.abs(spans[3][0]) < 1e-9, spans);
  ok("spans contiguous", spans.every((s, i) => i === 0 || Math.abs(s[1] - spans[i - 1][0]) < 1e-9), spans);
  ok("preview has 4 wedges", h.$("#preview").querySelectorAll("path").length === 4);
  ok("4 slice rows", h.all("#sliceList .lrow").length === 4);
  ok("4 slice swatches", h.all("#sliceSwatches .sw").length === 4);

  h.$("#sMinus").click();
  ok("slices 3", h.S.slices === 3 && a.spansFor().length === 3);

  // stepper limits
  const h2 = boot(), w2 = h2.w;
  for (let i = 0; i < 30; i++) w2.document.querySelector("#cPlus").click();
  ok("count capped at 16", h2.S.count === 16, h2.S.count);
  for (let i = 0; i < 30; i++) w2.document.querySelector("#cMinus").click();
  ok("count floored at 1", h2.S.count === 1, h2.S.count);
  for (let i = 0; i < 30; i++) w2.document.querySelector("#sPlus").click();
  ok("slices capped at 16", h2.S.slices === 16, h2.S.slices);
  for (let i = 0; i < 30; i++) w2.document.querySelector("#sMinus").click();
  ok("slices floored at 1", h2.S.slices === 1, h2.S.slices);
}
{
  // setting the total through the picker
  const h = boot(), w = h.w, a = h.api;
  pick(h, h.$("#totalField"), 0, 2, 30);
  ok("picked total", a.total() === 150, a.total());
  ok("field updated", h.$("#totalField").textContent === "2:30");
  pick(h, h.$("#totalField"), 1, 5, 9);
  ok("hours included", a.total() === 3909, a.total());
  ok("field shows hours", h.$("#totalField").textContent === "1:05:09", h.$("#totalField").textContent);
  pick(h, h.$("#totalField"), 0, 0, 0);
  ok("zero allowed", a.total() === 0);
  ok("start disabled at 0", h.$("#startBtn").disabled === true);
  pick(h, h.$("#totalField"), 0, 3, 0);
  ok("start re-enabled", h.$("#startBtn").disabled === false);
  ok("persisted", a.sum(JSON.parse(w.localStorage.getItem("minutemarker.cfg")).durations) === 180);
}
{
  // editing a per-timer row, then slice rows
  const h = boot(), w = h.w, a = h.api;
  h.$("#cPlus").click();
  pick(h, h.all("#durList button.t")[0], 0, 1, 0);
  ok("row edit applied", h.S.durations[0] === 60, h.S.durations);
  ok("total recomputed", a.total() === 60 + 150, a.total());

  const h2 = boot(), w2 = h2.w, a2 = h2.api;   // single timer + slices
  h2.$("#sPlus").click();                    // 2 slices of 150
  pick(h2, h2.all("#sliceList button.t")[0], 0, 4, 0);
  ok("slice edit applied", h2.S.sliceDurs[0] === 240, h2.S.sliceDurs);
  ok("single-timer total follows slices", a2.total() === a2.sum(h2.S.sliceDurs), [a2.total(), h2.S.sliceDurs]);
  ok("slice weights reshape spans", Math.abs(a2.spansFor()[0][0] - (1 - 240 / a2.total()) * 360) < 1e-9);
}
{
  // fitSlices keeps proportions and stays exact
  const h = boot(), w = h.w, a = h.api;
  h.$("#sPlus").click(); h.$("#sPlus").click();     // 3 slices of 300
  h.S.sliceDurs = [150, 100, 50];
  a.setTotal(600);
  ok("fitSlices sums exactly", a.sum(h.S.sliceDurs) === 600, h.S.sliceDurs);
  ok("fitSlices keeps ratio", JSON.stringify(h.S.sliceDurs) === "[300,200,100]", h.S.sliceDurs);
  a.setTotal(7);
  ok("fitSlices odd total", a.sum(h.S.sliceDurs) === 7, h.S.sliceDurs);
  a.setTotal(0);
  ok("fitSlices zero total", a.sum(h.S.sliceDurs) === 0, h.S.sliceDurs);
}

/* ── 5. colour picking & toggles ─────────────────────────────────── */
group("colour picking & toggles");
{
  const h = boot(), w = h.w, a = h.api;
  const sws = h.all("#palette .sw");
  ok("12 swatches", sws.length === 12);
  ok("first selected by default", sws[0].classList.contains("sel"));
  sws[5].click();
  ok("base changed", h.S.base === "#0E9BD1", h.S.base);
  ok("selection moved", sws[5].classList.contains("sel") && !sws[0].classList.contains("sel"));
  ok("accent var follows", w.document.documentElement.style.getPropertyValue("--accent") === "#0E9BD1");
  ok("persisted", JSON.parse(w.localStorage.getItem("minutemarker.cfg")).base === "#0E9BD1");

  h.$("#sPlus").click();
  const before = h.S.sliceColors.join();
  h.$("#shuffleBtn").click();
  ok("shuffle changes palette", h.S.sliceColors.join() !== before);
  ok("shuffle keeps length", h.S.sliceColors.length >= h.S.slices);

  const toggles = h.all("#toggles .toggle");
  ok("4 toggles", toggles.length === 4);
  ok("toggles are buttons", toggles.every(t => t.tagName === "BUTTON"));
  ok("toggles have switch role", toggles.every(t => t.getAttribute("role") === "switch"));
  ok("aria reflects state", toggles[0].getAttribute("aria-checked") === "false"
    && toggles[2].getAttribute("aria-checked") === "true");
  toggles[0].click();
  ok("toggle flips state", h.S.repeat === true);
  ok("toggle flips aria", toggles[0].getAttribute("aria-checked") === "true");
  ok("toggle flips visual", toggles[0].lastChild.classList.contains("on"));
  ok("toggle persisted", JSON.parse(w.localStorage.getItem("minutemarker.cfg")).repeat === true);
}
{
  const h = boot(), w = h.w, a = h.api;
  const chips = h.all("#soundChips .chip");
  ok("8 sound chips", chips.length === 8, chips.length);
  ok("chime on by default", chips[0].classList.contains("on"));
  chips[3].click();
  ok("sound changed", h.S.sound === "beeps", h.S.sound);
  ok("chip state moved", chips[3].classList.contains("on") && !chips[0].classList.contains("on"));
  ok("summary updated", h.$("#sumSound").textContent === "Beeps · 100%", h.$("#sumSound").textContent);
  ok("picking a sound previews it", h.state.plays.length === 1);

  const v = h.$("#vol");
  v.value = "40";
  v.dispatchEvent(new w.Event("input"));
  ok("volume applied", Math.abs(h.S.volume - 0.4) < 1e-9, h.S.volume);
  ok("volume read", h.$("#volRead").textContent === "40%");
  v.dispatchEvent(new w.Event("change"));
  ok("volume summary", h.$("#sumSound").textContent === "Beeps · 40%", h.$("#sumSound").textContent);
  ok("volume persisted", JSON.parse(w.localStorage.getItem("minutemarker.cfg")).volume === 0.4);
}

/* ── 6. presets ──────────────────────────────────────────────────── */
group("presets");
{
  const h = boot(), w = h.w, a = h.api;
  ok("empty state", h.$("#presetList").textContent.includes("No presets yet"));
  ok("summary none", h.$("#sumPresets").textContent === "none yet");

  h.$("#cPlus").click();
  h.$("#presetName").value = "Pomodoro";
  h.$("#saveBtn").click();
  ok("one preset", h.presets.length === 1);
  ok("preset row", h.all("#presetList .lrow").length === 1);
  ok("summary count", h.$("#sumPresets").textContent === "1 saved");
  ok("loaded name", h.$("#loadedName").textContent === "· Pomodoro");
  ok("backup filled", h.$("#backup").value.includes("Pomodoro"));
  ok("stored", JSON.parse(w.localStorage.getItem("minutemarker.presets")).length === 1);

  h.$("#saveBtn").click();
  ok("same name overwrites", h.presets.length === 1);

  h.$("#presetName").value = "Tea";
  a.setTotal(180);
  h.$("#saveBtn").click();
  ok("second preset", h.presets.length === 2);

  // mutate away, then load the first back
  a.setTotal(999); h.$("#sPlus").click();
  h.all("#presetList button.nm")[0].click();
  ok("preset restores durations", a.total() === 300, a.total());
  ok("preset restores count", h.S.count === 2, h.S.count);
  ok("preset restores slices", h.S.slices === 1, h.S.slices);
  ok("preset name into field", h.$("#presetName").value === "Pomodoro");

  h.all("#presetList .x")[1].click();
  ok("delete works", h.presets.length === 1 && h.presets[0].name === "Pomodoro");
  h.all("#presetList .x")[0].click();
  ok("back to empty", h.presets.length === 0 && h.$("#presetList").textContent.includes("No presets yet"));
  ok("summary back to none", h.$("#sumPresets").textContent === "none yet");

  // unnamed save
  h.$("#presetName").value = "";
  h.$("#saveBtn").click();
  ok("auto name", h.presets[0].name === "Preset 1", h.presets[0].name);
}
{
  // backup import
  const h = boot(), w = h.w, a = h.api;
  h.$("#backup").value = JSON.stringify([{ name: "Imported", cfg: { durations: [60], count: 1 } }]);
  h.$("#loadBtn").click();
  ok("import accepted", h.presets.length === 1 && h.presets[0].name === "Imported");
  ok("import feedback", h.$("#loadBtn").textContent === "Loaded");

  h.$("#backup").value = "hello world";
  h.$("#loadBtn").click();
  ok("garbage rejected", h.presets.length === 1);
  ok("garbage feedback", h.$("#loadBtn").textContent.includes("isn't a preset list"));

  h.$("#backup").value = JSON.stringify([1, 2, 3]);
  h.$("#loadBtn").click();
  ok("wrong-shape array rejected", h.presets.length === 1);
}
{
  // a preset saved with a broken cfg must not take the app down
  const h = boot({ storage: { "minutemarker.presets": JSON.stringify([
    { name: "Old", cfg: { durations: [120, 120], count: 2, slices: 5, sliceColors: ["#E5352B"] } }
  ]) } });
  h.all("#presetList button.nm")[0].click();
  ok("legacy preset colours repaired", h.S.sliceColors.length >= 5, h.S.sliceColors.length);
  ok("legacy preset renders", h.$("#preview").querySelectorAll("path").length === 5);
  ok("legacy preset sliceDurs", h.S.sliceDurs.length === 5);
}
{
  const h = boot({ storage: { "minutemarker.presets": JSON.stringify({ nope: true }) } });
  ok("non-array presets ignored", Array.isArray(h.presets) && h.presets.length === 0);
}

/* ── 7. WAV building ─────────────────────────────────────────────── */
group("audio");
{
  const h = boot(), w = h.w, a = h.api;
  const { buf, pcm } = a.silentWav(1);
  ok("wav size", buf.length === 44 + 8000, buf.length);
  ok("pcm is a view, not a copy", pcm.buffer === buf.buffer && pcm.length === 8000);
  ok("RIFF tag", String.fromCharCode(...buf.slice(0, 4)) === "RIFF");
  ok("WAVE tag", String.fromCharCode(...buf.slice(8, 12)) === "WAVE");
  ok("fmt tag", String.fromCharCode(...buf.slice(12, 16)) === "fmt ");
  ok("data tag", String.fromCharCode(...buf.slice(36, 40)) === "data");
  const dv = new DataView(buf.buffer);
  ok("riff size", dv.getUint32(4, true) === 36 + 8000);
  ok("pcm format", dv.getUint16(20, true) === 1);
  ok("mono", dv.getUint16(22, true) === 1);
  ok("sample rate", dv.getUint32(24, true) === 8000);
  ok("byte rate", dv.getUint32(28, true) === 8000);
  ok("block align", dv.getUint16(32, true) === 1);
  ok("8-bit", dv.getUint16(34, true) === 8);
  ok("data size", dv.getUint32(40, true) === 8000);
  ok("silence is 128", pcm.every(v => v === 128));

  a.renderInto(pcm, 0, a.SOUNDS.chime, 1);
  ok("render moves samples", pcm.some(v => v !== 128));
  ok("stays in 8-bit range", pcm.every(v => v >= 0 && v <= 255));
  const peak = Math.max(...pcm) - 128;
  ok("peak near full scale", peak > 90 && peak <= 127, peak);

  // quiet render should be quieter
  const q = a.silentWav(1);
  a.renderInto(q.pcm, 0, a.SOUNDS.chime, 0.2);
  ok("volume scales output", (Math.max(...q.pcm) - 128) < peak, [Math.max(...q.pcm) - 128, peak]);

  // out-of-range writes are ignored, not thrown
  const tiny = a.silentWav(0.05);
  a.renderInto(tiny.pcm, 10, a.SOUNDS.gong, 1);
  ok("late events clipped safely", tiny.pcm.every(v => v === 128));
  a.renderInto(tiny.pcm, -5, a.SOUNDS.gong, 1);
  ok("negative offsets safe", true);
}
{
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(60);
  const url = a.buildTrack();
  const blob = h.state.blobs.get(url);
  ok("track built", !!url);
  ok("track is wav", blob.type === "audio/wav");
  const snd = a.SOUNDS.chime;
  const expect = 44 + Math.ceil((60 + snd.len + 0.6) * 8000);
  ok("track length matches timer + tail", Math.abs(blob.size - expect) <= 1, [blob.size, expect]);

  h.S.repeat = true;
  const b2 = h.state.blobs.get(a.buildTrack());
  ok("repeat extends the track", b2.size > blob.size * 1.5, [blob.size, b2.size]);

  a.setTotal(3 * 3600);
  ok("over the cap → no track", a.buildTrack() === null);
}
{
  // baked tick offsets must line up with the on-screen slice boundaries
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(100);
  h.S.slices = 4; h.S.sliceDurs = [40, 30, 20, 10]; h.S.sliceChime = true;
  const weights = a.normWeights();
  const spans = a.spansFor();
  // slice k is empty once elapsed = 100 * (w0+...+wk)
  const emptyAt = weights.map((_, i) => 100 * weights.slice(0, i + 1).reduce((a, b) => a + b, 0));
  ok("first tick at 40 s", Math.abs(emptyAt[0] - 40) < 1e-9, emptyAt);
  // the same instant on the disk: remaining fraction hits the span's lower edge
  const fracAt = t => 1 - t / 100;
  ok("tick matches span edge", Math.abs(fracAt(emptyAt[0]) * 360 - spans[0][0]) < 1e-9,
     [fracAt(emptyAt[0]) * 360, spans[0][0]]);
  ok("second tick matches", Math.abs(fracAt(emptyAt[1]) * 360 - spans[1][0]) < 1e-9);
  ok("third tick matches", Math.abs(fracAt(emptyAt[2]) * 360 - spans[2][0]) < 1e-9);
  ok("last slice ends at 0", Math.abs(emptyAt[3] - 100) < 1e-9);
}

/* ── 8. the run loop ─────────────────────────────────────────────── */
group("run loop");
{
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(10);
  h.$("#startBtn").click();
  ok("run screen shown", h.$("#setup").hidden === true && h.$("#run").hidden === false);
  ok("one disk", h.all("#grid .cell").length === 1);
  ok("grid marked single", h.$("#grid").classList.contains("single"));
  ok("mode running", h.run.mode === "running");
  ok("button says Stop", h.$("#toggleBtn").textContent === "Stop");
  ok("track playing", h.state.plays.length === 1);
  ok("one frame queued", h.pending() === 1);

  h.tick(4000);
  ok("time counts down", h.$("#bigTime").textContent === "6:00".replace("6:00", "0:06"), h.$("#bigTime").textContent);
  const d = h.$("#grid path").getAttribute("d");
  ok("wedge shrinks", d && d.length > 0 && d !== "");
  ok("still one frame queued", h.pending() === 1, h.pending());

  h.tick(6100);
  ok("reaches zero", h.$("#bigTime").textContent === "0:00");
  ok("finished state", h.run.finished === true && h.run.mode === "finished");
  ok("subtitle", h.$("#subTime").textContent === "Time's up");
  ok("button says Dismiss", h.$("#toggleBtn").textContent === "Dismiss");
  ok("finished class", h.$("#run").classList.contains("finished"));
  ok("wedge cleared", h.$("#grid path").getAttribute("d") === "");
  ok("loop stops when finished", h.pending() === 0, h.pending());

  h.$("#toggleBtn").click();      // Dismiss
  ok("dismiss → ready", h.run.mode === "ready");
  ok("dismiss rewinds", h.$("#bigTime").textContent === "0:10");
  ok("dismiss says Start", h.$("#toggleBtn").textContent === "Start");
  ok("dismiss keeps loop stopped", h.pending() === 0);

  h.$("#toggleBtn").click();      // Start again
  ok("restart runs", h.run.mode === "running" && h.pending() === 1);
  h.tick(3000);
  ok("counts from zero again", h.$("#bigTime").textContent === "0:07", h.$("#bigTime").textContent);
}
{
  // pause / resume must not lose or gain time
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(60);
  h.$("#startBtn").click();
  h.tick(10000);
  ok("10 s in", h.$("#bigTime").textContent === "0:50", h.$("#bigTime").textContent);

  h.$("#toggleBtn").click();
  ok("paused", h.run.mode === "stopped");
  ok("paused label", h.$("#subTime").textContent === "Paused");
  ok("stage dimmed", h.$("#stage").classList.contains("paused"));
  ok("loop parked", h.pending() === 0, h.pending());

  h.state.now += 30000;           // 30 s go by while paused
  h.tick(0);
  ok("clock frozen while paused", h.$("#bigTime").textContent === "0:50", h.$("#bigTime").textContent);

  h.$("#toggleBtn").click();
  ok("resumed", h.run.mode === "running" && h.pending() === 1);
  h.tick(5000);
  ok("paused time not counted", h.$("#bigTime").textContent === "0:45", h.$("#bigTime").textContent);
}
{
  // the double-loop regression: Edit → Start must leave exactly one chain
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(60);
  h.$("#startBtn").click();
  ok("start: 1 frame", h.pending() === 1);
  h.tick(100);
  h.$("#editBtn").click();
  ok("edit stops the loop", h.pending() === 0, h.pending());
  ok("edit shows setup", h.$("#setup").hidden === false);
  h.$("#startBtn").click();
  ok("restart: still 1 frame", h.pending() === 1, h.pending());
  for (let i = 0; i < 5; i++) {
    h.tick(50);
    h.$("#editBtn").click();
    h.$("#startBtn").click();
  }
  ok("no loop multiplication after 5 cycles", h.pending() === 1, h.pending());
  h.tick(50);
  ok("still 1 after ticking", h.pending() === 1, h.pending());
}
{
  // reset mid-run
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(120);
  h.$("#startBtn").click();
  h.tick(30000);
  ok("30 s elapsed", h.$("#bigTime").textContent === "1:30");
  h.$("#resetBtn").click();
  ok("reset → ready", h.run.mode === "ready");
  ok("reset rewinds", h.$("#bigTime").textContent === "2:00", h.$("#bigTime").textContent);
  ok("reset parks the loop", h.pending() === 0);
  h.state.now += 60000;
  h.tick(0);
  ok("reset holds at zero elapsed", h.$("#bigTime").textContent === "2:00");
  h.$("#toggleBtn").click();
  h.tick(1000);
  ok("start after reset counts", h.$("#bigTime").textContent === "1:59", h.$("#bigTime").textContent);
}
{
  // multi-timer sequencing
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(30); h.$("#cPlus").click(); h.$("#cPlus").click();   // 3 × 10 s
  ok("3 × 10", JSON.stringify(h.S.durations) === "[10,10,10]", h.S.durations);
  h.$("#startBtn").click();
  ok("3 cells", h.all("#grid .cell").length === 3);
  ok("grid not single", !h.$("#grid").classList.contains("single"));
  ok("3 columns", h.$("#grid").style.gridTemplateColumns === "repeat(3,1fr)");

  h.tick(2000);
  let cells = h.all("#grid .cell");
  ok("first active", cells[0].className === "cell active", cells[0].className);
  ok("others pending", cells[1].className === "cell pending" && cells[2].className === "cell pending");
  ok("shows first timer's remainder", h.$("#bigTime").textContent === "0:08", h.$("#bigTime").textContent);
  ok("subtitle counts timers", h.$("#subTime").textContent === "Timer 1 of 3 · 0:28 left in total",
     h.$("#subTime").textContent);

  h.tick(9000);   // 11 s → into timer 2
  cells = h.all("#grid .cell");
  ok("first done", cells[0].className === "cell done", cells[0].className);
  ok("second active", cells[1].className === "cell active", cells[1].className);
  ok("index advanced", h.run.ti === 1, h.run.ti);
  ok("subtitle timer 2", h.$("#subTime").textContent.startsWith("Timer 2 of 3"), h.$("#subTime").textContent);
  ok("per-cell time shown", h.all("#grid .ct")[1].textContent === "0:09", h.all("#grid .ct")[1].textContent);
  ok("finished cell reads 0:00", h.all("#grid .ct")[0].textContent === "0:00");

  h.tick(20000);
  ok("all done", h.all("#grid .cell").every(c => c.className === "cell done"));
  ok("finished", h.run.finished === true);
}
{
  // grid column choices
  const cols = n => {
    const h = boot(), w = h.w, a = h.api;
    a.setTotal(600);
    for (let i = 1; i < n; i++) h.$("#cPlus").click();
    h.$("#startBtn").click();
    return h.$("#grid").style.gridTemplateColumns;
  };
  ok("1 → 1 col", cols(1) === "repeat(1,1fr)");
  ok("3 → 3 cols", cols(3) === "repeat(3,1fr)");
  ok("4 → 2 cols", cols(4) === "repeat(2,1fr)");
  ok("6 → 3 cols", cols(6) === "repeat(3,1fr)");
  ok("12 → 4 cols", cols(12) === "repeat(4,1fr)");
}
{
  // slice chime bookkeeping during a run (no baked track → live path)
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(100);
  h.S.slices = 4; h.S.sliceDurs = [40, 30, 20, 10];
  h.S.sliceChime = true;
  a.refresh();
  h.$("#startBtn").click();
  a.setTrackOK(false); a.freeTrack();          // force the live fallback
  ok("starts with all slices", h.run.si === 4, h.run.si);
  h.tick(41000);
  ok("one slice gone at 41 s", h.run.si === 3, h.run.si);
  h.tick(30000);
  ok("two gone at 71 s", h.run.si === 2, h.run.si);
  h.tick(20000);
  ok("three gone at 91 s", h.run.si === 1, h.run.si);
  ok("disk still has 4 wedges", h.$("#grid").querySelectorAll("path").length === 4);
}
{
  // the alarm repeat interval
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(2);
  h.S.repeat = true;
  h.$("#startBtn").click();
  h.tick(3000);
  ok("alarm interval armed", h.run.alarmId !== 0);
  h.$("#toggleBtn").click();                 // Dismiss
  ok("dismiss clears the alarm", h.run.alarmId === 0);
}
{
  // returning to a visible tab after the timer ran out while hidden
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(5);
  h.$("#startBtn").click();
  h.state.rafs.clear();                      // rAF frozen while hidden
  h.state.now += 20000;
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  ok("catches up on return", h.run.finished === true, h.run.mode);
  ok("shows zero", h.$("#bigTime").textContent === "0:00");
}
{
  // clicking the disks toggles, same as the button
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(60);
  h.$("#startBtn").click();
  h.$("#grid").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok("grid click pauses", h.run.mode === "stopped");
  h.$("#grid").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok("grid click resumes", h.run.mode === "running");
}
{
  // run title comes from the preset name
  const h = boot(), w = h.w, a = h.api;
  h.$("#presetName").value = "  Steeping tea  ";
  h.$("#startBtn").click();
  ok("title trimmed", h.$("#runTitle").textContent === "Steeping tea", h.$("#runTitle").textContent);
  h.$("#editBtn").click();
  h.$("#presetName").value = "";
  h.$("#startBtn").click();
  ok("title falls back", h.$("#runTitle").textContent === "Timer");
}

/* ── 9. disk geometry ────────────────────────────────────────────── */
group("disks");
{
  const h = boot(), w = h.w, a = h.api;
  const d = a.makeDisk(["#ff0000"], [[0, 360]]);
  ok("one path", d.paths.length === 1);
  ok("12 tick marks", d.svg.querySelectorAll("line").length === 12);
  ok("face, ring, hub", d.svg.querySelectorAll("circle").length === 3);
  a.drawDisk(d, 1);
  ok("full disk", d.paths[0].getAttribute("d") === a.FULL);
  a.drawDisk(d, 0);
  ok("empty disk", d.paths[0].getAttribute("d") === "");
  a.drawDisk(d, 0.5);
  ok("half disk", /^M 50 50 L/.test(d.paths[0].getAttribute("d")));
  a.drawDisk(d, 5);
  ok("frac clamped high", d.paths[0].getAttribute("d") === a.FULL);
  a.drawDisk(d, -1);
  ok("frac clamped low", d.paths[0].getAttribute("d") === "");

  // more spans than colours must still draw every span
  const d2 = a.makeDisk(["#ff0000", "#00ff00"], [[0, 90], [90, 180], [180, 270], [270, 360]]);
  ok("paths follow spans, not colours", d2.paths.length === 4);
  ok("colours cycle", d2.paths[2].getAttribute("fill") === "#ff0000");
  a.drawDisk(d2, 1);
  ok("all spans drawn", d2.paths.every(p => p.getAttribute("d") !== ""));
  a.drawDisk(d2, 0.5);
  ok("half: two wedges gone", d2.paths.filter(p => p.getAttribute("d") === "").length === 2);
}

/* ── 10. folds ───────────────────────────────────────────────────── */
group("folds");
{
  const h = boot(), w = h.w, a = h.api;
  const [fa, fb, fc] = ["#foldLayout", "#foldSound", "#foldPresets"].map(h.$);
  ok("all closed initially", !fa.open && !fb.open && !fc.open);
  fa.open = true; fa.dispatchEvent(new w.Event("toggle"));
  ok("stored open fold", w.localStorage.getItem("minutemarker.fold") === "foldLayout");
  fb.open = true; fb.dispatchEvent(new w.Event("toggle"));
  ok("opening one closes the others", !fa.open && fb.open && !fc.open);
  ok("stored moved", w.localStorage.getItem("minutemarker.fold") === "foldSound");
  fb.open = false; fb.dispatchEvent(new w.Event("toggle"));
  ok("closing clears storage", w.localStorage.getItem("minutemarker.fold") === "");
}
{
  const h = boot({ storage: { "minutemarker.fold": "foldPresets" } });
  ok("restores the saved fold", h.$("#foldPresets").open === true);
}
{
  const h = boot({ storage: { "minutemarker.fold": "notAFold" } });
  ok("ignores an unknown fold", ["#foldLayout", "#foldSound", "#foldPresets"].every(s => !h.$(s).open));
}

/* ── 11. dead code / hygiene ─────────────────────────────────────── */
group("hygiene");
{
  const src = require("fs").readFileSync(__dirname + "/../index.html", "utf8");
  const css = src.match(/<style>([\s\S]*?)<\/style>/)[1];
  const selectors = [...css.matchAll(/^\s*([.#][A-Za-z][\w.#\s>+,:-]*)\s*\{/gm)]
    .flatMap(m => m[1].split(",").map(s => s.trim()));
  const classes = new Set();
  for (const sel of selectors)
    for (const m of sel.matchAll(/\.([A-Za-z][\w-]*)/g)) classes.add(m[1]);

  const unused = [...classes].filter(c => {
    const re = new RegExp(`["'\`\\s.]${c}\\b`);
    // look for the class name anywhere in markup or script, outside the <style> block
    return !src.replace(css, "").match(re);
  });
  ok("no unused CSS classes", unused.length === 0, unused);

  ok("no localStorage outside the store wrapper",
     (src.match(/localStorage\./g) || []).length === 2, (src.match(/localStorage\./g) || []).length);
  ok("no inline style= in markup", (src.match(/<[^>]+ style="/g) || []).length === 0,
     src.match(/<[^>]+ style="/g));
  ok("no style.cssText in script", !src.includes("cssText"));
  ok("no maximum-scale", !src.includes("maximum-scale"));
  ok("no innerHTML", !src.includes("innerHTML"));
  ok("strict mode", src.includes('"use strict"'));
}

/* ── 12. audio lifetime & no double-sounding ─────────────────────── */
group("audio lifetime");
{
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(5);
  h.$("#startBtn").click();
  const url = a.getTrackUrl();
  ok("track url held", !!url && h.state.blobs.has(url));
  const playsBefore = h.state.plays.length;
  h.tick(6000);
  ok("finished", h.run.finished === true);
  ok("baked track means no live cue at finish", h.state.plays.length === playsBefore,
     h.state.plays.length - playsBefore);
  h.$("#editBtn").click();
  ok("track blob revoked on edit", !h.state.blobs.has(url));
  ok("track url cleared", a.getTrackUrl() === null);
}
{
  // with no baked track the loop has to sound the chimes itself
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(5);
  h.$("#startBtn").click();
  a.freeTrack();
  const before = h.state.plays.length;
  h.tick(6000);
  ok("live fallback fires the alarm", h.state.plays.length === before + 1,
     h.state.plays.length - before);
}
{
  // between-timer chime, live path only
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(20); h.$("#cPlus").click();          // 2 × 10 s
  h.$("#startBtn").click();
  a.freeTrack();
  const before = h.state.plays.length;
  h.tick(11000);
  ok("between chime fires once", h.state.plays.length === before + 1,
     h.state.plays.length - before);
  h.tick(2000);
  ok("and not again", h.state.plays.length === before + 1);
}
{
  // cue blobs are recycled, not accumulated
  const h = boot(), w = h.w, a = h.api;
  const chips = h.all("#soundChips .chip");
  for (let i = 0; i < 8; i++) chips[i % chips.length].click();
  ok("only one cue blob alive", h.state.blobs.size === 1, h.state.blobs.size);
}
{
  // an oversized timer degrades to live audio instead of failing
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(3 * 3600);
  h.$("#startBtn").click();
  ok("no track for a 3 h timer", a.getTrackUrl() === null);
  ok("run still starts", h.run.mode === "running" && h.$("#run").hidden === false);
  h.tick(1000);
  ok("still counting", h.$("#bigTime").textContent === "2:59:59", h.$("#bigTime").textContent);
}

/* ── 13. backgrounding ───────────────────────────────────────────── */
group("backgrounding");
{
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(300);
  h.$("#startBtn").click();
  h.tick(10000);

  h.state.visibility = "hidden";
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  // while hidden the queued frame simply never fires; time still passes
  h.state.now += 120000;
  ok("nothing repaints while hidden", h.$("#bigTime").textContent === "4:50", h.$("#bigTime").textContent);

  h.state.visibility = "visible";
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  ok("catches up on return", h.$("#bigTime").textContent === "2:50", h.$("#bigTime").textContent);
  ok("frame still queued", h.pending() === 1, h.pending());
  ok("track nudged back into step", h.state.plays.length >= 2, h.state.plays.length);
  h.tick(100);
  ok("keeps running after the catch-up", h.pending() === 1 && h.run.mode === "running");
}
{
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(5);
  h.$("#startBtn").click();
  h.state.visibility = "hidden";
  h.state.now += 20000;                 // ran out while hidden
  h.state.visibility = "visible";
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  ok("finishes on return", h.run.finished === true && h.run.mode === "finished");
  ok("shows zero", h.$("#bigTime").textContent === "0:00");
  h.tick(100);
  ok("stale frame drains and stops", h.pending() === 0, h.pending());
}
{
  // returning while paused must not restart anything
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(60);
  h.$("#startBtn").click();
  h.tick(5000);
  h.$("#toggleBtn").click();
  h.state.now += 60000;
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  ok("stays paused", h.run.mode === "stopped");
  ok("clock untouched", h.$("#bigTime").textContent === "0:55", h.$("#bigTime").textContent);
  ok("loop stays parked", h.pending() === 0, h.pending());
}
{
  // visibility events before a run has started are ignored
  const h = boot(), w = h.w;
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  ok("no-op when idle", h.run.on === false && h.pending() === 0);
}

/* ── 14. duration picker ─────────────────────────────────────────── */
group("picker");
{
  const h = boot(), w = h.w, a = h.api;
  const cols = h.all("#wheelCols .wheelScroll");
  ok("three columns", cols.length === 3);
  ok("labelled h/m/s", h.$("#wheelLabels").textContent === "HoursMinutesSeconds",
     h.$("#wheelLabels").textContent);
  ok("hours run 0-23", cols[0].querySelectorAll(".wheelItem").length === 24 * 3);
  ok("minutes run 0-59", cols[1].querySelectorAll(".wheelItem").length === 60 * 3);
  ok("seconds run 0-59", cols[2].querySelectorAll(".wheelItem").length === 60 * 3);
  ok("values zero-padded", cols[0].querySelectorAll(".wheelItem")[7].textContent === "07");
  ok("band drawn once", h.all("#wheelCols .wheelBand").length === 1);
  ok("closed at boot", h.$("#picker").hidden === true && a.picker.open === false);

  // spinbutton semantics, not a 180-item listbox
  ok("role spinbutton", cols.every(c => c.getAttribute("role") === "spinbutton"));
  ok("hours max 23", cols[0].getAttribute("aria-valuemax") === "23");
  ok("minutes max 59", cols[1].getAttribute("aria-valuemax") === "59");
  ok("items hidden from AT", cols[0].querySelector(".wheelItem").getAttribute("aria-hidden") === "true");
  ok("dialog marked modal", h.$("#picker").getAttribute("aria-modal") === "true");
  ok("dialog labelled", h.$("#picker").getAttribute("aria-labelledby") === "pickerTitle");
}
{
  // scroll maths is pure arithmetic — no layout needed
  const h = boot(), a = h.api;
  ok("item height 44", a.WHEEL_ITEM === 44);
  ok("index 0 at top 0", a.wheelTopFor(0) === 0);
  ok("index 5 at 220", a.wheelTopFor(5) === 220);
  ok("exact position", a.wheelIndexAt(220) === 5);
  ok("rounds to nearest", a.wheelIndexAt(231) === 5 && a.wheelIndexAt(243) === 6, [a.wheelIndexAt(231), a.wheelIndexAt(243)]);
  ok("round trip", [0, 3, 17, 59, 179].every(i => a.wheelIndexAt(a.wheelTopFor(i)) === i));
  ok("wrap forward", a.wrapTo(60, 60) === 0 && a.wrapTo(61, 60) === 1);
  ok("wrap backward", a.wrapTo(-1, 60) === 59 && a.wrapTo(-61, 60) === 59);
}
{
  // opening seeds the wheels from the current value
  const h = boot(), w = h.w, a = h.api;
  a.openPicker(3725, "Total time", () => {});
  ok("opens", a.picker.open === true && h.$("#picker").hidden === false);
  ok("title set", h.$("#pickerTitle").textContent === "Total time");
  ok("hours seeded", a.picker.cols.h.value === 1, a.picker.cols.h.value);
  ok("minutes seeded", a.picker.cols.m.value === 2, a.picker.cols.m.value);
  ok("seconds seeded", a.picker.cols.s.value === 5, a.picker.cols.s.value);
  ok("reads back", a.pickerSeconds() === 3725);
  ok("body scroll locked", w.document.body.style.overflow === "hidden");
  ok("focus on first wheel", w.document.activeElement === a.picker.cols.h.el);

  // seeded into the middle copy, so there is room to scroll both ways
  ok("hours centred in middle copy", a.picker.cols.h.idx === 24 + 1, a.picker.cols.h.idx);
  ok("scrollTop matches", a.picker.cols.h.el.scrollTop === (24 + 1) * 44, a.picker.cols.h.el.scrollTop);
  ok("centre item marked", a.picker.cols.h.sel.classList.contains("sel"));
  ok("only one marked", h.all("#wheelCols .wheelScroll")[0].querySelectorAll(".sel").length === 1);
  a.closePicker();
  ok("closes", a.picker.open === false && h.$("#picker").hidden === true);
  ok("scroll lock released", w.document.body.style.overflow === "");
}
{
  // clamping on the way in
  const h = boot(), a = h.api;
  a.openPicker(999999, "x", () => {});
  ok("clamps to 23:59:59", a.pickerSeconds() === a.MAX_PICK, a.pickerSeconds());
  a.closePicker();
  a.openPicker(-50, "x", () => {});
  ok("clamps negatives to 0", a.pickerSeconds() === 0);
  a.closePicker();
  a.openPicker(NaN, "x", () => {});
  ok("survives NaN", a.pickerSeconds() === 0);
  a.closePicker();
}
{
  // keyboard, including wrap at both ends
  const h = boot(), w = h.w, a = h.api;
  const key = (col, k) => col.el.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  a.openPicker(0, "x", () => {});
  const { h: H, m: M, s: Sec } = a.picker.cols;

  key(H, "ArrowDown");
  ok("arrow down steps up", H.value === 1, H.value);
  key(H, "ArrowUp");
  ok("arrow up steps back", H.value === 0);
  key(H, "ArrowUp");
  ok("wraps 00 to 23", H.value === 23, H.value);
  key(H, "ArrowDown");
  ok("wraps 23 to 00", H.value === 0, H.value);
  key(M, "ArrowUp");
  ok("minutes wrap to 59", M.value === 59, M.value);
  key(M, "PageDown");
  ok("page down jumps 5", M.value === 4, M.value);
  key(M, "PageUp");
  ok("page up jumps 5", M.value === 59, M.value);
  key(Sec, "End");
  ok("End is the last value", Sec.value === 59);
  key(Sec, "Home");
  ok("Home is zero", Sec.value === 0);
  ok("keyboard keeps the middle copy", H.idx === H.value + 24 && M.idx === M.value + 60);
  ok("scrollTop follows the keyboard", M.el.scrollTop === M.idx * 44, M.el.scrollTop);
  a.closePicker();
}
{
  // scrolling drives the value, and settling re-centres for the wrap
  const h = boot(), w = h.w, a = h.api;
  a.openPicker(0, "x", () => {});
  const M = a.picker.cols.m;
  ok("starts in the middle copy", M.idx === 60);

  M.el.scrollTop = a.wheelTopFor(63);          // fires scroll in the harness
  ok("scroll sets the value", M.value === 3, M.value);
  ok("marker moved", M.sel === M.items[63]);

  M.el.scrollTop = a.wheelTopFor(5);           // drifted into the first copy
  ok("value still correct across copies", M.value === 5, M.value);
  ok("not yet re-centred", M.idx === 5);
  a.closePicker();
}

{
  // Set commits, Cancel and Escape do not
  const h = boot(), w = h.w, a = h.api;
  let got = null;
  a.openPicker(60, "x", v => { got = v; });
  a.setWheel(a.picker.cols.m, 7);
  h.$("#pickSet").click();
  ok("Set commits the value", got === 420, got);
  ok("Set closes", a.picker.open === false);

  got = null;
  a.openPicker(60, "x", v => { got = v; });
  a.setWheel(a.picker.cols.m, 7);
  h.$("#pickCancel").click();
  ok("Cancel discards", got === null);
  ok("Cancel closes", a.picker.open === false);

  got = null;
  a.openPicker(60, "x", v => { got = v; });
  h.$("#picker").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  ok("Escape discards", got === null && a.picker.open === false);

  got = null;
  a.openPicker(60, "x", v => { got = v; });
  a.setWheel(a.picker.cols.s, 9);
  a.picker.cols.s.el.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  ok("Enter commits", got === 69, got);

  got = null;
  a.openPicker(60, "x", v => { got = v; });
  h.$("#picker").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok("backdrop click cancels", got === null && a.picker.open === false);

  got = null;
  a.openPicker(60, "x", v => { got = v; });
  h.$("#pickSet").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok("clicking Set does not count as a backdrop click", got === 60, got);
}
{
  // focus is taken and given back
  const h = boot(), w = h.w, a = h.api;
  const field = h.$("#totalField");
  field.focus();
  field.click();
  ok("focus moves into the picker", w.document.activeElement === a.picker.cols.h.el);
  h.$("#pickCancel").click();
  ok("focus returns to the control", w.document.activeElement === field, w.document.activeElement.id);
}
{
  // Tab is trapped inside the sheet
  const h = boot(), w = h.w, a = h.api;
  a.openPicker(0, "x", () => {});
  const f = [...h.$("#picker").querySelectorAll(".wheelScroll, button")];
  ok("five focus stops", f.length === 5, f.length);
  f[f.length - 1].focus();
  h.$("#picker").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  ok("Tab wraps to the first", w.document.activeElement === f[0]);
  h.$("#picker").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  ok("Shift+Tab wraps to the last", w.document.activeElement === f[f.length - 1]);
  a.closePicker();
}
{
  // every duration control opens it, seeded and titled correctly
  const h = boot(), w = h.w, a = h.api;
  a.setTotal(600);
  h.$("#totalField").click();
  ok("total field opens it", a.picker.open === true);
  ok("seeded from the total", a.pickerSeconds() === 600);
  ok("titled Total time", h.$("#pickerTitle").textContent === "Total time");
  a.closePicker();

  h.$("#cPlus").click();                       // 2 timers of 300
  const rows = h.all("#durList button.t");
  ok("rows are buttons now", rows.length === 2 && rows[0].tagName === "BUTTON");
  ok("row shows its duration", rows[0].textContent === "5:00");
  ok("row is labelled for AT", rows[0].getAttribute("aria-label") === "Timer 1, 5:00. Tap to change");
  rows[1].click();
  ok("timer row opens it", a.picker.open === true);
  ok("seeded from that timer", a.pickerSeconds() === 300);
  ok("titled with the timer", h.$("#pickerTitle").textContent === "Timer 2");
  a.setWheel(a.picker.cols.m, 1);
  h.$("#pickSet").click();
  ok("commits to the right timer", JSON.stringify(h.S.durations) === "[300,60]", h.S.durations);

  h.$("#sPlus").click();                       // 2 slices
  const sl = h.all("#sliceList button.t");
  ok("slice rows are buttons", sl.length === 2 && sl[0].tagName === "BUTTON");
  sl[0].click();
  ok("slice row opens it", a.picker.open === true);
  ok("titled with the slice", h.$("#pickerTitle").textContent === "Slice 1");
  a.setWheel(a.picker.cols.m, 2);
  a.setWheel(a.picker.cols.s, 30);
  h.$("#pickSet").click();
  ok("commits to the slice", h.S.sliceDurs[0] === 150, h.S.sliceDurs);
}
{
  // no typing route left anywhere
  const h = boot();
  ok("no number inputs", h.all("input[type=number]").length === 0);
  ok("no text inputs in the lists", h.all("#durList input, #sliceList input").length === 0);
  ok("total field is a button", h.$("#totalField").tagName === "BUTTON");
  const src = require("fs").readFileSync(__dirname + "/../index.html", "utf8");
  ok("parseTime removed", !src.includes("parseTime"));
  ok("no #mins / #secs left", !src.includes('"#mins"') && !src.includes('"#secs"'));
}

(async () => {
  group("picker settling");
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const h = boot(), a = h.api;
  a.openPicker(0, "x", () => {});
  const M = a.picker.cols.m;

  M.el.scrollTop = a.wheelTopFor(4);           // drifted up into the first copy
  ok("value read across copies", M.value === 4, M.value);
  ok("not re-centred yet", M.idx === 4);
  await sleep(220);
  ok("settles back into the middle copy", M.idx === 64, M.idx);
  ok("value unchanged by the hop", M.value === 4, M.value);
  ok("scrollTop moved silently", M.el.scrollTop === 64 * 44, M.el.scrollTop);

  M.el.scrollTop = a.wheelTopFor(176);         // drifted down into the last copy
  ok("value read in the last copy", M.value === 56, M.value);
  await sleep(220);
  ok("settles again", M.idx === 116 && M.value === 56, [M.idx, M.value]);

  M.el.scrollTop = a.wheelTopFor(70);          // already central
  await sleep(220);
  ok("no hop when already central", M.idx === 70 && M.value === 10, [M.idx, M.value]);
  a.closePicker();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
