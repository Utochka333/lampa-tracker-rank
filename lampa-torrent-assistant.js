/* Lampa Torrent Assistant v0.3.4 (experimental)
 * Prefetch public JacRed-compatible APIs on FULL movie/TV details only.
 * Uses the same score WEIGHTS as Tracker Rank (profile-aware), JSON field extraction.
 * Does not send data anywhere except the configured public parser endpoints.
 * UI: native Torrent redirect + best verified score/status on opened details page.
 */
(function(){
  'use strict';
  var VERSION='0.3.4', PREVIOUS=window.LampaTorrentAssistant;
  if(PREVIOUS && PREVIOUS.version===VERSION)return;
  if(PREVIOUS && typeof PREVIOUS.disable==='function')try{PREVIOUS.disable();}catch(e){}
  // v0.1 had no disable() method: it registered a legacy listener. Avoid enabling both at once;
  // remove the old plugin from Lampa before installing v0.2.
  var CONFIG={
    primary:'https://jac.stull.xyz', secondary:'http://jac.black', primaryKey:'1',
    // Secondary public endpoint in the previous Lampa settings worked with key 1.
    // If your jac.black requires a personal key, set it via Assistant configuration API.
    secondaryKey:'1', timeoutMs:10000, cacheMinutes:30,
    allowed:/\b(?:rutracker|kinozal|rutor|nnmclub|nnm-club|torrentby|torrent\.by)\b/i,
    redirectPlay:true, maxResults:600
  };
  var KEY_PREFIX='lta_v033_', CSS_ID='lta-v033-style', activeToken=0, listener=null,
      currentKey='',currentMovie=null,closed=false,runTimer=null,observer=null,captureTimer=null,initTimer=null;
  var requestControllers=new Set();
  var cacheMemory={};
  var DEFAULT_WEIGHTS={quality:30,hdr:10,audio:25,release:10,seeds:20,size:5,tracker:0};
  var BASE_MAX={quality:30,hdr:10,audio:25,release:10,seeds:20,size:5,tracker:1};
  function n(x){return String(x==null?'':x).replace(/\s+/g,' ').trim();}
  function num(x){return Number(String(x==null?'':x).replace(/\s/g,'').replace(',','.'))||0;}
  function cleanName(x){return n(x).toLowerCase().replace(/ё/g,'е').replace(/[^a-zа-яё0-9]+/gi,' ').replace(/\s+/g,' ').trim();}
  function movieOf(evt){
    var a=null;
    try{a=Lampa.Activity.active();}catch(e){}
    var candidates=[evt&&evt.object&&evt.object.card,evt&&evt.object&&evt.object.movie,
      evt&&evt.object&&evt.object.params&&evt.object.params.movie,
      a&&a.movie,a&&a.card,a&&a.params&&a.params.movie,
      evt&&evt.object&&evt.object.activity&&evt.object.activity.card];
    for(var i=0;i<candidates.length;i++){
      var m=candidates[i];if(m&&typeof m==='object'&&(m.title||m.name||m.original_title||m.original_name))return m;
    }
    return null;
  }
  function parseMovie(m){
    if(!m)return null;
    var title=n(m.title||m.name),original=n(m.original_title||m.original_name);
    var year=Number(n(m.release_date||m.first_air_date||m.year).slice(0,4))||null;
    var serial=Boolean(m.first_air_date || m.number_of_seasons || m.media_type==='tv' || m.type==='tv');
    if(!title&&!original)return null;
    var id=m.id||m.tmdb_id||null;
    return {title:title||original,original:original||title,year:year,serial:serial,
      id:id,key:(id?'tmdb:'+id+':'+(serial?'tv':'movie'):'title:'+cleanName(original||title)+':'+year+':'+serial)};
  }
  function cacheKey(m){return KEY_PREFIX+m.key;}
  function readCache(m){
    if(!m)return null;var k=cacheKey(m),d=cacheMemory[k];
    if(!d){try{d=JSON.parse(localStorage.getItem(k)||'null');}catch(e){}}
    if(!d||!d.at||Date.now()-d.at>CONFIG.cacheMinutes*60000)return null;
    return d;
  }
  function writeCache(m,d){
    var k=cacheKey(m);d.at=Date.now();cacheMemory[k]=d;
    try{localStorage.setItem(k,JSON.stringify(d));}catch(e){}
  }
  function qs(params){return Object.keys(params).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(params[k]);}).join('&');}
  function parserUrl(base,key,m){return base.replace(/\/$/,'')+'/api/v2.0/indexers/all/results?'+qs({
    apikey:key,Query:m.original||m.title,title:m.title,title_original:m.original,
    year:m.year||'',is_serial:m.serial?'1':'0'
  });}
  function abortRequests(){
    requestControllers.forEach(function(ctrl){ctrl.abort();});
    requestControllers.clear();
  }
  function fetchParser(base,key,m){
    if(closed)return Promise.reject(Error('Plugin disabled'));
    var ctrl=new AbortController();requestControllers.add(ctrl);
    var timeout=setTimeout(function(){ctrl.abort();},CONFIG.timeoutMs);
    return fetch(parserUrl(base,key,m),{method:'GET',mode:'cors',credentials:'omit',cache:'no-store',signal:ctrl.signal})
      .then(function(r){if(!r.ok)throw Error('HTTP '+r.status);return r.json();})
      .then(function(payload){
        if(!payload||!Array.isArray(payload.Results))throw Error('Нет массива Results');
        return payload.Results.slice(0,CONFIG.maxResults);
      }).finally(function(){clearTimeout(timeout);requestControllers.delete(ctrl);});
  }
  function inspectYear(r,m){
    // Only reject clearly contradictory dates. Unknown release years are allowed,
    // as tracker titles routinely omit release date or include upload year.
    var year=Number(r.released||r.Released||r.releaseYear||0);
    if(year&&m.year&&!m.serial&&Math.abs(year-m.year)>1)return false;
    var title=n(r.Title||r.title);
    // Explicit year inside brackets near movie title is useful; avoid extracting upload dates.
    var fromTitle=title.match(/(?:\(|\[|\/|\s)(19\d{2}|20\d{2})(?:\)|\]|\s|\/)/);
    if(fromTitle&&m.year&&!m.serial&&Math.abs(Number(fromTitle[1])-m.year)>1)return false;
    return true;
  }
  function isRelated(r,m){
    if(!inspectYear(r,m))return false;
    var d=detailsOf(r),candidates=[r.Title,r.title,d.name,d.originalName,r.name,r.originalName].filter(Boolean).map(cleanName);
    var originals=[m.title,m.original].filter(Boolean).map(cleanName);
    return originals.some(function(title){
      if(title.length<4)return false;
      return candidates.some(function(c){
        // Film/series title must start at a logical boundary, not within an unrelated word.
        return c===title||c.indexOf(title+' ')===0||c.indexOf(' '+title+' ')>=0||c.endsWith(' '+title);
      });
    });
  }
  function detailsOf(r){return r.Details&&typeof r.Details==='object'?r.Details:{};}
  function ffprobeText(r){
    var d=detailsOf(r),sources=[d.ffprobe,d.mediaInfo,r.MediaInfo];
    return sources.map(function(v){return typeof v==='string'?v:(v&&typeof v==='object'?JSON.stringify(v):'');}).join(' ');
  }
  function getQuality(r){
    var d=detailsOf(r),txt=n(r.Title)+' '+n(d.quality)+' '+ffprobeText(r).slice(0,3000);
    if(/(?:2160p|\b4k\b|\buhd\b|3840.{0,12}(?:2160|1608)|"height":2160)/i.test(txt))return {name:'4K',points:30};
    if(/(?:1080p|\bfhd\b|1920.{0,12}(?:1080|800)|"height":1080)/i.test(txt))return {name:'FHD',points:26};
    if(/(?:720p|1280.{0,12}720|"height":720)/i.test(txt))return {name:'HD',points:19};
    if(/(?:480p|576p|\bsd\b)/i.test(txt))return {name:'SD',points:10};
    var dquality=Number(d.quality);if(dquality>=2160)return {name:'4K',points:30};
    if(dquality>=1080)return {name:'FHD',points:26};
    if(dquality>=720)return {name:'HD',points:19};
    return {name:'Неизвестно',points:14};
  }
  function hdrPoints(r){
    var txt=n(r.Title)+' '+n(detailsOf(r).hdr);
    if(/(?:dolby\s*vision|\bdovi\b|\bdv\b|\bp8\b|hdr10\+)/i.test(txt))return 10;
    if(/\bhdr(?:10)?\b/i.test(txt))return 8;
    return 0;
  }
  function audioPoints(r){
    var d=detailsOf(r),title=n(r.Title),voices=Array.isArray(d.voices)?d.voices.join(' '):n(d.voices);
    var audioLangs='';
    var f=d.ffprobe||d.mediaInfo||r.MediaInfo;
    if(f){
      try{
        if(typeof f==='string')f=JSON.parse(f);
        var streams=Array.isArray(f)?f:(f.streams||[]);
        audioLangs=streams.filter(function(x){return /audio/i.test(x.codec_type||'');})
          .map(function(x){return n(x.tags&&x.tags.language)+' '+n(x.tags&&x.tags.title);}).join(' ');
      }catch(e){}
    }
    var t=[title,voices,audioLangs].join(' ');
    if(/(?:\bДубляж\b|\bДБ\b|\bDUB\b|\bDUB\s*\(RUS\)|\bRUS\s*[-:]\s*Дубляж)/i.test(t))return {points:25,name:'Русский дубляж'};
    if(/(?:\bRUS\b|\brus\b|\bрусск|\bLostFilm\b|\bHDRezka\b|\bTVShows\b|\bMVO\b|многоголос)/i.test(t)){
      if(/(?:\bMVO\b|многоголос|\bLostFilm\b|\bHDRezka\b|\bTVShows\b)/i.test(t))return {points:22,name:'Русская озвучка (вероятно)'};
      return {points:21,name:'Русская дорожка'};
    }
    if(/(?:\bAVO\b|одноголос|\bПМ\b|профессиональн)/i.test(t))return {points:15,name:'Озвучка, язык не подтверждён'};
    if(/(?:\bUKR\b|\bENG\b|\boriginal\b)/i.test(t))return {points:2,name:'Русская дорожка не подтверждена'};
    return {points:12,name:'Язык неизвестен'};
  }
  function releasePoints(r){
    var txt=n(r.Title);
    if(/\b(?:REMUX|BDREMUX)\b/i.test(txt))return 10;
    if(/(?:Blu[ -]?ray|BDRip|BD50|BD25)/i.test(txt))return 9;
    if(/\bWEB[ .-]?DL\b/i.test(txt))return 8;
    if(/\bWEBRip\b/i.test(txt))return 6;
    if(/(?:HDTV|HDTVRip|DVDRip)/i.test(txt))return 4;
    if(/(?:Telecine|TSRip|TeleSync|\bCAM\b)/i.test(txt))return 1;
    return 5;
  }
  function sizePoints(gb,q,profile){
    if(!gb||gb<=0)return 3;
    var range=q==='4K'?[8,55]:q==='FHD'?[2,22]:q==='HD'?[.7,9]:[.3,6];
    if(profile==='economy'){
      if(gb<=range[0])return 5;
      if(gb<=range[1])return Math.max(2,Math.round(5-(gb-range[0])/(range[1]-range[0])*3));
      return 1;
    }
    if(gb>=range[0]&&gb<=range[1])return 5;
    if(gb<range[0])return Math.max(1,Math.round(5*gb/range[0]));
    return Math.max(2,Math.round(5*range[1]/gb));
  }
  function seedPoints(s){if(s===null)return 8;if(s<1)return 0;if(s<5)return 3;if(s<10)return 7;if(s<25)return 12;if(s<75)return 15;if(s<200)return 18;return 20;}
  function getProfile(){
    var r=window.LampaTrackerRank;
    var p=r&&r.options&&r.options.profile||'balanced';
    return {name:p, weights:r&&r.profiles&&r.profiles[p]||DEFAULT_WEIGHTS};
  }
  // Evaluate JSON releases through Tracker Rank's actual scoring function
  // rather than maintaining two diverging implementations.
  function trackerRankScore(r){
    var rank=window.LampaTrackerRank;
    if(!rank || typeof rank.inspect!=='function')return null;
    try{
      var card=document.createElement('div');card.className='torrent-item';
      card.dataset.tracker=n(r.Tracker||r.trackers||r.Source);
      var title=document.createElement('div');title.className='torrent-item__title';title.textContent=n(r.Title||r.title);card.appendChild(title);
      var meta=document.createElement('div');meta.className='torrent-item__audio';
      var d=detailsOf(r),info='';
      if(Array.isArray(d.voices))info+=' '+d.voices.join(' ');
      else if(d.voices)info+=' '+String(d.voices);
      var f=d.ffprobe||d.mediaInfo||r.MediaInfo;
      if(f){
        try{
          if(typeof f==='string')f=JSON.parse(f);
          var streams=Array.isArray(f)?f:(f.streams||[]);
          streams.filter(function(x){return x.codec_type==='audio';}).forEach(function(x){
            var tags=x.tags||{};
            info+=' '+n(tags.language)+' '+n(tags.title);
          });
        }catch(e){}
      }
      meta.textContent=info.slice(0,1200);card.appendChild(meta);
      var stats=document.createElement('div');stats.className='torrent-item__stats';
      var gb=(Number(r.Size||0)/1073741824);
      stats.textContent=' Раздают: '+(r.Seeders==null?'':Number(r.Seeders))+
        ' Качают: '+(r.Peers==null?'':Number(r.Peers))+
        ' '+gb.toFixed(2)+' ГБ';
      card.appendChild(stats);
      var result=rank.inspect(card);
      if(result && Number.isFinite(result.total)){
        return {score:result.total, title:n(r.Title), quality:result.quality.name,
          audio:result.audio.name,seeds:r.Seeders==null?null:Number(r.Seeders),
          sizeGB:Math.round(gb*10)/10,tracker:n(r.Tracker),profile:rank.options&&rank.options.profile||'balanced'};
      }
    }catch(e){console.warn('[Torrent Assistant] Shared rating unavailable:',e);}
    return null;
  }
  function scoreJSON(r){
    var shared=trackerRankScore(r);
    if(shared)return shared;
    var size=Number(r.Size||0)/1073741824,quality=getQuality(r),audio=audioPoints(r),profile=getProfile();
    var seeds=r.Seeders===undefined||r.Seeders===null?null:Math.max(0,Number(r.Seeders)||0);
    var raw={quality:quality.points,hdr:hdrPoints(r),audio:audio.points,release:releasePoints(r),seeds:seedPoints(seeds),size:sizePoints(size,quality.name,profile.name),tracker:0};
    var total=0;Object.keys(profile.weights).forEach(function(k){
      total+=Math.round((raw[k]||0)*Number(profile.weights[k])/(BASE_MAX[k]||1));
    });
    return {score:Math.max(0,Math.min(100,total)),title:n(r.Title),quality:quality.name,audio:audio.name,
      seeds:seeds,sizeGB:Math.round(size*10)/10,tracker:n(r.Tracker),profile:profile.name};
  }
  function isAllowed(r){
    var tracker=n(r.Tracker||r.trackers||r.Source);
    var rank=window.LampaTrackerRank;
    if(rank&&rank.options&&rank.options.filter===false)return true;
    if(rank&&rank.options&&rank.options.allowed){
      var choices=rank.options.allowed;
      var names={RuTracker:/\brutracker\b/i,Kinozal:/\bkinozal\b/i,Rutor:/\brutor\b/i,NNMClub:/\b(?:nnmclub|nnm-club)\b/i,TorrentBy:/\b(?:torrentby|torrent\.by)\b/i};
      return Object.keys(names).some(function(k){return choices[k]!==false&&names[k].test(tracker);});
    }
    return CONFIG.allowed.test(tracker);
  }
  function bestFrom(results,m){
    var matched=results.filter(function(r){return r&&isAllowed(r)&&isRelated(r,m);});
    var ranked=matched.map(scoreJSON).sort(function(a,b){return b.score-a.score||(b.seeds||0)-(a.seeds||0);});
    return {status:ranked.length?'found':'empty',best:ranked[0]||null,number:ranked.length,server:'',at:Date.now()};
  }
  function releaseIdentity(r){
    return n(r.MagnetUri||r.Link||r.Guid||r.Title).slice(0,900);
  }
  function mergeResults(groups){
    var seen=new Set(),out=[];
    groups.forEach(function(g){g.forEach(function(r){
      var key=releaseIdentity(r);
      if(!key||seen.has(key))return;
      seen.add(key);out.push(r);
    });});
    return out;
  }
  function runSearch(base,key,m,wide){
    var searches=[m],seen={};
    function add(v){
      var token=[cleanName(v.original),cleanName(v.title),v.year,v.serial].join('|');
      if(!seen[token]){seen[token]=true;searches.push(v);}
    }
    seen[[cleanName(m.original),cleanName(m.title),m.year,m.serial].join('|')]=true;
    // JacRed indexers can differ in how they match localized vs original names.
    if(cleanName(m.title)!==cleanName(m.original)){
      add(Object.assign({},m,{title:m.original,original:m.original}));
      add(Object.assign({},m,{title:m.title,original:m.title}));
    }
    // Multi-season packs frequently do not have the premiere year as their release year.
    if(m.serial){
      add(Object.assign({},m,{year:null}));
      if(cleanName(m.title)!==cleanName(m.original)){
        add(Object.assign({},m,{title:m.original,original:m.original,year:null}));
        add(Object.assign({},m,{title:m.title,original:m.title,year:null}));
      }
    }
    // Bound network activity: no more than two queries per parser host.
    searches=searches.slice(0,2);
    return Promise.allSettled(searches.map(function(v){return fetchParser(base,key,v);})).then(function(items){
      var good=items.filter(function(x){return x.status==='fulfilled';});
      if(!good.length)throw (items[0]&&items[0].reason)||Error('Все запросы отклонены');
      return mergeResults(good.map(function(x){return x.value;}));
    });
  }
  function ensureStyle(){
    if(document.getElementById(CSS_ID))return;
    var el=document.createElement('style');el.id=CSS_ID;
    el.textContent=
      '.lta-v03{display:inline-flex;align-items:center;justify-content:flex-start;gap:.35em;width:max-content;max-width:95%;'+
      'white-space:normal;margin:.55em 0 .55em 0!important;padding:.28em .65em;border-radius:.35em;'+
      'border:1px solid #53635b;background:rgba(16,27,24,.79);color:#c4d2cb;'+
      'font-size:.82em;font-weight:650;line-height:1.35;clear:both;vertical-align:middle}'+
      '.lta-v03.good{border-color:#359966;color:#64e5a1}'+
      '.lta-v03.warn{border-color:#b48d36;color:#edc76b}'+
      '.lta-v03.bad{border-color:#bd5e57;color:#f59b92}'+
      '.lta-direct-torrent{display:inline-flex!important;align-items:center!important;'+
      'gap:.42em!important;background:#f4f4f4!important;color:#222!important;'+
      'border-radius:.6em!important;min-height:2.5em!important;'+
      'padding:.35em 1.25em!important;margin-right:.35em!important}'+
      '.lta-direct-torrent span{color:inherit!important}';
    (document.head||document.documentElement).appendChild(el);
  }
  function activeRoot(){try{var a=Lampa.Activity.active();return a&&a.component==='full'&&a.activity&&a.activity.render&&a.activity.render();}catch(e){return null;}}
  function findDetailsAnchor(root){
    // Place after the year/country header and BEFORE the movie title.
    var selectors=['.full-start-new__title','.full-start__title','.full-start__name',
      '.full-start-new__name','.full-start__head'];
    for(var i=0;i<selectors.length;i++){
      var title=root.find(selectors[i]).first();
      if(title.length)return title;
    }
    // Conservative fallback: above action buttons, never inside the buttons row.
    return root.find('.full-start-new__buttons').first();
  }
  function paint(root,m,state){
    if(!root||!root.length||!root[0]||!document.body.contains(root[0]))return;
    var badge=root.find('.lta-v03').first();
    if(!badge.length){
      badge=$('<div class="lta-v03"></div>');
      var anchor=findDetailsAnchor(root);
      if(anchor.length)anchor.before(badge);
      else root.prepend(badge);
    }
    var message='',level='';
    if(state.status==='loading')message='⌛ Проверяем торренты…';
    else if(state.status==='found'&&state.best){
      message=(state.confirmed?'Лучший торрент: ':'Предварительно: ')+state.best.score+' · '+state.best.quality+' · '+(state.best.seeds==null?'?':state.best.seeds)+' раздающих';
      level=state.best.score>75?'good':state.best.score>=55?'warn':'bad';
    }else if(state.status==='empty')message='Поиск не нашёл подходящих (проверь список вручную)';
    else if(state.status==='error')message='⚠ Не удалось проверить раздачи';
    else message='Торренты ещё не проверены';
    if(badge.text()!==message)badge.text(message);
    badge.removeClass('good warn bad').addClass(level);
    badge.attr('title',state.status==='found'&&state.best?state.best.title+' | '+state.best.audio+' · '+state.best.tracker+' · '+state.best.sizeGB+' ГБ · '+state.server:'Предварительная проверка через публичные парсеры');
  }
  var lastListSignature='';
  function captureVisibleRankedResults(){
    var rank=window.LampaTrackerRank;
    if(!currentMovie||!rank||typeof rank.inspect!=='function')return;
    var visible=Array.prototype.slice.call(document.querySelectorAll('.torrent-item')).filter(function(card){
      return card.getClientRects().length&&!card.classList.contains('ltr-hidden')&&!card.classList.contains('ltr-duplicate');
    });
    if(!visible.length)return;
    var results=[];
    visible.forEach(function(card){
      // The live card is the source of truth: score AND seeder count come from the same scan.
      var item=rank.inspect(card);
      if(!item||!Number.isFinite(item.total)||!item.matched||!item.matched.length)return;
      if(!isRelated({Title:item.title},currentMovie))return;
      results.push({score:item.total,title:item.title,quality:item.quality.name,
        audio:item.audio.name,seeds:item.seeds,sizeGB:item.size,tracker:item.matched.join(', ')});
    });
    if(!results.length)return;
    results.sort(function(a,b){return b.score-a.score||(b.seeds||0)-(a.seeds||0);});
    var best=results[0];
    var signature=[currentMovie.key,best.title,best.score,best.seeds,results.length].join('|');
    if(signature===lastListSignature)return;
    lastListSignature=signature;
    var d={status:'found',best:best,number:results.length,server:'Список Lampa',confirmed:true,at:Date.now()};
    writeCache(currentMovie,d);
    // If the movie details page is still visible, immediately repaint its score.
    // Avoid unnecessary DOM mutations; changes to the list can arrive in several waves.
    var root=activeRoot();
    if(root&&root.length&&root.find('.lta-v03').length)paint(root,currentMovie,d);
  }
  function bindPlay(root){
    if(!CONFIG.redirectPlay||!root||!root.length)return;
    var area=root.find('.full-start-new__buttons').first();
    if(!area.length)return;
    var play=area.find('.button--play').first();
    var source=root.find('.buttons--container > .full-start__button.view--torrent').first();
    if(!source.length)source=root.find('.full-start__button.view--torrent').not('.lta-direct-torrent').first();
    if(!source.length)return;
    var direct=area.find('.lta-direct-torrent').first();
    if(!direct.length){
      // A separate remote-focusable button avoids the original "Select source" listener.
      direct=source.clone(false,false);
      direct.removeClass('hide button--play').addClass('selector lta-direct-torrent').removeAttr('id');
      direct.find('span').first().text('Смотреть торренты');
      direct.off();
      direct.on('hover:enter.lta click.lta',function(ev){
        if(ev){ev.preventDefault();ev.stopImmediatePropagation();}
        // Invoke the native torrent source directly, bypassing the source chooser.
        source.trigger('hover:enter',[{}]);
      });
      if(play.length){play.before(direct);play.hide().removeClass('selector');}
      else area.prepend(direct);
    }else if(play.length)play.hide().removeClass('selector');
  }
  function onDetails(evt){
    if(!evt||evt.type!=='complite'||!evt.object||!evt.object.activity)return;
    var movie=parseMovie(movieOf(evt));if(!movie)return;
    if(currentKey!==movie.key)lastListSignature='';
    currentMovie=movie;currentKey=movie.key;
    var token=++activeToken,root=evt.object.activity.render();
    abortRequests(); // Cancel every in-flight lookup for the previous page.
    bindPlay(root);
    var cached=readCache(movie);
    paint(root,movie,cached||{status:'loading'});
    if(runTimer)clearTimeout(runTimer);
    // Cached results are valid for 30 minutes; avoid refetching on every opening.
    if(cached)return;
    runTimer=setTimeout(function(){
      runTimer=null;
      if(closed||token!==activeToken)return;
      var primaryError=null;
      runSearch(CONFIG.primary,CONFIG.primaryKey,movie,true)
        .then(function(primaryResults){
          var p=bestFrom(primaryResults,movie);
          p.server='jac.stull.xyz';
          if(!closed&&token===activeToken&&p.status==='found'){var live=readCache(movie);paint(root,movie,live&&live.confirmed?live:p);}
          return {primary:primaryResults,result:p};
        })
        .catch(function(error){
          primaryError=error;
          return {primary:[],result:{status:'empty'}};
        })
        .then(function(initial){
          if(closed||token!==activeToken)return {primary:initial.primary,secondary:[]};
          if(initial.result.status==='found')return {primary:initial.primary,secondary:[]};
          return runSearch(CONFIG.secondary,CONFIG.secondaryKey,movie,true)
            .then(function(secondaryResults){return {primary:initial.primary,secondary:secondaryResults};})
            .catch(function(){return {primary:initial.primary,secondary:[]};});
        })
        .then(function(data){
          if(closed||token!==activeToken)return;
          var merged=bestFrom(mergeResults([data.primary,data.secondary]),movie);
          merged.server=data.secondary.length?'jac.stull.xyz + jac.black':'jac.stull.xyz';
          var confirmed=readCache(movie);
          if(confirmed&&confirmed.confirmed){
            // The live, already ranked Lampa list takes precedence over older API data.
            paint(root,movie,confirmed);
          }else{
            if(merged.status==='found')writeCache(movie,merged);
            paint(root,movie,merged.status==='empty'&&primaryError&&data.secondary.length===0?{status:'error'}:merged);
          }
        })
        .catch(function(err){
          if(closed||token!==activeToken)return;
          paint(root,movie,{status:'error'});
          console.warn('[Torrent Assistant] Search failed:',err&&err.message||err);
        });
    },400);
  }
  function disable(){
    closed=true;activeToken++;
    if(runTimer)clearTimeout(runTimer);
    abortRequests();
    if(captureTimer)clearTimeout(captureTimer);
    if(initTimer)clearInterval(initTimer);
    if(listener&&Lampa.Listener&&Lampa.Listener.remove)try{Lampa.Listener.remove('full',listener);}catch(e){}
    if(observer)observer.disconnect();
    $('.button--play').show().addClass('selector');
    var el=document.getElementById(CSS_ID);if(el)el.remove();
    $('.lta-v03,.lta-direct-torrent').remove();
  }
  function init(){
    if(!window.Lampa||!Lampa.Listener||!Lampa.Activity||!(window.$||window.jQuery))return false;
    ensureStyle();
    listener=onDetails;Lampa.Listener.follow('full',listener);
    observer=new MutationObserver(function(mutations){
      if(closed||!currentMovie||captureTimer)return;
      // Ignore changes unrelated to newly inserted torrent cards.
      var relevant=mutations.some(function(m){
        return Array.prototype.some.call(m.addedNodes,function(node){
          return node.nodeType===1&&((node.matches&&node.matches('.torrent-item'))||(node.querySelector&&node.querySelector('.torrent-item')));
        });
      });
      if(!relevant)return;
      captureTimer=setTimeout(function(){captureTimer=null;if(!closed)captureVisibleRankedResults();},350);
    });
    observer.observe(document.body||document.documentElement,{childList:true,subtree:true});
    window.LampaTorrentAssistant={version:VERSION,config:CONFIG,disable:disable,
      testSearch:function(movie){var m=parseMovie(movie);return m?runSearch(CONFIG.primary,CONFIG.primaryKey,m,true).then(function(x){return bestFrom(x,m);}):Promise.reject(Error('Нет данных фильма'));},
      rank:scoreJSON,refresh:function(){var root=activeRoot();if(root&&currentMovie){var c=readCache(currentMovie);paint(root,currentMovie,c||{status:'loading'});bindPlay(root);}}
    };
    console.info('[Lampa Torrent Assistant] '+VERSION+' loaded');return true;
  }
  if(!init()){
    var count=0;
    initTimer=setInterval(function(){if(init()||++count>80){clearInterval(initTimer);initTimer=null;}},250);
  }
})();
