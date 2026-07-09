/**
 * Static CSS + client JS for the §3.E HTML report (extracted from html-report.js
 * to keep that module focused on rendering logic). All strings here are constant —
 * they carry NO document-derived data, so there is no P8 concern in this file; the
 * untrusted data is escaped where html-report.js interpolates it. The client JS is
 * self-contained (no external loads) and never mutates the emitted bytes, so the
 * §3.A determinism contract is unaffected.
 */

export const CSS = `*{box-sizing:border-box}body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#0f172a;background:#f8fafc}header{padding:16px 24px;background:#fff;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}h1{font-size:18px;margin:0}h2{font-size:16px;margin:16px 0 8px}h3{font-size:13px;text-transform:uppercase;color:#64748b;margin:16px 0 6px}.chip{font-size:12px;color:#64748b}.tabs{display:flex;flex-wrap:wrap;gap:4px;padding:8px 24px;background:#fff;border-bottom:1px solid #e2e8f0;position:sticky;top:0;z-index:2}.tab{border:0;background:0;padding:6px 12px;cursor:pointer;border-radius:6px;font:inherit;color:#475569}.tab.on{background:#0ea5a4;color:#fff}.panel{display:none;padding:16px 24px;max-width:1100px}.panel.on{display:block}.cards{display:flex;flex-wrap:wrap;gap:10px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;min-width:110px}.card b{font-size:22px;display:block}.card span{font-size:12px;color:#64748b}.bar{display:flex;align-items:center;gap:10px;margin:4px 0}.bar span{width:110px;font-size:12px}.track{flex:1;height:10px;background:#e2e8f0;border-radius:6px;overflow:hidden}.track i{display:block;height:100%}.track .g{background:#16a34a}.track .a{background:#d97706}.track .r{background:#dc2626}.bar b{width:40px;text-align:right;font-size:12px}.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.tag{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:14px;padding:2px 10px;font-size:12px}table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #eef2f7;vertical-align:top}.muted{color:#64748b}.small{font-size:11px}.hot{color:#dc2626}.layer{margin:10px 0}.rec{background:#fff;border:1px solid #e2e8f0;border-left:4px solid #94a3b8;border-radius:6px;padding:12px 14px;margin:8px 0}.rec.sev-priority-1,.rec.impact-H{border-left-color:#dc2626}.rec.sev-priority-2{border-left-color:#d97706}.rec.sev-priority-3,.rec.impact-M{border-left-color:#0ea5a4}.rt{font-weight:600;font-size:15px}.ri{font-size:12px;color:#b45309;margin:2px 0 6px}.act{margin:6px 0}.ex{margin:6px 0;font-size:12px;color:#334155}.pill{font-size:11px;background:#f1f5f9;border-radius:10px;padding:1px 8px;font-weight:400}.fix{color:#166534;font-size:12px}.filters{display:flex;gap:8px;margin:8px 0;align-items:center;flex-wrap:wrap}.filters select{padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px}.risks li,.ex li{margin:4px 0}code{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:12px}.scroll{overflow:auto}pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;font-size:11px}.gwrap{border:1px solid #e2e8f0;border-radius:8px;background:#fff;height:520px;overflow:hidden;cursor:grab}.gwrap:active{cursor:grabbing}#gsvg{width:100%;height:100%;display:block;touch-action:none}.ge{stroke:#cbd5e1;stroke-width:1}.ge.adj{stroke:#0ea5a4;stroke-width:2}.ge.dim{opacity:.1}.gn{cursor:pointer}.gn text{font-size:9px;fill:#475569}.gn circle{stroke:#fff;stroke-width:1}.gn.sel circle{stroke:#0f172a;stroke-width:3}.gn.dim{opacity:.16}.ghint{font-size:12px;color:#64748b;margin-top:8px;display:flex;gap:8px;align-items:center}.gbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0;font-size:13px}.gbar .sep{color:#cbd5e1}.ghint button,.pager button,.gbar button{font:inherit;color:#0ea5a4;background:0;border:1px solid #cbd5e1;border-radius:6px;padding:3px 10px;cursor:pointer}.gbar button:hover{background:#f1f5f9}.pager{display:flex;gap:8px;margin:10px 0;align-items:center}.rawwrap{margin-top:12px}summary{cursor:pointer;color:#475569;font-size:13px;padding:4px 0}.cols{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}.cols>div{flex:1;min-width:220px}.planobj{background:#fff;border:1px solid #e2e8f0;border-radius:6px;margin:6px 0;padding:2px 12px}.planobj summary{padding:8px 0}.pbody{padding:2px 0 10px}.pbody table{margin-top:6px}.mxwrap{overflow:auto;max-height:640px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}table.mx{border-collapse:collapse;font-size:10px;table-layout:fixed}table.mx td,table.mx th.mx-col{width:15px;height:15px;min-width:15px;border:1px solid #eef2f7;text-align:center;padding:0}table.mx th.mx-row{width:210px;max-width:210px;overflow:hidden;text-overflow:ellipsis;text-align:right;padding:0 8px;white-space:nowrap;font-weight:400;color:#334155;position:sticky;left:0;background:#fff;border:1px solid #eef2f7;z-index:1}table.mx thead th{position:sticky;top:0;background:#fff;color:#64748b;z-index:2}table.mx th.mx-corner{width:210px;min-width:210px;left:0;z-index:3;border:1px solid #eef2f7;background:#fff}.mx-diag{background:#e2e8f0}.mx-dep{background:#0ea5a4}.mx-cycle{background:#dc2626}.mx-key{display:inline-block;width:11px;height:11px;border-radius:2px;vertical-align:middle;margin:0 2px}@media(prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}header,.tabs,.card,table,.rec,.gwrap,.planobj{background:#1e293b;border-color:#334155}.tag,.pill,code{background:#334155;border-color:#475569}.ge{stroke:#334155}.gn text{fill:#cbd5e1}.gn circle{stroke:#1e293b}.mxwrap{background:#1e293b}table.mx th.mx-row,table.mx thead th{background:#1e293b;color:#cbd5e1}.mx-diag{background:#334155}}`;

