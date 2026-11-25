/* Lampa Torrent Assistant v0.1.0
 * Keeps the existing torrent source and Tracker Rank unchanged.
 * Redirects the main Play button to Lampa's native torrent source.
 * Remembers the best Tracker Rank score after the torrent list has been opened.
 * No API keys, no external requests; this build does not prefetch remote search.
 */
(function () {
  'use strict';
  var VERSION = '0.1.0';
  if (window.LampaTorrentAssistant && window.LampaTorrentAssistant.version === VERSION) return;
  var OPT = {redirectPlay: true, cacheHours: 12};
  var STYLE = 'lta-style';
  var lastMovie = null;
  var observer = null;
  var pending = false;
  var timer = null;
  var lastSave = '';
  function safeText(v){return String(v == null ? '' : v).replace(/\s+/g,' ').trim();}
  function getMovie(){
    try {
      var a = Lampa.Activity.active();
      return a && (a.movie || (a.params && a.params.movie) || a.card) || null;
    } catch(e){return null;}
  }
  function key(movie){
    if(!movie)return '';
    var name = safeText(movie.title || movie.name || movie.original_title || movie.original_name);
    var year = safeText(movie.release_date || movie.first_air_date || '').slice(0,4);
    return (movie.id ? 'tmdb:' + movie.id + ':' + (movie.media_type || (movie.first_air_date?'tv':'movie')) : 'name:' + name.toLowerCase()+':'+year);
  }
  function storageKey(movie){return 'lta_best_' + key(movie);}
  function readBest(movie){
    if(!movie || !key(movie))return null;
    try {
      var raw = localStorage.getItem(storageKey(movie));
      if(!raw)return null;
      var d = JSON.parse(raw);
      if(Date.now()-d.time > OPT.cacheHours * 3600000) return null;
      return d;
    } catch(e){return null;}
  }
  function saveBest(movie, result){
    if(!movie || !key(movie))return;
    try { localStorage.setItem(storageKey(movie),JSON.stringify({score:result.score,title:result.title,time:Date.now()})); } catch(e){}
  }
  function addCSS(){
    if(document.getElementById(STYLE))return;
    var s=document.createElement('style');s.id=STYLE;
    s.textContent='.lta-best{display:inline-flex;align-items:center;gap:.3em;background:rgba(13,43,33,.8);border:1px solid #398260;border-radius:5px;padding:.22em .55em;margin:.5em .3em .3em 0;color:#83e6b6;font-size:.85em;font-weight:650;max-width:100%;white-space:nowrap}.lta-best--unknown{color:#adb7b1;border-color:#57645e;background:rgba(24,32,30,.7)}';
    (document.head || document.documentElement).appendChild(s);
  }
  function showBest(root, movie){
    if(!root || !root.length)return;
    var area=root.find('.full-start-new__buttons').first();
    if(!area.length)return;
    var el=area.find('.lta-best');
    if(!el.length){el=$('<span class="lta-best lta-best--unknown"></span>');area.append(el);}
    var data=readBest(movie);
    el.text(data ? ('★ Лучший торрент: '+data.score+'/100') : '★ Торренты: ещё не проверены');
    el.toggleClass('lta-best--unknown',!data);
    el.attr('title',data ? 'Оценка последней просмотренной выдачи; обновится после нового поиска' : 'Откройте список торрентов для первой оценки');
  }
  function adaptCard(root,movie){
    if(!root || !root.length || !root[0] || !document.body.contains(root[0]))return;
    var area=root.find('.full-start-new__buttons').first();
    var play=area.find('.button--play').first();
    var torrent=root.find('.buttons--container > .view--torrent').first();
    if(!torrent.length)torrent=root.find('.full-start__button.view--torrent').first();
    if(OPT.redirectPlay && play.length && torrent.length && !play.data('lta-bound')){
      // Main source panel is intentionally replaced, while the native torrent button remains intact.
      play.off('hover:enter');
      play.on('hover:enter.lta',function(){torrent.trigger('hover:enter');});
      play.on('click.lta',function(e){e.preventDefault();e.stopImmediatePropagation();torrent.trigger('hover:enter');});
      play.data('lta-bound',true);
      var label=play.find('span').first();
      if(label.length)label.text('Смотреть торренты');
      play.attr('title','Открыть список торрент-раздач');
    }
    showBest(root,movie);
  }
  function activeFullRoot(){
    try {
      var a=Lampa.Activity.active();
      if(a && a.component === 'full' && a.activity && a.activity.render)return a.activity.render();
    } catch(e){}
    return null;
  }
  function collectTorrentScores(){
    if(!lastMovie)return;
    var cards=document.querySelectorAll('.torrent-item[data-ltr-score]');
    var best=-1,title='';
    for(var i=0;i<cards.length;i++){
      var card=cards[i];
      if(card.classList.contains('ltr-hidden') || card.classList.contains('ltr-duplicate'))continue;
      var n=Number(card.getAttribute('data-ltr-score'));
      if(isFinite(n) && n>best){best=n;title=safeText(card.querySelector('.torrent-item__title') && card.querySelector('.torrent-item__title').textContent).slice(0,120);}
    }
    if(best<0)return;
    var signature=key(lastMovie)+':'+best+':'+cards.length;
    if(signature===lastSave)return;
    lastSave=signature;
    saveBest(lastMovie,{score:best,title:title});
  }
  function onFull(e){
    if(!e)return;
    if(e.type==='start')return;
    if(e.type!=='complite' || !e.object || !e.object.activity)return;
    var root=e.object.activity.render();
    var movie=getMovie() || lastMovie;
    if(movie)lastMovie=movie;
    var attempts=0;
    function tick(){
      if(!root || !root[0] || !document.body.contains(root[0]))return;
      adaptCard(root,movie);
      if(++attempts<14)setTimeout(tick,250);
    }
    tick();
  }
  function onMutations(){
    if(pending)return;
    pending=true;
    setTimeout(function(){pending=false;collectTorrentScores();},300);
  }
  function init(){
    if(!window.Lampa || !Lampa.Listener || !Lampa.Activity || !window.jQuery && !window.$)return false;
    addCSS();
    Lampa.Listener.follow('full',onFull);
    if(!observer){observer=new MutationObserver(onMutations);observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['data-ltr-score','class']});}
    var root=activeFullRoot();
    if(root){lastMovie=getMovie()||lastMovie;adaptCard(root,lastMovie);}
    window.LampaTorrentAssistant={version:VERSION,refresh:function(){var r=activeFullRoot();if(r)adaptCard(r,getMovie()||lastMovie);},cache:readBest,config:OPT};
    console.info('[Lampa Torrent Assistant] Loaded '+VERSION);
    return true;
  }
  if(!init()){
    var count=0;
    timer=setInterval(function(){if(init() || ++count>80)clearInterval(timer);},250);
  }
})();
