// ============================================================================
// hud.js — 鹈鹕海岸 · 追鱼 HUD (camera-hud owned, per src/CONTRACT.md §4.5)
//
//  - self-injects <style id="hud-style"> (all classes prefixed hud-)
//  - mounts itself into #hud-layer, Chinese UI, gold / deep-sea-blue glass look
//  - speedometer (SVG dial), fish / combo / score, day-phase, autopilot, camera
//  - 14 achievements panel (K), toasts + screen flash
//  - touch controls (coarse pointer or ?touch=1), cinematic letterbox, intro
//  - hot values are updated through textContent / attributes only (never innerHTML
//    per frame), everything is guarded so the HUD can run with missing callbacks.
// ============================================================================

let hudUid = 0;

const ICON = {
  mute:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.4h3.3L12 5.2v13.6l-4.7-4.2H4z" fill="currentColor"/><path class="hud-ico-wave" d="M15.3 8.7a4.9 4.9 0 0 1 0 6.6M17.9 6.1a8.4 8.4 0 0 1 0 11.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path class="hud-ico-mute-line" d="M4.6 19.4 19.4 4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="hud-ico-pause-a" x="7" y="5" width="3.6" height="14" rx="1.3" fill="currentColor"/><rect class="hud-ico-pause-b" x="13.4" y="5" width="3.6" height="14" rx="1.3" fill="currentColor"/><path class="hud-ico-play" d="M8.4 5.6 18.4 12 8.4 18.4z" fill="currentColor"/></svg>',
  restart:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.2 12a7.2 7.2 0 1 1-2.4-5.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M19.4 4.4v4.4h-4.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  camera:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7.2" width="18" height="11.6" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.2 7.2 9.5 4.9h5l1.3 2.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  fish:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.2 12c3.2-4.1 7.2-5.2 10.2-5.2 3 0 5.2 2.1 6.3 5.2-1.1 3.1-3.3 5.2-6.3 5.2-3 0-7-1.1-10.2-5.2Z" fill="#7fe3d8"/><path d="M19.4 10.2 22.6 7v10l-3.2-3.2Z" fill="#2ec4b6"/><circle cx="7.9" cy="10.9" r="1.05" fill="#0b1026"/><path d="M12.6 8.2c.9 1.1 1.4 2.5 1.4 3.8 0 1.3-.5 2.7-1.4 3.8" fill="none" stroke="#0b1026" stroke-opacity=".22" stroke-width="1.1"/></svg>',
  trophy:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 3.6h9.6v3.6a4.8 4.8 0 0 1-9.6 0V3.6Z" fill="#ffd9a0"/><path d="M7.2 4.6H4.1v1.7a3 3 0 0 0 3.1 3M16.8 4.6h3.1v1.7a3 3 0 0 1-3.1 3" fill="none" stroke="#ffb36b" stroke-width="1.4" stroke-linecap="round"/><path d="M12 12.2v3.4M8.6 19.6h6.8M10 16.4h4l.6 3.2H9.4l.6-3.2Z" fill="#ffb36b"/></svg>',
  info:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="#cfe3ff" stroke-width="1.6"/><path d="M12 10.6v5.2M12 7.5v.9" stroke="#cfe3ff" stroke-width="1.7" stroke-linecap="round"/></svg>',
};

// crisp SVG day-phase icons (emoji glyphs render inconsistently across platforms)
const PHASE_ICON = {
  黄昏:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 17.4h19" stroke="#ffb36b" stroke-width="1.5" stroke-linecap="round" fill="none"/><circle cx="12" cy="13.2" r="4.1" fill="#ffcf8a"/><path d="M12 4.6v2.1M5.2 7.4l1.5 1.5M18.8 7.4l-1.5 1.5" stroke="#ffb36b" stroke-width="1.4" stroke-linecap="round"/></svg>',
  日落:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 17.4h19" stroke="#ff9b6b" stroke-width="1.5" stroke-linecap="round" fill="none"/><path d="M7.6 17.2a4.4 4.4 0 0 1 8.8 0Z" fill="#ff8f6b"/><path d="M12 5.4v2.2M5.4 8.2l1.5 1.5M18.6 8.2l-1.5 1.5" stroke="#ff9b6b" stroke-width="1.3" stroke-linecap="round"/></svg>',
  蓝调:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.6 4.2a7.4 7.4 0 1 0 4.2 10.6 8.6 8.6 0 0 1-4.2-10.6Z" fill="#8fb8ff"/><path d="M5.2 6.2l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5Z" fill="#cfe3ff"/><circle cx="18.6" cy="5.6" r="1" fill="#cfe3ff"/></svg>',
  深夜:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.2 4a7.2 7.2 0 1 0 3.6 9.8A8.4 8.4 0 0 1 16.2 4Z" fill="#dbe7ff"/><circle cx="6.4" cy="6.2" r="1" fill="#ffe6a8"/><circle cx="9.2" cy="3.4" r=".7" fill="#cfe3ff"/><circle cx="4.6" cy="10.4" r=".8" fill="#cfe3ff"/></svg>',
  拂晓:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 17.4h19" stroke="#7fe3d8" stroke-width="1.5" stroke-linecap="round" fill="none"/><path d="M7.6 17.2a4.4 4.4 0 0 1 8.8 0Z" fill="#ffd9a0"/><path d="M12 4.8v2.4M5.2 7.6l1.6 1.6M18.8 7.6l-1.6 1.6" stroke="#ffd9a0" stroke-width="1.3" stroke-linecap="round"/><path d="M12 10.4l1.1 2 2 .3-1.5 1.5.4 2-2-1.1-2 1.1.4-2-1.5-1.5 2-.3 1.1-2Z" fill="#7fe3d8" fill-opacity=".55"/></svg>',
};