// Tab switching.
const TABS_JS = `document.querySelectorAll('.tab').forEach(function(t){t.onclick=function(){document.querySelectorAll('.tab,.panel').forEach(function(e){e.classList.remove('on')});t.classList.add('on');document.getElementById('p-'+t.dataset.t).classList.add('on')}});`;

// Dependency-graph interaction. A seeded, NO-random force simulation (Coulomb
// repulsion + edge springs + centering) animates the nodes from their deterministic
// layered seed into a clustered layout; plus node drag, zoom/fit buttons, background
// pan, and click-a-node to highlight its neighbours. All client-side, so it never
// touches the emitted bytes. Functions are exposed on window for the tab's buttons.
const GRAPH_JS = `(function(){
  var svg=document.getElementById('gsvg'); if(!svg) return;
  var gv=document.getElementById('gv');
  var nodes=[].slice.call(svg.querySelectorAll('.gn'));
  var edges=[].slice.call(svg.querySelectorAll('.ge'));
  var vb=svg.viewBox.baseVal, W=vb.width||1080, H=vb.height||600;
  var P={}, home={}, adj={};
  nodes.forEach(function(n){var id=n.dataset.id; P[id]={x:+n.dataset.x,y:+n.dataset.y,vx:0,vy:0,fix:false}; home[id]={x:+n.dataset.x,y:+n.dataset.y}; adj[id]={};});
  edges.forEach(function(e){var s=e.dataset.src,t=e.dataset.tgt; if(P[s]&&P[t]){adj[s][t]=1; adj[t][s]=1;}});
  var ids=Object.keys(P);
  function paint(){
    nodes.forEach(function(n){var p=P[n.dataset.id]; n.setAttribute('transform','translate('+p.x.toFixed(1)+' '+p.y.toFixed(1)+')');});
    edges.forEach(function(e){var a=P[e.dataset.src],b=P[e.dataset.tgt]; if(a&&b){e.setAttribute('x1',a.x.toFixed(1));e.setAttribute('y1',a.y.toFixed(1));e.setAttribute('x2',b.x.toFixed(1));e.setAttribute('y2',b.y.toFixed(1));}});
  }
  var anim=null, alpha=0;
  function tick(){
    var cx=W/2, cy=H/2, i, j;
    for(i=0;i<ids.length;i++){var a=P[ids[i]]; a.vx=(a.vx+(cx-a.x)*0.004)*0.9; a.vy=(a.vy+(cy-a.y)*0.004)*0.9;}
    for(i=0;i<ids.length;i++){for(j=i+1;j<ids.length;j++){var a=P[ids[i]],b=P[ids[j]];var dx=a.x-b.x,dy=a.y-b.y,d2=dx*dx+dy*dy+0.01,d=Math.sqrt(d2),f=1600/d2;a.vx+=f*dx/d;a.vy+=f*dy/d;b.vx-=f*dx/d;b.vy-=f*dy/d;}}
    for(i=0;i<ids.length;i++){var id=ids[i],a=P[id];for(var t in adj[id]){var b=P[t];var dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1,f=(d-90)*0.015;a.vx+=f*dx/d;a.vy+=f*dy/d;}}
    for(i=0;i<ids.length;i++){var p=P[ids[i]];if(p.fix)continue;p.x+=Math.max(-12,Math.min(12,p.vx));p.y+=Math.max(-12,Math.min(12,p.vy));p.x=Math.max(20,Math.min(W-20,p.x));p.y=Math.max(20,Math.min(H-20,p.y));}
    paint(); alpha*=0.985;
    if(alpha>0.02) anim=requestAnimationFrame(tick);
  }
  window.gLayout=function(mode){
    if(anim){cancelAnimationFrame(anim);anim=null;}
    var mx=document.getElementById('gmatrix'),sw=document.getElementById('gsvgwrap');
    if(mode==='matrix'){if(mx)mx.style.display='';if(sw)sw.style.display='none';return;}
    if(mx)mx.style.display='none';if(sw)sw.style.display='';
    if(mode==='layered'){ids.forEach(function(id){P[id].x=home[id].x;P[id].y=home[id].y;P[id].vx=0;P[id].vy=0;});paint();}
    else{alpha=1;anim=requestAnimationFrame(tick);}
  };
  var view={k:1,x:0,y:0};
  function applyView(){gv.setAttribute('transform','translate('+view.x+' '+view.y+') scale('+view.k+')');}
  window.gZoom=function(f){view.k=Math.max(0.2,Math.min(5,view.k*f));applyView();};
  window.gReset=function(){view={k:1,x:0,y:0};applyView();window.gLayout('layered');};
  window.gFit=function(){var a=1e9,b=1e9,c=-1e9,d=-1e9;ids.forEach(function(id){var p=P[id];a=Math.min(a,p.x);b=Math.min(b,p.y);c=Math.max(c,p.x);d=Math.max(d,p.y);});var w=c-a||1,h=d-b||1,k=Math.min(W/(w+80),H/(h+80),3);view.k=k;view.x=(W-k*(a+c))/2;view.y=(H-k*(b+d))/2;applyView();};
  function toLocal(ev){var pt=svg.createSVGPoint();pt.x=ev.clientX;pt.y=ev.clientY;var m=gv.getScreenCTM();return m?pt.matrixTransform(m.inverse()):{x:ev.clientX,y:ev.clientY};}
  var drag=null,moved=false;
  nodes.forEach(function(n){n.addEventListener('mousedown',function(ev){ev.stopPropagation();ev.preventDefault();drag=n.dataset.id;moved=false;P[drag].fix=true;});});
  var pan=null;
  svg.addEventListener('mousedown',function(ev){if(drag)return;pan={x:ev.clientX,y:ev.clientY,vx:view.x,vy:view.y};});
  window.addEventListener('mousemove',function(ev){
    if(drag){moved=true;var l=toLocal(ev);P[drag].x=l.x;P[drag].y=l.y;paint();return;}
    if(pan){view.x=pan.vx+(ev.clientX-pan.x);view.y=pan.vy+(ev.clientY-pan.y);applyView();}
  });
  window.addEventListener('mouseup',function(){if(drag){P[drag].fix=false;drag=null;}pan=null;});
  svg.addEventListener('wheel',function(ev){ev.preventDefault();window.gZoom(ev.deltaY<0?1.1:0.9);},{passive:false});
  function clr(){nodes.forEach(function(n){n.classList.remove('sel','dim');});edges.forEach(function(e){e.classList.remove('adj','dim');});}
  nodes.forEach(function(n){n.addEventListener('click',function(ev){ev.stopPropagation();if(moved){moved=false;return;}var id=n.dataset.id,keep={};keep[id]=1;clr();edges.forEach(function(e){if(e.dataset.src===id||e.dataset.tgt===id){e.classList.add('adj');keep[e.dataset.src]=1;keep[e.dataset.tgt]=1;}else{e.classList.add('dim');}});nodes.forEach(function(m){if(keep[m.dataset.id]){if(m.dataset.id===id)m.classList.add('sel');}else{m.classList.add('dim');}});});});
  svg.addEventListener('click',function(){clr();});
  // Default view is the STATIC hierarchical layout the server already rendered (no
  // JS needed on load). Force / Layered / Matrix are opt-in via the buttons.
})();`;

