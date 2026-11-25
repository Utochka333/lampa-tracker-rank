/* Lampa Torrent Assistant v0.2.0 (experimental)
 * Prefetch public JacRed-compatible APIs on FULL movie/TV details only.
 * Uses the same score WEIGHTS as Tracker Rank (profile-aware), JSON field extraction.
 * Does not send data anywhere except the configured public parser endpoints.
 * UI: native Torrent redirect + best verified score/status on opened details page.
 */
(function(){
  'use strict';
  var VERSION='0.2.0', PREVIOUS=window.LampaTorrentAssistant;
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
    redirectPlay:true, maxResults:300
  };
  var KEY_PREFIX='lta_v02_', CSS_ID='lta-v02-style', activeToken=0, timers=[], listener=null,
      currentKey='',currentMovie=null,closed=false,requestController=null,runTimer=null,observer=null;
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
  function fetchParser(base,key,m){
    var ctrl=new AbortController();requestController=ctrl;
    var timeout=setTimeout(function(){ctrl.abort();},CONFIG.timeoutMs);timers.push(timeout);
    return fetch(parserUrl(base,key,m),{method:'GET',mode:'cors',credentials:'omit',cache:'no-store',signal:ctrl.signal})
      .then(function(r){if(!r.ok)throw Error('HTTP '+r.status);return r.json();})
      .then(function(payload){
        if(!payload||!Array.isArray(payload.Results))throw Error('Нет массива Results');
        return payload.Results.slice(0,CONFIG.maxResults);
      }).finally(function(){clearTimeout(timeout);if(requestController===ctrl)requestController=null;});
  }
  function isAllowed(r){return CONFIG.allowed.test(n(r.Tracker||r.trackers||r.Source));}
  function inspectYear(r,m){
    // Only reject clearly contradictory dates. Unknown release years are allowed,
    // as tracker titles routinely omit release date or include upload year.
    var year=Number(r.released||r.Released||r.releaseYear||0);
    if(year&&m.year&&Math.abs(year-m.year)>1)return false;
    var title=n(r.Title||r.title);
    // Explicit year inside brackets near movie title is useful; avoid extracting upload dates.
    var fromTitle=title.match(/(?:\(|\[|\/|\s)(19\d{2}|20\d{2})(?:\)|\]|\s|\/)/);
    if(fromTitle&&m.year&&Math.abs(Number(fromTitle[1])-m.year)>1)return false;
    return true;
  }
  function isRelated(r,m){
    if(!inspectYear(r,m))return false;
    var raw=n(r.Title||r.title),details=r.Details&&typeof r.Details==='object'?r.Details:{};
    var candidates=[raw,details.name,details.originalName,r.name,r.originalName].filter(Boolean).map(cleanName);
    var titles=[m.title,m.original].filter(Boolean).map(cleanName);
    return titles.some(function(t){
      if(!t||t.length<3)return false;
      return candidates.some(function(candidate){
        return candidate===t || candidate.indexOf(t+' ')===0 || candidate.indexOf(t+' 19')>=0 ||
          candidate.indexOf(t+' 20')>=0 || candidate.indexOf(' '+t+' ')>=0;
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
  function scoreJSON(r){
    var size=Number(r.Size||0)/1073741824,quality=getQuality(r),audio=audioPoints(r),profile=getProfile();
    var seeds=r.Seeders===undefined||r.Seeders===null?null:Math.max(0,Number(r.Seeders)||0);
    var raw={quality:quality.points,hdr:hdrPoints(r),audio:audio.points,release:releasePoints(r),seeds:seedPoints(seeds),size:sizePoints(size,quality.name,profile.name),tracker:0};
    var total=0;Object.keys(profile.weights).forEach(function(k){
      total+=Math.round((raw[k]||0)*Number(profile.weights[k])/(BASE_MAX[k]||1));
    });
    return {score:Math.max(0,Math.min(100,total)),title:n(r.Title),quality:quality.name,audio:audio.name,
      seeds:seeds,sizeGB:Math.round(size*10)/10,tracker:n(r.Tracker),profile:profile.name};
  }
  function bestFrom(results,m){
    var matched=results.filter(function(r){return r&&isAllowed(r)&&isRelated(r,m);});
    var ranked=matched.map(scoreJSON).sort(function(a,b){return b.score-a.score||(b.seeds||0)-(a.seeds||0);});
    return {status:ranked.length?'found':'empty',best:ranked[0]||null,number:ranked.length,server:'',at:Date.now()};
  }
  function ensureStyle(){
    if(document.getElementById(CSS_ID))return;
    var el=document.createElement('style');el.id=CSS_ID;
    el.textContent='.lta-v02{display:inline-flex;align-items:center;gap:.36em;max-width:100%;white-space:normal;margin:.45em .4em .3em 0;padding:.28em .55em;border-radius:.32em;border:1px solid #53635b;background:rgba(16,27,24,.82);color:#b7c4bd;font-size:.85em;font-weight:600;line-height:1.3}.lta-v02.good{border-color:#359966;color:#64e5a1}.lta-v02.warn{border-color:#b48d36;color:#edc76b}.lta-v02.bad{border-color:#bd5e57;color:#f59b92}.lta-v02 .lta-v02-sub{font-size:.85em;opacity:.85}';
    (document.head||document.documentElement).appendChild(el);
  }
  function activeRoot(){try{var a=Lampa.Activity.active();return a&&a.component==='full'&&a.activity&&a.activity.render&&a.activity.render();}catch(e){return null;}}
  function paint(root,m,state){
    if(!root||!root.length||!root[0]||!document.body.contains(root[0]))return;
    var area=root.find('.full-start-new__buttons').first();if(!area.length)return;
    var badge=area.find('.lta-v02');if(!badge.length){badge=$('<span class="lta-v02"></span>');area.append(badge);}
    var text='',level='';
    if(state.status==='loading')text='⏳ Ищем торренты…';
    else if(state.status==='found'&&state.best){
      text='★ Лучший торрент: '+state.best.score+'/100 · '+state.best.quality+' · '+state.best.seeds+' сидов';
      level=state.best.score>=85?'good':state.best.score>=65?'warn':'bad';
    }else if(state.status==='empty')text='Торренты по выбранным источникам не найдены';
    else if(state.status==='error')text='⚠ Не удалось проверить торренты';
    else text='Торренты ещё не проверены';
    badge.text(text).removeClass('good warn bad').addClass(level);
    badge.attr('title',state.status==='found'&&state.best?state.best.audio+' · '+state.best.tracker+' · '+state.best.sizeGB+' ГБ · '+state.server:'Результат предварительной проверки через публичный парсер');
  }
  function bindPlay(root){
    if(!CONFIG.redirectPlay||!root||!root.length)return;
    var area=root.find('.full-start-new__buttons').first();
    var play=area.find('.button--play').first();
    var torrent=root.find('.buttons--container > .view--torrent').first();
    if(!torrent.length)torrent=root.find('.full-start__button.view--torrent').first();
    if(!play.length||!torrent.length)return;
    if(!play.data('lta-v02-bound')){
      play.off('hover:enter.lta click.lta');
      play.on('hover:enter.lta-v02',function(ev){ev.preventDefault();ev.stopImmediatePropagation();torrent.trigger('hover:enter');});
      play.on('click.lta-v02',function(ev){ev.preventDefault();ev.stopImmediatePropagation();torrent.trigger('hover:enter');});
      play.data('lta-v02-bound',true);
      play.attr('title','Открыть торренты');
      var span=play.find('span').first();if(span.length)span.text('Смотреть торренты');
    }
  }
  function onDetails(evt){
    if(!evt||evt.type!=='complite'||!evt.object||!evt.object.activity)return;
    var movie=parseMovie(movieOf(evt));if(!movie)return;
    currentMovie=movie;currentKey=movie.key;
    var token=++activeToken,root=evt.object.activity.render();
    bindPlay(root);
    var cached=readCache(movie);
    if(cached){paint(root,movie,cached);return;}
    paint(root,movie,{status:'loading'});
    if(runTimer)clearTimeout(runTimer);
    runTimer=setTimeout(function(){
      if(closed||token!==activeToken)return;
      fetchParser(CONFIG.primary,CONFIG.primaryKey,movie).then(function(res){
        return {results:res,server:'jac.stull.xyz'};
      }).catch(function(firstErr){
        return fetchParser(CONFIG.secondary,CONFIG.secondaryKey,movie).then(function(res){return {results:res,server:'jac.black'};});
      }).then(function(info){
        if(closed||token!==activeToken)return;
        var out=bestFrom(info.results,movie);out.server=info.server;writeCache(movie,out);paint(root,movie,out);
      }).catch(function(err){
        if(closed||token!==activeToken)return;
        paint(root,movie,{status:'error'});
        console.warn('[Torrent Assistant] Parser test failed:',err&&err.message||err);
      });
    },400);
  }
  function disable(){
    closed=true;activeToken++;
    if(runTimer)clearTimeout(runTimer);
    if(requestController)requestController.abort();
    timers.forEach(clearTimeout);timers=[];
    if(listener&&Lampa.Listener&&Lampa.Listener.remove)try{Lampa.Listener.remove('full',listener);}catch(e){}
    if(observer)observer.disconnect();
    var el=document.getElementById(CSS_ID);if(el)el.remove();
    $('.lta-v02').remove();
  }
  function init(){
    if(!window.Lampa||!Lampa.Listener||!Lampa.Activity||!(window.$||window.jQuery))return false;
    ensureStyle();
    listener=onDetails;Lampa.Listener.follow('full',listener);
    window.LampaTorrentAssistant={version:VERSION,config:CONFIG,disable:disable,
      testSearch:function(movie){var m=parseMovie(movie);return m?fetchParser(CONFIG.primary,CONFIG.primaryKey,m).then(function(x){return bestFrom(x,m);}):Promise.reject(Error('Нет данных фильма'));},
      rank:scoreJSON,refresh:function(){var root=activeRoot();if(root&&currentMovie){var c=readCache(currentMovie);paint(root,currentMovie,c||{status:'loading'});bindPlay(root);}}
    };
    console.info('[Lampa Torrent Assistant] '+VERSION+' loaded');return true;
  }
  if(!init()){
    var count=0,id=setInterval(function(){if(init()||++count>80)clearInterval(id);},250);
  }
})();