const CSS = `
.hud-root{
  --hud-ink:#0b1026;
  --hud-gold:#ffd9a0;
  --hud-gold-2:#ffb36b;
  --hud-sea:#2ec4b6;
  --hud-red:#ff5c5c;
  --hud-line:rgba(255,227,190,.16);
  --hud-line-2:rgba(255,227,190,.3);
  --hud-glass:linear-gradient(158deg,rgba(22,31,60,.72),rgba(8,12,28,.62));
  position:absolute;inset:0;z-index:5;pointer-events:none;
  font-family:var(--font);color:var(--paper,#f6f1e7);
  font-variant-numeric:tabular-nums;
  -webkit-user-select:none;user-select:none;
  -webkit-touch-callout:none;
  text-shadow:0 1px 2px rgba(3,6,18,.45);
}
#hud-layer > .hud-root{pointer-events:none;}

.hud-root button{font-family:inherit;color:inherit;-webkit-user-select:none;user-select:none;}
.hud-emoji{font-style:normal;line-height:1;}

/* ------------------------------------------------ letterbox */
.hud-cinebar{position:absolute;left:0;right:0;height:0;background:#04060f;pointer-events:none;transition:height .35s cubic-bezier(.4,0,.2,1);}
.hud-cinebar-top{top:0;box-shadow:0 8px 28px rgba(0,0,0,.4);}
.hud-cinebar-bottom{bottom:0;box-shadow:0 -8px 28px rgba(0,0,0,.4);}
.hud-root.hud-cine .hud-cinebar{height:7.2vh;}

/* ------------------------------------------------ top bar */
.hud-top{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:14px 16px;pointer-events:none;}
.hud-topleft{display:flex;flex-direction:column;align-items:flex-start;gap:8px;min-width:0;}

.hud-phase{display:flex;align-items:center;gap:9px;padding:7px 12px 7px 9px;border-radius:13px;background:var(--hud-glass);border:1px solid var(--hud-line);backdrop-filter:blur(10px) saturate(1.15);box-shadow:0 10px 26px rgba(2,5,16,.35),inset 0 1px 0 rgba(255,255,255,.06);}
.hud-phase-icon{width:20px;height:20px;display:grid;place-items:center;filter:drop-shadow(0 0 9px rgba(255,179,107,.45));}
.hud-phase-icon svg{width:20px;height:20px;display:block;}
.hud-phase-text{display:flex;flex-direction:column;line-height:1.1;min-width:52px;}
.hud-phase-name{font-size:12px;font-weight:700;letter-spacing:.16em;color:#ffe6c4;}
.hud-phase-sub{font-size:8.5px;letter-spacing:.1em;color:rgba(246,241,231,.45);margin-top:3px;}
.hud-phase-track{width:46px;height:2px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden;margin-left:2px;}
.hud-phase-bar{display:block;width:100%;height:100%;border-radius:2px;background:linear-gradient(90deg,var(--hud-gold-2),var(--hud-gold));transform-origin:left center;transform:scaleX(0);}

.hud-auto{display:flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;font-size:9px;font-weight:600;letter-spacing:.24em;color:#ffd9a0;background:rgba(255,179,107,.12);border:1px solid rgba(255,179,107,.3);opacity:0;transform:translateY(-4px);transition:opacity .3s ease,transform .3s ease;}
.hud-root.hud-auto-on .hud-auto{opacity:1;transform:none;}
.hud-auto i{width:6px;height:6px;border-radius:50%;background:#7ef0c9;box-shadow:0 0 8px #7ef0c9;animation:hud-pulse 1.6s ease-in-out infinite;}

.hud-cam{position:absolute;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;max-width:min(520px,60vw);padding:7px 14px;border-radius:999px;border:1px solid rgba(255,227,190,.18);background:rgba(10,16,36,.46);backdrop-filter:blur(8px);color:inherit;cursor:pointer;pointer-events:auto;font-size:11px;line-height:1;transition:background .2s,border-color .2s,box-shadow .2s;}
.hud-cam:hover{background:rgba(22,32,62,.6);border-color:rgba(255,217,160,.42);box-shadow:0 0 20px rgba(255,179,107,.18);}
.hud-cam:active{transform:translateX(-50%) scale(.985);}
.hud-cam-kicker{font-size:8.5px;letter-spacing:.26em;color:rgba(246,241,231,.42);}
.hud-cam-name{font-size:12px;font-weight:700;letter-spacing:.1em;color:#ffe6c4;white-space:nowrap;}
.hud-cam-hint{font-size:9.5px;letter-spacing:.04em;color:rgba(246,241,231,.56);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:250px;}
.hud-bpm{padding-left:9px;margin-left:1px;border-left:1px solid rgba(255,227,190,.16);font-size:8.5px;font-weight:700;letter-spacing:.13em;color:rgba(127,227,216,.8);white-space:nowrap;}
.hud-bpm.hud-bpm-hidden{display:none;}
.hud-cam.hud-cam-flash .hud-cam-name{animation:hud-camflash .6s ease;}
.hud-cam.hud-cam-flash{border-color:rgba(255,217,160,.6);}

.hud-topright{display:flex;align-items:center;gap:7px;pointer-events:none;}
.hud-meta{display:flex;flex-direction:column;align-items:flex-end;gap:1px;margin-right:2px;font-size:9px;letter-spacing:.14em;color:rgba(246,241,231,.42);}
.hud-fps{font-weight:700;color:rgba(126,240,201,.8);}
.hud-fps.hud-fps-mid{color:#ffd9a0;}
.hud-fps.hud-fps-low{color:#ff8f8f;}
.hud-q{font-size:8.5px;letter-spacing:.16em;}

.hud-ico{width:34px;height:34px;padding:0;display:grid;place-items:center;border-radius:50%;border:1px solid rgba(255,227,190,.16);background:rgba(10,16,36,.44);backdrop-filter:blur(8px);color:rgba(246,241,231,.74);cursor:pointer;pointer-events:auto;transition:color .18s,background .18s,border-color .18s,transform .12s;}
.hud-ico:hover{color:#ffe6c4;border-color:rgba(255,217,160,.5);background:rgba(255,179,107,.14);}
.hud-ico:active{transform:scale(.93);}
.hud-ico svg{width:15px;height:15px;display:block;}
.hud-ico .hud-ico-mute-line{display:none;}
.hud-ico.hud-muted .hud-ico-wave{display:none;}
.hud-ico.hud-muted .hud-ico-mute-line{display:block;}
.hud-ico .hud-ico-play{display:none;}
.hud-ico.hud-paused .hud-ico-pause-a,.hud-ico.hud-paused .hud-ico-pause-b{display:none;}
.hud-ico.hud-paused .hud-ico-play{display:block;}

/* ------------------------------------------------ speedometer */
.hud-gauge-wrap{position:absolute;left:16px;bottom:8px;width:210px;height:150px;pointer-events:none;filter:drop-shadow(0 10px 24px rgba(2,5,16,.5));}
.hud-gauge{width:100%;height:100%;display:block;overflow:visible;}
.hud-gauge-track{fill:none;stroke:rgba(255,255,255,.09);stroke-width:8;stroke-linecap:round;}
.hud-gauge-fill{fill:none;stroke-width:8;stroke-linecap:round;transition:stroke-dashoffset .12s linear;filter:drop-shadow(0 0 7px rgba(255,179,107,.3));}
.hud-gauge-tick{stroke:rgba(246,241,231,.2);stroke-width:1.3;stroke-linecap:round;}
.hud-gauge-tick-major{stroke:rgba(255,231,200,.46);stroke-width:1.7;}
.hud-gauge-ticklabel{fill:rgba(246,241,231,.34);font-size:8px;font-family:var(--font);text-anchor:middle;}
.hud-needle{stroke:#ffd9a0;stroke-width:2.6;stroke-linecap:round;}
.hud-gauge-hub{fill:#ffd9a0;filter:drop-shadow(0 0 6px rgba(255,217,160,.8));}
.hud-gauge-readout{position:absolute;left:50%;bottom:0;transform:translateX(-50%);display:flex;align-items:baseline;gap:5px;white-space:nowrap;pointer-events:none;}
.hud-speed-num{display:inline-block;font-size:43px;font-weight:800;line-height:.95;letter-spacing:-.03em;color:#7ef0c9;text-shadow:0 0 24px rgba(46,196,182,.4);transition:color .18s linear;}
.hud-speed-unit{font-size:9px;font-weight:600;letter-spacing:.18em;color:rgba(246,241,231,.48);}

/* ------------------------------------------------ stats */
.hud-stats{position:absolute;right:16px;bottom:12px;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;}
.hud-stat-card{display:flex;flex-direction:column;gap:5px;min-width:136px;padding:9px 13px 10px;border-radius:14px;background:var(--hud-glass);border:1px solid var(--hud-line);backdrop-filter:blur(10px) saturate(1.1);box-shadow:0 10px 26px rgba(2,5,16,.35),inset 0 1px 0 rgba(255,255,255,.05);}
.hud-row{display:flex;align-items:center;gap:7px;}
.hud-fish-icon{width:17px;height:13px;display:grid;place-items:center;filter:drop-shadow(0 0 6px rgba(46,196,182,.45));}
.hud-fish-icon svg{width:17px;height:13px;display:block;}
.hud-ach-ico{display:grid;place-items:center;}
.hud-ach-ico svg{width:15px;height:15px;display:block;}
.hud-toast-ic{flex:0 0 auto;display:grid;place-items:center;width:17px;height:17px;margin-top:1px;}
.hud-toast-ic svg{width:17px;height:17px;display:block;}
.hud-fish-num{display:inline-block;font-size:25px;font-weight:800;line-height:1;color:#eafcff;}
.hud-combo{display:inline-block;margin-left:auto;font-size:12px;font-weight:800;letter-spacing:.02em;color:#93a2c2;transition:color .2s;}
.hud-score-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:8.5px;letter-spacing:.18em;color:rgba(246,241,231,.42);}
.hud-score-num{font-size:12px;font-weight:700;letter-spacing:.04em;color:rgba(255,230,196,.85);}
.hud-ach-open{display:flex;align-items:center;gap:7px;padding:8px 12px;border-radius:12px;border:1px solid rgba(255,227,190,.18);background:rgba(10,16,36,.46);backdrop-filter:blur(8px);color:rgba(246,241,231,.8);cursor:pointer;pointer-events:auto;font-size:10.5px;letter-spacing:.12em;transition:background .18s,border-color .18s,color .18s;}
.hud-ach-open b{font-size:10px;font-weight:700;letter-spacing:.04em;color:#ffd9a0;}
.hud-ach-open:hover{background:rgba(255,179,107,.14);border-color:rgba(255,217,160,.45);color:#ffe6c4;}
.hud-ach-open:active{transform:scale(.97);}

/* ------------------------------------------------ toasts */
.hud-toasts{position:absolute;right:16px;bottom:186px;z-index:4;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:min(340px,78vw);pointer-events:none;}
.hud-toast{display:flex;align-items:flex-start;gap:9px;width:100%;padding:9px 13px;border-radius:12px;background:linear-gradient(155deg,rgba(20,28,54,.88),rgba(8,12,28,.84));border:1px solid rgba(255,227,190,.2);border-left:3px solid var(--hud-t,c,#ffd9a0);backdrop-filter:blur(10px);box-shadow:0 12px 30px rgba(2,5,16,.5);opacity:0;transform:translateX(120%);transition:transform .34s cubic-bezier(.2,.85,.25,1),opacity .28s ease;}
.hud-toast.hud-toast-in{opacity:1;transform:none;}
.hud-toast.hud-toast-out{opacity:0;transform:translateX(60%);transition-duration:.26s;}
.hud-toast-ach{--hud-t:#ffb36b;}
.hud-toast-fish{--hud-t:#2ec4b6;}
.hud-toast-info{--hud-t:rgba(200,215,245,.8);}
.hud-toast-ic{flex:0 0 auto;font-size:15px;line-height:1.25;}
.hud-toast-body{display:flex;flex-direction:column;gap:2px;min-width:0;}
.hud-toast-title{font-size:12px;font-weight:700;letter-spacing:.06em;color:#ffe9cc;white-space:normal;}
.hud-toast-desc{font-size:10px;line-height:1.45;letter-spacing:.02em;color:rgba(246,241,231,.6);}

/* ------------------------------------------------ intro */
.hud-intro{position:absolute;left:50%;bottom:112px;z-index:3;transform:translate(-50%,12px);opacity:0;visibility:hidden;transition:opacity .5s ease,transform .5s ease,visibility .5s;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:6px;max-width:min(680px,86vw);padding:10px 18px;border-radius:14px;background:rgba(8,12,28,.52);border:1px solid rgba(255,227,190,.14);backdrop-filter:blur(8px);text-align:center;}
.hud-root.hud-intro-on .hud-intro{opacity:1;visibility:visible;transform:translate(-50%,0);}
.hud-intro-title{font-size:8.5px;letter-spacing:.42em;text-indent:.42em;color:#ffd9a0;}
.hud-intro-keys{display:flex;flex-wrap:wrap;justify-content:center;gap:5px 13px;font-size:10.5px;color:rgba(246,241,231,.72);}
.hud-intro-keys span{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;}
.hud-intro-keys kbd{font-family:inherit;font-size:8.5px;font-weight:700;min-width:15px;padding:2px 5px;border-radius:5px;text-align:center;color:#ffe6c4;background:rgba(255,255,255,.07);border:1px solid rgba(255,227,190,.2);}

/* ------------------------------------------------ flash */
/* NOTE: intentionally no mix-blend-mode here. Compositing a DOM layer with
   mix-blend-mode (screen) over a WebGL canvas makes the canvas backdrop render
   black on some macOS Chrome/ANGLE builds (giant black rectangle). Plain alpha
   compositing is portable and looks practically identical. */
.hud-flash{position:absolute;inset:0;z-index:12;opacity:0;pointer-events:none;transition:opacity .34s ease;}
.hud-flash.hud-flash-on{opacity:1;transition-duration:.06s;}
.hud-flash-catch{background:radial-gradient(58% 48% at 50% 56%,rgba(46,196,182,.30),rgba(46,196,182,.08) 52%,transparent 76%);}
.hud-flash-jump{background:radial-gradient(70% 62% at 50% 52%,rgba(226,240,255,.20),rgba(226,240,255,.05) 50%,transparent 74%);}
.hud-flash-ach{background:radial-gradient(70% 62% at 50% 52%,rgba(255,179,107,.28),rgba(255,179,107,.07) 52%,transparent 76%);}
.hud-flash-info{background:radial-gradient(70% 62% at 50% 52%,rgba(120,160,255,.16),rgba(120,160,255,.04) 50%,transparent 76%);}

/* ------------------------------------------------ achievements */
.hud-ach-backdrop{position:absolute;inset:0;z-index:6;background:rgba(3,6,18,.45);backdrop-filter:blur(2px);opacity:0;visibility:hidden;pointer-events:none;transition:opacity .26s ease,visibility .26s;}
.hud-root.hud-ach-open .hud-ach-backdrop{opacity:1;visibility:visible;pointer-events:auto;}
.hud-ach-panel{position:absolute;z-index:7;top:64px;right:16px;bottom:16px;width:566px;max-width:calc(100vw - 32px);display:flex;flex-direction:column;border-radius:18px;border:1px solid rgba(255,227,190,.2);background:linear-gradient(165deg,rgba(18,26,52,.94),rgba(7,10,24,.94));backdrop-filter:blur(16px) saturate(1.15);box-shadow:0 26px 64px rgba(2,5,16,.6),inset 0 1px 0 rgba(255,255,255,.07);opacity:0;transform:translateX(calc(100% + 28px));transition:transform .34s cubic-bezier(.2,.85,.25,1),opacity .28s ease;pointer-events:none;overflow:hidden;}
.hud-root.hud-ach-open .hud-ach-panel{opacity:1;transform:none;pointer-events:auto;}
.hud-ach-head{position:relative;padding:15px 16px 12px;border-bottom:1px solid rgba(255,227,190,.1);}
.hud-ach-title{display:flex;align-items:baseline;gap:8px;font-size:16px;font-weight:800;letter-spacing:.14em;color:#ffe6c4;}
.hud-ach-title small{font-size:8px;font-weight:600;letter-spacing:.32em;color:rgba(246,241,231,.35);}
.hud-ach-count{position:absolute;right:48px;top:16px;font-size:11px;font-weight:700;letter-spacing:.06em;color:#ffd9a0;}
.hud-ach-close{position:absolute;right:12px;top:11px;width:30px;height:30px;padding:0;border-radius:50%;border:1px solid rgba(255,227,190,.16);background:rgba(255,255,255,.05);color:rgba(246,241,231,.65);cursor:pointer;font-size:14px;line-height:1;transition:background .16s,color .16s;}
.hud-ach-close:hover{background:rgba(230,57,70,.2);color:#fff;}
.hud-ach-progress{height:3px;margin-top:11px;border-radius:3px;background:rgba(255,255,255,.09);overflow:hidden;}
.hud-ach-progress-bar{display:block;width:100%;height:100%;border-radius:3px;background:linear-gradient(90deg,#2ec4b6,#ffd9a0 60%,#ffb36b);transform-origin:left center;transform:scaleX(0);transition:transform .5s cubic-bezier(.2,.8,.2,1);}
.hud-ach-list{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;padding:10px 12px 6px;display:grid;grid-template-columns:1fr 1fr;align-content:start;gap:6px;}
.hud-ach-list::-webkit-scrollbar{width:6px;}
.hud-ach-list::-webkit-scrollbar-thumb{background:rgba(255,227,190,.18);border-radius:6px;}
.hud-ach-item{display:grid;grid-template-columns:24px minmax(0,1fr) 14px;align-items:center;gap:9px;padding:8px 9px;border-radius:10px;background:rgba(255,255,255,.028);border:1px solid rgba(255,255,255,.04);opacity:.56;filter:saturate(.4);transition:opacity .3s,filter .3s,background .3s,border-color .3s,transform .3s;}
.hud-ach-badge{width:22px;height:22px;display:grid;place-items:center;border-radius:50%;border:1px solid rgba(255,255,255,.16);font-size:8.5px;font-weight:700;color:rgba(246,241,231,.45);letter-spacing:0;}
.hud-ach-body{display:flex;flex-direction:column;gap:2px;min-width:0;}
.hud-ach-name{font-size:11.5px;font-weight:700;letter-spacing:.04em;color:rgba(246,241,231,.82);}
.hud-ach-desc{font-size:9.5px;line-height:1.45;letter-spacing:.01em;color:rgba(246,241,231,.42);}
.hud-ach-tick{font-size:12px;font-weight:800;color:transparent;}
.hud-ach-item.hud-unlocked{opacity:1;filter:none;background:linear-gradient(120deg,rgba(255,179,107,.16),rgba(255,217,160,.05) 70%);border-color:rgba(255,200,130,.42);}
.hud-ach-item.hud-unlocked .hud-ach-badge{background:linear-gradient(140deg,#ffd9a0,#ffb36b);border-color:rgba(255,217,160,.7);color:#34160a;}
.hud-ach-item.hud-unlocked .hud-ach-name{color:#ffe6c4;}
.hud-ach-item.hud-unlocked .hud-ach-desc{color:rgba(255,225,190,.62);}
.hud-ach-item.hud-unlocked .hud-ach-tick{color:#ffd9a0;}
.hud-ach-item.hud-new{animation:hud-achpop .7s cubic-bezier(.2,.9,.3,1);}
.hud-ach-foot{padding:9px 16px 12px;border-top:1px solid rgba(255,227,190,.08);font-size:8.5px;letter-spacing:.16em;color:rgba(246,241,231,.32);text-align:center;}

/* ------------------------------------------------ touch controls */
.hud-touchpad{position:absolute;inset:auto 0 0 0;height:236px;z-index:5;display:none;pointer-events:none;}
.hud-root.hud-touch .hud-touchpad{display:block;}
.hud-tpad-left{position:absolute;left:12px;bottom:12px;display:flex;gap:8px;pointer-events:none;}
.hud-tpad-right{position:absolute;right:12px;bottom:12px;display:flex;flex-direction:column;align-items:flex-end;gap:7px;pointer-events:none;}
.hud-trow{display:flex;align-items:flex-end;gap:7px;}
.hud-tbtn{pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:0;font-family:inherit;font-size:19px;line-height:1;color:rgba(246,241,231,.86);background:linear-gradient(158deg,rgba(26,37,70,.74),rgba(7,11,26,.68));border:1px solid rgba(255,227,190,.22);border-radius:17px;backdrop-filter:blur(8px);box-shadow:0 8px 20px rgba(2,5,16,.42),inset 0 1px 0 rgba(255,255,255,.08);transition:transform .07s ease,background .12s,border-color .12s,box-shadow .12s,color .12s;}
.hud-tbtn small{font-family:inherit;font-size:7.5px;font-weight:600;letter-spacing:.14em;color:rgba(246,241,231,.5);}
.hud-tbtn.hud-pressed{background:linear-gradient(158deg,rgba(255,179,107,.46),rgba(230,57,70,.22));border-color:rgba(255,228,186,.85);color:#fff8ec;transform:scale(.93);box-shadow:0 0 24px rgba(255,179,107,.45),inset 0 1px 0 rgba(255,255,255,.22);}
.hud-tlane{width:56px;height:56px;border-radius:16px;font-size:17px;}
.hud-tsm{width:42px;height:42px;border-radius:50%;font-size:13px;}
.hud-twing{width:54px;height:52px;border-radius:16px;font-size:12.5px;font-weight:700;letter-spacing:.1em;}
.hud-tjump{width:64px;height:64px;border-radius:50%;font-size:14px;font-weight:800;letter-spacing:.06em;border-color:rgba(255,217,160,.45);background:linear-gradient(158deg,rgba(255,179,107,.32),rgba(230,57,70,.2));}
.hud-taccel,.hud-tbrake{width:58px;height:54px;border-radius:16px;font-size:15px;}
.hud-taccel{border-color:rgba(46,196,182,.42);background:linear-gradient(158deg,rgba(46,196,182,.26),rgba(7,11,26,.68));}
.hud-tbrake{border-color:rgba(230,57,70,.4);background:linear-gradient(158deg,rgba(230,57,70,.22),rgba(7,11,26,.68));}

/* ------------------------------------------------ animations */
@keyframes hud-pulse{0%,100%{opacity:.4;transform:scale(.82)}50%{opacity:1;transform:scale(1.12)}}
@keyframes hud-camflash{0%{color:#fff;text-shadow:0 0 16px rgba(255,217,160,.95)}100%{color:#ffe6c4;text-shadow:none}}
@keyframes hud-pop{0%{transform:scale(1)}36%{transform:scale(1.24)}100%{transform:scale(1)}}
@keyframes hud-achpop{0%{transform:scale(.96);box-shadow:0 0 0 rgba(255,179,107,0)}45%{transform:scale(1.015);box-shadow:0 0 26px rgba(255,179,107,.35)}100%{transform:scale(1);box-shadow:0 0 0 rgba(255,179,107,0)}}
.hud-fish-num.hud-pop,.hud-combo.hud-pop{animation:hud-pop .34s ease;}

/* ------------------------------------------------ touch layout */
.hud-root.hud-touch .hud-top{padding:10px 12px;}
.hud-root.hud-touch .hud-phase{padding:6px 9px;gap:7px;border-radius:11px;}
.hud-root.hud-touch .hud-phase-icon{font-size:16px;}
.hud-root.hud-touch .hud-phase-name{font-size:11px;letter-spacing:.12em;}
.hud-root.hud-touch .hud-phase-sub{font-size:8px;}
.hud-root.hud-touch .hud-phase-track{width:32px;}
.hud-root.hud-touch .hud-auto{font-size:8px;padding:3px 7px;letter-spacing:.18em;}
.hud-root.hud-touch .hud-cam{top:52px;padding:5px 11px;gap:6px;}
.hud-root.hud-touch .hud-cam-kicker{display:none;}
.hud-root.hud-touch .hud-cam-hint{max-width:140px;font-size:8.5px;}
.hud-root.hud-touch .hud-bpm{font-size:7.5px;padding-left:7px;}
.hud-root.hud-touch .hud-cam-name{font-size:11px;}
.hud-root.hud-touch .hud-meta{font-size:8px;}
.hud-root.hud-touch .hud-q{font-size:7.5px;}
.hud-root.hud-touch .hud-ico{width:32px;height:32px;}
.hud-root.hud-touch .hud-stats{right:auto;left:12px;bottom:auto;top:94px;align-items:flex-start;gap:6px;}
.hud-root.hud-touch .hud-stat-card{flex-direction:row;align-items:center;gap:10px;min-width:0;padding:6px 10px;border-radius:11px;}
.hud-root.hud-touch .hud-fish-num{font-size:18px;}
.hud-root.hud-touch .hud-combo{font-size:10.5px;margin-left:0;}
.hud-root.hud-touch .hud-score-row{gap:6px;font-size:7.5px;letter-spacing:.1em;}
.hud-root.hud-touch .hud-score-num{font-size:10.5px;}
.hud-root.hud-touch .hud-ach-open{padding:6px 10px;font-size:9px;gap:5px;}
.hud-root.hud-touch .hud-ach-open b{font-size:9px;}
.hud-root.hud-touch .hud-gauge-wrap{left:50%;bottom:12px;transform:translateX(-50%) scale(.56);transform-origin:50% 100%;}
.hud-root.hud-touch .hud-gauge-readout{bottom:5px;}
.hud-root.hud-touch .hud-intro{bottom:216px;max-width:88vw;padding:8px 13px;}
.hud-root.hud-touch .hud-intro-keys{font-size:9.5px;gap:4px 9px;}
.hud-root.hud-touch .hud-toasts{right:10px;bottom:214px;max-width:min(300px,80vw);}
.hud-root.hud-touch .hud-cinebar{height:0;}
.hud-root.hud-touch.hud-cine .hud-cinebar{height:5.5vh;}
.hud-root.hud-touch .hud-ach-panel{top:54px;left:10px;right:10px;bottom:10px;width:auto;max-width:none;border-radius:16px;}
.hud-root.hud-touch .hud-ach-title{font-size:14px;}
.hud-root.hud-touch .hud-ach-list{display:flex;flex-direction:column;gap:6px;}

/* ------------------------------------------------ narrow / small screens */
@media (max-width:860px){
  .hud-cam{max-width:calc(100vw - 260px);padding:6px 10px;}
  .hud-cam-hint{display:none;}
  .hud-gauge-wrap{width:184px;height:132px;left:12px;bottom:6px;}
  .hud-speed-num{font-size:37px;}
  .hud-stats{right:12px;bottom:10px;}
  .hud-toasts{right:12px;bottom:170px;}
  .hud-intro{bottom:104px;}
  .hud-ach-panel{top:56px;right:10px;bottom:10px;width:min(340px,calc(100vw - 20px));}
}
@media (max-width:600px){
  .hud-top{padding:9px 10px;}
  .hud-phase{padding:5px 8px;}
  .hud-phase-track{display:none;}
  .hud-meta{font-size:7.5px;gap:0;}
  .hud-q{font-size:7px;}
  .hud-ico{width:30px;height:30px;}
  .hud-ico svg{width:13px;height:13px;}
  .hud-stat-card{min-width:118px;padding:8px 11px;}
  .hud-fish-num{font-size:21px;}
  .hud-gauge-wrap{width:170px;height:122px;}
  .hud-ach-panel{top:50px;}
}

/* ------------------------------------------------ reduced motion / low quality */
@media (prefers-reduced-motion:reduce){
  .hud-root *{animation-duration:.001ms !important;animation-iteration-count:1 !important;}
  .hud-toast{transition-duration:.14s;}
}
.hud-root.hud-lowfx .hud-phase,.hud-root.hud-lowfx .hud-stat-card,.hud-root.hud-lowfx .hud-cam,.hud-root.hud-lowfx .hud-ico,.hud-root.hud-lowfx .hud-ach-open,.hud-root.hud-lowfx .hud-toast,.hud-root.hud-lowfx .hud-ach-panel,.hud-root.hud-lowfx .hud-intro,.hud-root.hud-lowfx .hud-tbtn{backdrop-filter:none !important;}
.hud-root.hud-lowfx .hud-gauge-wrap{filter:none;}
.hud-root.hud-lowfx .hud-ach-panel,.hud-root.hud-lowfx .hud-toast{box-shadow:0 8px 20px rgba(2,5,16,.5);}
`;

