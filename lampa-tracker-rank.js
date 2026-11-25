/* Lampa Tracker Rank v1.0.0 — combined tracker allowlist, scoring, colouring.
 * Works on rendered torrent items from public parsers; no parser requests modified.
 * Local-only UI logic. Disable competing Torrent Styles v2 before installing.
 */
(function () {
  'use strict';
  if (window.LampaTrackerRank && window.LampaTrackerRank.version === '1.0.0') return;

  var CONFIG = {
    allowed: [
      {name:'RuTracker', rank:15, rx:/\brutracker(?:\.org|\.net)?\b/i},
      {name:'Kinozal',   rank:13, rx:/\bkinozal(?:\.tv)?\b/i},
      {name:'Rutor',     rank:11, rx:/\brutor(?:\.(?:info|is|org))?\b/i},
      {name:'NNMClub',   rank:9,  rx:/\b(?:nnmclub|nnm-club|nnmclub\.to)\b/i},
      {name:'TorrentBy', rank:7,  rx:/\b(?:torrentby|torrent\.by)\b/i}
    ],
    hideUnknown: true,
    sortByScore: true,
    // Avoid modifying results elsewhere in the Lampa UI.
    cardSelector: '.torrent-item',
    scoreWeights: {quality:30, hdr:15, seeds:25, size:15, tracker:15}
  };
  var STYLE_ID='lampa-tracker-rank-css';
  var HIDE='ltr-hidden';
  var CARD='ltr-card';
  var BADGE='ltr-score';
  var META_SELECTORS=[
    '.torrent-item__tracker','.torrent-item__trackers',
    '.torrent-item__details','.torrent-item__info',
    '.torrent-item__footer','.torrent-item__bottom',
    '.torrent-item__meta','.torrent-item__time',
    '.torrent-item__date','.torrent-item__subtitle'
  ];
  var observed=null, pending=false, internalMutation=false, disabled=false;
  var originalOrder=new WeakMap();
  var generated = new WeakMap();
  var MAX_CARDS=400;

  function n(v) {return String(v==null?'':v).replace(/\s+/g,' ').trim();}
  function num(s) {return parseFloat(String(s).replace(/\s/g,'').replace(',','.'))||0;}
  function textOf(el) { return el ? n(el.textContent) : ''; }
  function firstText(card,selectors) {
    for(var i=0;i<selectors.length;i++) {
      var e=card.querySelector(selectors[i]);
      if(e) {var t=textOf(e); if(t)return t;}
    }
    return '';
  }
  function sourceString(card) {
    var data=card.dataset||{};
    var direct=[data.tracker,data.trackers,data.source,data.sources,data.site].filter(Boolean).join(', ');
    if(direct)return direct;
    var parts=[];
    META_SELECTORS.forEach(function(sel){
      var els=card.querySelectorAll(sel);
      for(var i=0;i<els.length;i++){
        var el=els[i];
        if (el.closest && el.closest('.'+BADGE))continue;
        var s=textOf(el);
        if(s && s.length<320)parts.push(s);
      }
    });
    // Common Lampa torrent cards put the tracker names on a short date/source line.
    if(!parts.length) {
      var nodes=card.querySelectorAll('small,span,div');
      for(var j=0;j<nodes.length && j<75;j++){
        if(nodes[j].children.length>1)continue;
        var val=textOf(nodes[j]);
        if(val.length>150)continue;
        if(CONFIG.allowed.some(function(t){return t.rx.test(val);}))parts.push(val);
      }
    }
    return parts.join(', ');
  }
  function titleOf(card){
    return firstText(card,[
      '.torrent-item__title','.torrent-item__name',
      '.torrent-item__head','.torrent-item__header',
      '.torrent-item__content .torrent-item__title',
      '.torrent-item__main'
    ]) || n((card.innerText||card.textContent||'').split('\n')[0]).slice(0,200);
  }
  function getMetric(card,names,regex){
    for(var i=0;i<names.length;i++){
      var node=card.querySelector(names[i]);
      if(node){var v=num(textOf(node));if(isFinite(v))return v;}
    }
    var t=textOf(card);
    var m=t.match(regex);
    return m?num(m[1]):null;
  }
  function seedsOf(card){
    var ds=card.dataset||{};
    if(ds.seeders!=null)return num(ds.seeders);
    return getMetric(card,[
      '.torrent-item__seeds','.torrent-item__seed',
      '.torrent-item__seeders','.torrent-item__peers-seeds',
      '[data-seeds]'
    ],/(?:Раздают|Сиды|Seeds|Seeders)\s*:?\s*(\d[\d\s]*)/i);
  }
  function peersOf(card){
    return getMetric(card,[
      '.torrent-item__leechers','.torrent-item__leech',
      '.torrent-item__peers'
    ],/(?:Качают|Пиры|Leechers|Leechs)\s*:?\s*(\d[\d\s]*)/i);
  }
  function sizeOf(card){
    var ds=card.dataset||{};
    if(ds.sizeBytes)return num(ds.sizeBytes)/1073741824;
    var source=firstText(card,[
      '.torrent-item__size','.torrent-item__weight',
      '.torrent-item__details','.torrent-item__footer'
    ]) || textOf(card);
    var m=source.match(/(\d+(?:[.,]\d+)?)\s*(ТиБ|TiB|ТБ|TB|ГиБ|GiB|ГБ|GB|МиБ|MiB|МБ|MB)\b/i);
    if(!m)return null;
    var v=num(m[1]),unit=m[2].toLowerCase();
    if(/^(?:т|t)/.test(unit))return v*1024;
    if(/^(?:м|m)/.test(unit))return v/1024;
    return v;
  }
  function qualityOf(title,card){
    var t=title+' '+firstText(card,['.torrent-item__quality','.torrent-item__tags']);
    if(/(?:2160p|3840\s*[xх×]\s*2160|\b4k\b|\buhd\b)/i.test(t))return {name:'4K',score:30};
    if(/(?:1080p|1920\s*[xх×]\s*(?:8\d\d|9\d\d|10\d\d)|\bfhd\b)/i.test(t))return {name:'1080p',score:23};
    if(/(?:720p|1280\s*[xх×]\s*720|\bhd\b)/i.test(t))return {name:'720p',score:14};
    if(/(?:480p|576p|\bsd\b|720\s*[xх×]\s*(?:304|400|480|576|534|576))/i.test(t))return {name:'SD',score:5};
    return {name:'Неизвестно',score:0};
  }
  function hdrOf(title,card){
    var t=title+' '+firstText(card,['.torrent-item__quality','.torrent-item__tags']);
    if(/(?:dolby\s*vision|\bDoVi\b|\bDV\b|\bHDR10\+?\b)/i.test(t))return {name:'DV/HDR10',score:15};
    if(/\bHDR\b/i.test(t))return {name:'HDR',score:12};
    return {name:'SDR/неизв.',score:0};
  }
  function sizePoints(gb,q){
    if(gb==null||!isFinite(gb)||gb<=0)return 0;
    var range=q.name==='4K'?[8,35]:q.name==='1080p'?[2,15]:q.name==='720p'?[0.7,8]:[0.3,5];
    if(gb>=range[0]&&gb<=range[1])return 15;
    if(gb<range[0])return Math.round(Math.max(0,15*gb/range[0]));
    return Math.max(1,Math.round(15*range[1]/gb));
  }
  function score(card){
    var source=sourceString(card);
    var matched=CONFIG.allowed.filter(function(t){return t.rx.test(source);});
    var title=titleOf(card),quality=qualityOf(title,card),hdr=hdrOf(title,card);
    var seeds=seedsOf(card),peers=peersOf(card),size=sizeOf(card);
    var seedPoints=seeds==null?0:Math.min(25,Math.round(25*Math.log(1+Math.max(0,seeds))/Math.log(1001)));
    var trackerPoints=matched.length?Math.max.apply(null,matched.map(function(t){return t.rank;})):0;
    var sizeScore=sizePoints(size,quality);
    return {
      total:quality.score+hdr.score+seedPoints+sizeScore+trackerPoints,
      source:source,matched:matched.map(function(t){return t.name;}),
      quality:quality,hdr:hdr,seeds:seeds,peers:peers,size:size,
      subscores:{quality:quality.score,hdr:hdr.score,seeds:seedPoints,size:sizeScore,tracker:trackerPoints}
    };
  }
  function style(){
    if(document.getElementById(STYLE_ID))return;
    var el=document.createElement('style');el.id=STYLE_ID;
    el.textContent=''
      +'.ltr-hidden{display:none !important}'
      +'.ltr-card{position:relative !important;padding-right:5.2em !important}'
      +'.ltr-score{position:absolute;right:.65em;top:.55em;z-index:3;'
      +'border:1px solid var(--ltr-edge,#399c62);background:rgba(12,24,22,.94);'
      +'border-radius:.45em;padding:.22em .48em;color:var(--ltr-ink,#65d594);'
      +'font-weight:700;font-size:.83em;pointer-events:none;white-space:nowrap}'
      +'.ltr-score::before{content:"★ ";opacity:.8}'
      +'.ltr-card [class*="seed"]{color:#3fdc83 !important}'
      +'.ltr-card [class*="leech"],.ltr-card [class*="peer"]{color:#56abff !important}'
      +'.ltr-card [class*="bitrate"]{color:#3fdc83 !important}'
      +'.ltr-card [class*="size"],.ltr-card [class*="weight"]{color:#5ada9b !important}'
      +'.ltr-card [class*="seed"],.ltr-card [class*="leech"],'
      +'.ltr-card [class*="peer"],.ltr-card [class*="bitrate"],'
      +'.ltr-card [class*="size"]{font-weight:600}'
      +'.ltr-card.ltr-best{box-shadow:inset 3px 0 0 #3bd68b}'
      +'.ltr-card.ltr-warn [class*="seed"]{color:#ecb64d !important}';
    (document.head||document.documentElement).appendChild(el);
  }
  function badge(card,result){
    var el=card.querySelector('.'+BADGE);
    if(!el){el=document.createElement('span');el.className=BADGE;card.appendChild(el);}
    var hue=result.total>=75?'#54dc94':result.total>=50?'#edc467':'#f28b85';
    el.style.setProperty('--ltr-ink',hue);
    el.style.setProperty('--ltr-edge',hue);
    var nextScore=String(result.total)+'/100';
    if(el.textContent!==nextScore)el.textContent=nextScore;
    var tip='Рейтинг '+result.total+'/100 | качество '+result.subscores.quality+'/30'
      +' | HDR '+result.subscores.hdr+'/15 | сиды '+result.subscores.seeds+'/25'
      +' | размер '+result.subscores.size+'/15 | трекер '+result.subscores.tracker+'/15';
    if(el.title!==tip)el.title=tip;
    card.classList.toggle('ltr-best',result.total>=75);
    card.classList.toggle('ltr-warn',result.seeds!==null&&result.seeds<5);
  }
  function reconcile(cards){
    // only reorder homogeneous card groups; do not move unrelated buttons/headers.
    if(!CONFIG.sortByScore||cards.length<2)return;
    var byParent=new Map();
    cards.forEach(function(card){
      if(card.classList.contains(HIDE)||!card.parentNode)return;
      var p=card.parentNode;
      if(!byParent.has(p))byParent.set(p,[]);
      byParent.get(p).push(card);
    });
    byParent.forEach(function(group,parent){
      if(group.length<2)return;
      var children=Array.prototype.slice.call(parent.children);
      var eligible=children.every(function(ch){return ch.matches&&ch.matches(CONFIG.cardSelector);});
      if(!eligible)return;
      group.sort(function(a,b){
        var aa=num(a.dataset.ltrScore),bb=num(b.dataset.ltrScore);
        return bb-aa || (originalOrder.get(a)||0)-(originalOrder.get(b)||0);
      });
      var current=children.filter(function(ch){return !ch.classList.contains(HIDE);});
      if(group.every(function(ch,i){return current[i]===ch;}))return;
      var focused=document.activeElement;
      internalMutation=true;
      group.forEach(function(ch){parent.appendChild(ch);});
      // Moving nodes must not steal TV remote focus.
      if(focused&&focused.isConnected&&focused.focus)try{focused.focus({preventScroll:true});}catch(e){}
      setTimeout(function(){internalMutation=false;},0);
    });
  }
  function scan(){
    pending=false;
    if(disabled)return;
    var cards=Array.prototype.slice.call(document.querySelectorAll(CONFIG.cardSelector)).slice(0,MAX_CARDS);
    cards.forEach(function(card,i){
      if(!originalOrder.has(card))originalOrder.set(card,i);
      // Skip our own nodes when extracting metadata, via dedicated selectors.
      var result=score(card);
      var hidden=(result.matched.length===0) && (CONFIG.hideUnknown||!!result.source);
      card.classList.toggle(HIDE,hidden);
      card.classList.add(CARD);
      card.dataset.ltrScore=String(result.total);
      card.dataset.ltrSources=result.matched.join(',');
      badge(card,result);
      generated.set(card,result);
    });
    reconcile(cards);
  }
  function schedule(){
    if(disabled||pending||internalMutation)return;
    pending=true;
    setTimeout(scan,180);
  }
  style();
  observed=new MutationObserver(schedule);
  observed.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  schedule();
  window.LampaTrackerRank={
    version:'1.0.0',
    config:CONFIG,
    refresh:scan,
    inspect:function(card){return card?score(card):null;},
    disable:function(){
      disabled=true; if(observed)observed.disconnect();
      document.querySelectorAll(CONFIG.cardSelector).forEach(function(card){
        card.classList.remove(HIDE,CARD,'ltr-best','ltr-warn');
        var b=card.querySelector('.'+BADGE);if(b)b.remove();
        delete card.dataset.ltrScore;delete card.dataset.ltrSources;
      });
      var st=document.getElementById(STYLE_ID);if(st)st.remove();
    }
  };
  console.info('[Lampa Tracker Rank] Loaded (5 trackers, colour badges, scoring).');
})();