// Findings virtualization: parse the inert JSON island, filter by family/severity,
// and render one page (50) at a time via DOM APIs (textContent — never innerHTML —
// so island data stays inert, P8).
const FINDINGS_JS = `(function(){var el=document.getElementById('fdata');if(!el)return;var data;try{data=JSON.parse(el.textContent||'[]')}catch(e){data=[]}var PAGE=50,page=0,fam='',sev='';var recs=document.getElementById('recs'),info=document.getElementById('fInfo');function flt(){return data.filter(function(f){return(!fam||f.family===fam)&&(!sev||f.severity===sev)})}function add(p,cls,txt){var e=document.createElement(cls==='code'?'code':'div');if(cls&&cls!=='code')e.className=cls;if(txt!=null)e.textContent=txt;p.appendChild(e);return e}function render(){var list=flt(),total=list.length,pages=Math.max(1,Math.ceil(total/PAGE));if(page>=pages)page=pages-1;if(page<0)page=0;var sl=list.slice(page*PAGE,page*PAGE+PAGE);recs.textContent='';sl.forEach(function(f){var d=document.createElement('div');d.className='rec sev-'+(f.severity||'');var h=document.createElement('div');var c=document.createElement('code');c.textContent=f.rule_id||'';h.appendChild(c);add(h,'pill',' '+(f.severity||''));add(h,'muted',' '+(f.family||''));d.appendChild(h);add(d,'',f.message||'');if(f.suggestion)add(d,'fix','Fix: '+f.suggestion);add(d,'muted small',(f.object||'')+' \\u00b7 '+(f.file||'')+':'+(f.line||0));recs.appendChild(d)});info.textContent=total?('Showing '+(page*PAGE+1)+'\\u2013'+(page*PAGE+sl.length)+' of '+total):'No findings match the filter.'}document.getElementById('fFam').addEventListener('change',function(e){fam=e.target.value;page=0;render()});document.getElementById('fSev').addEventListener('change',function(e){sev=e.target.value;page=0;render()});document.getElementById('fPrev').addEventListener('click',function(){page--;render()});document.getElementById('fNext').addEventListener('click',function(){page++;render()});render()})();`;

export const APP_JS = TABS_JS + GRAPH_JS + FINDINGS_JS;
