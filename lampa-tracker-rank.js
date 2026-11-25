/* Lampa Tracker Rank v1.3.3 — combined tracker allowlist, scoring, colouring.
 * Works on rendered torrent items from public parsers; no parser requests modified.
 * Local-only UI logic. Disable competing Torrent Styles v2 before installing.
 */
(function () {
  'use strict';
  if (window.LampaTrackerRank) {
    if (window.LampaTrackerRank.version === '1.3.3') return;
    try { if (window.LampaTrackerRank.disable) window.LampaTrackerRank.disable(); } catch(e) {}
  }

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
    scoreWeights: {quality:30, hdr:10, audio:25, release:10, seeds:20, size:5, tracker:0}
  };
  // The Balanced profile preserves the exact weights requested by the user.
  var PROFILES = {
    balanced:{quality:30,hdr:10,audio:25,release:10,seeds:20,size:5,tracker:0},
    cinema:{quality:35,hdr:15,audio:25,release:15,seeds:5,size:5,tracker:0},
    quick:{quality:20,hdr:5,audio:25,release:5,seeds:40,size:5,tracker:0},
    economy:{quality:20,hdr:0,audio:25,release:5,seeds:25,size:25,tracker:0}
  };
  var STORAGE='lampa_tracker_rank_v13_';
  function load(key,fallback){
    try{if(window.Lampa&&Lampa.Storage&&Lampa.Storage.get){var x=Lampa.Storage.get(STORAGE+key);if(x!==undefined&&x!==null)return x;}}
    catch(e){}
    try{var raw=window.localStorage.getItem(STORAGE+key);return raw===null?fallback:JSON.parse(raw);}catch(e){return fallback;}
  }
  function save(key,value){
    try{if(window.Lampa&&Lampa.Storage&&Lampa.Storage.set)Lampa.Storage.set(STORAGE+key,value);}
    catch(e){}
    try{window.localStorage.setItem(STORAGE+key,JSON.stringify(value));}catch(e){}
  }
  var OPTIONS={
    profile:String(load('profile','balanced')),
    filter:load('filter',true)!==false,
    sorting:load('sorting',true)!==false,
    grouping:load('grouping',false)===true,
    showReadiness:load('readiness',true)!==false,
    showDetails:load('details',true)!==false,
    allowed:{}
  };
  CONFIG.allowed.forEach(function(t){OPTIONS.allowed[t.name]=load('tracker_'+t.name,true)!==false;});
  function isKnownTracker(name){return CONFIG.allowed.some(function(t){return t.name===name;});}
  if(!PROFILES[OPTIONS.profile])OPTIONS.profile='balanced';
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
  var reorderLock=false;
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
  // Rendered Lampa cards vary across builds; prefer full card text rather than
  // one guessed selector which might contain bitrate instead of seeds/size.
  function metricText(card){
    return n(card.innerText || card.textContent || '');
  }
  function seedsOf(card){
    var ds=card.dataset||{};
    if(ds.seeders!=null)return num(ds.seeders);
    var t=metricText(card),m=t.match(/(?:Раздают|Разда[её]т|Seeders|Seeds|Сиды)\s*:?\s*(\d[\d\s]*)/i);
    return m?num(m[1]):null;
  }
  function peersOf(card){
    var t=metricText(card),m=t.match(/(?:Качают|Leechers|Peers|Пиры)\s*:?\s*(\d[\d\s]*)/i);
    return m?num(m[1]):null;
  }
  function bitrateOf(card){
    var t=metricText(card);
    var m=t.match(/(?:Битрейт|Bitrate)\s*:?\s*(\d+(?:[.,]\d+)?)\s*(?:Мбит\/с|Mbps|Mb\/s)/i);
    return m?num(m[1]):null;
  }
  function sizeOf(card){
    var ds=card.dataset||{};
    if(ds.sizeBytes)return num(ds.sizeBytes)/1073741824;
    var t=metricText(card);
    var values=[...t.matchAll(/(\d+(?:[.,]\d+)?)\s*(ТиБ|TiB|ТБ|TB|ГиБ|GiB|ГБ|GB|МиБ|MiB|МБ|MB)(?![A-Za-zА-Яа-я])/gi)];
    if(!values.length)return null;
    var m=values[values.length-1],v=num(m[1]),unit=m[2].toLowerCase();
    if(/^(?:т|t)/.test(unit))return v*1024;
    if(/^(?:м|m)/.test(unit))return v/1024;
    return v;
  }
  function qualityOf(title,card){
    var t=title+' '+firstText(card,['.torrent-item__quality','.torrent-item__tags']);
    if(/(?:2160p|3840\s*[xх×]\s*\d{3,4}|\b4k\b|\buhd\b)/i.test(t))return {name:'4K',raw:30};
    if(/(?:1080p|1920\s*[xх×]\s*\d{3,4}|\bfhd\b)/i.test(t))return {name:'1080p',raw:26};
    if(/(?:720p|1280\s*[xх×]\s*\d{3,4}|\bhd\b)/i.test(t))return {name:'720p',raw:19};
    if(/(?:480p|576p|\bsd\b|720\s*[xх×]\s*\d{3,4})/i.test(t))return {name:'SD',raw:10};
    return {name:'Неизвестно',raw:14};
  }
  function hdrOf(title,card){
    var t=title+' '+firstText(card,['.torrent-item__quality','.torrent-item__tags']);
    if(/(?:dolby\s*vision|\bDoVi\b|\bDV\b|\bP8\b|HDR10\+)/i.test(t))return {name:'DV/HDR10+',raw:10};
    if(/\bHDR(?:10)?\b/i.test(t))return {name:'HDR',raw:8};
    return {name:'SDR/неизвестно',raw:0};
  }
  function audioOf(title,card){
    var t=(title+' '+firstText(card,['.torrent-item__ffprobe','.torrent-item__tags','.torrent-item__audio'])).replace(/\s+/g,' ');
    if(/(?:RUS\s*[-–:]\s*Дубляж|\bДубляж\b|\bДБ\b|\bDUB\b|\bDubbing\b|\bДублированн)/i.test(t))return {name:'Русский дубляж',raw:25,certainty:'явно'};
    if(/(?:RUS\s*[-–:]|\bRUS\b|\bРусск(?:ий|ая|ое)\b)/i.test(t)) {
      if(/(?:MVO|\bПМ\b|многоголос|профессиональн|LostFilm|HDRezka|TVShows)/i.test(t))return {name:'Русская многоголосая',raw:22,certainty:'вероятно'};
      return {name:'Русская дорожка',raw:21,certainty:'явно'};
    }
    if(/(?:\bMVO\b|\bПМ\b|многоголос|профессиональн|\bAVO\b|одноголос)/i.test(t))return {name:'Озвучка (язык не указан)',raw:15,certainty:'неизвестно'};
    if(/(?:\bUKR\b|украинск|\bENG\b|original\s*eng|английск)/i.test(t))return {name:'Русская не подтверждена',raw:2,certainty:'нет подтверждения'};
    return {name:'Язык неизвестен',raw:12,certainty:'неизвестно'};
  }
  function releaseOf(title){
    if(/\b(?:REMUX|BDREMUX)\b/i.test(title))return {name:'REMUX',raw:10};
    if(/(?:Blu[ -]?ray|BDRip|BD50|BD25)/i.test(title))return {name:'Blu-ray/BDRip',raw:9};
    if(/\bWEB[ .-]?DL\b/i.test(title))return {name:'WEB-DL',raw:8};
    if(/\bWEBRip\b/i.test(title))return {name:'WEBRip',raw:6};
    if(/\b(?:HDTV|HDTVRip|DVDRip)\b/i.test(title))return {name:'TV/DVD',raw:4};
    if(/(?:Telecine|TSRip|TeleSync|\bTC\b|\bCAM\b|\bTS\b)/i.test(title))return {name:'TS/CAM',raw:1};
    return {name:'Неизвестно',raw:5};
  }
  function codecOf(title){
    if(/\bAV1\b/i.test(title))return 'AV1';
    if(/(?:\bHEVC\b|\bH[ .-]?265\b|\bx265\b)/i.test(title))return 'HEVC';
    if(/(?:\bH[ .-]?264\b|\bx264\b|\bAVC\b)/i.test(title))return 'H264';
    return 'неизвестно';
  }
  function sizePoints(gb,q){
    if(gb==null||!isFinite(gb)||gb<=0)return 3;
    var range=q.name==='4K'?[8,55]:q.name==='1080p'?[2,22]:q.name==='720p'?[0.7,9]:[0.3,6];
    if(OPTIONS.profile==='economy'){
      if(gb<=range[0])return 5;
      if(gb<=range[1])return Math.max(2,Math.round(5-(gb-range[0])/(range[1]-range[0])*3));
      return 1;
    }
    if(gb>=range[0]&&gb<=range[1])return 5;
    if(gb<range[0])return Math.max(1,Math.round(5*gb/range[0]));
    return Math.max(2,Math.round(5*range[1]/gb));
  }
  function seedPoints(seeds){
    if(seeds==null)return 8;
    if(seeds<1)return 0;
    if(seeds<5)return 3;
    if(seeds<10)return 7;
    if(seeds<25)return 12;
    if(seeds<75)return 15;
    if(seeds<200)return 18;
    return 20;
  }
  function readiness(seeds,bitrate){
    if(seeds===null||seeds===undefined)return {label:'скорость не проверена',level:'unknown'};
    if(seeds<5)return {label:'мало сидов',level:'bad'};
    if(seeds<10)return {label:'сидов немного',level:'warn'};
    if(bitrate!==null&&bitrate>=100&&seeds<40)return {label:'высокий битрейт',level:'warn'};
    return {label:'сидов достаточно',level:'good'};
  }
  function score(card){
    var source=sourceString(card);
    var matched=CONFIG.allowed.filter(function(t){return t.rx.test(source);});
    var title=titleOf(card),quality=qualityOf(title,card),hdr=hdrOf(title,card);
    var audio=audioOf(title,card),release=releaseOf(title),codec=codecOf(title);
    var seeds=seedsOf(card),peers=peersOf(card),size=sizeOf(card),bitrate=bitrateOf(card);
    var w=PROFILES[OPTIONS.profile]||PROFILES.balanced;
    var raw={quality:quality.raw,hdr:hdr.raw,audio:audio.raw,release:release.raw,seeds:seedPoints(seeds),size:sizePoints(size,quality),tracker:0};
    var sub={};Object.keys(w).forEach(function(k){var max={quality:30,hdr:10,audio:25,release:10,seeds:20,size:5,tracker:1}[k];sub[k]=Math.round(raw[k]*w[k]/max);});
    var total=Math.max(0,Math.min(100,Object.keys(sub).reduce(function(a,k){return a+sub[k];},0)));
    return {total:total,source:source,matched:matched.map(function(t){return t.name;}),
      title:title,quality:quality,hdr:hdr,audio:audio,release:release,codec:codec,seeds:seeds,peers:peers,
      size:size,bitrate:bitrate,readiness:readiness(seeds,bitrate),subscores:sub,weights:w};
  }
  function style(){
    if(document.getElementById(STYLE_ID))return;
    var el=document.createElement('style');el.id=STYLE_ID;
    el.textContent=`
      .ltr-hidden,.ltr-duplicate{display:none!important}
      /* Single typography system for the bitrate, seeds, peers, size and readiness labels. */
      .ltr-card .ltr-ready{
        display:inline-flex!important;align-items:center!important;justify-content:center!important;
        margin:.15em .35em .15em 0!important;padding:.34em .62em!important;
        /* Small visual offset: centre the readiness label between date and card edge. */
        position:relative!important;top:.44em!important;
        border-radius:5px!important;background:#1a2925!important;color:#b5d6ca!important;
        font-family:inherit!important;font-size:.88em!important;font-weight:800!important;
        line-height:1.3!important;letter-spacing:0!important;
        border:1px solid #426354!important;box-sizing:border-box!important;
      }
      .ltr-ready.good{color:#57dc94!important;border-color:#358055!important}
      .ltr-ready.warn{color:#eaca62!important;border-color:#8c6d27!important}
      .ltr-ready.bad{color:#ef8c86!important;border-color:#99534c!important}
      .ltr-groups{display:block!important;color:#9ecbb8!important;font-size:.75em!important;margin-top:.22em!important}
      .ltr-card{position:relative!important;padding-right:3.4em!important}
      .ltr-score{position:absolute;right:.65em;top:1.25em;z-index:3;
        border:1px solid var(--ltr-edge,#399c62);background:rgba(12,24,22,.94);
        border-radius:.45em;padding:.22em .48em;color:var(--ltr-ink,#65d594);
        font-weight:800;font-size:.97em;line-height:1.1;pointer-events:none;white-space:nowrap}
      /* Numeric rating only, no decorative star. */
      /* Metrics: consistent font, centred text, larger single-outline badges. */
      .ltr-card .ltr-metric,.ltr-card .ltr-size{
        display:inline-flex!important;align-items:center!important;justify-content:center!important;
        vertical-align:middle!important;gap:.24em!important;
        /* Align torrent metrics slightly below the source/date baseline. */
        position:relative!important;top:.36em!important;
        border:1px solid currentColor!important;border-radius:5px!important;
        padding:.26em .54em!important;min-height:1.75em!important;
        font-family:inherit!important;font-size:.88em!important;font-weight:800!important;
        line-height:1.3!important;letter-spacing:0!important;
        box-shadow:none!important;white-space:nowrap!important;
        width:fit-content!important;max-width:max-content!important;min-width:0!important;
        flex:0 0 auto!important;align-self:center!important;box-sizing:border-box!important;
        background:rgba(0,0,0,.22)!important;
      }
      .ltr-card .ltr-metric *, .ltr-card .ltr-size *{
        background:transparent!important;background-color:transparent!important;
        border:0!important;outline:0!important;box-shadow:none!important;
        border-radius:0!important;padding:0!important;margin:0!important;
        color:inherit!important;font-family:inherit!important;font-size:inherit!important;
        font-weight:inherit!important;line-height:inherit!important;
        min-width:0!important;max-width:none!important;
      }
      .ltr-card .ltr-metric-label{
        font-family:inherit!important;font-size:.88em!important;font-weight:800!important;
        line-height:1.3!important;letter-spacing:0!important;text-transform:none!important;
        display:inline-flex!important;align-items:center!important;vertical-align:middle!important;
        position:relative!important;top:.36em!important;
      }
      .ltr-card .ltr-green{color:#40dc83!important;background:rgba(13,82,43,.35)!important}
      .ltr-card .ltr-yellow{color:#e9c451!important;background:rgba(93,73,12,.34)!important}
      .ltr-card .ltr-amber{color:#edab3e!important;background:rgba(111,71,11,.40)!important}
      .ltr-card .ltr-orange{color:#f5a854!important;background:rgba(101,52,9,.34)!important}
      .ltr-card .ltr-red{color:#ef7777!important;background:rgba(104,23,23,.33)!important}
      .ltr-card .ltr-blue{color:#66b6ff!important;background:rgba(20,58,105,.35)!important}
      .ltr-card .ltr-size.ltr-green{color:#5adb9c!important;background:rgba(16,70,47,.45)!important}
      .ltr-card .ltr-size.ltr-yellow{color:#e9c451!important;background:rgba(93,73,12,.38)!important}
      .ltr-card .ltr-size.ltr-amber{color:#edab3e!important;background:rgba(111,71,11,.43)!important}
      .ltr-card .ltr-size.ltr-orange{color:#f5a854!important;background:rgba(101,52,9,.45)!important}
      .ltr-card.ltr-best{box-shadow:inset 3px 0 0 #3bd68b}
    `;
    (document.head||document.documentElement).appendChild(el);
  }
  function markMetric(el,type,color){
    if(!el||el.classList.contains(BADGE))return;
    var names=['ltr-green','ltr-yellow','ltr-amber','ltr-orange','ltr-red','ltr-blue'];
    if(type==='size'){
      el.classList.remove('ltr-metric');
      el.classList.add('ltr-size');
      names.forEach(function(c){el.classList.toggle(c,c===color);});
      return;
    }
    el.classList.remove('ltr-size');
    el.classList.add('ltr-metric');
    names.forEach(function(c){el.classList.toggle(c,c===color);});
  }
  function decorate(card,r){
    // Look at leaf nodes and the adjacent value nodes, to handle Lampa variants.
    var nodes=card.querySelectorAll('span,div,b,strong,small');
    for(var i=0;i<nodes.length && i<250;i++){
      var el=nodes[i];
      if(el.classList.contains(BADGE)||el.closest('.'+BADGE))continue;
      if(el.children.length>1)continue;
      var tx=n(el.textContent);
      if(!tx || tx.length>60)continue;
      if(/(?:ТиБ|TiB|ТБ|TB|ГиБ|GiB|ГБ|GB|МиБ|MiB|МБ|MB)\s*$/i.test(tx) && /\d/.test(tx) && !/Битрейт/i.test(tx)){
        // Metric is already parsed from this card, so use normalized GiB for thresholds.
        var gb=r.size;
        // Fall back to the local text if a layout variant prevents card-level extraction.
        if(gb==null){
          var sm=tx.match(/(\d+(?:[.,]\d+)?)\s*(ТиБ|TiB|ТБ|TB|ГиБ|GiB|ГБ|GB|МиБ|MiB|МБ|MB)\b/i);
          if(sm){gb=num(sm[1]);if(/^(?:т|t)/i.test(sm[2]))gb*=1024;else if(/^(?:м|m)/i.test(sm[2]))gb/=1024;}
        }
        var sizeColor=gb==null?'ltr-blue':gb<25?'ltr-green':gb<50?'ltr-yellow':gb<100?'ltr-amber':'ltr-orange';
        markMetric(el,'size',sizeColor); continue;
      }
      if(/(?:Раздают|Сиды|Seeders)\s*:?/i.test(tx)){
        var color=r.seeds==null?'ltr-blue':r.seeds<5?'ltr-red':r.seeds<10?'ltr-yellow':'ltr-green';
        var target=(tx.match(/\d/) ? el : el.nextElementSibling);
        if(target)markMetric(target,'metric',color);
        el.classList.add('ltr-metric-label');
      }
      if(/(?:Битрейт|Bitrate)\s*:?/i.test(tx)){
        var color2=r.bitrate==null?'ltr-blue':r.bitrate<50?'ltr-green':r.bitrate<75?'ltr-yellow':r.bitrate<100?'ltr-orange':'ltr-red';
        var target2=(tx.match(/\d/) ? el : el.nextElementSibling);
        if(target2)markMetric(target2,'metric',color2);
        el.classList.add('ltr-metric-label');
      }
      if(/(?:Качают|Leechers)\s*:?/i.test(tx)){
        var target3=(tx.match(/\d/) ? el : el.nextElementSibling);
        if(target3)markMetric(target3,'metric','ltr-blue');
        el.classList.add('ltr-metric-label');
      }
    }
  }
  function badge(card,result){
    var el=card.querySelector('.'+BADGE);
    if(!el){el=document.createElement('span');el.className=BADGE;card.appendChild(el);}
    var hue=result.total>75?'#54dc94':result.total>=55?'#edc467':'#f28b85';
    el.style.setProperty('--ltr-ink',hue);
    el.style.setProperty('--ltr-edge',hue);
    var nextScore=String(result.total);
    if(el.textContent!==nextScore)el.textContent=nextScore;
    var tip='Рейтинг '+result.total+'/100 | '+Object.keys(result.subscores).map(function(k){
      return k+': '+result.subscores[k]+'/'+result.weights[k];
    }).join(' | ')+' | '+result.release.name+' | '+result.codec+' | '+result.audio.name;
    if(el.title!==tip)el.title=tip;
    card.classList.toggle('ltr-best',result.total>75);
    card.classList.toggle('ltr-warn',result.seeds!==null&&result.seeds<5);
  }
  function addReadiness(card,result){
    var el=card.querySelector('.ltr-ready');
    if(!OPTIONS.showReadiness){if(el)el.remove();return;}
    if(!el){el=document.createElement('span');el.className='ltr-ready';card.appendChild(el);}
    el.className='ltr-ready '+(result.readiness.level==='unknown'?'':result.readiness.level);
    var label='● '+result.readiness.label.charAt(0).toUpperCase()+result.readiness.label.slice(1);
    if(el.textContent!==label)el.textContent=label;
    el.title='Оценка по сидам и битрейту, НЕ замер скорости TorrServer';
  }
  function hideGroupDuplicates(cards,results){
    var seen=Object.create(null);
    cards.forEach(function(card){
      card.classList.remove('ltr-duplicate');
      var extra=card.querySelector('.ltr-groups');if(extra)extra.remove();
      if(!OPTIONS.grouping||card.classList.contains(HIDE))return;
      var r=results.get(card);
      if(!r||r.size==null||r.audio.certainty==='неизвестно'||r.quality.name==='Неизвестно')return;
      // Conservative fingerprint: title + year + format + language + codec + HDR + near-identical size.
      var base=r.title.toLowerCase().replace(/\[[^\]]*\]/g,' ').replace(/\([^)]*\)/g,' ')
        .replace(/(2160p|1080p|720p|4k|hdr10\+?|dolby vision|web[ .-]?dl|webrip|remux|bluray|bdrip|x26[45]|h26[45])/g,' ')
        .replace(/[\\/|:,_-]+/g,' ').replace(/\s+/g,' ').trim().slice(0,90);
      if(base.length<14)return;
      var rounded=Math.round(r.size*10)/10;
      var key=[base,r.quality.name,r.hdr.name,r.audio.name,r.release.name,r.codec,rounded].join('|');
      if(!seen[key]){seen[key]=card;return;}
      var winner=seen[key],prev=results.get(winner);
      if(prev&&prev.total<r.total){winner.classList.add('ltr-duplicate');seen[key]=card;}
      else card.classList.add('ltr-duplicate');
      var chosen=seen[key],note=chosen.querySelector('.ltr-groups');
      if(!note){note=document.createElement('small');note.className='ltr-groups';chosen.appendChild(note);}
      note.textContent='Есть похожая раздача (отключи группировку для просмотра всех)';
    });
  }
  function registerSettings(){
    if(!window.Lampa||!Lampa.SettingsApi||!Lampa.SettingsApi.addComponent)return false;
    try{
      Lampa.SettingsApi.addComponent({component:'ltr_rank',name:'Tracker Rank',icon:'<svg width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M22 2l6.2 13.3 14.5 1.7-10.7 10 2.8 14.6L22 34.3 9.2 41.6 12 27 1.3 17l14.5-1.7z"/></svg>'});
      var params=[
        ['profile','Профиль рейтинга','select',{balanced:'Сбалансированный',cinema:'Максимальное качество',quick:'Быстрый запуск',economy:'Экономия трафика'},'balanced'],
        ['filter','Фильтровать трекеры','trigger',null,true],
        ['sorting','Сортировать по рейтингу','trigger',null,true],
        ['grouping','Скрывать похожие дубликаты','trigger',null,false],
        ['readiness','Индикатор готовности','trigger',null,true],
        ['details','Рейтинг на карточках','trigger',null,true]
      ];
      CONFIG.allowed.forEach(function(t){params.push(['tracker_'+t.name,'Разрешён '+t.name,'trigger',null,true]);});
      params.forEach(function(p){
        var param={name:STORAGE+p[0],type:p[2],default:p[4]};if(p[3])param.values=p[3];
        Lampa.SettingsApi.addParam({component:'ltr_rank',param:param,
          field:{name:p[1],description:p[0]==='grouping'?'Осторожная группировка: можно вернуть все раздачи':undefined},
          onChange:function(changed){
            var value=(typeof changed==='boolean'||typeof changed==='string')?changed:undefined;
            if(value===undefined){try{value=Lampa.Storage.field(STORAGE+p[0]);}catch(e){value=load(p[0],p[4]);}}
            if(p[0].indexOf('tracker_')===0){OPTIONS.allowed[p[0].slice(8)]=value!==false;}
            else if(p[0]==='profile')OPTIONS.profile=PROFILES[value]?value:'balanced';
            else OPTIONS[p[0]=== 'readiness'?'showReadiness':p[0]=== 'details'?'showDetails':p[0]]=value;
            save(p[0],value);schedule();
          }});
      });
      return true;
    }catch(e){console.warn('[Lampa Tracker Rank] Settings unavailable:',e);return false;}
  }
  function reconcile(cards){
    if(!CONFIG.sortByScore||cards.length<2||reorderLock)return;
    var byParent=new Map();
    cards.forEach(function(card){
      if(!card.parentNode)return;
      var p=card.parentNode;
      if(!byParent.has(p))byParent.set(p,[]);
      byParent.get(p).push(card);
    });
    byParent.forEach(function(group,parent){
      if(group.length<2)return;
      // Sorting must include hidden cards to preserve correct ordinal positions.
      var current=Array.prototype.slice.call(parent.children).filter(function(el){return group.indexOf(el)!==-1;});
      if(current.length<2)return;
      var desired=current.slice().sort(function(a,b){
        var ah=a.classList.contains(HIDE)||a.classList.contains('ltr-duplicate'),bh=b.classList.contains(HIDE)||b.classList.contains('ltr-duplicate');
        if(ah!==bh)return ah?1:-1;
        return num(b.dataset.ltrScore)-num(a.dataset.ltrScore)
          || (originalOrder.get(a)||0)-(originalOrder.get(b)||0);
      });
      if(desired.every(function(el,i){return el===current[i];}))return;
      var focused=document.activeElement;
      // Placeholders preserve headers and control elements interleaved with cards.
      reorderLock=true; internalMutation=true;
      var slots=current.map(function(el){var c=document.createComment('ltr-slot');parent.insertBefore(c,el);parent.removeChild(el);return c;});
      slots.forEach(function(slot,i){parent.replaceChild(desired[i],slot);});
      if(focused&&focused.isConnected&&focused.focus)try{focused.focus({preventScroll:true});}catch(e){}
    });
    if(reorderLock)setTimeout(function(){reorderLock=false;internalMutation=false;schedule();},60);
  }
  function scan(){
    pending=false;
    if(disabled)return;
    var cards=Array.prototype.slice.call(document.querySelectorAll(CONFIG.cardSelector)).slice(0,MAX_CARDS);
    var results=new Map();
    cards.forEach(function(card,i){
      if(!originalOrder.has(card))originalOrder.set(card,i);
      // Skip our own nodes when extracting metadata, via dedicated selectors.
      var result=score(card);
      var hidden=OPTIONS.filter && !result.matched.some(function(t){return OPTIONS.allowed[t];});
      card.classList.toggle(HIDE,hidden);
      card.classList.add(CARD);
      card.dataset.ltrScore=String(result.total);
      card.dataset.ltrSources=result.matched.join(',');
      if(OPTIONS.showDetails)badge(card,result);else{var b=card.querySelector('.'+BADGE);if(b)b.remove();}
      decorate(card,result);
      addReadiness(card,result);
      results.set(card,result);
      generated.set(card,result);
    });
    hideGroupDuplicates(cards,results);
    if(OPTIONS.sorting)reconcile(cards);
  }
  function schedule(){
    if(disabled||pending||internalMutation)return;
    pending=true;
    setTimeout(scan,180);
  }
  style();
  var settingsReady=registerSettings();
  if(!settingsReady){
    var tries=0;
    var settingsTimer=setInterval(function(){
      if(disabled||registerSettings()||++tries>=15)clearInterval(settingsTimer);
    },1000);
  }
  observed=new MutationObserver(function(mutations){
    if(internalMutation)return;
    // Ignore our own badges and readiness labels to prevent observe/scan loops.
    if(mutations.every(function(m){return m.target.closest && m.target.closest('.ltr-score,.ltr-ready,.ltr-groups');}))return;
    schedule();
  });
  observed.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  schedule();
  window.LampaTrackerRank={
    version:'1.3.3',
    config:CONFIG,options:OPTIONS,profiles:PROFILES,
    refresh:scan,
    setOption:function(key,value){if(key==='profile'&& !PROFILES[value])return;
      if(key.indexOf('tracker_')===0){if(!isKnownTracker(key.slice(8)))return; OPTIONS.allowed[key.slice(8)]=!!value;}
      else if(key==='readiness')OPTIONS.showReadiness=!!value;
      else if(key==='details')OPTIONS.showDetails=!!value;
      else OPTIONS[key]=value;save(key,value);schedule();},
    inspect:function(card){return card?score(card):null;},
    disable:function(){
      disabled=true; if(observed)observed.disconnect();
      document.querySelectorAll(CONFIG.cardSelector).forEach(function(card){
        card.classList.remove(HIDE,CARD,'ltr-best','ltr-warn','ltr-duplicate');
        var r=card.querySelector('.ltr-ready');if(r)r.remove();
        var d=card.querySelector('.ltr-groups');if(d)d.remove();
        var b=card.querySelector('.'+BADGE);if(b)b.remove();
        delete card.dataset.ltrScore;delete card.dataset.ltrSources;
      });
      document.querySelectorAll('.ltr-metric,.ltr-size,.ltr-metric-label').forEach(function(el){
        ['ltr-metric','ltr-size','ltr-metric-label','ltr-green','ltr-yellow','ltr-amber','ltr-orange','ltr-red','ltr-blue'].forEach(function(cls){el.classList.remove(cls);});
      });
      var st=document.getElementById(STYLE_ID);if(st)st.remove();
    }
  };
  console.info('[Lampa Tracker Rank v1.3.3] All six features loaded.');
})();