// ---------------------------------------------------------------------------
function createEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function svgEl(tag, attrs) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  return n;
}
function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return;
  try {
    fn(...args);
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('[hud] callback error:', err);
  }
}
function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}
function fmtNum(n) {
  const s = String(Math.round(n));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function finiteNum(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function mixRgb(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}
const SPEED_CYAN = [46, 196, 182];
const SPEED_GOLD = [255, 179, 107];
const SPEED_RED = [255, 92, 92];
const ARC_LEN = Math.PI * 76;

function phaseInfo(p) {
  let v = p % 1;
  if (v < 0) v += 1;
  if (v < 0.055 || v >= 0.965) return '黄昏';
  if (v < 0.225) return '日落';
  if (v < 0.42) return '蓝调';
  if (v < 0.8) return '深夜';
  return '拂晓';
}

const COMBO_COLORS = ['#93a2c2', '#7fe3d8', '#ffd9a0', '#ffb36b', '#ff8a5c', '#ff5c5c'];

export function createHud(opts) {
  const options = opts || {};
  const onAction = options.onAction;
  const onCamera = options.onCamera;
  const onMute = options.onMute;
  const onPause = options.onPause;
  const onRestart = options.onRestart;

  const uid = ++hudUid;
  const GRAD_ID = 'hud-speedgrad-' + uid;

  // ---------------------------------------------------------------- style
  if (!document.getElementById('hud-style')) {
    const st = document.createElement('style');
    st.id = 'hud-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ---------------------------------------------------------------- touch mode
  const params = new URLSearchParams(location.search);
  let touchMode = params.get('touch') === '1';
  if (!touchMode && window.matchMedia) {
    try {
      touchMode = window.matchMedia('(pointer: coarse)').matches && (navigator.maxTouchPoints || 0) > 0;
    } catch (err) {
      touchMode = false;
    }
  }
  if (touchMode) {
    try {
      document.body.classList.add('touch');
    } catch (err) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- root
  const root = createEl('div', 'hud-root' + (touchMode ? ' hud-touch' : ''));

  // letterbox
  const barTop = createEl('div', 'hud-cinebar hud-cinebar-top');
  const barBottom = createEl('div', 'hud-cinebar hud-cinebar-bottom');
  root.appendChild(barTop);
  root.appendChild(barBottom);

  // ---------------------------------------------------------- top bar
  const top = createEl('div', 'hud-top');
  const topLeft = createEl('div', 'hud-topleft');

  const phase = createEl('div', 'hud-phase');
  const phaseIcon = createEl('span', 'hud-phase-icon');
  phaseIcon.innerHTML = PHASE_ICON['黄昏'];
  const phaseText = createEl('span', 'hud-phase-text');
  const phaseName = createEl('b', 'hud-phase-name', '黄昏');
  const phaseSub = createEl('i', 'hud-phase-sub', '夜色 0%');
  phaseText.append(phaseName, phaseSub);
  const phaseTrack = createEl('span', 'hud-phase-track');
  const phaseBar = createEl('i', 'hud-phase-bar');
  phaseTrack.appendChild(phaseBar);
  phase.append(phaseIcon, phaseText, phaseTrack);

  const autoPill = createEl('div', 'hud-auto');
  const autoDot = createEl('i');
  autoPill.append(autoDot, document.createTextNode('AUTO PILOT'));
  topLeft.append(phase, autoPill);

  const topRight = createEl('div', 'hud-topright');
  const meta = createEl('div', 'hud-meta');
  const fpsEl = createEl('span', 'hud-fps', '60 FPS');
  const qEl = createEl('span', 'hud-q', '画质 高');
  meta.append(fpsEl, qEl);

  const muteBtn = createEl('button', 'hud-ico hud-mute');
  muteBtn.type = 'button';
  muteBtn.innerHTML = ICON.mute;
  muteBtn.title = '静音 (M)';
  muteBtn.setAttribute('aria-label', '静音');
  const pauseBtn = createEl('button', 'hud-ico hud-pause');
  pauseBtn.type = 'button';
  pauseBtn.innerHTML = ICON.pause;
  pauseBtn.title = '暂停 (P)';
  pauseBtn.setAttribute('aria-label', '暂停');
  const restartBtn = createEl('button', 'hud-ico hud-restart');
  restartBtn.type = 'button';
  restartBtn.innerHTML = ICON.restart;
  restartBtn.title = '重新开始 (R)';
  restartBtn.setAttribute('aria-label', '重新开始');
  topRight.append(meta, muteBtn, pauseBtn, restartBtn);
  top.append(topLeft, topRight);

  // camera pill
  const camPill = createEl('button', 'hud-cam');
  camPill.type = 'button';
  camPill.title = '切换镜头 (C)';
  camPill.setAttribute('aria-label', '切换镜头');
  const camKicker = createEl('span', 'hud-cam-kicker', '相机');
  const camName = createEl('b', 'hud-cam-name', '追尾');
  const camHint = createEl('span', 'hud-cam-hint', '后上方 3/4 跟拍');
  const bpmEl = createEl('span', 'hud-bpm', 'BPM --');
  camPill.append(camKicker, camName, camHint, bpmEl);

  // ---------------------------------------------------------- speed gauge
  const gaugeWrap = createEl('div', 'hud-gauge-wrap');
  const svg = svgEl('svg', { viewBox: '0 0 200 132', class: 'hud-gauge', 'aria-hidden': 'true' });
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: GRAD_ID, x1: '0', y1: '0', x2: '1', y2: '0' });
  const stops = [
    ['0', '#2ec4b6'],
    ['0.55', '#ffd9a0'],
    ['1', '#ff5c5c'],
  ];
  for (const [off, col] of stops) grad.appendChild(svgEl('stop', { offset: off, 'stop-color': col }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  const arcD = 'M 24 110 A 76 76 0 0 1 176 110';
  const track = svgEl('path', { d: arcD, class: 'hud-gauge-track' });
  const fill = svgEl('path', {
    d: arcD,
    class: 'hud-gauge-fill',
    stroke: 'url(#' + GRAD_ID + ')',
    'stroke-dasharray': ARC_LEN.toFixed(2),
    'stroke-dashoffset': ARC_LEN.toFixed(2),
  });
  svg.append(track, fill);

  // ticks + labels
  for (let i = 0; i <= 12; i++) {
    const a = Math.PI - (i * Math.PI) / 12;
    const major = i % 2 === 0;
    const rOut = major ? 68 : 65;
    const rIn = major ? 57 : 60;
    const x1 = 100 + Math.cos(a) * rOut;
    const y1 = 110 - Math.sin(a) * rOut;
    const x2 = 100 + Math.cos(a) * rIn;
    const y2 = 110 - Math.sin(a) * rIn;
    svg.appendChild(
      svgEl('line', {
        x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2),
        class: 'hud-gauge-tick' + (major ? ' hud-gauge-tick-major' : ''),
      })
    );
    if (i === 0 || i === 6 || i === 12) {
      const lr = 44;
      svg.appendChild(
        svgEl('text', {
          x: (100 + Math.cos(a) * lr).toFixed(2),
          y: (110 - Math.sin(a) * lr + 2.6).toFixed(2),
          class: 'hud-gauge-ticklabel',
          text: String(i * 10),
        })
      );
    }
  }
  const needle = svgEl('line', { x1: 100, y1: 110, x2: 100, y2: 46, class: 'hud-needle', transform: 'rotate(-90 100 110)' });
  const hub = svgEl('circle', { cx: 100, cy: 110, r: 4.6, class: 'hud-gauge-hub' });
  svg.append(needle, hub);

  const readout = createEl('div', 'hud-gauge-readout');
  const speedNum = createEl('span', 'hud-speed-num', '0');
  const speedUnit = createEl('span', 'hud-speed-unit', 'km/h');
  readout.append(speedNum, speedUnit);
  gaugeWrap.append(svg, readout);

  // ---------------------------------------------------------- stats
  const stats = createEl('div', 'hud-stats');
  const statCard = createEl('div', 'hud-stat-card');
  const fishRow = createEl('div', 'hud-row');
  const fishIcon = createEl('span', 'hud-fish-icon');
  fishIcon.innerHTML = ICON.fish;
  const fishNum = createEl('b', 'hud-fish-num', '0');
  const comboEl = createEl('span', 'hud-combo', '×1');
  fishRow.append(fishIcon, fishNum, comboEl);
  const scoreRow = createEl('div', 'hud-score-row');
  const scoreLabel = createEl('span', '', '得分');
  const scoreNum = createEl('b', 'hud-score-num', '0');
  scoreRow.append(scoreLabel, scoreNum);
  statCard.append(fishRow, scoreRow);

  const achOpenBtn = createEl('button', 'hud-ach-open');
  achOpenBtn.type = 'button';
  achOpenBtn.setAttribute('aria-label', '成就面板 (K)');
  achOpenBtn.title = '成就面板 (K)';
  const achOpenIcon = createEl('span', 'hud-ach-ico');
  achOpenIcon.innerHTML = ICON.trophy;
  const achOpenText = createEl('span', '', '成就');
  const achOpenCount = createEl('b', '', '0/14');
  achOpenBtn.append(achOpenIcon, achOpenText, achOpenCount);
  stats.append(statCard, achOpenBtn);

  // ---------------------------------------------------------- toasts / intro / flash
  const toasts = createEl('div', 'hud-toasts');

  const intro = createEl('div', 'hud-intro');
  const introTitle = createEl('div', 'hud-intro-title', '骑行提示');
  const introKeys = createEl('div', 'hud-intro-keys');
  if (touchMode) {
    for (const [k, v] of [
      ['◀ ▶', '变道'],
      ['▲ ▼', '速度'],
      ['跳跃 / 展翅', '动作'],
      ['📷', '换镜头'],
      ['K', '成就'],
    ]) {
      const span = createEl('span');
      const kbd = createEl('kbd', '', k);
      span.append(kbd, document.createTextNode(' ' + v));
      introKeys.appendChild(span);
    }
  } else {
    for (const [k, v] of [
      ['W/S', '加速减速'],
      ['A/D', '变道抓鱼'],
      ['空格', '跳跃'],
      ['T', '展翅抬轮'],
      ['C', '切换镜头'],
      ['K', '成就'],
    ]) {
      const span = createEl('span');
      const kbd = createEl('kbd', '', k);
      span.append(kbd, document.createTextNode(' ' + v));
      introKeys.appendChild(span);
    }
  }
  intro.append(introTitle, introKeys);

  const flashEl = createEl('div', 'hud-flash');

  // ---------------------------------------------------------- achievements panel
  const achBackdrop = createEl('div', 'hud-ach-backdrop');
  const achPanel = createEl('section', 'hud-ach-panel');
  achPanel.setAttribute('aria-label', '成就');
  const achHead = createEl('header', 'hud-ach-head');
  const achTitle = createEl('div', 'hud-ach-title');
  const achTitleMain = createEl('span', '', '成就');
  const achTitleSub = createEl('small', '', 'ACHIEVEMENTS');
  achTitle.append(achTitleMain, achTitleSub);
  const achCount = createEl('div', 'hud-ach-count', '0 / 14');
  const achClose = createEl('button', 'hud-ach-close', '✕');
  achClose.type = 'button';
  achClose.setAttribute('aria-label', '关闭成就面板');
  const achProgress = createEl('div', 'hud-ach-progress');
  const achProgressBar = createEl('i', 'hud-ach-progress-bar');
  achProgress.appendChild(achProgressBar);
  achHead.append(achTitle, achCount, achClose, achProgress);
  const achList = createEl('div', 'hud-ach-list');
  const achFoot = createEl('div', 'hud-ach-foot', '按 K 关闭 · 继续骑行解锁更多');
  achPanel.append(achHead, achList, achFoot);

  // ---------------------------------------------------------- touch controls
  const touchpad = createEl('div', 'hud-touchpad');
  const tpadLeft = createEl('div', 'hud-tpad-left');
  const laneLeft = createEl('button', 'hud-tbtn hud-tlane', '◀');
  laneLeft.type = 'button';
  laneLeft.setAttribute('aria-label', '向左变道');
  const laneRight = createEl('button', 'hud-tbtn hud-tlane', '▶');
  laneRight.type = 'button';
  laneRight.setAttribute('aria-label', '向右变道');
  tpadLeft.append(laneLeft, laneRight);

  const tpadRight = createEl('div', 'hud-tpad-right');
  const rowTop = createEl('div', 'hud-trow');
  const tCamBtn = createEl('button', 'hud-tbtn hud-tsm');
  tCamBtn.type = 'button';
  tCamBtn.innerHTML = ICON.camera;
  tCamBtn.setAttribute('aria-label', '切换镜头');
  tCamBtn.title = '切换镜头';
  const tMuteBtn = createEl('button', 'hud-tbtn hud-tsm hud-tmute');
  tMuteBtn.type = 'button';
  tMuteBtn.innerHTML = ICON.mute;
  tMuteBtn.setAttribute('aria-label', '静音');
  tMuteBtn.title = '静音';
  rowTop.append(tCamBtn, tMuteBtn);

  const rowMid = createEl('div', 'hud-trow');
  const tWingBtn = createEl('button', 'hud-tbtn hud-twing', '展翅');
  tWingBtn.type = 'button';
  tWingBtn.setAttribute('aria-label', '展翅');
  const tJumpBtn = createEl('button', 'hud-tbtn hud-tjump', '跳跃');
  tJumpBtn.type = 'button';
  tJumpBtn.setAttribute('aria-label', '跳跃');
  rowMid.append(tWingBtn, tJumpBtn);

  const rowLow = createEl('div', 'hud-trow');
  const tAccelBtn = createEl('button', 'hud-tbtn hud-taccel');
  tAccelBtn.type = 'button';
  tAccelBtn.setAttribute('aria-label', '加速');
  tAccelBtn.append(document.createTextNode('▲'), createEl('small', '', '加速'));
  const tBrakeBtn = createEl('button', 'hud-tbtn hud-tbrake');
  tBrakeBtn.type = 'button';
  tBrakeBtn.setAttribute('aria-label', '减速');
  tBrakeBtn.append(document.createTextNode('▼'), createEl('small', '', '减速'));
  rowLow.append(tAccelBtn, tBrakeBtn);

  tpadRight.append(rowTop, rowMid, rowLow);
  touchpad.append(tpadLeft, tpadRight);

  // ---------------------------------------------------------- assemble
  root.append(top, camPill, gaugeWrap, stats, toasts, intro, flashEl, achBackdrop, achPanel, touchpad);

  // mount (main may re-append, that simply moves the same node)
  const layer = document.getElementById('hud-layer');
  if (layer) layer.appendChild(root);
  else document.body.appendChild(root);

  // ---------------------------------------------------------------- refs
  const refs = {
    phaseIcon, phaseName, phaseSub, phaseBar,
    camPill, camName, camHint,
    fpsEl, qEl, muteBtn, pauseBtn, restartBtn, bpmEl,
    gaugeWrap, fill, needle, hub, speedNum,
    fishNum, comboEl, scoreNum, achOpenCount,
    toasts, intro, flashEl, achPanel, achList, achCount, achProgressBar,
    achOpenBtn, achClose, achBackdrop, root,
    tMuteBtn, tCamBtn,
  };

  // ---------------------------------------------------------------- caches
  const cache = {
    kmh: -1,
    ratio: -1,
    fish: -1,
    combo: -1,
    score: -1,
    phaseName: '',
    nightPct: -1,
    phaseT: -2,
    phaseWriteT: 0,
    fpsShown: -1,
    fpsT: 0,
    quality: -1,
    qLabel: '',
    auto: null,
    paused: null,
    muted: null,
    cameraId: '',
    shotName: '',
    cine: null,
    achRef: null,
    achCount: -1,
    achRows: [],
    lowfx: null,
    introTimer: null,
    flashTimer: null,
    hudTime: 0,
    lastShotSync: -1,
    lastMuteSync: -1,
    lastBpmT: -1,
    bpm: -1,
    achOpen: false,
    timers: new Set(),
    toastRecent: new Map(),
  };

  let camModes = [];

  // ---------------------------------------------------------------- helpers
  function later(fn, ms) {
    const id = setTimeout(() => {
      cache.timers.delete(id);
      try {
        fn();
      } catch (err) {
        /* ignore */
      }
    }, ms);
    cache.timers.add(id);
    return id;
  }

  function retrigger(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    // force a style flush so the animation restarts
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function speedColor(ratio) {
    let c;
    if (ratio < 0.55) c = mixRgb(SPEED_CYAN, SPEED_GOLD, ratio / 0.55);
    else if (ratio < 0.85) c = mixRgb(SPEED_GOLD, SPEED_RED, (ratio - 0.55) / 0.3);
    else c = SPEED_RED;
    return c;
  }

  function applyMuted(m) {
    const on = !!m;
    if (cache.muted === on) return;
    cache.muted = on;
    refs.muteBtn.classList.toggle('hud-muted', on);
    refs.tMuteBtn.classList.toggle('hud-muted', on);
  }

  function applyPaused(p) {
    const on = !!p;
    if (cache.paused === on) return;
    cache.paused = on;
    refs.pauseBtn.classList.toggle('hud-paused', on);
    if (on) hideIntro();
  }

  function applyAuto(on) {
    const v = !!on;
    if (cache.auto === v) return;
    cache.auto = v;
    root.classList.toggle('hud-auto-on', v);
  }

  function setQualityLabel(str) {
    const txt = str == null ? '' : String(str);
    if (txt === cache.qLabel) return;
    cache.qLabel = txt;
    refs.qEl.textContent = txt ? '画质 ' + txt : '';
  }

  function applyCamera(modes, currentId) {
    if (Array.isArray(modes) && modes.length) camModes = modes.slice();
    let id = currentId;
    if (!id && camModes.length) id = camModes[0].id;
    if (!id) return;
    const changed = id !== cache.cameraId;
    cache.cameraId = id;
    let info = null;
    for (let i = 0; i < camModes.length; i++) if (camModes[i].id === id) { info = camModes[i]; break; }
    if (changed) {
      refs.camName.textContent = info && info.label ? info.label : id;
      refs.camHint.textContent = info && info.hint ? info.hint : '';
      cache.shotName = '';
      retrigger(refs.camPill, 'hud-cam-flash');
    }
    const cine = id === 'cinematic';
    if (cache.cine !== cine) {
      cache.cine = cine;
      root.classList.toggle('hud-cine', cine);
    }
  }

  function applyQualityFromState(q) {
    const level = Math.max(0, Math.min(2, Math.round(finiteNum(q, 0))));
    if (level === cache.quality) return;
    cache.quality = level;
    const lab = ['高', '中', '低'][level] || '';
    if (!cache.qLabel) setQualityLabel(lab);
    const low = level >= 2;
    if (cache.lowfx !== low) {
      cache.lowfx = low;
      root.classList.toggle('hud-lowfx', low);
    }
  }

  function pushToast(title, desc, kind) {
    const k = kind === 'ach' || kind === 'fish' ? kind : 'info';
    const item = createEl('div', 'hud-toast hud-toast-' + k);
    const ic = createEl('div', 'hud-toast-ic');
    ic.innerHTML = k === 'ach' ? ICON.trophy : k === 'fish' ? ICON.fish : ICON.info;
    const body = createEl('div', 'hud-toast-body');
    body.appendChild(createEl('b', 'hud-toast-title', String(title == null ? '' : title)));
    if (desc != null && desc !== '') body.appendChild(createEl('span', 'hud-toast-desc', String(desc)));
    item.append(ic, body);
    refs.toasts.appendChild(item);
    while (refs.toasts.children.length > 2) refs.toasts.removeChild(refs.toasts.firstChild);
    // enter animation on next frame
    requestAnimationFrame(() => {
      try {
        item.classList.add('hud-toast-in');
      } catch (err) {
        /* ignore */
      }
    });
    later(() => {
      item.classList.add('hud-toast-out');
      later(() => {
        if (item.parentNode) item.parentNode.removeChild(item);
      }, 340);
    }, 3200);
  }

  // public toast (dedupes identical titles within 2.4s so game.js + HUD
  // auto-detection of achievement unlocks never double-toast)
  function toast(title, desc, kind) {
    const k = kind === 'ach' || kind === 'fish' ? kind : 'info';
    const key = k + '|' + String(title == null ? '' : title);
    const now = performance.now ? performance.now() : Date.now();
    const prev = cache.toastRecent.get(key);
    if (prev != null && now - prev < 2400) return false;
    cache.toastRecent.set(key, now);
    if (cache.toastRecent.size > 12) {
      let oldKey = null;
      let oldVal = Infinity;
      for (const entry of cache.toastRecent) {
        if (entry[1] < oldVal) {
          oldVal = entry[1];
          oldKey = entry[0];
        }
      }
      if (oldKey != null) cache.toastRecent.delete(oldKey);
    }
    pushToast(title, desc, k);
    return true;
  }

  function flash(kind) {
    const k = kind === 'catch' || kind === 'jump' || kind === 'ach' ? kind : 'info';
    refs.flashEl.className = 'hud-flash hud-flash-' + k;
    void refs.flashEl.offsetWidth;
    refs.flashEl.classList.add('hud-flash-on');
    if (cache.flashTimer) clearTimeout(cache.flashTimer);
    cache.flashTimer = setTimeout(() => {
      cache.flashTimer = null;
      refs.flashEl.classList.remove('hud-flash-on');
    }, 380);
  }

  function showIntro() {
    root.classList.add('hud-intro-on');
    if (cache.introTimer) clearTimeout(cache.introTimer);
    cache.introTimer = setTimeout(() => {
      cache.introTimer = null;
      hideIntro();
    }, 3000);
  }
  function hideIntro() {
    root.classList.remove('hud-intro-on');
    if (cache.introTimer) {
      clearTimeout(cache.introTimer);
      cache.introTimer = null;
    }
  }

  function toggleAchievements(force) {
    const open = typeof force === 'boolean' ? force : !cache.achOpen;
    if (open === cache.achOpen) return;
    cache.achOpen = open;
    root.classList.toggle('hud-ach-open', open);
    refs.achOpenBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      hideIntro();
      if (cache.achCount === 0) refs.achCount.textContent = '0 / 14';
    }
  }

  // ---------------------------------------------------------------- achievements
  function buildAchList(list) {
    refs.achList.textContent = '';
    cache.achRows.length = 0;
    for (let i = 0; i < list.length; i++) {
      const a = list[i] || {};
      const row = createEl('div', 'hud-ach-item');
      const badge = createEl('span', 'hud-ach-badge', pad2(i + 1));
      const body = createEl('div', 'hud-ach-body');
      body.appendChild(createEl('b', 'hud-ach-name', String(a.name == null ? '' : a.name)));
      body.appendChild(createEl('span', 'hud-ach-desc', String(a.desc == null ? '' : a.desc)));
      const tick = createEl('span', 'hud-ach-tick', '✓');
      row.append(badge, body, tick);
      refs.achList.appendChild(row);
      const unlocked = !!a.unlocked;
      applyAchRow({ row, badge, tick, idx: i, unlocked }, unlocked, false);
      cache.achRows.push({ row, badge, tick, idx: i, unlocked, name: a.name, desc: a.desc });
    }
    cache.achRef = list;
    syncAchProgress(false);
  }

  function applyAchRow(row, unlocked, animate) {
    row.row.classList.toggle('hud-unlocked', unlocked);
    row.badge.textContent = unlocked ? '✓' : pad2(row.idx + 1);
    if (unlocked && animate) retrigger(row.row, 'hud-new');
  }

  function syncAchProgress(animate) {
    let count = 0;
    for (let i = 0; i < cache.achRows.length; i++) if (cache.achRows[i].unlocked) count++;
    if (count === cache.achCount) return;
    cache.achCount = count;
    const total = cache.achRows.length || 14;
    refs.achCount.textContent = count + ' / ' + total;
    refs.achOpenCount.textContent = count + '/' + total;
    refs.achProgressBar.style.transform = 'scaleX(' + (count / total).toFixed(4) + ')';
    if (animate) retrigger(refs.achOpenBtn, 'hud-cam-flash');
  }

  function syncAchievements(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    if (list !== cache.achRef || list.length !== cache.achRows.length) {
      buildAchList(list);
      return;
    }
    let changed = false;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const row = cache.achRows[i];
      if (!a || !row) continue;
      const u = !!a.unlocked;
      if (u !== row.unlocked) {
        row.unlocked = u;
        applyAchRow(row, u, true);
        changed = true;
        if (u) {
          const shown = toast(a.name, a.desc, 'ach');
          if (shown) flash('ach');
        }
      }
    }
    if (changed) syncAchProgress(true);
  }

  // ---------------------------------------------------------------- bindings
  function bindClick(el, fn) {
    if (!el) return;
    el.addEventListener('click', (e) => {
      if (e) e.preventDefault();
      safeCall(fn);
    });
  }

  function bindHold(el, action) {
    let held = false;
    const press = (e) => {
      if (e && e.pointerType === 'mouse' && e.button !== 0) return;
      if (e) e.preventDefault();
      if (held) return;
      held = true;
      el.classList.add('hud-pressed');
      try {
        if (e && e.pointerId != null && el.setPointerCapture) el.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      safeCall(onAction, action, true);
    };
    const release = (e) => {
      if (!held) return;
      held = false;
      el.classList.remove('hud-pressed');
      try {
        if (e && e.pointerId != null && el.releasePointerCapture) el.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      safeCall(onAction, action, false);
    };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('pointerleave', release);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  bindClick(muteBtn, () => {
    applyMuted(!cache.muted);
    safeCall(onMute);
  });
  bindClick(pauseBtn, () => safeCall(onPause));
  bindClick(restartBtn, () => {
    toggleAchievements(false);
    safeCall(onRestart);
  });
  bindClick(camPill, () => safeCall(onCamera));
  bindClick(tCamBtn, () => safeCall(onCamera));
  bindClick(tMuteBtn, () => {
    applyMuted(!cache.muted);
    safeCall(onMute);
  });
  bindClick(achOpenBtn, () => toggleAchievements());
  bindClick(achClose, () => toggleAchievements(false));
  bindClick(achBackdrop, () => toggleAchievements(false));

  bindHold(laneLeft, 'left');
  bindHold(laneRight, 'right');
  bindHold(tAccelBtn, 'accel');
  bindHold(tBrakeBtn, 'brake');
  bindHold(tJumpBtn, 'jump');
  bindHold(tWingBtn, 'wing');

  function onKeyDown(e) {
    if (!e || e.repeat) return;
    // HUD only owns K (main.js owns C / M / P / R); Escape also closes the panel.
    let started = true;
    try {
      const P = window.__PELICAN__;
      if (P && P.state && typeof P.state.started === 'boolean') started = P.state.started;
    } catch (err) {
      started = true;
    }
    if (!started) return;
    if (e.code === 'KeyK' || e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      toggleAchievements();
    } else if (e.code === 'Escape' || e.key === 'Escape') {
      if (cache.achOpen) toggleAchievements(false);
    }
  }
  window.addEventListener('keydown', onKeyDown);

  // ---------------------------------------------------------------- update
  function update(dt, state) {
    if (!state) return;
    const step = finiteNum(dt, 0.016);
    cache.hudTime += step;

    // ---- speed
    const speed = Math.max(0, finiteNum(state.speed, 0));
    const kmh = Math.round(speed * 3.6);
    const ratio = clamp01(finiteNum(state.speedRatio, speed / finiteNum(state.speedMax, 34)));
    if (kmh !== cache.kmh) {
      refs.speedNum.textContent = String(kmh);
      cache.kmh = kmh;
    }
    if (Math.abs(ratio - cache.ratio) > 0.0015) {
      cache.ratio = ratio;
      const off = ARC_LEN * (1 - ratio);
      refs.fill.style.strokeDashoffset = off.toFixed(2);
      refs.needle.setAttribute('transform', 'rotate(' + (-90 + ratio * 180).toFixed(2) + ' 100 110)');
      const c = speedColor(ratio);
      const col = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
      refs.speedNum.style.color = col;
      refs.speedNum.style.textShadow = '0 0 22px rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',.5)';
      refs.needle.style.stroke = col;
      refs.hub.style.fill = col;
    }

    // ---- fish / combo / score
    const fish = Math.max(0, Math.round(finiteNum(state.fishCount, 0)));
    if (fish !== cache.fish) {
      refs.fishNum.textContent = String(fish);
      if (cache.fish >= 0) retrigger(refs.fishNum, 'hud-pop');
      cache.fish = fish;
    }
    const combo = Math.max(1, Math.round(finiteNum(state.combo, 1)));
    if (combo !== cache.combo) {
      refs.comboEl.textContent = '×' + combo;
      refs.comboEl.style.color = COMBO_COLORS[Math.min(combo, COMBO_COLORS.length - 1)];
      if (cache.combo >= 0) retrigger(refs.comboEl, 'hud-pop');
      cache.combo = combo;
    }
    const score = Math.round(finiteNum(state.score, 0));
    if (score !== cache.score) {
      refs.scoreNum.textContent = fmtNum(score);
      cache.score = score;
    }

    // ---- day phase
    const ph = ((finiteNum(state.dayPhase, 0) % 1) + 1) % 1;
    const info = phaseInfo(ph);
    if (info !== cache.phaseName) {
      cache.phaseName = info;
      refs.phaseName.textContent = info;
      refs.phaseIcon.innerHTML = PHASE_ICON[info] || PHASE_ICON['黄昏'];
    }
    const nightPct = Math.round(clamp01(finiteNum(state.night, 0)) * 100);
    if (nightPct !== cache.nightPct) {
      cache.nightPct = nightPct;
      refs.phaseSub.textContent = '夜色 ' + nightPct + '%';
    }
    if (cache.hudTime - cache.phaseWriteT > 0.2 || Math.abs(ph - cache.phaseT) > 0.5) {
      cache.phaseWriteT = cache.hudTime;
      cache.phaseT = ph;
      refs.phaseBar.style.transform = 'scaleX(' + ph.toFixed(3) + ')';
    }

    // ---- autopilot / pause
    if (typeof state.autopilot === 'boolean') applyAuto(state.autopilot);
    if (typeof state.paused === 'boolean') applyPaused(state.paused);

    // ---- camera
    const cid = typeof state.cameraMode === 'string' ? state.cameraMode : '';
    if (cid && cid !== cache.cameraId) {
      applyCamera(camModes, cid);
    } else if (!cache.cameraId && camModes.length) {
      applyCamera(camModes, camModes[0].id);
    }
    if (cache.cameraId === 'cinematic') {
      let shot = '';
      try {
        const P = window.__PELICAN__;
        if (P && P.cameras && typeof P.cameras.shotLabel === 'string') shot = P.cameras.shotLabel;
      } catch (err) {
        shot = '';
      }
      if (shot && shot !== cache.shotName) {
        cache.shotName = shot;
        refs.camHint.textContent = shot;
      }
    }

    // ---- quality / fps
    applyQualityFromState(state.quality);
    if (cache.hudTime - cache.fpsT > 0.3) {
      cache.fpsT = cache.hudTime;
      const fps = Math.round(finiteNum(state.fps, 60));
      if (fps !== cache.fpsShown) {
        cache.fpsShown = fps;
        refs.fpsEl.textContent = fps + ' FPS';
        refs.fpsEl.classList.toggle('hud-fps-mid', fps < 50 && fps >= 32);
        refs.fpsEl.classList.toggle('hud-fps-low', fps < 32);
      }
    }

    // ---- mute sync from audio handle (main owns M key) + BPM read-out
    if (cache.hudTime - cache.lastMuteSync > 0.25) {
      cache.lastMuteSync = cache.hudTime;
      try {
        const P = window.__PELICAN__;
        if (P && P.audio && typeof P.audio.muted === 'boolean') applyMuted(P.audio.muted);
      } catch (err) {
        /* ignore */
      }
    }
    if (cache.hudTime - cache.lastBpmT > 0.5) {
      cache.lastBpmT = cache.hudTime;
      let bpm = 0;
      try {
        const P = window.__PELICAN__;
        if (P && P.audio && typeof P.audio.bpm === 'number') bpm = P.audio.bpm;
      } catch (err) {
        bpm = 0;
      }
      if (bpm > 0) {
        const shown = Math.round(bpm);
        if (shown !== cache.bpm) {
          cache.bpm = shown;
          refs.bpmEl.textContent = 'BPM ' + shown;
          refs.bpmEl.classList.remove('hud-bpm-hidden');
        }
      } else if (!refs.bpmEl.classList.contains('hud-bpm-hidden')) {
        refs.bpmEl.textContent = 'BPM --';
      }
    }

    // ---- achievements
    syncAchievements(state.achievements);
  }

  // ---------------------------------------------------------------- dispose
  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    if (cache.introTimer) clearTimeout(cache.introTimer);
    if (cache.flashTimer) clearTimeout(cache.flashTimer);
    for (const id of cache.timers) clearTimeout(id);
    cache.timers.clear();
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  const handle = {
    element: root,
    update,
    toast,
    flash,
    setCameraModes(modes, currentId) {
      applyCamera(modes, currentId || cache.cameraId);
    },
    setAutopilot(on) {
      applyAuto(on);
    },
    setQualityLabel,
    showIntro,
    hideIntro,
    dispose,
    // extras (safe for main to use; contract API above is authoritative)
    toggleAchievements,
    setMuted(m) {
      applyMuted(m);
    },
    setPaused(p) {
      applyPaused(p);
    },
    get touch() {
      return touchMode;
    },
    get achievementsOpen() {
      return cache.achOpen;
    },
  };

  // initial defaults
  applyMuted(false);
  setQualityLabel('高');
  refs.achOpenCount.textContent = '0/14';

  return handle;
}
